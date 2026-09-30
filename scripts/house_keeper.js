/**
 * house_keeper.js
 * Keeper for MonadPulseHouse: records RedStone's signed prices at each pending bet's strike and result
 * times and settles the bets, so winnings reach players' balances ~2 s after the result is signed.
 *
 * Event-driven: BetPlaced / BetSettled / PriceRecorded logs arrive over Monad's WebSocket (ChainStream);
 * a local timer wakes the keeper at each strike or result time plus the report's publication delay.
 * The gateway is asked for a report only when a bet needs it. On start and after a reconnect, pending
 * bets are re-read from the contract, so nothing that happened meanwhile is missed.
 *
 * If the exact report never appears, the earliest report up to 30 s later is recorded; the contract uses
 * it once its grace period has passed. A bet with no price at all is voided (stake returned) by the
 * contract after its void timeout, and the keeper sends that settlement too.
 *
 * Usage:
 *   npm run keeper -- --mode dry-run                  (reads chain, simulates, sends nothing)
 *   npm run keeper -- --mode live --network testnet   (needs KEEPER_PRIVATE_KEY in .env)
 * Env: KEEPER_HEALTH_PORT (optional) serves GET /health for a process supervisor.
 */

import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ethers } from 'ethers';
import { ENVIRONMENTS, SUPPORTED_MARKETS } from '../src/config.js';
import { HOUSE_ABI } from '../src/contracts/HouseAbi.js';
import { ReportSource } from './lib/report_source.js';
import { ChainStream } from './lib/chain_stream.js';
import { MonadRpcProvider } from '../src/rpc.js';

const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
if (args.includes('--private-key')) {
  console.error('[SECURITY] --private-key is not supported (leaks via shell history / ps). Set KEEPER_PRIVATE_KEY instead.');
  process.exit(1);
}
const isLive = arg('--mode') === 'live';
const targetNet = arg('--network') || 'testnet';
const privateKey = process.env.KEEPER_PRIVATE_KEY;

// When to ask for a report after its time: all signatures are in by ~2 s (measured on the gateway)
const REPORT_ATTEMPTS_S = [1.5, 2.5, 3.5, 5, 8, 12, 20];
const INTERVAL = 10;
const SUBSTITUTE_STEPS = 3;
const MAX_BETS_PER_TX = 60;
const MAX_UPDATES_PER_TX = 12;
const LOW_BALANCE = ethers.parseEther('1');
// A send that keeps failing (e.g. the wallet is out of gas money) must not retry in a tight loop:
// resubmitting the same nonce every ~50ms floods the node with in-flight copies of the same
// transaction for no benefit.
const ERROR_BACKOFF_MS = 5000;
// A handful of sends were seen rejected as "insufficient balance" on well-funded wallets on Monad
// testnet, in a way that wasn't really about the gasLimit value (retesting the identical call, same
// gasLimit, later succeeded). A related case WAS pinned down directly: rapid unwaited placeBet calls
// against one wallet (a manual test script racing itself, reading the wallet's on-chain balance fresh
// each time but never awaiting the previous send) hit both a genuine nonce collision and, once its
// balance ran low, a msg.value that exceeded its real native balance - which Monad's node reports as
// an undecodable revert ("missing revert data") rather than a recognisable insufficient-funds error.
// The general lesson carries over here: overlapping transactions from the same wallet key (this
// keeper and some other script or process both active on it) are the most likely explanation for an
// "insufficient balance" that clears on its own, not the gasLimit. MIN_GAS_LIMIT stays as a cheap
// defensive buffer regardless.
const MIN_GAS_LIMIT = 200_000n;
// Bets read back from the contract on start: the most recent ones, until this many settled in a row
const RESCAN_SETTLED_RUN = 200;

const config = ENVIRONMENTS[targetNet];
if (!config) {
  console.error(`[CONFIG] Unknown --network "${targetNet}". Use one of: ${Object.keys(ENVIRONMENTS).join(', ')}.`);
  process.exit(1);
}
if (!config.contractAddress) {
  console.error(`[CONFIG] ${config.name}: contract address is not configured. See .env.example.`);
  process.exit(1);
}
if (isLive && !privateKey) {
  console.error('[CONFIG] KEEPER_PRIVATE_KEY is required in live mode.');
  process.exit(1);
}

// Two live keepers on one key race the same nonces. Hold a per-wallet lock file (with our PID) for the
// life of the process; a lock whose PID is dead is stale and gets taken over.
if (isLive) {
  const lockPath = path.join(os.tmpdir(), `house_keeper_${new ethers.Wallet(privateKey).address.toLowerCase()}.lock`);
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  for (let attempt = 0; ; attempt++) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const owner = Number(fs.readFileSync(lockPath, 'utf8'));
      if (owner && alive(owner) && owner !== process.pid) {
        console.error(`[KEEPER] Another keeper (pid ${owner}) already runs on this wallet. Stop it first (lock: ${lockPath}).`);
        process.exit(1);
      }
      if (attempt > 2) throw e;
      fs.rmSync(lockPath, { force: true }); // stale lock from a dead process
    }
  }
  const release = () => { try { if (Number(fs.readFileSync(lockPath, 'utf8')) === process.pid) fs.rmSync(lockPath); } catch { /* already gone */ } };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
}

console.log(`[KEEPER] ${isLive ? 'LIVE' : 'DRY-RUN (simulates, sends nothing)'} on ${config.name} (chain ${config.chainId})`);
console.log(`[KEEPER] RPC ${config.rpcUrl} | WS ${config.wsUrl} | house ${config.contractAddress}`);

const MARKETS = new Map(Object.values(SUPPORTED_MARKETS).map((m) => [m.marketId.toLowerCase(), m]));

class HouseKeeper {
  constructor() {
    this.provider = new MonadRpcProvider(config.rpcUrl, config.chainId);
    this.wallet = privateKey ? new ethers.Wallet(privateKey, this.provider) : null;
    this.house = new ethers.Contract(config.contractAddress, HOUSE_ABI, this.wallet || this.provider);
    this.pending = new Map();   // betId -> { id, marketId, startTs, endTs, priceGrace, voidAfter }
    this.recorded = new Set();  // `${marketId}:${ts}` prices known on-chain
    this.timer = null;
    this.busy = false;
    this.again = false;
    this.lastErrorAt = 0; // backoff floor after a failed send, see ERROR_BACKOFF_MS
    this.stats = { settled: 0, won: 0, lost: 0, push: 0, void: 0, pricesRecorded: 0, txs: 0, gasSpentWei: 0n, errors: 0 };
  }

  async init() {
    if ((await this.provider.getCode(config.contractAddress)) === '0x') {
      throw new Error(`No contract deployed at ${config.contractAddress} on ${config.name}.`);
    }
    // Logged only: each bet keeps its own priceGrace/voidAfter from when it was placed (the owner
    // cannot retime a pending bet), so scheduling always reads those, never these current defaults.
    const [signers, threshold, grace, voidAfter] = await Promise.all([
      this.house.oracleSigners(), this.house.signerThreshold(), this.house.priceGrace(), this.house.voidAfter()
    ]);
    console.log(`[KEEPER] Oracle: ${signers.length} signers, ${threshold} required | grace ${Number(grace)}s | void after ${Number(voidAfter)}s | wallet ${this.wallet?.address || '(none)'}`);
    this.source = new ReportSource({ feeds: [...MARKETS.values()].map((m) => m.feed), signers, threshold: Number(threshold) });
    this.stream = new ChainStream({
      wsUrl: config.wsUrl,
      address: config.contractAddress,
      onLog: (raw) => this.onLog(raw),
      onReconnect: () => {
        console.log('[KEEPER] Event stream connected; re-reading pending bets');
        this.rescan().catch((err) => console.error('[KEEPER] rescan failed:', err.message));
      }
    });
    this.stream.start();
  }

  /** Pending bets from the contract: newest first, stopping after a long run of settled ones */
  async rescan() {
    const count = Number(await this.house.betCount());
    let settledRun = 0;
    for (let id = count - 1; id >= 0 && settledRun < RESCAN_SETTLED_RUN; id--) {
      const b = await this.house.bets(id);
      if (Number(b.status) === 1) {
        settledRun = 0;
        this.track(id, b.marketId, Number(b.startTs), Number(b.duration), Number(b.priceGrace), Number(b.voidAfter));
        const m = b.marketId.toLowerCase();
        for (const ts of [Number(b.startTs), Number(b.startTs) + Number(b.duration)]) {
          if (!this.recorded.has(`${m}:${ts}`) && (await this.house.prices(b.marketId, ts)) > 0n) this.recorded.add(`${m}:${ts}`);
        }
      } else {
        settledRun++;
      }
    }
    console.log(`[KEEPER] ${this.pending.size} pending bet(s)`);
    this.schedule();
  }

  track(id, marketId, startTs, duration, priceGrace, voidAfter) {
    if (!MARKETS.has(marketId.toLowerCase())) {
      console.warn(`[KEEPER] bet #${id} on unknown market ${marketId}; skipped`);
      return;
    }
    this.pending.set(Number(id), { id: Number(id), marketId: marketId.toLowerCase(), startTs, endTs: startTs + duration, priceGrace, voidAfter });
  }

  async onLog(raw) {
    let e;
    try { e = this.house.interface.parseLog(raw); } catch (_) { return; }
    if (!e || raw.removed) return;
    if (e.name === 'BetPlaced') {
      // The event carries no priceGrace/voidAfter (they were added after it was defined); read the
      // bet itself so this pending entry uses what it was actually placed with, not today's globals.
      const full = await this.house.bets(e.args.betId);
      this.track(e.args.betId, e.args.marketId, Number(e.args.startTs), Number(e.args.duration), Number(full.priceGrace), Number(full.voidAfter));
      this.schedule();
    } else if (e.name === 'BetSettled') {
      this.pending.delete(Number(e.args.betId));
    } else if (e.name === 'PriceRecorded') {
      this.recorded.add(`${e.args.marketId.toLowerCase()}:${Number(e.args.ts)}`);
    }
  }

  /** Next wake-up: the earliest report attempt any pending bet is waiting for */
  schedule() {
    clearTimeout(this.timer);
    const nowMs = Date.now();
    let next = Infinity;
    for (const b of this.pending.values()) {
      for (const ts of [b.startTs, b.endTs]) {
        if (this.recorded.has(`${b.marketId}:${ts}`)) continue;
        for (const d of REPORT_ATTEMPTS_S) {
          const at = (ts + d) * 1000;
          if (at > nowMs) { next = Math.min(next, at); break; }
        }
      }
      // Deadlines the contract itself acts on: substitute after the grace, void after the timeout.
      // A deadline already in the past (e.g. this bet was only just discovered by a rescan after
      // an outage) is due now, not "never" - Math.max keeps it from being dropped from `next`.
      for (const at of [(b.endTs + b.priceGrace + 1) * 1000, (b.endTs + b.voidAfter + 1) * 1000]) {
        next = Math.min(next, Math.max(at, nowMs));
      }
    }
    if (next === Infinity) return;
    // After a failed send, never retry sooner than ERROR_BACKOFF_MS since that failure - otherwise a
    // persistently failing send (e.g. the wallet out of gas money) retries in a tight loop, which floods
    // the node with in-flight copies of the same nonce instead of giving it - or an operator - a chance
    // to recover.
    if (this.lastErrorAt) next = Math.max(next, this.lastErrorAt + ERROR_BACKOFF_MS);
    this.timer = setTimeout(() => this.run(), Math.max(50, next - nowMs));
  }

  async run() {
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    try {
      do {
        this.again = false;
        await this.work();
      } while (this.again);
      this.lastErrorAt = 0;
    } catch (err) {
      this.stats.errors++;
      this.lastErrorAt = Date.now();
      console.error('[KEEPER] error:', err.shortMessage || err.message);
    } finally {
      this.busy = false;
      this.schedule();
    }
  }

  async work() {
    const now = Math.floor(Date.now() / 1000);
    const updates = [];
    const settleIds = [];
    const wanted = new Map(); // `${marketId}:${ts}` -> { market, ts }
    for (const b of this.pending.values()) {
      for (const ts of [b.startTs, b.endTs]) {
        const key = `${b.marketId}:${ts}`;
        if (!this.recorded.has(key) && ts <= now) wanted.set(key, { marketId: b.marketId, ts });
      }
    }
    for (const [key, { marketId, ts }] of wanted) {
      if (updates.length >= MAX_UPDATES_PER_TX) break;
      const market = MARKETS.get(marketId);
      const reports = await this.source.reportsAt(market.feed, ts);
      if (reports) {
        updates.push({ key, marketId, ts, reports });
        continue;
      }
      // Exact report missing past its publication window: record the earliest later one for the
      // contract's substitute rule (used only after its grace period)
      if (now >= ts + REPORT_ATTEMPTS_S[REPORT_ATTEMPTS_S.length - 1]) {
        for (let k = 1; k <= SUBSTITUTE_STEPS; k++) {
          const later = ts + k * INTERVAL;
          const lk = `${marketId}:${later}`;
          if (later > now) break;
          if (this.recorded.has(lk)) break;
          const lr = await this.source.reportsAt(market.feed, later);
          if (lr) {
            if (!updates.some((u) => u.key === lk)) updates.push({ key: lk, marketId, ts: later, reports: lr });
            console.log(`[KEEPER] ${market.symbol} report at ${ts} missing; recorded ${later} as its substitute`);
            break;
          }
        }
      }
    }
    const willHave = new Set([...this.recorded, ...updates.map((u) => u.key)]);
    for (const b of this.pending.values()) {
      if (settleIds.length >= MAX_BETS_PER_TX) break;
      if (b.endTs > now) continue;
      const ready = willHave.has(`${b.marketId}:${b.startTs}`) && willHave.has(`${b.marketId}:${b.endTs}`);
      const pastGrace = now >= b.endTs + b.priceGrace;
      const pastVoid = now >= b.endTs + b.voidAfter;
      if (ready || pastGrace || pastVoid) settleIds.push(b.id);
    }
    if (!updates.length && !settleIds.length) return;
    await this.send(updates, settleIds);
  }

  async send(updates, betIds) {
    const payload = updates.map((u) => ({ marketId: u.marketId, ts: u.ts, reports: u.reports }));
    const label = `${updates.length} price(s), ${betIds.length} bet(s)`;
    if (!isLive) {
      try {
        await this.house.recordAndSettle.staticCall(payload, betIds, { from: this.wallet?.address });
        console.log(`[DRY-RUN] would send recordAndSettle: ${label}`);
      } catch (err) {
        console.log(`[DRY-RUN] recordAndSettle would fail (${label}): ${err.shortMessage || err.message}`);
      }
      for (const u of updates) this.recorded.add(u.key);
      for (const id of betIds) this.pending.delete(id);
      return;
    }
    const est = await this.house.recordAndSettle.estimateGas(payload, betIds);
    // Monad charges the full gas limit, so the margin above est is kept small. See MIN_GAS_LIMIT above
    // for the (unconfirmed) defensive floor applied on top of that margin.
    const gasLimit = (est * 110n) / 100n > MIN_GAS_LIMIT ? (est * 110n) / 100n : MIN_GAS_LIMIT;
    const tx = await this.house.recordAndSettle(payload, betIds, { gasLimit });
    const rcpt = await tx.wait();
    this.stats.txs++;
    this.stats.gasSpentWei += rcpt.fee;
    for (const u of updates) this.recorded.add(u.key);
    let settled = 0;
    for (const log of rcpt.logs) {
      let e;
      try { e = this.house.interface.parseLog(log); } catch (_) { continue; }
      if (e?.name === 'PriceRecorded') {
        this.recorded.add(`${e.args.marketId.toLowerCase()}:${Number(e.args.ts)}`);
        this.stats.pricesRecorded++;
      }
      if (e?.name === 'BetSettled') {
        settled++;
        this.pending.delete(Number(e.args.betId));
        this.stats.settled++;
        const k = ['', '', 'won', 'lost', 'push', 'void'][Number(e.args.status)];
        if (k) this.stats[k]++;
      }
    }
    console.log(`[KEEPER] ${label} -> ${settled} settled | tx ${rcpt.hash} | gas ${ethers.formatEther(rcpt.fee)} MON`);
    const bal = await this.provider.getBalance(this.wallet.address);
    if (bal < LOW_BALANCE) console.error(`[KEEPER] LOW BALANCE: ${ethers.formatEther(bal)} MON. Bets stop settling when it runs out; top up ${this.wallet.address}.`);
  }

  health() {
    return {
      ok: Boolean(this.stream?.status.connected),
      mode: isLive ? 'live' : 'dry-run',
      pending: this.pending.size,
      ...this.stats,
      gasSpentWei: undefined,
      gasSpentMon: ethers.formatEther(this.stats.gasSpentWei),
      stream: this.stream?.status ?? null
    };
  }

  serveHealth(port) {
    http.createServer((req, res) => {
      const body = this.health();
      res.writeHead(body.ok ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    }).listen(port, () => console.log(`[KEEPER] health on http://localhost:${port}/health`));
  }
}

const keeper = new HouseKeeper();
await keeper.init();
if (process.env.KEEPER_HEALTH_PORT) keeper.serveHealth(Number(process.env.KEEPER_HEALTH_PORT));
setInterval(() => {
  const h = keeper.health();
  console.log(`[KEEPER] pending ${h.pending} | settled ${h.settled} (won ${h.won}, lost ${h.lost}, push ${h.push}, void ${h.void}) | prices ${h.pricesRecorded} | gas ${h.gasSpentMon} MON | errors ${h.errors} | stream ${h.ok ? 'up' : 'DOWN'}`);
}, 5 * 60e3).unref();
