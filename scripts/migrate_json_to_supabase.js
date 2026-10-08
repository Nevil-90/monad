/**
 * scripts/migrate_json_to_supabase.js
 * One-time move of the existing data/events-*.json cache into Supabase, so the history already
 * indexed from the chain doesn't need a full rescan just because the store changed. Decodes every
 * log the same way scripts/lib/event_index.js does going forward (scripts/lib/decode_log.js), so the
 * `activity` and `bets` tables end up exactly as if the relay had been writing to Supabase all along.
 *
 * Usage: npm run migrate:supabase
 * Safe to re-run: every write is an upsert keyed the same way the relay's own writes are.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getConfig } from '../src/config.js';
import { supabase } from './lib/supabase_store.js';
import { decodeLog } from './lib/decode_log.js';

const BATCH = 500;
const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');

async function upsertBatches(sb, table, rows, onConflict) {
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await sb.from(table).upsert(rows.slice(i, i + BATCH), { onConflict });
    if (error) throw new Error(`${table}: ${error.message}`);
    console.log(`[migrate] ${table}: ${Math.min(i + BATCH, rows.length)} / ${rows.length}`);
  }
}

async function main() {
  const cfg = getConfig();
  if (!cfg.contractAddress || cfg.deployBlock === null) {
    console.error('[migrate] NEXT_PUBLIC_CONTRACT_ADDRESS / NEXT_PUBLIC_CONTRACT_DEPLOY_BLOCK must be set in .env');
    process.exit(1);
  }
  const address = cfg.contractAddress.toLowerCase();
  const file = path.join(dataDir, `events-${cfg.chainId}-${address}.json`);
  if (!fs.existsSync(file)) {
    console.log(`[migrate] no cache file at ${file}; nothing to migrate.`);
    return;
  }
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (saved.address.toLowerCase() !== address) {
    console.error(`[migrate] ${file} is for ${saved.address}, not the contract in .env (${address}). Not migrating.`);
    process.exit(1);
  }
  console.log(`[migrate] read ${saved.logs.length} events from ${file} (head ${saved.head})`);

  const eventRows = [];
  const activityRows = [];
  const placedByBet = new Map();
  const settledByBet = new Map();
  for (const l of saved.logs) {
    const entry = { blockNumber: l.blockNumber, transactionHash: l.transactionHash, index: l.index, topics: l.topics, data: l.data, timestamp: l.timestamp };
    eventRows.push({ chain_id: cfg.chainId, address, block_number: entry.blockNumber, log_index: entry.index, tx_hash: entry.transactionHash, block_time: entry.timestamp, topics: entry.topics, data: entry.data });
    const { activity, placed, settled } = decodeLog(entry);
    if (activity) activityRows.push({ chain_id: cfg.chainId, address, tx_hash: activity.txHash, log_index: activity.logIndex, block_number: activity.blockNumber, block_time: activity.blockTime, type: activity.type, user_address: activity.userAddress?.toLowerCase() ?? null, market_id: activity.marketId, bet_id: activity.betId ?? null, side: activity.side ?? null, amount: activity.amount });
    if (placed) placedByBet.set(placed.betId, placed);
    if (settled) settledByBet.set(settled.betId, settled);
  }

  const placedRows = [...placedByBet.values()].map((b) => ({
    chain_id: cfg.chainId, address, bet_id: b.betId, user_address: b.userAddress?.toLowerCase() ?? null,
    market_id: b.marketId, side: b.side, stake: b.stake, payout: b.payout, start_ts: b.startTs, duration: b.duration,
    end_ts: b.endTs, streak_bet: b.streakBet, status: 'Pending', paid: 0,
    tx_hash: b.txHash, block_number: b.blockNumber, placed_at: b.placedAt
  }));
  const settledRows = [...settledByBet.values()].map((b) => ({
    chain_id: cfg.chainId, address, bet_id: b.betId, user_address: b.userAddress?.toLowerCase() ?? null,
    market_id: b.marketId, status: b.status, paid: b.paid, start_price: b.startPrice, end_price: b.endPrice,
    streak_after: b.streakAfter, settle_tx: b.settleTx, settle_block: b.settleBlock, settled_at: b.settledAt
  }));

  const sb = supabase();
  await upsertBatches(sb, 'events', eventRows, 'chain_id,address,tx_hash,log_index');
  await upsertBatches(sb, 'activity', activityRows, 'chain_id,address,tx_hash,log_index');
  // Placed before settled, same reason as the relay's own flush: a settle-only row must never
  // overwrite placed-only fields with nulls, and upserting placed first then settled on top is how
  // that's avoided without a hand-merged row.
  await upsertBatches(sb, 'bets', placedRows, 'chain_id,address,bet_id');
  await upsertBatches(sb, 'bets', settledRows, 'chain_id,address,bet_id');

  const { error: stateErr } = await sb.from('index_state').upsert(
    { chain_id: cfg.chainId, address, from_block: saved.fromBlock, head: saved.head },
    { onConflict: 'chain_id,address' }
  );
  if (stateErr) throw new Error(`index_state: ${stateErr.message}`);

  const { count: eventCount } = await sb.from('events').select('*', { count: 'exact', head: true }).eq('chain_id', cfg.chainId).eq('address', address);
  const { count: betCount } = await sb.from('bets').select('*', { count: 'exact', head: true }).eq('chain_id', cfg.chainId).eq('address', address);
  console.log(`[migrate] done. Supabase now has ${eventCount} events and ${betCount} bets for ${address} (source file had ${saved.logs.length} events, ${placedByBet.size} distinct bet ids placed).`);
}

main().catch((err) => {
  console.error(`[migrate] failed: ${err.message}`);
  process.exit(1);
});
