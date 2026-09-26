/**
 * scripts/lib/event_index.js
 * Indexes the AMM contract's event logs from its deploy block and keeps following new blocks, so the
 * Dashboard gets its whole history in one request. Monad's public RPCs only allow eth_getLogs over
 * 100 blocks per request and the chain makes ~8,400 blocks an hour, which is too slow to scan from
 * every browser. Each log keeps its transaction hash, so every row stays verifiable on the explorer.
 *
 * The index is saved to disk (data/, git-ignored) so a restart does not rescan from the deploy block.
 */

import fs from 'fs';
import path from 'path';
import { ethers } from 'ethers';
import { MonadRpcProvider } from '../../src/rpc.js';

const CHUNK = 100;
const CONCURRENCY = 4;
const POLL_MS = 1500;

export class EventIndex {
  constructor({ rpcUrl, chainId, address, fromBlock, dataDir, log = console }) {
    this.provider = new MonadRpcProvider(rpcUrl, chainId);
    this.address = ethers.getAddress(address);
    this.fromBlock = fromBlock;
    this.log = log;
    this.file = path.join(dataDir, `events-${chainId}-${this.address.toLowerCase()}.json`);
    this.logs = [];           // oldest first
    this.head = fromBlock - 1; // last fully indexed block
    this.blockTimes = new Map();
    this.status = { ok: false, error: null, latest: null };
    this.subscribers = new Set(); // (logs, head) => void, called as new blocks are indexed
    this.load();
  }

  load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved.address === this.address && saved.fromBlock === this.fromBlock) {
        this.logs = saved.logs;
        this.head = saved.head;
        this.log.log(`[index] resumed at block ${this.head} with ${this.logs.length} events`);
      }
    } catch (_) {
      // No saved index yet: start from the deploy block
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ address: this.address, fromBlock: this.fromBlock, head: this.head, logs: this.logs }));
    fs.renameSync(tmp, this.file);
  }

  start() {
    const tick = async () => {
      try {
        await this.catchUp();
        this.status = { ...this.status, ok: true, error: null };
      } catch (err) {
        this.status = { ...this.status, ok: false, error: err.shortMessage || err.message };
        this.log.error(`[index] ${this.status.error}`);
      }
      setTimeout(tick, POLL_MS);
    };
    tick();
  }

  async blockTime(n) {
    if (!this.blockTimes.has(n)) this.blockTimes.set(n, (await this.provider.getBlock(n)).timestamp);
    return this.blockTimes.get(n);
  }

  async catchUp() {
    const latest = await this.provider.getBlockNumber();
    this.status.latest = latest;
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
      for (const batch of results) {
        for (const l of batch) {
          this.logs.push({
            blockNumber: l.blockNumber,
            transactionHash: l.transactionHash,
            index: l.index,
            topics: l.topics,
            data: l.data,
            timestamp: await this.blockTime(l.blockNumber)
          });
        }
      }
      const before = this.head;
      const added = results.flat().length ? this.logs.slice(this.logs.length - results.flat().length) : [];
      this.head = ranges[ranges.length - 1][1];
      for (const fn of this.subscribers) fn(added, this.head);
      if (results.some((r) => r.length) || this.head - before >= CHUNK * 10) this.save();
    }
  }

  /** Events after `block` (oldest first), and the block the index has reached */
  since(block) {
    const after = Number(block);
    let i = this.logs.length;
    while (i > 0 && this.logs[i - 1].blockNumber > after) i--;
    return { address: this.address, head: this.head, logs: this.logs.slice(i) };
  }
}
