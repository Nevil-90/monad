/**
 * scripts/dev_chain.js
 * Local development chain with realistic contract activity for the UI and the transparency
 * dashboard. Starts Ganache on :8545, deploys MonadUpDownAMM with 5 local oracle signing keys,
 * creates the markets from src/config.js (same market IDs), then keeps simulating rounds: many
 * wallets bet, rounds lock and settle with reports signed by those local keys, winners claim,
 * refunds happen, and fees are paid out to the creator, keepers and treasury.
 *
 * Usage:
 *   npm run compile && npm run dev:chain
 *   then, in another terminal, start the app with the printed NEXT_PUBLIC_* variables.
 *
 * Chain time is fast-forwarded to run rounds quickly, so block times run ahead of the wall clock.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ganache from 'ganache';
import { ethers } from 'ethers';
import { SUPPORTED_MARKETS } from '../src/config.js';
import { signReport, feedIdBytes32 } from '../src/oracle.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.DEV_CHAIN_PORT || 8545);
const WALLETS = 30;
const INITIAL_ROUNDS = Number(process.env.DEV_CHAIN_ROUNDS || 5);
const LIVE_INTERVAL_MS = 7000;

const load = (name) => ({
  abi: JSON.parse(fs.readFileSync(path.join(root, 'build', `${name}.abi`), 'utf8')),
  bin: fs.readFileSync(path.join(root, 'build', `${name}.bin`), 'utf8').trim()
});

// Local oracle network (dev only): 5 keys, all required, like production
const oracleKeys = [1, 2, 3, 4, 5].map((i) => new ethers.SigningKey(ethers.id(`dev-oracle-signer-${i}`)));
// Every local signer's report for the round's pinned report timestamp
const reportsFor = (feed, price, tsSec) => oracleKeys.map((k) => signReport(k, feed, price, BigInt(tsSec) * 1000n));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const rand = (a, b) => a + Math.random() * (b - a);

const server = ganache.server({
  logging: { quiet: true },
  chain: { chainId: 10143 },
  wallet: { totalAccounts: WALLETS + 4, defaultBalance: 100000 }
});
await new Promise((resolve, reject) => server.listen(PORT, (err) => (err ? reject(err) : resolve())));

const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${PORT}`, undefined, { batchMaxCount: 1 });
const signers = await Promise.all(Array.from({ length: WALLETS + 4 }, (_, i) => provider.getSigner(i)));
const [owner, creator, keeperA, keeperB, ...players] = signers;

const A = load('MonadUpDownAMM_sol_MonadUpDownAMM');
const oracleAddrs = oracleKeys.map((k) => ethers.computeAddress(k.publicKey));
const amm = await (await new ethers.ContractFactory(A.abi, A.bin, owner).deploy(oracleAddrs, oracleAddrs.length)).waitForDeployment();
const deployBlock = await provider.getBlockNumber();
const ammAddr = await amm.getAddress();

const markets = [];
for (const m of Object.values(SUPPORTED_MARKETS)) {
  await (await amm.connect(creator).createMarket(feedIdBytes32(m.feed), m.name, m.symbol, m.roundDuration)).wait();
  await (await amm.connect(owner).setMarketVerified(m.marketId, true)).wait();
  const base = { BTC: 84000, ETH: 2600, SOL: 150, MON: 0.026 }[m.symbol.split('/')[0]] || 100;
  markets.push({ ...m, price: base });
}

const now = async () => Number((await provider.getBlock('latest')).timestamp);
const warpTo = async (ts) => {
  const n = await now();
  if (ts > n) await provider.send('evm_increaseTime', [ts - n]);
  await provider.send('evm_mine', []);
};
const toInt = (price) => BigInt(Math.round(price * 1e8));

async function playRound(m) {
  // Other markets' rounds age while time is fast-forwarded; an expired empty round is locked,
  // which cancels it as one-sided and starts a fresh round at the current time
  let rId = (await amm.markets(m.marketId)).currentRoundId;
  let round = await amm.rounds(m.marketId, rId);
  if (Number(round.status) === 1 && (await now()) > Number(round.betCloseTimestamp)) {
    await warpTo(Number(round.lockTimestamp));
    await (await amm.connect(keeperA).lockRoundWithUpdate(m.marketId, rId, [])).wait();
    rId = (await amm.markets(m.marketId)).currentRoundId;
    round = await amm.rounds(m.marketId, rId);
  }
  const bettors = [...players].sort(() => Math.random() - 0.5).slice(0, Math.floor(rand(3, 12)));
  const oneSided = Math.random() < 0.08;
  const sides = new Map();
  for (const w of bettors) {
    const up = oneSided ? true : Math.random() < 0.55;
    const amount = ethers.parseEther(rand(0.5, 60).toFixed(2));
    sides.set(await w.getAddress(), up);
    await (await amm.connect(w)[up ? 'betUp' : 'betDown'](m.marketId, rId, { value: amount })).wait();
  }

  const lockTs = Number(await amm.lockReportTimestamp(m.marketId, rId));
  await warpTo(lockTs + 1);
  const lockPrice = m.price;
  await (await amm.connect(pick([keeperA, keeperB])).lockRoundWithUpdate(
    m.marketId, rId, reportsFor(m.feed, toInt(lockPrice), lockTs))).wait();

  const after = await amm.rounds(m.marketId, rId);
  if (Number(after.status) === 2) {
    // Random walk to the close; a small chance of an exact tie
    m.price = Math.random() < 0.05 ? lockPrice : lockPrice * (1 + rand(-0.004, 0.004));
    const closeTs = Number(await amm.closeReportTimestamp(m.marketId, rId));
    await warpTo(closeTs + 1);
    await (await amm.connect(pick([keeperA, keeperB])).settleRoundWithUpdate(
      m.marketId, rId, reportsFor(m.feed, toInt(m.price), closeTs))).wait();
  }

  // Claims: most winners claim right away, every refund is claimed
  const final = await amm.rounds(m.marketId, rId);
  for (const w of bettors) {
    const addr = await w.getAddress();
    const won = Number(final.status) === 3 && (Number(final.winningSide) === 1) === sides.get(addr);
    const refund = Number(final.status) === 4;
    if ((won && Math.random() < 0.85) || refund) {
      await (await amm.connect(w).claimPayout(m.marketId, rId)).wait();
    }
  }
  return Number(final.status) === 3 ? (Number(final.winningSide) === 1 ? 'Rise' : 'Fall') : 'refund';
}

async function payFees() {
  for (const k of [keeperA, keeperB]) {
    if ((await amm.keeperRewards(await k.getAddress())) > 0n && Math.random() < 0.5) await (await amm.connect(k).claimKeeperRewards()).wait();
  }
  const m = pick(markets);
  const mk = await amm.markets(m.marketId);
  if (mk.creatorFeesAccrued > 0n && Math.random() < 0.3) await (await amm.connect(creator).claimCreatorFees(m.marketId)).wait();
  if ((await amm.treasuryFees(m.marketId)) > 0n && Math.random() < 0.15) await (await amm.connect(owner).withdrawTreasury(m.marketId, await owner.getAddress())).wait();
}

console.log(`Dev chain on http://127.0.0.1:${PORT} · AMM ${ammAddr}`);
console.log(`Simulating ${INITIAL_ROUNDS} rounds per market…`);
for (let i = 0; i < INITIAL_ROUNDS; i++) {
  for (const m of markets) await playRound(m);
  await payFees();
}

console.log('\nStart the UI against this chain with:\n');
console.log(`  NEXT_PUBLIC_RPC_URL=http://127.0.0.1:${PORT} NEXT_PUBLIC_CONTRACT_ADDRESS=${ammAddr} NEXT_PUBLIC_CONTRACT_DEPLOY_BLOCK=${deployBlock} NEXT_PUBLIC_LOG_CHUNK_BLOCKS=1000 npm run dev\n`);
console.log('Live activity continues every few seconds. Ctrl+C to stop.');

let busy = false;
setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    const m = pick(markets);
    const result = await playRound(m);
    await payFees();
    console.log(`  ${new Date().toLocaleTimeString()} · ${m.symbol} round settled: ${result}`);
  } catch (err) {
    console.error('  simulation step failed:', err.shortMessage || err.message);
  }
  busy = false;
}, LIVE_INTERVAL_MS);
