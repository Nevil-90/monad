/**
 * scripts/lib/dashboard_store.js
 * Read side of the Dashboard: paginated, filtered queries against the `activity` and `bets` tables
 * scripts/lib/event_index.js writes to, plus the SQL aggregates (supabase/schema.sql) for the Wallets
 * tab and the summary stat tiles. Every query is filtered and paginated in Postgres, so the browser
 * never downloads more than the one page it is showing. Row shapes match exactly what src/ChainHistory.js
 * used to hand the Dashboard from its in-memory arrays, so src/Dashboard.js's table rendering needed no
 * changes, only how it asks for rows.
 */
import { supabase } from './supabase_store.js';

const MAX_PAGE_SIZE = 200;
const isFullTxHash = (q) => /^0x[0-9a-f]{64}$/i.test(q);
const pageOf = (n) => (Number.isInteger(Number(n)) && Number(n) >= 0 ? Number(n) : 0);
const sizeOf = (n) => (Number.isInteger(Number(n)) && Number(n) > 0 ? Math.min(Number(n), MAX_PAGE_SIZE) : 25);

/**
 * Runs a PostgREST `.range()` page request. A page past the end of the result set (the filters
 * changed, or the data shrank, since the caller picked this page number) makes PostgREST error
 * instead of returning zero rows, so that specific case re-runs at page 0 to get a real `count`
 * back; the caller (src/Dashboard.js) then clamps to the last real page and re-fetches that.
 */
async function rangeQuery(buildQuery, pg, sz) {
  let { data, count, error } = await buildQuery().range(pg * sz, pg * sz + sz - 1);
  if (error?.code === 'PGRST103') ({ data, count, error } = await buildQuery().range(0, sz - 1));
  if (error) throw error;
  return { data, count };
}

export async function activityPage({ chainId, address, market, type, q, page, pageSize }) {
  const pg = pageOf(page), sz = sizeOf(pageSize);
  const buildQuery = () => {
    let query = supabase().from('activity').select('*', { count: 'exact' }).eq('chain_id', chainId).eq('address', address);
    if (market && market !== 'all') query = query.eq('market_id', market);
    if (type && type !== 'all') query = type === 'lp' ? query.in('type', ['lpIn', 'lpOut']) : query.eq('type', type);
    if (q) query = isFullTxHash(q) ? query.eq('tx_hash', q.toLowerCase()) : query.or(`user_address.ilike.%${q}%,tx_hash.ilike.${q}%`);
    return query.order('block_number', { ascending: false }).order('log_index', { ascending: false });
  };
  const { data, count } = await rangeQuery(buildQuery, pg, sz);
  const rows = data.map((r) => ({
    tx: r.tx_hash, block: Number(r.block_number), logIndex: r.log_index, type: r.type,
    user: r.user_address, marketId: r.market_id, betId: r.bet_id ?? undefined, side: r.side ?? undefined,
    amount: Number(r.amount)
  }));
  return { rows, total: count ?? rows.length };
}

export async function betsPage({ chainId, address, market, q, page, pageSize }) {
  const pg = pageOf(page), sz = sizeOf(pageSize);
  const buildQuery = () => {
    let query = supabase().from('bets').select('*', { count: 'exact' }).eq('chain_id', chainId).eq('address', address);
    if (market && market !== 'all') query = query.eq('market_id', market);
    if (q) query = query.or(`tx_hash.ilike.${q}%,settle_tx.ilike.${q}%,user_address.ilike.%${q}%`);
    return query.order('bet_id', { ascending: false });
  };
  const { data, count } = await rangeQuery(buildQuery, pg, sz);
  const rows = data.map((b) => ({
    betId: Number(b.bet_id), user: b.user_address, marketId: b.market_id, side: b.side,
    stake: b.stake !== null ? Number(b.stake) : null, status: b.status, paid: Number(b.paid),
    startPrice: b.start_price !== null ? Number(b.start_price) : null,
    endPrice: b.end_price !== null ? Number(b.end_price) : null,
    startTs: b.start_ts !== null ? Number(b.start_ts) : null, duration: b.duration ?? null,
    tx: b.tx_hash, block: Number(b.block_number),
    settleTx: b.settle_tx ?? undefined, settleBlock: b.settle_block !== null ? Number(b.settle_block) : undefined
  }));
  return { rows, total: count ?? rows.length };
}

export async function walletsPage({ chainId, address, market, q, sort, dir, page, pageSize }) {
  const pg = pageOf(page), sz = sizeOf(pageSize);
  const args = { p_chain_id: chainId, p_address: address, p_market_id: market && market !== 'all' ? market : null, p_query: q || null };
  const [{ data: rowsData, error: rowsErr }, { data: total, error: countErr }] = await Promise.all([
    supabase().rpc('dashboard_wallets', { ...args, p_sort: sort || 'staked', p_dir: dir === 1 ? 1 : -1, p_limit: sz, p_offset: pg * sz }),
    supabase().rpc('dashboard_wallets_count', args)
  ]);
  if (rowsErr) throw rowsErr;
  if (countErr) throw countErr;
  const rows = (rowsData || []).map((w) => ({
    address: w.address, bets: Number(w.bets), staked: Number(w.staked), won: Number(w.won),
    refunded: Number(w.refunded), jackpots: Number(w.jackpots), wins: Number(w.wins), losses: Number(w.losses),
    lastBlock: Number(w.last_block), net: Number(w.net)
  }));
  return { rows, total: Number(total ?? rows.length) };
}

export async function summary({ chainId, address, market }) {
  const { data, error } = await supabase().rpc('dashboard_summary', {
    p_chain_id: chainId, p_address: address, p_market_id: market && market !== 'all' ? market : null
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return {
    betsCount: Number(row?.bets_count ?? 0), riseIn: Number(row?.rise_in ?? 0), fallIn: Number(row?.fall_in ?? 0),
    wins: Number(row?.wins ?? 0), refunds: Number(row?.refunds ?? 0), jackpots: Number(row?.jackpots ?? 0),
    walletCount: Number(row?.wallet_count ?? 0)
  };
}
