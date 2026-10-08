/**
 * scripts/lib/event_index.js
 * Indexes the AMM contract's event logs from its deploy block and keeps following new blocks, so the
 * Dashboard gets its whole history in one request. Monad's public RPCs only allow eth_getLogs over
 * 100 blocks per request and the chain makes ~8,400 blocks an hour, which is too slow to scan from
 * every browser. Each log keeps its transaction hash, so every row stays verifiable on the explorer.
 *
 * Nothing is polled: new logs and blocks are pushed over Monad's WebSocket (ChainStream). getLogs runs
 * only to fill gaps, once at start and once after each reconnect. A gap after being offline a while is
 * caught up a few hundred blocks at a time (the RPC's 100-block cap on eth_getLogs) and logged as it
 * goes, since on a fast chain that catch-up can take minutes and would otherwise look hung.
 *
 * The index's durable store is Supabase (schema in supabase/schema.sql), not a local file: a restart
 * resumes from there instead of rescanning from the deploy block, and it is the one shared, central
 * place every relay (and the Dashboard's paginated queries, via scripts/lib/dashboard_store.js) reads
 * from. Each log is also decoded once here (scripts/lib/decode_log.js) into the structured `activity`
 * and `bets` rows the Dashboard filters, sorts and paginates in SQL.
 *
 * Writes are debounced and batched: a burst of new events collapses into one upsert a little later,
 * instead of a round trip per event. Only rows added since the last flush are sent (not the whole
 * history), so a flush stays cheap no matter how large the index has grown.
 */

import { ethers } from 'ethers';
import { MonadRpcProvider } from '../../src/rpc.js';
import { ChainStream, wsUrlFor } from './chain_stream.js';
import { supabase } from './supabase_store.js';
import { decodeLog } from './decode_log.js';

const CHUNK = 100;
// In-flight getLogs calls; the shared RPC provider paces the actual send rate (src/rpc.js), this just
// needs to be high enough to keep that budget full given ~1s of latency per call
const CONCURRENCY = 8;
// Block-height updates to browsers at most this often (Monad makes ~3 blocks a second)
const HEAD_PUSH_MS = 2000;
// How long a burst of save() calls is allowed to coalesce into a single Supabase round trip
const SAVE_DEBOUNCE_MS = 1500;
// Backfill progress is logged at most this often, so a long catch-up stays visible without spamming
const PROGRESS_LOG_MS = 5000;
// Rows fetched per page while hydrating the in-memory index from Supabase on startup
const LOAD_PAGE = 1000;

export class EventIndex {
  /** Async because startup hydrates `this.logs` from Supabase; `new EventIndex(...)` would race that. */
  static async create(opts) {
    const index = new EventIndex(opts);
    await index.load();
    return index;
  }

  constructor({ rpcUrl, wsUrl = wsUrlFor(rpcUrl), chainId, address, fromBlock, log = console }) {
    this.provider = new MonadRpcProvider(rpcUrl, chainId);
    this.wsUrl = wsUrl;
    this.chainId = chainId;
    this.address = ethers.getAddress(address);
    this.fromBlock = fromBlock;
    this.log = log;
    this.logs = [];           // oldest first
    this.head = fromBlock - 1; // last fully indexed block
    this.blockTimes = new Map();
    this.status = { ok: false, error: null, latest: null };
    this.subscribers = new Set(); // ({ logs, head, gasPrice }) => void, called as events and blocks arrive
    this.keys = new Set();        // `${tx}:${index}` of indexed logs
    this.gasPrice = null;         // wei, re-read when the block base fee changes
    this.backfilling = false;
    this.buffer = [];             // logs pushed while a backfill runs
    // Rows decoded since the last flush, waiting to be upserted into Supabase
    this.pending = { events: [], activity: [], placed: [], settled: [], removedKeys: [] };
  }

  /** Throws on a Supabase/config problem rather than silently falling back to a rescan: a relay that
   *  can't reach its store should fail to start, not quietly re-index from the deploy block. */
  async load() {
    const sb = supabase();
    const addr = this.address.toLowerCase();
    const { data: state, error: stateErr } = await sb.from('index_state').select('from_block,head')
      .eq('chain_id', this.chainId).eq('address', addr).maybeSingle();
    if (stateErr) throw new Error(`[index] loading index_state from Supabase: ${stateErr.message}`);
    if (!state || Number(state.from_block) !== this.fromBlock) {
      this.log.log('[index] no matching Supabase cache for this contract/fromBlock yet; indexing from the deploy block');
      return;
    }
    this.head = Number(state.head);
    for (let from = 0; ; from += LOAD_PAGE) {
      const { data: rows, error } = await sb.from('events')
        .select('block_number,log_index,tx_hash,block_time,topics,data')
        .eq('chain_id', this.chainId).eq('address', addr)
        .order('block_number', { ascending: true }).order('log_index', { ascending: true })
        .range(from, from + LOAD_PAGE - 1);
      if (error) throw new Error(`[index] loading events from Supabase: ${error.message}`);
      for (const r of rows) {
        const entry = { blockNumber: Number(r.block_number), transactionHash: r.tx_hash, index: Number(r.log_index), topics: r.topics, data: r.data, timestamp: Number(r.block_time) };
        this.logs.push(entry);
        this.keys.add(`${entry.transactionHash}:${entry.index}`);
      }
      if (rows.length < LOAD_PAGE) break;
    }
    this.log.log(`[index] resumed at block ${this.head} with ${this.logs.length} events (from Supabase)`);
  }

  /** Schedules a flush; repeated calls within SAVE_DEBOUNCE_MS collapse into the one that fires */
  save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flushPending().catch((err) => this.log.error(`[index] save failed: ${err.message}`));
    }, SAVE_DEBOUNCE_MS);
  }

  /** Flushes the pending rows now, without waiting for the debounce (used on shutdown) */
  async flush() {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    await this.flushPending();
  }

  /** On failure, puts the whole batch back in front of whatever queued meanwhile so nothing taken
   *  out of `this.pending` is ever dropped; the next save() retries it (upserts are idempotent, so
   *  re-sending rows a prior, partially-failed attempt already wrote is harmless). */
  async flushPending() {
    const batch = this.pending;
    this.pending = { events: [], activity: [], placed: [], settled: [], removedKeys: [] };
    try {
      await this.writeBatch(batch);
    } catch (err) {
      this.pending = {
        events: [...batch.events, ...this.pending.events],
        activity: [...batch.activity, ...this.pending.activity],
        placed: [...batch.placed, ...this.pending.placed],
        settled: [...batch.settled, ...this.pending.settled],
        removedKeys: [...batch.removedKeys, ...this.pending.removedKeys]
      };
      this.save();
      throw err;
    }
  }

  async writeBatch({ events, activity, placed, settled, removedKeys }) {
    const sb = supabase();
    const addr = this.address.toLowerCase();

    if (events.length) {
      const rows = events.map((e) => ({ chain_id: this.chainId, address: addr, block_number: e.blockNumber, log_index: e.index, tx_hash: e.transactionHash, block_time: e.timestamp, topics: e.topics, data: e.data }));
      const { error } = await sb.from('events').upsert(rows, { onConflict: 'chain_id,address,tx_hash,log_index' });
      if (error) throw error;
    }
    if (activity.length) {
      const rows = activity.map((r) => ({ chain_id: this.chainId, address: addr, tx_hash: r.txHash, log_index: r.logIndex, block_number: r.blockNumber, block_time: r.blockTime, type: r.type, user_address: r.userAddress?.toLowerCase() ?? null, market_id: r.marketId, bet_id: r.betId ?? null, side: r.side ?? null, amount: r.amount }));
      const { error } = await sb.from('activity').upsert(rows, { onConflict: 'chain_id,address,tx_hash,log_index' });
      if (error) throw error;
    }
    // Placed and settled are upserted separately (not merged into one row first): a row in a single
    // upsert call can only carry the columns that call knows, so a settle-only upsert never overwrites
    // placed-only fields (stake, market, side, ...) with nulls, and vice versa.
    if (placed.length) {
      const rows = placed.map((b) => ({
        chain_id: this.chainId, address: addr, bet_id: b.betId, user_address: b.userAddress?.toLowerCase() ?? null,
        market_id: b.marketId, side: b.side, stake: b.stake, payout: b.payout, start_ts: b.startTs, duration: b.duration,
        end_ts: b.endTs, streak_bet: b.streakBet, status: 'Pending', paid: 0,
        tx_hash: b.txHash, block_number: b.blockNumber, placed_at: b.placedAt
      }));
      const { error } = await sb.from('bets').upsert(rows, { onConflict: 'chain_id,address,bet_id' });
      if (error) throw error;
    }
    if (settled.length) {
      const rows = settled.map((b) => ({
        chain_id: this.chainId, address: addr, bet_id: b.betId, user_address: b.userAddress?.toLowerCase() ?? null,
        market_id: b.marketId, status: b.status, paid: b.paid, start_price: b.startPrice, end_price: b.endPrice,
        streak_after: b.streakAfter, settle_tx: b.settleTx, settle_block: b.settleBlock, settled_at: b.settledAt
      }));
      const { error } = await sb.from('bets').upsert(rows, { onConflict: 'chain_id,address,bet_id' });
      if (error) throw error;
    }
    for (const key of removedKeys) {
      const [txHash, logIndex] = [key.slice(0, key.lastIndexOf(':')), Number(key.slice(key.lastIndexOf(':') + 1))];
      await sb.from('events').delete().eq('chain_id', this.chainId).eq('address', addr).eq('tx_hash', txHash).eq('log_index', logIndex);
      await sb.from('activity').delete().eq('chain_id', this.chainId).eq('address', addr).eq('tx_hash', txHash).eq('log_index', logIndex);
    }
    const { error: stateErr } = await sb.from('index_state').upsert(
      { chain_id: this.chainId, address: addr, from_block: this.fromBlock, head: this.head },
      { onConflict: 'chain_id,address' }
    );
    if (stateErr) throw stateErr;
  }

  start() {
    this.stream = new ChainStream({
      wsUrl: this.wsUrl,
      address: this.address,
      log: this.log,
      onReconnect: () => this.backfill(),
      onLog: (raw) => this.onLog(raw),
      onHead: (head) => this.onHead(head)
    });
    this.stream.start();
  }

  /** Fetches everything between the saved head and the chain head once (start, and after a reconnect) */
  async backfill() {
    if (this.backfilling) return;
    this.backfilling = true;
    try {
      await this.catchUp();
      const buffered = this.buffer.splice(0);
      if (buffered.length) await this.addLogs(buffered);
      this.status = { ...this.status, ok: true, error: null };
    } catch (err) {
      this.status = { ...this.status, ok: false, error: err.shortMessage || err.message };
      this.log.error(`[index] backfill failed: ${this.status.error}; retrying on the next reconnect`);
      this.stream.ws?.close();
    } finally {
      this.backfilling = false;
    }
  }

  async onLog(raw) {
    if (this.backfilling) {
      this.buffer.push(raw);
      return;
    }
    await this.addLogs([raw]);
  }

  async onHead(head) {
    this.blockTimes.set(head.number, head.timestamp);
    if (this.blockTimes.size > 5000) this.blockTimes.delete(this.blockTimes.keys().next().value);
    this.status.latest = head.number;
    let gasChanged = false;
    if (head.baseFeePerGas !== null && head.baseFeePerGas !== this.baseFee) {
      this.baseFee = head.baseFeePerGas;
      try {
        const price = BigInt(await this.provider.send('eth_gasPrice', []));
        gasChanged = price !== this.gasPrice;
        this.gasPrice = price;
      } catch (err) {
        this.log.error(`[index] gas price: ${err.shortMessage || err.message}`);
      }
    }
    if (this.backfilling || head.number <= this.head) return;
    this.head = head.number;
    if (gasChanged || Date.now() - (this.lastHeadPush || 0) >= HEAD_PUSH_MS) this.push([]);
  }

  push(logs) {
    this.lastHeadPush = Date.now();
    for (const fn of this.subscribers) fn({ logs, head: this.head, gasPrice: this.gasPrice });
  }

  /** Decodes one newly-added entry and queues its rows for the next Supabase flush */
  queueForSave(entry) {
    this.pending.events.push(entry);
    const { activity, placed, settled } = decodeLog(entry);
    if (activity) this.pending.activity.push(activity);
    if (placed) this.pending.placed.push(placed);
    if (settled) this.pending.settled.push(settled);
  }

  /** Adds pushed (raw JSON-RPC) logs in order; drops duplicates, and removes logs of re-organised blocks */
  async addLogs(raws) {
    const added = [];
    for (const r of raws) {
      const entry = {
        blockNumber: Number(r.blockNumber),
        transactionHash: r.transactionHash,
        index: Number(r.logIndex ?? r.index),
        topics: r.topics,
        data: r.data
      };
      const key = `${entry.transactionHash}:${entry.index}`;
      if (r.removed) {
        if (this.keys.delete(key)) {
          this.logs = this.logs.filter((l) => `${l.transactionHash}:${l.index}` !== key);
          this.pending.removedKeys.push(key);
        }
        continue;
      }
      if (this.keys.has(key)) continue;
      entry.timestamp = await this.blockTime(entry.blockNumber);
      this.keys.add(key);
      added.push(entry);
    }
    if (!added.length) return;
    this.logs.push(...added);
    this.logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
    this.head = Math.max(this.head, ...added.map((l) => l.blockNumber));
    for (const entry of added) this.queueForSave(entry);
    this.save();
    this.push(added);
  }

  async blockTime(n) {
    if (!this.blockTimes.has(n)) this.blockTimes.set(n, (await this.provider.getBlock(n)).timestamp);
    return this.blockTimes.get(n);
  }

  async catchUp() {
    const latest = await this.provider.getBlockNumber();
    this.status.latest = latest;
    const startHead = this.head;
    const totalBlocks = latest - startHead;
    if (totalBlocks > CHUNK * 10) {
      this.log.log(`[index] catching up ${totalBlocks} blocks (${this.head} -> ${latest}); this can take a while on a fresh index`);
    }
    let lastLog = Date.now();
    while (this.head < latest) {
      const ranges = [];
      for (let a = this.head + 1; a <= latest && ranges.length < CONCURRENCY * 4; a += CHUNK) {
        ranges.push([a, Math.min(latest, a + CHUNK - 1)]);
      }
      const results = [];
      for (let i = 0; i < ranges.length; i += CONCURRENCY) {
        results.push(...await Promise.all(ranges.slice(i, i + CONCURRENCY).map(([a, b]) =>
          this.provider.getLogs({ address: this.address, fromBlock: a, toBlock: b }))));
      }
      const added = [];
      for (const l of results.flat()) {
        const key = `${l.transactionHash}:${l.index}`;
        if (this.keys.has(key)) continue;
        this.keys.add(key);
        const entry = {
          blockNumber: l.blockNumber,
          transactionHash: l.transactionHash,
          index: l.index,
          topics: l.topics,
          data: l.data,
          timestamp: await this.blockTime(l.blockNumber)
        };
        this.logs.push(entry);
        added.push(entry);
      }
      for (const entry of added) this.queueForSave(entry);
      const before = this.head;
      this.head = ranges[ranges.length - 1][1];
      this.push(added);
      if (added.length || this.head - before >= CHUNK * 10) this.save();
      if (this.head < latest && Date.now() - lastLog >= PROGRESS_LOG_MS) {
        lastLog = Date.now();
        const pct = totalBlocks > 0 ? Math.round(((this.head - startHead) / totalBlocks) * 100) : 100;
        this.log.log(`[index] catching up: block ${this.head} / ${latest} (${pct}%, ${this.logs.length} events indexed so far)`);
      }
    }
    if (totalBlocks > CHUNK * 10) this.log.log(`[index] caught up to block ${latest}`);
  }

  /** Events after `block` (oldest first), and the block the index has reached */
  since(block) {
    const after = Number(block);
    let i = this.logs.length;
    while (i > 0 && this.logs[i - 1].blockNumber > after) i--;
    return { address: this.address, head: this.head, logs: this.logs.slice(i) };
  }
}
