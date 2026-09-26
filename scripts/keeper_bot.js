/**
 * keeper_bot.js
 * Production-Ready Standalone Autonomous Keeper Bot for MonadPulse AMM
 * 
 * Zero-Hardcoding Architecture:
 * 2. Gas limits dynamically estimated on-chain via contract estimateGas().
 * 3. Protocol fees and keeper bounties queried directly from on-chain contract state.
 * 4. Pyth update fees queried directly from on-chain Pyth contract via getUpdateFee().
 * 5. Pull-oracle integration with Pyth Hermes v2: fetches the signed update for the round's exact
 *    lock/close timestamp (SEC-01/02). The contract only accepts the first price at/after that time.
 * 6. Supports both Monad Mainnet and Monad Testnet without hardcoding.
 * 
 * Usage:
 * node scripts/keeper_bot.js --mode dry-run
 * KEEPER_PRIVATE_KEY=<HEX_KEY> PYTH_API_KEY=<KEY> node scripts/keeper_bot.js --mode live --network testnet
 * (SEC-10: keys are read from the environment only, never from argv / shell history)
 */

import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ENVIRONMENTS, SUPPORTED_MARKETS } from '../src/config.js';
import { AMM_ABI } from '../src/contracts/AMMAbi.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('================================================================================');
console.log('MONADPULSE: AUTONOMOUS KEEPER & SETTLEMENT ENGINE');
console.log('================================================================================\n');

// Parse CLI options
const args = process.argv.slice(2);
const isLive = args.includes('--mode') && args[args.indexOf('--mode') + 1] === 'live';
const targetNet = args.includes('--network') ? args[args.indexOf('--network') + 1] : 'testnet';
if (args.includes('--private-key')) {
  console.error('[SECURITY] --private-key is not supported (leaks via shell history / ps). Set KEEPER_PRIVATE_KEY instead.');
  process.exit(1);
}
const privateKey = process.env.KEEPER_PRIVATE_KEY;
// Hermes requires an API key since the Pyth Core upgrade (2026-08-26)
const pythApiKey = process.env.PYTH_API_KEY;
if (isLive && !pythApiKey) {
  console.error('[CONFIG] PYTH_API_KEY is required in live mode (Hermes returns 401 without it). Get one at Pyth Terminal.');
  process.exit(1);
}
const isContinuous = args.includes('--continuous');
const intervalSec = 5;

const config = ENVIRONMENTS[targetNet];
if (!config) {
  console.error(`[CONFIG] Unknown --network "${targetNet}". Use one of: ${Object.keys(ENVIRONMENTS).join(', ')}.`);
  process.exit(1);
}
for (const [name, value] of [['contract address', config.contractAddress], ['Pyth contract address', config.pythContractAddress], ['RPC URL', config.rpcUrl]]) {
  if (!value) {
    console.error(`[CONFIG] ${config.name}: ${name} is not configured. See .env.example.`);
    process.exit(1);
  }
}
if (isLive && !privateKey) {
  console.error('[CONFIG] KEEPER_PRIVATE_KEY is required in live mode.');
  process.exit(1);
}

console.log(`[CONFIG] Operational Mode: ${isLive ? 'LIVE ON-CHAIN BROADCAST' : 'DRY-RUN (reads chain, sends nothing)'}`);
console.log(`[CONFIG] Target Network: ${config.name} (Chain ID: ${config.chainId})`);
console.log(`[CONFIG] Monad RPC: ${config.rpcUrl}`);
console.log(`[CONFIG] Pyth Contract: ${config.pythContractAddress}`);
console.log(`[CONFIG] MonadPulse AMM Address: ${config.contractAddress}`);

// Minimal Pyth ABI for update fees
const PYTH_MINIMAL_ABI = [
  'function getUpdateFee(bytes[] calldata updateData) external view returns (uint256 feeAmount)'
];

export class AutonomousKeeper {
  constructor() {
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.wallet = null;
    if (privateKey) {
      this.wallet = new ethers.Wallet(privateKey, this.provider);
      console.log(`[KEEPER] Authenticated Signer: ${this.wallet.address}`);
    }

    const signerOrProvider = this.wallet || this.provider;
    this.ammContract = new ethers.Contract(config.contractAddress, AMM_ABI, signerOrProvider);
    this.pythContract = new ethers.Contract(config.pythContractAddress, PYTH_MINIMAL_ABI, signerOrProvider);

    this.hermesBaseUrl = `${config.pythHermesUrl}/v2/updates/price`;
    this.priceWindowSeconds = null;
    // Counters only ever reflect confirmed transactions (live) or detected due actions (dry-run)
    this.stats = { locked: 0, settled: 0, gasSpentWei: 0n, rewardsClaimedWei: 0n, due: 0, errors: 0 };
  }

  /** Reads the parameters the keeper depends on. Refuses to start if the contract cannot be read. */
  async initOnChainParams() {
    const code = await this.provider.getCode(config.contractAddress);
    if (code === '0x') throw new Error(`No contract deployed at ${config.contractAddress} on ${config.name}.`);
    this.priceWindowSeconds = BigInt(await this.ammContract.priceWindowSeconds());
    const keeperFee = await this.ammContract.keeperFeeBps();
    console.log(`[ON-CHAIN CONFIG] Keeper Fee: ${(Number(keeperFee) / 100).toFixed(2)}% | Price Window: ${this.priceWindowSeconds}s`);
  }

  /**
   * Fetch the signed Pyth update for the first price published at/after `targetTs` from Hermes.
   * Returns [] only when that pinned update does not exist yet; any other failure throws.
   * The contract verifies the pin (publishTime >= target > prevPublishTime), so a wrong update
   * simply reverts; we pre-check to avoid wasting gas.
   */
  async fetchPythPriceUpdate(feedId, targetTs) {
    const cleanFeedId = feedId.startsWith('0x') ? feedId.slice(2) : feedId;
    const url = `${this.hermesBaseUrl}/${targetTs}?ids[]=${cleanFeedId}&encoding=hex&parsed=true`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: pythApiKey ? { Authorization: `Bearer ${pythApiKey}` } : {}
    });
    if (response.status === 404) return [];
    if (!response.ok) throw new Error(`Hermes ${response.status} ${response.statusText}`);
    const data = await response.json();
    const parsed = data?.parsed?.[0];
    if (!parsed || !data?.binary?.data?.length) throw new Error('Hermes returned no price update');
    const publishTime = Number(parsed.price?.publish_time);
    const prevPublishTime = Number(parsed.metadata?.prev_publish_time);
    const maxTs = Number(targetTs) + Number(this.priceWindowSeconds);
    if (!(publishTime >= targetTs && publishTime <= maxTs) || (prevPublishTime && prevPublishTime >= targetTs)) {
      console.warn(`    [HERMES] Update for ${targetTs} is not the pinned first price (publish=${publishTime}, prev=${prevPublishTime}); skipping.`);
      return [];
    }
    return data.binary.data.map(d => (d.startsWith('0x') ? d : `0x${d}`));
  }

  /** Sends a keeper transaction and records what it actually cost and earned */
  async broadcast(label, method, market, rId, vaa) {
    const pythFee = vaa.length ? await this.pythContract.getUpdateFee(vaa) : 0n;
    if (!isLive) {
      // Dry-run: simulate against current chain state; a revert here means the real call would fail too
      await this.ammContract[method].staticCall(market.marketId, rId, vaa, { value: pythFee, from: this.wallet?.address });
      console.log(`    [DRY-RUN] ${label} #${rId} would succeed (Pyth fee ${pythFee} wei). Nothing sent.`);
      this.stats.due++;
      return;
    }
    const before = await this.ammContract.keeperRewards(this.wallet.address);
    const est = await this.ammContract[method].estimateGas(market.marketId, rId, vaa, { value: pythFee });
    const tx = await this.ammContract[method](market.marketId, rId, vaa, { value: pythFee, gasLimit: (est * 130n) / 100n });
    const rcpt = await tx.wait();
    const earned = (await this.ammContract.keeperRewards(this.wallet.address)) - before;
    this.stats.gasSpentWei += rcpt.fee;
    if (method === 'lockRoundWithUpdate') this.stats.locked++;
    else this.stats.settled++;
    console.log(`    [${label} CONFIRMED] Tx: ${rcpt.hash} | Gas: -${ethers.formatEther(rcpt.fee)} MON | Reward accrued: +${ethers.formatEther(earned)} MON`);
  }

  /**
   * Evaluates market state and triggers keeper actions
   */
  async evaluateMarket(marketKey, market) {
    console.log(`\n--> Checking Market: [${market.symbol}] (Pyth ID: ${market.pythId.slice(0, 14)}...)`);
    const now = Math.floor(Date.now() / 1000);

    const mData = await this.ammContract.markets(market.marketId);
    if (!mData.active) {
      console.log('    [SKIP] Market is not active on-chain.');
      return;
    }
    if (mData.currentRoundId === 0n) {
      console.log('    [SKIP] Market has no rounds yet.');
      return;
    }
    const round = await this.ammContract.rounds(market.marketId, mData.currentRoundId);

    const rId = round.roundId;
    const status = Number(round.status);
    const lockTs = Number(round.lockTimestamp);
    const closeTs = Number(round.closeTimestamp);

    console.log(`    [ON-CHAIN] Round #${rId}: Status=${status} (1:Open, 2:Locked, 3:Settled, 4:Cancelled)`);
    console.log(`    [TIMESTAMPS] Now: ${now} | Lock: ${lockTs} (${lockTs - now}s) | Close: ${closeTs} (${closeTs - now}s)`);

    // Round needs locking. SEC-04: no lateness cutoff; the lock price is pinned to lockTimestamp.
    if (status === 1 && now >= lockTs) {
      const uncontested = round.totalUp === 0n || round.totalDown === 0n;
      console.log(`    [ACTION] Round #${rId} ready for LOCK${uncontested ? ' (uncontested: cancel & roll, no price needed)' : ''}.`);
      const vaa = uncontested ? [] : await this.fetchPythPriceUpdate(market.pythId, lockTs);
      if (!uncontested && vaa.length === 0) {
        console.log('    [WAIT] Pinned Pyth update for lockTimestamp not available yet.');
        return;
      }
      await this.broadcast('LOCK', 'lockRoundWithUpdate', market, rId, vaa);
    }

    // Round needs settlement. SEC-04: no lateness cutoff; the close price is pinned to closeTimestamp.
    if (status === 2 && now >= closeTs) {
      console.log(`    [ACTION] Round #${rId} ready for SETTLEMENT. Total Pool: ${ethers.formatEther(round.totalPool)} MON`);
      const vaa = await this.fetchPythPriceUpdate(market.pythId, closeTs);
      if (vaa.length === 0) {
        console.log('    [WAIT] Pinned Pyth update for closeTimestamp not available yet.');
        return;
      }
      await this.broadcast('SETTLE', 'settleRoundWithUpdate', market, rId, vaa);
    }
  }

  /**
   * Run keeper cycle across all supported markets. A failure in one market is reported and does
   * not stop the others.
   */
  async runCycle() {
    console.log('[KEEPER CYCLE START] Polling markets at: ' + new Date().toISOString());
    for (const [key, m] of Object.entries(SUPPORTED_MARKETS)) {
      try {
        await this.evaluateMarket(key, m);
      } catch (err) {
        this.stats.errors++;
        console.error(`    [ERROR] ${m.symbol}: ${err.shortMessage || err.message}`);
      }
    }

    // SEC-03: bounties are credited on-chain and must be pulled
    if (isLive) {
      try {
        const accrued = await this.ammContract.keeperRewards(this.wallet.address);
        if (accrued > 0n) {
          const rcpt = await (await this.ammContract.claimKeeperRewards()).wait();
          this.stats.rewardsClaimedWei += accrued;
          this.stats.gasSpentWei += rcpt.fee;
          console.log(`[KEEPER] Claimed ${ethers.formatEther(accrued)} MON in bounties. Tx: ${rcpt.hash}`);
        }
      } catch (err) {
        this.stats.errors++;
        console.error(`[KEEPER] Bounty claim failed: ${err.shortMessage || err.message}`);
      }
    }

    const s = this.stats;
    console.log('\n================================================================================');
    if (isLive) {
      console.log(`Rounds locked: ${s.locked} | Rounds settled: ${s.settled} | Errors: ${s.errors}`);
      console.log(`Gas spent: ${ethers.formatEther(s.gasSpentWei)} MON | Rewards claimed: ${ethers.formatEther(s.rewardsClaimedWei)} MON`);
      console.log(`Net: ${ethers.formatEther(s.rewardsClaimedWei - s.gasSpentWei)} MON`);
    } else {
      console.log(`Dry-run: ${s.due} keeper action(s) due and simulated successfully | Errors: ${s.errors}`);
    }
    console.log('================================================================================\n');
  }

  async start() {
    await this.initOnChainParams();
    await this.runCycle();

    if (isContinuous) {
      console.log(`[DAEMON] Continuous polling mode enabled (Interval: ${intervalSec}s)`);
      setInterval(async () => {
        try {
          await this.runCycle();
        } catch (cycleErr) {
          console.error('[KEEPER LOOP ERROR]', cycleErr);
        }
      }, intervalSec * 1000);
    }
  }
}

async function main() {
  const keeper = new AutonomousKeeper();
  await keeper.start();
}

main().catch((err) => {
  console.error(`[KEEPER] ${err.shortMessage || err.message}`);
  process.exit(1);
});
