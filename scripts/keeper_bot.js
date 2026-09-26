/**
 * keeper_bot.js
 * Keeper for MonadPulse: locks and settles rounds with signed RedStone reports, finalizes rounds after
 * a challenge period, and cancels rounds that could not be resolved in time.
 *
 * Event-driven, nothing is polled:
 *   - the contract's logs arrive over Monad's WebSocket (ChainStream); any event on a market makes the
 *     keeper re-read that market's recent rounds once (continuous play: a round may still be running
 *     or settling after the next one opened)
 *   - otherwise the keeper sleeps until the round's next deadline (lock time, close time, the report's
 *     publication ~12 s later, the end of a challenge period, expiry) and acts then
 *   - the report for a round's pinned time is fetched once from RedStone's 24 h history
 *     (fetchReportsAt), at the time it is published, with a few scheduled retries if it is late
 * After a reconnect every market is re-read once, so nothing that happened meanwhile is missed.
 *
 * Usage:
 *   npm run keeper -- --mode dry-run                  (reads chain, simulates, sends nothing)
 *   npm run keeper -- --mode live --network testnet   (needs KEEPER_PRIVATE_KEY in .env)
 * Env: KEEPER_HEALTH_PORT (optional) serves GET /health for a process supervisor.
 * SEC-10: keys are read from the environment only, never from argv / shell history.
 */

import http from 'http';
import { ethers } from 'ethers';
import { ENVIRONMENTS, SUPPORTED_MARKETS } from '../src/config.js';
import { AMM_ABI } from '../src/contracts/AMMAbi.js';
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

// When to look for a report after its timestamp. Measured 2026-09-26 on the history gateway: 2 of 5
// signatures at +0.5 s, all 5 by +2 s. Retries bypass the gateway CDN's 5 s cache (ReportSource), so
// an early incomplete answer does not stick. After the last attempt the keeper falls back to the
// earliest later report (SEC-28).
const REPORT_ATTEMPTS_S = [1.5, 2.5, 3.5, 5, 8, 12, 20, 45];
const GIVE_UP_S = REPORT_ATTEMPTS_S[REPORT_ATTEMPTS_S.length - 1];
const RETRY_AFTER_ERROR_S = 10;
// Rounds per market checked on each look: the current one and the ones before it that may still be
// locking or settling while the next is already taking bets
const ROUNDS_BACK = 4;
const LOW_BALANCE = ethers.parseEther('1');
const CLAIM_REWARDS_AT = ethers.parseEther('0.05');

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

console.log(`[KEEPER] ${isLive ? 'LIVE' : 'DRY-RUN (simulates, sends nothing)'} on ${config.name} (chain ${config.chainId})`);
console.log(`[KEEPER] RPC ${config.rpcUrl} | WS ${config.wsUrl} | AMM ${config.contractAddress}`);

const MARKETS = new Map(Object.values(SUPPORTED_MARKETS).map((m) => [m.marketId.toLowerCase(), m]));

class Keeper {
  constructor() {
    this.provider = new MonadRpcProvider(config.rpcUrl, config.chainId);
    this.wallet = privateKey ? new ethers.Wallet(privateKey, this.provider) : null;
    this.amm = new ethers.Contract(config.contractAddress, AMM_ABI, this.wallet || this.provider);
    this.notices = new Set();
    this.timers = new Map();   // marketId -> timeout for its next deadline
    this.queues = new Map();   // marketId -> promise chain (one check at a time per market)
    this.dryRun = new Set();   // actions already simulated in dry-run mode
    this.lastEventAt = null;
    this.stats = { locked: 0, settled: 0, refunded: 0, gasSpentWei: 0n, rewardsClaimedWei: 0n, errors: 0 };
  }

  notice(key, message) {
    if (this.notices.has(key)) return;
    this.notices.add(key);
    if (this.notices.size > 2000) this.notices.clear();
    console.log(message);
  }

  /** Refuses to start unless the contract exists; uses the contract's own signer set and rules */
  async init() {
    if ((await this.provider.getCode(config.contractAddress)) === '0x') {
      throw new Error(`No contract deployed at ${config.contractAddress} on ${config.name}.`);
    }
    const [signers, threshold, challenge] = await Promise.all([
      this.amm.oracleSigners(), this.amm.signerThreshold(), this.amm.CHALLENGE_PERIOD()
    ]);
    this.threshold = Number(threshold);
    this.challengePeriod = Number(challenge);
    console.log(`[KEEPER] Oracle: ${signers.length} signers, ${this.threshold} required | challenge ${this.challengePeriod}s | wallet ${this.wallet?.address || '(none)'}`);
    this.source = new ReportSource({ feeds: [...MARKETS.values()].map((m) => m.feed), signers, threshold: this.threshold });
    this.stream = new ChainStream({
      wsUrl: config.wsUrl,
      address: config.contractAddress,
      onLog: (raw) => this.onLog(raw),
      onReconnect: () => {
        console.log('[KEEPER] Event stream connected; reading every market once');
        for (const market of MARKETS.values()) this.check(market);
      }
    });
    this.stream.start();
  }

  onLog(raw) {
    this.lastEventAt = Date.now();
    let parsed;
    try { parsed = this.amm.interface.parseLog(raw); } catch (_) { return; }
    const id = parsed?.args?.marketId ? String(parsed.args.marketId).toLowerCase() : null;
    const market = id && MARKETS.get(id);
    if (market) this.check(market);
  }

  /** Re-reads a market and acts on / schedules its current round. Calls for one market run one at a time. */
  check(market) {
    const id = market.marketId.toLowerCase();
    if (this.queues.get(id)?.waiting) return this.queues.get(id);
    const prev = this.queues.get(id) || Promise.resolve();
    const run = prev.then(async () => {
      run.waiting = false;
      let next = null;
      try {
        next = await this.checkMarket(market);
      } catch (err) {
        this.stats.errors++;
        console.error(`    [ERROR] ${market.symbol}: ${err.shortMessage || err.message}`);
        next = Math.floor(Date.now() / 1000) + RETRY_AFTER_ERROR_S;
      }
      this.schedule(market, next);
    });
    run.waiting = true;
    this.queues.set(id, run);
    return run;
  }

  schedule(market, atSec) {
    const id = market.marketId.toLowerCase();
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    if (atSec === null) return;
    const ms = Math.max(0, atSec * 1000 - Date.now()) + 250; // a little after, so chain time has passed it
    this.timers.set(id, setTimeout(() => this.check(market), ms));
  }

  async send(label, method, market, rId, reports) {
    const fn = this.amm[method];
    const callArgs = reports ? [market.marketId, rId, reports] : [market.marketId, rId];
    if (!isLive) {
      const key = `${market.feed}:${rId}:${method}`;
      if (this.dryRun.has(key)) return;
      await fn.staticCall(...callArgs, { from: this.wallet?.address });
      this.dryRun.add(key);
      console.log(`    [DRY-RUN] ${market.symbol} ${label} #${rId} would succeed. Nothing sent.`);
      return;
    }
    const est = await fn.estimateGas(...callArgs);
    // Monad charges the full gas limit, so the margin stays small (SEC-25)
    const tx = await fn(...callArgs, { gasLimit: (est * 110n) / 100n });
    const sentAt = Date.now() / 1000;
    const rcpt = await tx.wait();
    const confirmedAt = Date.now() / 1000;
    const settled = rcpt.logs.map((l) => { try { return this.amm.interface.parseLog(l); } catch (_) { return null; } }).find((e) => e?.name === 'RoundSettled');
    const accrued = await this.amm.keeperRewards(this.wallet.address);
    this.stats.gasSpentWei += rcpt.fee;
    const kind = { lockRoundWithUpdate: 'locked', settleRoundWithUpdate: 'settled', finalizeRound: 'settled', emergencyRefund: 'refunded' }[method];
    this.stats[kind]++;
    console.log(`    [${label}] ${market.symbol} #${rId} tx ${rcpt.hash} | gas ${ethers.formatEther(rcpt.fee)} MON | ${settled ? `settle bounty ${ethers.formatEther(settled.args.keeperReward)} MON | ` : ''}${this.latency(method, sentAt, confirmedAt)}`);
    await this.afterTx(accrued);
  }

  /** How long after the round's lock/close time this transaction was confirmed (for the log) */
  latency(method, sentAt, confirmedAt) {
    if (!this.dueAt || !['lockRoundWithUpdate', 'settleRoundWithUpdate'].includes(method)) return '';
    const at = (t) => `+${(t - this.dueAt).toFixed(1)}s`;
    return `${method === 'lockRoundWithUpdate' ? 'lock' : 'close'} time ${this.dueAt}: report ${this.reportAt ? at(this.reportAt) : '?'}, sent ${at(sentAt)}, confirmed ${at(confirmedAt)}`;
  }

  /** After each transaction: withdraw rewards once they are worth a claim, warn when funds run low */
  async afterTx(accrued) {
    try {
      if (accrued >= CLAIM_REWARDS_AT) {
        const rcpt = await (await this.amm.claimKeeperRewards()).wait();
        this.stats.rewardsClaimedWei += accrued;
        this.stats.gasSpentWei += rcpt.fee;
        console.log(`[KEEPER] Claimed ${ethers.formatEther(accrued)} MON in rewards. Tx ${rcpt.hash}`);
      }
      const bal = await this.provider.getBalance(this.wallet.address);
      this.balance = bal;
      if (bal < LOW_BALANCE) console.error(`[KEEPER] LOW BALANCE: ${ethers.formatEther(bal)} MON. Rounds stop settling when it runs out; top up ${this.wallet.address}.`);
    } catch (err) {
      this.stats.errors++;
      console.error(`[KEEPER] After-transaction step failed: ${err.shortMessage || err.message}`);
    }
  }

  /** Acts on the market's current round if something is due; returns when to look again (s), or null */
  /**
   * Continuous play: the next round can open while earlier ones are still locking or settling, so
   * the last few rounds of the market are checked. Returns the earliest time one needs a look (s).
   */
  async checkMarket(market) {
    const m = await this.amm.markets(market.marketId);
    if (m.currentRoundId === 0n) return null;
    let next = null;
    for (let rId = m.currentRoundId; rId >= 1n && rId > m.currentRoundId - BigInt(ROUNDS_BACK); rId--) {
      const round = await this.amm.rounds(market.marketId, rId);
      const at = await this.checkRound(market, rId, round);
      if (at !== null && (next === null || at < next)) next = at;
    }
    return next;
  }

  async checkRound(market, rId, round) {
    const status = Number(round.status);
    const now = Math.floor(Date.now() / 1000);
    const key = `${market.feed}:${rId}`;

    // Nobody bet, or only one side: nothing to decide. Bettors refund directly and the next bet opens a
    // new round (SEC-24/26), so the keeper spends nothing. A BetPlaced event wakes it if that changes.
    if (status !== 1 && status !== 2) return null;
    if (round.totalUp === 0n || round.totalDown === 0n) return null;

    // A contested round nobody could resolve: its bettors refund directly (SEC-26), and it does not
    // block the market (the next bet opens a new round), so the keeper spends nothing on it
    const expiry = Number(round.expiryTimestamp);
    if (now > expiry) return null;

    const step = Number(round.priceWindow);
    const delay = Number(round.maxReportDelay);
    const pin = (t) => Math.ceil(Number(t) / step) * step;
    const lockPin = pin(round.lockTimestamp);
    const closePin = pin(round.closeTimestamp);
    // Next report attempt for a pinned time, or the fallback deadline after the last one
    const nextAttempt = (pinned) => {
      const at = REPORT_ATTEMPTS_S.map((s) => pinned + s).find((t) => t > now);
      return Math.min(at ?? pinned + delay + GIVE_UP_S, expiry + 1);
    };

    if (status === 1) {
      if (now < Number(round.lockTimestamp)) return lockPin + REPORT_ATTEMPTS_S[0];
      this.dueAt = Number(round.lockTimestamp);
      const found = await this.bestReport(market, key, 'lock', lockPin, delay, step, now);
      if (!found) return nextAttempt(lockPin);
      await this.send(found.pinned ? 'LOCK' : 'LOCK (late report)', 'lockRoundWithUpdate', market, rId, found.reports);
      return null; // the RoundLocked event triggers the next check
    }

    // Locked. A late (provisional) lock report is replaced by an earlier one if one can be found now.
    if (Number(round.lockPublishTime) > lockPin && now < Number(round.finalizeAfter)) {
      const earlier = await this.source.earliest(market.feed, lockPin, lockPin + delay, step, Number(round.lockPublishTime));
      if (earlier) {
        await this.send('IMPROVE LOCK', 'lockRoundWithUpdate', market, rId, earlier.reports);
        return null;
      }
    }
    if (now < Number(round.closeTimestamp)) return closePin + REPORT_ATTEMPTS_S[0];
    this.dueAt = Number(round.closeTimestamp);

    const proposed = Number(round.closePublishTime);
    if (proposed === 0) {
      const found = await this.bestReport(market, key, 'close', closePin, delay, step, now);
      if (!found) return nextAttempt(closePin);
      await this.send(found.pinned ? 'SETTLE' : 'PROPOSE CLOSE (late report)', 'settleRoundWithUpdate', market, rId, found.reports);
      return null;
    }
    if (proposed > closePin && now < Number(round.finalizeAfter)) {
      const earlier = await this.source.earliest(market.feed, closePin, closePin + delay, step, proposed);
      if (earlier) {
        await this.send('IMPROVE CLOSE', 'settleRoundWithUpdate', market, rId, earlier.reports);
        return null;
      }
    }
    if (now >= Number(round.finalizeAfter)) {
      await this.send('FINALIZE', 'finalizeRound', market, rId);
      return null;
    }
    this.notice(`${key}:challenge`, `    [CHALLENGE] ${market.symbol} #${rId}: close report ${proposed} proposed; final at ${round.finalizeAfter}.`);
    return Number(round.finalizeAfter);
  }

  /**
   * The report set to lock/settle with: the pinned one, fetched from the gateway's history once it is
   * published; only after the last scheduled attempt, the earliest later one within the round's
   * maxReportDelay. A later report is challengeable on-chain for CHALLENGE_PERIOD (SEC-28).
   */
  async bestReport(market, key, what, pinnedTs, delay, step, now) {
    const exact = await this.source.reportsAt(market.feed, pinnedTs);
    this.reportAt = Date.now() / 1000;
    if (exact) return { pinned: true, reports: exact };
    if (now < pinnedTs + GIVE_UP_S) {
      this.notice(`${key}:${what}:wait`, `    [WAIT] ${market.symbol}: ${what} report at ${pinnedTs} not published yet.`);
      return null;
    }
    const later = await this.source.earliest(market.feed, pinnedTs + step, pinnedTs + delay, step);
    if (later) {
      console.log(`    [LATE] ${market.symbol}: no complete ${what} report at ${pinnedTs} after ${GIVE_UP_S}s; using ${later.ts} (challengeable for ${this.challengePeriod}s).`);
      return { pinned: false, reports: later.reports };
    }
    this.notice(`${key}:${what}:none`, `    [WAIT] ${market.symbol}: no complete ${what} report in [${pinnedTs}, ${pinnedTs + delay}] yet.`);
    return null;
  }

  health() {
    const s = this.stats;
    const ok = Boolean(this.stream?.status.connected);
    return {
      ok,
      mode: isLive ? 'live' : 'dry-run',
      network: config.name,
      wallet: this.wallet?.address || null,
      balanceMon: this.balance === undefined ? null : ethers.formatEther(this.balance),
      stream: this.stream?.status ?? null,
      lastEventAgoMs: this.lastEventAt === null ? null : Date.now() - this.lastEventAt,
      scheduled: this.timers.size,
      reports: this.source?.stats ?? null,
      rounds: { locked: s.locked, settled: s.settled, refunded: s.refunded, errors: s.errors },
      // SEC-11: what keeping costs versus what it earns
      gasSpentMon: ethers.formatEther(s.gasSpentWei),
      rewardsClaimedMon: ethers.formatEther(s.rewardsClaimedWei),
      netMon: ethers.formatEther(s.rewardsClaimedWei - s.gasSpentWei)
    };
  }

  /** GET /health on KEEPER_HEALTH_PORT: 200 while the event stream is connected, else 503 */
  serveHealth(port) {
    http.createServer((req, res) => {
      const body = this.health();
      res.writeHead(body.ok ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    }).listen(port, () => console.log(`[KEEPER] health on http://localhost:${port}/health`));
  }

  async start() {
    await this.init();
    if (isLive) this.balance = await this.provider.getBalance(this.wallet.address);
    if (process.env.KEEPER_HEALTH_PORT) this.serveHealth(Number(process.env.KEEPER_HEALTH_PORT));
    // Local summary line; reads nothing from the network
    setInterval(() => {
      const h = this.health();
      console.log(`[KEEPER] locked ${h.rounds.locked}, settled ${h.rounds.settled}, refunded ${h.rounds.refunded}, errors ${h.rounds.errors}${isLive ? ` | net ${h.netMon} MON` : ''} | stream ${h.ok ? 'up' : 'DOWN'}`);
    }, 5 * 60e3);
  }
}

new Keeper().start().catch((err) => {
  console.error(`[KEEPER] ${err.shortMessage || err.message}`);
  process.exit(1);
});
