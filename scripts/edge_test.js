/**
 * scripts/edge_test.js
 * Two edge cases on the deployed contract (Monad testnet), with real wallets and real RedStone reports.
 * Run with NO keeper running (npm run dev:testnet stopped): case A needs nobody to settle.
 *
 *  A. Nobody resolves a contested round (SOL). After its expiry (close + emergencyTimeout, 10 min) each
 *     bettor claims its stake back directly; settling it afterwards with the real close report must
 *     revert (SEC-29); emergencyRefund then restarts the market.
 *  B. The owner uses its powers mid-round (BTC): fees to 10%, pause, market deactivated. Betting is
 *     blocked, but the round still locks and settles (this script submits the real reports, as anyone
 *     can) at the fee it opened with, and the winner is paid in full while paused. Everything is then
 *     restored.
 *
 * Usage: npm run test:edge   (owner key in DEPLOYER_PRIVATE_KEY or KEEPER_PRIVATE_KEY; ~13 minutes)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
import { getConfig, SUPPORTED_MARKETS } from '../src/config.js';
import { AMM_ABI } from '../src/contracts/AMMAbi.js';
import { MonadRpcProvider } from '../src/rpc.js';
import { fetchReportsAt } from '../src/oracle.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = getConfig();
const provider = new MonadRpcProvider(cfg.rpcUrl, cfg.chainId);
const owner = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY || process.env.KEEPER_PRIVATE_KEY, provider);
const amm = new ethers.Contract(cfg.contractAddress, AMM_ABI, provider);
const keys = JSON.parse(fs.readFileSync(path.join(root, 'data', 'test-wallets.json'), 'utf8'));
const [a1, a2, b1, b2] = keys.slice(0, 4).map((k) => new ethers.Wallet(k, provider));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...x) => console.log(new Date().toISOString().slice(11, 19), ...x);
let passed = 0;
let failed = 0;
const check = (ok, msg) => { ok ? passed++ : failed++; console.log(`${ok ? '[PASS]' : '\x1b[31m[FAIL]\x1b[0m'} ${msg}`); };
const eventOf = (rc, name) => rc.logs.map((l) => { try { return amm.interface.parseLog(l); } catch (_) { return null; } }).find((e) => e?.name === name);
const balance = async (addr) => BigInt(await provider.send('eth_getBalance', [addr, 'latest']));
const waitUntil = async (sec) => { while (Date.now() / 1000 < sec) await sleep(1000); };
const reverts = (p) => p.then(() => null, (e) => e.reason || e.shortMessage || 'reverted');

let signers;
let threshold;
async function reportsAt(feed, ts) {
  for (let i = 0; i < 20; i++) {
    const sets = await fetchReportsAt([feed], ts * 1000, { signers, fresh: i || null });
    if (sets[feed].length >= threshold) return sets[feed].map((p) => p.report);
    await sleep(1500);
  }
  throw new Error(`no complete ${feed} report at ${ts}`);
}

async function openRound(market) {
  for (;;) {
    const m = await amm.markets(market.marketId);
    const r = await amm.rounds(market.marketId, m.currentRoundId);
    const now = Date.now() / 1000;
    const oneSided = r.totalUp === 0n || r.totalDown === 0n;
    if (Number(r.status) === 1 && now < Number(r.betCloseTimestamp) - 20) return m.currentRoundId;
    if (Number(r.status) === 1 && oneSided && now > Number(r.betCloseTimestamp)) return m.currentRoundId;
    if ([3, 4].includes(Number(r.status))) {
      try { await (await amm.connect(owner).startRound(market.marketId)).wait(); } catch (_) { /* someone else did */ }
    }
    await sleep(3000);
  }
}

async function contested(market, up, down, stake) {
  let rId = await openRound(market);
  rId = eventOf(await (await amm.connect(up).betUp(market.marketId, rId, { value: stake })).wait(), 'BetPlaced').args.roundId;
  await (await amm.connect(down).betDown(market.marketId, rId, { value: stake })).wait();
  return rId;
}

// ---------------------------------------------------------------------------------------------
async function caseA() {
  const market = SUPPORTED_MARKETS.SOL;
  const stake = await amm.minBet();
  const rId = await contested(market, a1, a2, stake);
  const r = await amm.rounds(market.marketId, rId);
  log(`A: SOL round ${rId} contested; nobody will lock or settle it. Expiry at ${r.expiryTimestamp} (~${Math.round((Number(r.expiryTimestamp) - Date.now() / 1000) / 60)} min)`);
  check(await reverts(amm.connect(a1).claimPayout.staticCall(market.marketId, rId)) !== null, 'A: before expiry, no refund (the round can still be resolved)');
  await waitUntil(Number(r.expiryTimestamp) + 3);
  const closeReports = await reportsAt(market.feed, Number(r.closeTimestamp));
  for (const [name, w] of [['1', a1], ['2', a2]]) {
    const before = await balance(w.address);
    const rc = await (await amm.connect(w).claimPayout(market.marketId, rId)).wait();
    const got = (await balance(w.address)) - before + rc.fee;
    check(got === stake, `A: after expiry, wallet ${name} took its ${ethers.formatEther(stake)} MON back itself (no keeper, no one else's transaction)`);
  }
  const lockTry = await reverts(amm.connect(owner).lockRoundWithUpdate.staticCall(market.marketId, rId, await reportsAt(market.feed, Number(r.lockTimestamp))));
  check(/expired/i.test(lockTry || ''), `A: locking it now with the real report is refused (${lockTry})`);
  const rr = await amm.rounds(market.marketId, rId);
  check(Number(rr.status) === 1, 'A: round still unresolved on-chain, so it can never settle after the refunds (SEC-29)');
  void closeReports;
  await (await amm.connect(owner).emergencyRefund(market.marketId, rId)).wait();
  check(Number((await amm.rounds(market.marketId, rId)).status) === 4 && (await amm.markets(market.marketId)).currentRoundId === rId + 1n,
    'A: emergencyRefund closes it and the market continues with a new round');
}

// ---------------------------------------------------------------------------------------------
async function caseB() {
  const market = SUPPORTED_MARKETS.BTC;
  const stake = await amm.minBet();
  const fees = await Promise.all([amm.creatorFeeBps(), amm.keeperFeeBps(), amm.treasuryFeeBps()]);
  const rId = await contested(market, b1, b2, stake);
  const r = await amm.rounds(market.marketId, rId);
  log(`B: BTC round ${rId} contested at ${r.feeBps / 100n}.${String(r.feeBps % 100n).padStart(2, '0')}% fee; owner now raises fees to 10%, pauses, deactivates the market`);
  try {
    await (await amm.connect(owner).setProtocolFees(300, 300, 400)).wait();
    await (await amm.connect(owner).setPaused(true)).wait();
    await (await amm.connect(owner).setMarketActive(market.marketId, false)).wait();
    const betTry = await reverts(amm.connect(b1).betUp.staticCall(market.marketId, rId, { value: stake }));
    check(/paused/i.test(betTry || ''), `B: new bets are blocked (${betTry})`);

    // Lock and settle with the real reports unless someone (e.g. a keeper) already did: anyone may
    await waitUntil(Number(r.lockTimestamp) + 2);
    if (Number((await amm.rounds(market.marketId, rId)).status) === 1) {
      await (await amm.connect(owner).lockRoundWithUpdate(market.marketId, rId, await reportsAt(market.feed, Number(r.lockTimestamp)))).wait();
    }
    await waitUntil(Number(r.closeTimestamp) + 2);
    if (Number((await amm.rounds(market.marketId, rId)).status) === 2) {
      await (await amm.connect(owner).settleRoundWithUpdate(market.marketId, rId, await reportsAt(market.feed, Number(r.closeTimestamp)))).wait();
    }
    const done = await amm.rounds(market.marketId, rId);
    check(Number(done.status) === 3 || Number(done.status) === 4, `B: the round locked and settled while paused (${Number(done.status) === 3 ? `${Number(done.winningSide) === 1 ? 'Rise' : 'Fall'} won` : 'tie'})`);
    if (Number(done.status) === 3) {
      const fee = (done.totalPool * 150n) / 10000n;
      check(done.feeBps === 150n && done.netPayoutPool === done.totalPool - fee, `B: fee taken is the round's own 1.5% (${ethers.formatEther(fee)} MON), not the new 10%`);
      const winner = Number(done.winningSide) === 1 ? b1 : b2;
      const before = await balance(winner.address);
      const rc = await (await amm.connect(winner).claimPayout(market.marketId, rId)).wait();
      const got = (await balance(winner.address)) - before + rc.fee;
      check(got === done.netPayoutPool, `B: winner paid in full while paused: ${ethers.formatEther(got)} MON`);
    }
    check((await amm.markets(market.marketId)).currentRoundId === rId, 'B: no new round starts on the deactivated market');
  } finally {
    await (await amm.connect(owner).setProtocolFees(...fees)).wait();
    await (await amm.connect(owner).setPaused(false)).wait();
    await (await amm.connect(owner).setMarketActive(market.marketId, true)).wait();
    // Restart the round chain if the round finished while the market was off (reverts, harmlessly, if not)
    try { await (await amm.connect(owner).startRound(market.marketId)).wait(); } catch (_) { /* round still running */ }
    log(`B: restored fees ${fees.join('/')} bps, unpaused, market active again`);
  }
  check(!(await amm.paused()) && (await amm.protocolTotalFeeBps()) === 150n && (await amm.markets(market.marketId)).active, 'B: contract back to normal');
}

if ((await amm.owner()).toLowerCase() !== owner.address.toLowerCase()) throw new Error('Needs the owner key');
// Case A needs rounds nobody settles: refuse to run next to a keeper (e.g. npm run dev:testnet)
try {
  const { execSync } = await import('child_process');
  if (execSync('ps aux').toString().split('\n').some((l) => l.includes('keeper_bot.js') && !l.includes('grep'))) {
    console.error('A keeper is running on this machine (npm run dev:testnet?). Stop it for this test: case A needs a round nobody settles.');
    process.exit(1);
  }
} catch (_) { /* ps unavailable: rely on the operator */ }
[signers, threshold] = await Promise.all([amm.oracleSigners(), amm.signerThreshold().then(Number)]);
const minBet = await amm.minBet();
for (const w of [a1, a2, b1, b2]) {
  if ((await provider.getBalance(w.address)) < minBet * 2n) await (await owner.sendTransaction({ to: w.address, value: minBet * 3n })).wait();
}
await Promise.all([caseA(), caseB()]);
console.log(`\nEDGE TEST VERDICT: ${passed}/${passed + failed} checks passed`);
if (failed) process.exitCode = 1;
