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
 * The index is saved to disk (data/, git-ignored) so a restart does not rescan from the deploy block.
 * Saves are debounced and async: a burst of new events collapses into one write a little later,
 * instead of a blocking full-file rewrite on every single event.
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { ethers } from 'ethers';
import { MonadRpcProvider } from '../../src/rpc.js';
import { ChainStream, wsUrlFor } from './chain_stream.js';

const CHUNK = 100;
// In-flight getLogs calls; the shared RPC provider paces the actual send rate (src/rpc.js), this just
// needs to be high enough to keep that budget full given ~1s of latency per call
const CONCURRENCY = 8;
// Block-height updates to browsers at most this often (Monad makes ~3 blocks a second)
const HEAD_PUSH_MS = 2000;
// How long a burst of save() calls is allowed to coalesce into a single disk write
const SAVE_DEBOUNCE_MS = 1500;
// Backfill progress is logged at most this often, so a long catch-up stays visible without spamming
const PROGRESS_LOG_MS = 5000;

export class EventIndex {
  constructor({ rpcUrl, wsUrl = wsUrlFor(rpcUrl), chainId, address, fromBlock, dataDir, log = console }) {
    this.provider = new MonadRpcProvider(rpcUrl, chainId);
    this.wsUrl = wsUrl;
    this.address = ethers.getAddress(address);
    this.fromBlock = fromBlock;
    this.log = log;
    this.file = path.join(dataDir, `events-${chainId}-${this.address.toLowerCase()}.json`);
    this.logs = [];           // oldest first
    this.head = fromBlock - 1; // last fully indexed block
    this.blockTimes = new Map();
    this.status = { ok: false, error: null, latest: null };
    this.subscribers = new Set(); // ({ logs, head, gasPrice }) => void, called as events and blocks arrive
    this.keys = new Set();        // `${tx}:${index}` of indexed logs
    this.gasPrice = null;         // wei, re-read when the block base fee changes
    this.backfilling = false;
    this.buffer = [];             // logs pushed while a backfill runs
    this.load();
  }

  load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved.address === this.address && saved.fromBlock === this.fromBlock) {
        this.logs = saved.logs;
        this.head = saved.head;
        for (const l of this.logs) this.keys.add(`${l.transactionHash}:${l.index}`);
        this.log.log(`[index] resumed at block ${this.head} with ${this.logs.length} events`);
      }
    } catch (_) {
      // No saved index yet: start from the deploy block
    }
  }

  /** Schedules a write; repeated calls within SAVE_DEBOUNCE_MS collapse into the one that fires */
  save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.writeFile().catch((err) => this.log.error(`[index] save failed: ${err.message}`));
    }, SAVE_DEBOUNCE_MS);
  }

  /** Writes the current index now, without waiting for the debounce (used on shutdown) */
  async flush() {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    await this.writeFile();
  }

  async writeFile() {
    const body = JSON.stringify({ address: this.address, fromBlock: this.fromBlock, head: this.head, logs: this.logs });
    const tmp = `${this.file}.tmp`;
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    await fsp.writeFile(tmp, body);
    await fsp.rename(tmp, this.file);
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
        if (this.keys.delete(key)) this.logs = this.logs.filter((l) => `${l.transactionHash}:${l.index}` !== key);
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
