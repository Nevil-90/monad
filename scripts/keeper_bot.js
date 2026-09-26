/**
 * keeper_bot.js
 * Keeper for MonadPulse: locks and settles rounds with signed RedStone reports, and refunds rounds
 * that can no longer be resolved.
 *
 * RedStone's free gateway only serves the latest reports (every 10 seconds), never past ones, so the
 * keeper runs continuously and captures reports as they are published. When a round reaches its lock
 * or close time, it submits the captured report set for exactly that round's pinned timestamp
 * (see lockReportTimestamp / closeReportTimestamp on the contract, SEC-01/02).
 *
 * Usage:
 *   npm run keeper -- --mode dry-run                  (reads chain, simulates, sends nothing)
 *   npm run keeper -- --mode live --network testnet   (needs KEEPER_PRIVATE_KEY in .env)
 * SEC-10: keys are read from the environment only, never from argv / shell history.
 */

import { ethers } from 'ethers';
import { ENVIRONMENTS, SUPPORTED_MARKETS } from '../src/config.js';
import { AMM_ABI } from '../src/contracts/AMMAbi.js';
import { ReportArchive } from './lib/report_archive.js';

const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
if (args.includes('--private-key')) {
  console.error('[SECURITY] --private-key is not supported (leaks via shell history / ps). Set KEEPER_PRIVATE_KEY instead.');
  process.exit(1);
}
const isLive = arg('--mode') === 'live';
const targetNet = arg('--network') || 'testnet';
const privateKey = process.env.KEEPER_PRIVATE_KEY;
const CYCLE_MS = 3000;

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
console.log(`[KEEPER] RPC ${config.rpcUrl} | AMM ${config.contractAddress}`);

class Keeper {
  constructor() {
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.wallet = privateKey ? new ethers.Wallet(privateKey, this.provider) : null;
    this.amm = new ethers.Contract(config.contractAddress, AMM_ABI, this.wallet || this.provider);
    this.startedAt = Date.now();
    this.notices = new Set();
    this.busy = false;
    this.stats = { locked: 0, settled: 0, refunded: 0, gasSpentWei: 0n, rewardsClaimedWei: 0n, errors: 0 };
  }

  notice(key, message) {
    if (this.notices.has(key)) return;
    this.notices.add(key);
    console.log(message);
  }

  /** Refuses to start unless the contract exists; captures reports for the contract's own signer set */
  async init() {
    if ((await this.provider.getCode(config.contractAddress)) === '0x') {
      throw new Error(`No contract deployed at ${config.contractAddress} on ${config.name}.`);
    }
    const signers = await this.amm.oracleSigners();
    this.threshold = Number(await this.amm.signerThreshold());
    this.emergencyTimeout = Number(await this.amm.emergencyTimeout());
    console.log(`[KEEPER] Oracle: ${signers.length} signers, ${this.threshold} required | wallet ${this.wallet?.address || '(none)'}`);
    this.archive = new ReportArchive({
      feeds: Object.values(SUPPORTED_MARKETS).map((m) => m.feed),
      signers,
      threshold: this.threshold
    });
    this.archive.start();
  }

  async send(label, method, market, rId, reports) {
    const fn = this.amm[method];
    const callArgs = method === 'emergencyRefund' ? [market.marketId, rId] : [market.marketId, rId, reports];
    if (!isLive) {
      await fn.staticCall(...callArgs, { from: this.wallet?.address });
      this.notice(`${market.feed}:${rId}:${label}:dry`, `    [DRY-RUN] ${market.symbol} ${label} #${rId} would succeed. Nothing sent.`);
      return;
    }
    const before = await this.amm.keeperRewards(this.wallet.address);
    const est = await fn.estimateGas(...callArgs);
    const rcpt = await (await fn(...callArgs, { gasLimit: (est * 130n) / 100n })).wait();
    const earned = (await this.amm.keeperRewards(this.wallet.address)) - before;
    this.stats.gasSpentWei += rcpt.fee;
    this.stats[{ LOCK: 'locked', SETTLE: 'settled', REFUND: 'refunded' }[label]]++;
    console.log(`    [${label}] ${market.symbol} #${rId} tx ${rcpt.hash} | gas ${ethers.formatEther(rcpt.fee)} MON | reward +${ethers.formatEther(earned)} MON`);
  }

  async checkMarket(market) {
    const m = await this.amm.markets(market.marketId);
    if (!m.active || m.currentRoundId === 0n) return;
    const rId = m.currentRoundId;
    const round = await this.amm.rounds(market.marketId, rId);
    const status = Number(round.status);
    const now = Math.floor(Date.now() / 1000);
    const key = `${market.feed}:${rId}`;

    // Nobody bet: nothing to lock, settle or refund. The next bet replaces the round on-chain (SEC-24),
    // so idle markets cost the keeper nothing.
    if (round.totalPool === 0n) return;

    // A round nobody could resolve: refund it so the market moves on (anyone may call this)
    if ((status === 1 || status === 2) && now > Number(round.closeTimestamp) + this.emergencyTimeout) {
      return this.send('REFUND', 'emergencyRefund', market, rId);
    }

    let method;
    let reportTs;
    if (status === 1 && now >= Number(round.lockTimestamp)) {
      if (round.totalUp === 0n || round.totalDown === 0n) {
        return this.send('LOCK', 'lockRoundWithUpdate', market, rId, []); // uncontested: cancel, no price
      }
      method = 'lockRoundWithUpdate';
      reportTs = Number(await this.amm.lockReportTimestamp(market.marketId, rId));
    } else if (status === 2 && now >= Number(round.closeTimestamp)) {
      method = 'settleRoundWithUpdate';
      reportTs = Number(await this.amm.closeReportTimestamp(market.marketId, rId));
    } else {
      return;
    }

    const reports = this.archive.reportsAt(market.feed, reportTs);
    if (!reports) {
      if (reportTs * 1000 < this.startedAt - 10000) {
        this.notice(`${key}:missed`, `    [MISSED] ${market.symbol} #${rId}: its ${reportTs} report was published before this keeper started. It refunds after the ${this.emergencyTimeout / 60} min timeout.`);
      } else {
        this.notice(`${key}:${method}`, `    [WAIT] ${market.symbol} #${rId}: waiting for all ${this.threshold} signed reports at ${reportTs}.`);
      }
      return;
    }
    await this.send(method === 'lockRoundWithUpdate' ? 'LOCK' : 'SETTLE', method, market, rId, reports);
  }

  async cycle() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const market of Object.values(SUPPORTED_MARKETS)) {
        try {
          await this.checkMarket(market);
        } catch (err) {
          this.stats.errors++;
          console.error(`    [ERROR] ${market.symbol}: ${err.shortMessage || err.message}`);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  async claimRewards() {
    if (!isLive) return;
    try {
      const accrued = await this.amm.keeperRewards(this.wallet.address);
      if (accrued === 0n) return;
      const rcpt = await (await this.amm.claimKeeperRewards()).wait();
      this.stats.rewardsClaimedWei += accrued;
      this.stats.gasSpentWei += rcpt.fee;
      console.log(`[KEEPER] Claimed ${ethers.formatEther(accrued)} MON in rewards. Tx ${rcpt.hash}`);
    } catch (err) {
      this.stats.errors++;
      console.error(`[KEEPER] Reward claim failed: ${err.shortMessage || err.message}`);
    }
  }

  report() {
    const s = this.stats;
    const net = isLive ? ` | net ${ethers.formatEther(s.rewardsClaimedWei - s.gasSpentWei)} MON` : '';
    console.log(`[KEEPER] locked ${s.locked}, settled ${s.settled}, refunded ${s.refunded}, errors ${s.errors}${net}`);
  }

  async start() {
    await this.init();
    setInterval(() => this.cycle(), CYCLE_MS);
    setInterval(() => this.claimRewards(), 10 * 60e3);
    setInterval(() => this.report(), 5 * 60e3);
  }
}

new Keeper().start().catch((err) => {
  console.error(`[KEEPER] ${err.shortMessage || err.message}`);
  process.exit(1);
});
