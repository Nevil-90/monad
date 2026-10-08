-- Pulse relay: Supabase schema.
-- Run this once, in full, in the Supabase SQL editor (Project > SQL Editor > New query > Run) before
-- starting `npm run relay`. Safe to re-run: every statement is idempotent.
--
-- This replaces data/*.json as the relay's store. Three kinds of table:
--   index_state   one row per (chain, contract): where the relay's backfill has reached, so a restart
--                 resumes instead of rescanning from the deploy block.
--   events        the raw log archive (one row per contract log), kept so history can be reprocessed
--                 if the decoding logic ever changes.
--   activity,bets structured, indexed rows decoded from those logs. activity is one row per
--                 money-moving event (bet/win/jackpot/refund/cashout/vault deposit or withdrawal) and
--                 powers the Dashboard's Activity tab; bets is one row per bet (upserted on BetPlaced,
--                 then again on BetSettled) and powers the Bets tab and the Wallets tab's aggregates.
-- Only the relay (service_role key) ever reads or writes these; the browser never talks to Supabase
-- directly, so Row Level Security below is "deny eversyone except service_role", which is the default
-- once RLS is enabled with no policies.

create table if not exists index_state (
  chain_id   bigint not null,
  address    text not null,
  from_block bigint not null,
  head       bigint not null,
  primary key (chain_id, address)
);

create table if not exists events (
  chain_id     bigint not null,
  address      text not null,
  block_number bigint not null,
  log_index    integer not null,
  tx_hash      text not null,
  block_time   bigint not null,
  topics       jsonb not null,
  data         text not null,
  primary key (chain_id, address, tx_hash, log_index)
);
create index if not exists events_block_idx on events (chain_id, address, block_number);

create table if not exists activity (
  chain_id     bigint not null,
  address      text not null,
  tx_hash      text not null,
  log_index    integer not null,
  block_number bigint not null,
  block_time   bigint not null,
  type         text not null,    -- bet | win | jackpot | refund | cashout | lpIn | lpOut
  user_address text,
  market_id    text,
  bet_id       bigint,
  side         text,
  amount       numeric not null default 0,
  primary key (chain_id, address, tx_hash, log_index)
);
create index if not exists activity_block_idx on activity (chain_id, address, block_number desc, log_index desc);
create index if not exists activity_user_idx on activity (chain_id, address, user_address);
create index if not exists activity_type_idx on activity (chain_id, address, type);
create index if not exists activity_market_idx on activity (chain_id, address, market_id);

create table if not exists bets (
  chain_id     bigint not null,
  address      text not null,
  bet_id       bigint not null,
  user_address text,
  market_id    text,
  side         text,
  stake        numeric,
  payout       numeric,
  start_ts     bigint,
  duration     integer,
  end_ts       bigint,
  streak_bet   boolean,
  status       text not null default 'Pending',
  paid         numeric not null default 0,
  start_price  numeric,
  end_price    numeric,
  streak_after integer,
  tx_hash      text,
  block_number bigint,
  placed_at    bigint,
  settle_tx    text,
  settle_block bigint,
  settled_at   bigint,
  primary key (chain_id, address, bet_id)
);
create index if not exists bets_user_idx on bets (chain_id, address, user_address);
create index if not exists bets_market_idx on bets (chain_id, address, market_id);
create index if not exists bets_block_idx on bets (chain_id, address, bet_id desc);

alter table index_state enable row level security;
alter table events enable row level security;
alter table activity enable row level security;
alter table bets enable row level security;

-- ---------------------------------------------------------------------------------------------
-- Dashboard aggregates (the Wallets tab and the summary stat tiles), computed in SQL so the browser
-- never has to download the full history to total it up. PostgREST can't express a GROUP BY on its
-- own, so these are plain SQL functions called over RPC.
-- ---------------------------------------------------------------------------------------------

create or replace function dashboard_summary(p_chain_id bigint, p_address text, p_market_id text default null)
returns table (
  bets_count   bigint,
  rise_in      numeric,
  fall_in      numeric,
  wins         numeric,
  refunds      numeric,
  jackpots     numeric,
  wallet_count bigint
) language sql stable as $$
  with b as (
    select * from bets
    where chain_id = p_chain_id and address = p_address
      and (p_market_id is null or market_id = p_market_id)
  ), j as (
    select * from activity
    where chain_id = p_chain_id and address = p_address and type = 'jackpot'
      and (p_market_id is null or market_id = p_market_id)
  )
  select
    (select count(*) from b)::bigint,
    (select coalesce(sum(stake), 0) from b where side = 'UP'),
    (select coalesce(sum(stake), 0) from b where side = 'DOWN'),
    (select coalesce(sum(paid), 0) from b where status = 'Won'),
    (select coalesce(sum(paid), 0) from b where status in ('Push', 'Void')),
    (select coalesce(sum(amount), 0) from j),
    (select count(distinct user_address) from b where user_address is not null)::bigint;
$$;

create or replace function dashboard_wallets(
  p_chain_id bigint, p_address text, p_market_id text default null, p_query text default null,
  p_sort text default 'staked', p_dir int default -1, p_limit int default 25, p_offset int default 0
) returns table (
  address text, bets bigint, staked numeric, won numeric, refunded numeric, jackpots numeric,
  wins bigint, losses bigint, last_block bigint, net numeric
) language sql stable as $$
  with b as (
    select * from bets
    where chain_id = p_chain_id and address = p_address and user_address is not null
      and (p_market_id is null or market_id = p_market_id)
  ), agg as (
    select
      user_address as addr,
      count(*) as bets,
      coalesce(sum(stake), 0) as staked,
      coalesce(sum(paid) filter (where status = 'Won'), 0) as won,
      coalesce(sum(paid) filter (where status in ('Push', 'Void')), 0) as refunded,
      count(*) filter (where status = 'Won') as wins,
      count(*) filter (where status = 'Lost') as losses,
      max(coalesce(settle_block, block_number)) as last_block
    from b
    group by user_address
  ), j as (
    select user_address as addr, coalesce(sum(amount), 0) as jackpots, max(block_number) as last_block
    from activity
    where chain_id = p_chain_id and address = p_address and type = 'jackpot'
      and (p_market_id is null or market_id = p_market_id)
    group by user_address
  ), merged as (
    select
      agg.addr as address, agg.bets, agg.staked, agg.won, agg.refunded,
      coalesce(j.jackpots, 0) as jackpots, agg.wins, agg.losses,
      greatest(agg.last_block, coalesce(j.last_block, 0)) as last_block,
      (agg.won + agg.refunded + coalesce(j.jackpots, 0) - agg.staked) as net,
      case when agg.wins + agg.losses > 0 then agg.wins::numeric / (agg.wins + agg.losses) else -1 end as winrate
    from agg
    left join j on j.addr = agg.addr
  ), scored as (
    select *,
      case p_sort
        when 'bets' then bets::numeric
        when 'out' then won + refunded + jackpots
        when 'net' then net
        when 'winrate' then winrate
        when 'lastBlock' then last_block::numeric
        else staked
      end as sort_val
    from merged
    where p_query is null or address ilike '%' || p_query || '%'
  )
  select address, bets, staked, won, refunded, jackpots, wins, losses, last_block, net
  from scored
  order by case when p_dir = 1 then sort_val else -sort_val end asc
  limit p_limit offset p_offset;
$$;

create or replace function dashboard_wallets_count(
  p_chain_id bigint, p_address text, p_market_id text default null, p_query text default null
) returns bigint language sql stable as $$
  select count(*) from (
    select user_address from bets
    where chain_id = p_chain_id and address = p_address and user_address is not null
      and (p_market_id is null or market_id = p_market_id)
      and (p_query is null or user_address ilike '%' || p_query || '%')
    group by user_address
  ) w;
$$;
