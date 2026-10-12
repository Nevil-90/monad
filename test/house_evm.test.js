/**
 * test/house_evm.test.js
 * MonadPulseHouse on an in-memory Ganache EVM with the real compiled bytecode (npm run compile first).
 *
 * Checked after every step: the contract holds exactly vault assets + player balances + jackpot pot,
 * and every pending payout is reserved (lockedPayouts <= vaultAssets).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ganache from 'ganache';
import { ethers } from 'ethers';
import { signReport, feedIdBytes32, parsePackage, medianUnits, REDSTONE_PRIMARY_SIGNERS } from '../src/oracle.js';

const buildDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build');
const UP = 1;
const DOWN = 2;
const S = { Pending: 1n, Won: 2n, Lost: 3n, Push: 4n, Void: 5n };
const mon = (v) => ethers.parseEther(String(v));

let passed = 0;
let total = 0;
function assert(cond, msg) {
  total++;
  if (cond) { passed++; console.log(`[PASS] ${msg}`); } else { console.error(`\x1b[31m[FAIL]\x1b[0m ${msg}`); process.exitCode = 1; }
}
async function reverts(promise, reason, msg) {
  try {
    await promise;
    assert(false, `${msg} (did not revert)`);
  } catch (err) {
    const text = `${err?.shortMessage || ''} ${err?.message || ''} ${err?.info?.error?.message || ''} ${err?.info?.error?.data?.reason || ''}`;
    assert(!reason || text.includes(reason), `${msg}${reason && !text.includes(reason) ? ` (reverted with: ${text.slice(0, 160)})` : ''}`);
  }
}

const eth = ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 10, defaultBalance: 100000 }, chain: { vmErrorsOnRPCResponse: true } });
const provider = new ethers.BrowserProvider(eth);
const [owner, alice, bob, lp2, keeper, carol, dave, erin, frank] = await provider.listAccounts();

const keys = [1, 2, 3, 4, 5].map((i) => new ethers.SigningKey(ethers.id(`oracle-signer-${i}`)));
const signerAddrs = keys.map((k) => ethers.computeAddress(k.publicKey));
const abi = JSON.parse(fs.readFileSync(path.join(buildDir, 'MonadPulseHouse_sol_MonadPulseHouse.abi'), 'utf8'));
const bin = fs.readFileSync(path.join(buildDir, 'MonadPulseHouse_sol_MonadPulseHouse.bin'), 'utf8');
const house = await (await new ethers.ContractFactory(abi, bin, owner).deploy(signerAddrs, 4)).waitForDeployment();
const addr = await house.getAddress();

const BTC = ethers.id('BTC-market');
const ETH = ethers.id('ETH-market');
await (await house.setMarket(BTC, feedIdBytes32('BTC'), true)).wait();
await (await house.setMarket(ETH, feedIdBytes32('ETH'), true)).wait();

// Raw read: ethers caches 'latest' briefly, which returns a stale time right after a warp
const now = async () => parseInt((await eth.request({ method: 'eth_getBlockByNumber', params: ['latest', false] })).timestamp, 16);
async function warpTo(t) {
  // evm_setTime pins the clock (evm_increaseTime drifts with wall-clock time between calls)
  if (t > await now()) await provider.send('evm_setTime', [t * 1000]);
  await provider.send('evm_mine', []);
}
const update = (marketId, feed, ts, units, signers = keys.slice(0, 4)) => ({
  marketId, ts, reports: signers.map((k) => signReport(k, feed, BigInt(units), BigInt(ts) * 1000n))
});
async function balanceOf(a) { return BigInt(await eth.request({ method: 'eth_getBalance', params: [a, 'latest'] })); }
async function invariant(label) {
  const [held, vault, bal, pot, locked, treasury] = await Promise.all([balanceOf(addr), house.vaultAssets(), house.totalBalances(), house.jackpotPot(), house.lockedPayouts(), house.treasury()]);
  assert(held === vault + bal + pot + treasury && locked <= vault, `Solvency after ${label}: held ${ethers.formatEther(held)} = vault ${ethers.formatEther(vault)} + balances ${ethers.formatEther(bal)} + pot ${ethers.formatEther(pot)} + treasury ${ethers.formatEther(treasury)}; reserved ${ethers.formatEther(locked)}`);
}

// Reference implementation of the contract's pricing (quadratic cost market maker), in exact integers
const ONE = 10n ** 18n;
const BPS = 10000n;
function isqrt(n) {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
}
function refShares(B, d, side, stake, marginBps = 300n) {
  const dSide = side === UP ? d : -d;
  const a = ONE / 2n + (dSide * ONE) / (2n * B);
  const cost = (stake * BPS) / (BPS + marginBps);
  const root = isqrt(a * a + (cost * ONE * ONE) / B);
  return (2n * B * (root - a)) / ONE;
}
const netOf = (stake, gross, feeBps = 300n) => gross - ((gross - stake) * feeBps) / BPS;
const windowKey = (market, startTs, duration) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'uint256', 'uint256'], [market, startTs, duration]));
/** Checks a placed bet's gross payout against the reference, from its window's state around it */
async function checkPrice(bet, market, side, stake, label) {
  const w = await house.windows(windowKey(market, bet.startTs, bet.duration));
  const b = await house.bets(bet.id);
  const before = side === UP ? w.net - b.payout : w.net + b.payout;
  const expected = refShares(w.liquidity, before, side, stake);
  assert(b.payout === expected, `${label}: gross payout ${ethers.formatEther(b.payout)} MON matches the cost-function price to the wei`);
  return b.payout;
}
async function place(who, market, side, stake, { duration = 30, fromBalance = 0n, minPayout = 0n } = {}) {
  // A margin-free estimate is occasionally too tight (e.g. the first bet in a fresh window writes an
  // extra slot); every other caller in this codebase adds the same +10% (SEC-25), so match it here too.
  const est = await house.connect(who).placeBet.estimateGas(market, side, duration, fromBalance, minPayout, { value: stake });
  const tx = await house.connect(who).placeBet(market, side, duration, fromBalance, minPayout, { value: stake, gasLimit: est + 100_000n });
  const rc = await tx.wait();
  const ev = rc.logs.map((l) => { try { return house.interface.parseLog(l); } catch (_) { return null; } }).find((e) => e?.name === 'BetPlaced');
  return { id: ev.args.betId, startTs: Number(ev.args.startTs), duration: Number(ev.args.duration), endTs: Number(ev.args.startTs) + Number(ev.args.duration), streakBet: ev.args.streakBet, payout: ev.args.payout };
}
/** Records start and end prices for a bet and settles it */
async function resolve(bet, startUnits, endUnits, market = BTC, feed = 'BTC') {
  await warpTo(bet.endTs + 2);
  await (await house.connect(keeper).recordAndSettle([update(market, feed, bet.startTs, startUnits), update(market, feed, bet.endTs, endUnits)], [bet.id])).wait();
  return house.bets(bet.id);
}

console.log('--- Vault and limits ---');
await reverts(house.connect(alice).placeBet(BTC, UP, 30, 0, 0, { value: mon(1) }), 'Bet exceeds house limit', 'An empty vault accepts no bets');
await (await house.connect(owner).addLiquidity({ value: mon(1000) })).wait();
assert((await house.shares(owner.address)) === mon(1000), 'First LP gets 1 share per MON');
assert((await house.maxStake()) === (mon(20) * 10300n) / 9700n, 'Max stake: at even odds a win may take at most 2% of the free vault');
await reverts(house.connect(alice).placeBet(BTC, UP, 30, 0, 0, { value: mon(30) }), 'Bet exceeds house limit', 'A bet whose win exceeds 2% of the vault reverts');
await reverts(house.connect(alice).placeBet(BTC, UP, 30, 0, 0, { value: mon(0.05) }), 'Bet below minimum', 'Below the minimum bet reverts');
await reverts(house.connect(alice).placeBet(BTC, UP, 45, 0, 0, { value: mon(1) }), 'Duration not offered', 'A duration not offered reverts');
await reverts(house.connect(alice).placeBet(BTC, 0, 30, 0, 0, { value: mon(1) }), 'Invalid side', 'Side None reverts');
await reverts(house.connect(alice).placeBet(BTC, UP, 30, 0, mon(2), { value: mon(1) }), 'Payout below minimum', 'minPayout above the quote reverts (quote protection)');
await invariant('seeding');

console.log('\n--- Future strike, win, loss, push ---');
const t0 = await now();
const b1 = await place(alice, BTC, UP, mon(10));
assert(b1.startTs % 10 === 0 && b1.startTs >= t0 + 5 && b1.startTs <= t0 + 16, `Strike is the next 10 s mark at least 5 s ahead (bet ~${t0}, strike ${b1.startTs})`);
assert(b1.streakBet === true, 'First bet with nothing pending is a streak bet');
const g1 = await checkPrice(b1, BTC, UP, mon(10), 'First bet in a window');
assert(g1 > mon(19.25) && g1 < mon(19.42), `First bet near even odds pays just under 1.942x gross, its own size moving the price a little (${ethers.formatEther(g1)} MON for 10)`);
assert(b1.payout === netOf(mon(10), g1), `The quoted payout is after the 3% win fee: ${ethers.formatEther(b1.payout)} MON (~1.91x)`);
assert((await house.lockedPayouts()) === g1, 'The full gross payout is reserved at placement');
await reverts(house.connect(keeper).recordAndSettle([update(BTC, 'BTC', b1.startTs, 6_000_000_000_000n)], []), 'Future report time', 'A price for a future time cannot be recorded');
await invariant('a pending bet');
let r = await resolve(b1, 6_000_000_000_000n, 6_000_100_000_000n);
assert(r.status === S.Won, 'Price rose: Rise bet won');
assert((await house.balances(alice.address)) === netOf(mon(10), g1), 'Winner credited the quoted payout (after the win fee) to the in-game balance at settlement');
assert((await house.treasury()) === g1 - netOf(mon(10), g1), `3% of the profit went to the treasury (${ethers.formatEther(await house.treasury())} MON)`);
assert((await house.jackpotPot()) === mon(0.1), '1% of the stake went to the jackpot pot');
assert((await house.streak(alice.address)) === 1n, 'Streak 1 after a streak win');
await invariant('a win');
{
  const [h, p] = await Promise.all([house.houseInfo(), house.playerInfo(alice.address)]);
  assert(h.vaultAssets === (await house.vaultAssets()) && h.maxStake === (await house.maxStake()) && h.jackpotPot === (await house.jackpotPot()) && h.marginBps === 300n && h.winFeeBps === 300n && h.treasury === (await house.treasury()),
    'houseInfo() returns the same values as the individual views, in one call');
  assert(p.balance === netOf(mon(10), g1) && p.streak === 1n && p.pendingBets === 0n, 'playerInfo() returns balance, streak and pending bets in one call');
}

const b2 = await place(bob, BTC, UP, mon(5));
r = await resolve(b2, 6_000_000_000_000n, 5_999_000_000_000n);
assert(r.status === S.Lost && (await house.balances(bob.address)) === 0n, 'Price fell: Rise bet lost, nothing credited');
const b3 = await place(bob, BTC, DOWN, mon(5));
r = await resolve(b3, 6_000_000_000_000n, 6_000_000_000_000n);
assert(r.status === S.Push && (await house.balances(bob.address)) === mon(5), 'Exact tie: push, full stake back (no fee)');
await invariant('loss and push');

console.log('\n--- Ride it (bet from balance) and cash out ---');
const aliceBal = await house.balances(alice.address);
const b4 = await place(alice, BTC, DOWN, 0n, { fromBalance: aliceBal });
assert((await house.balances(alice.address)) === 0n && (await house.bets(b4.id)).stake === aliceBal, 'Whole balance re-bet with no MON sent');
const g4 = await checkPrice(b4, BTC, DOWN, aliceBal, 'Bet from balance');
await reverts(house.connect(alice).placeBet(BTC, UP, 30, mon(1), 0), 'Balance too low', 'Cannot bet more balance than held');
r = await resolve(b4, 6_000_000_000_000n, 5_990_000_000_000n);
const won4 = netOf(aliceBal, g4);
assert(r.status === S.Won && (await house.balances(alice.address)) === won4, `Won again: ${ethers.formatEther(aliceBal)} -> ${ethers.formatEther(won4)} MON`);
assert((await house.streak(alice.address)) === 2n, 'Streak 2');
await reverts(house.connect(alice).withdrawBalance(won4 + mon(0.01)), 'Nothing to withdraw', 'Asking to cash out more than the balance holds reverts, does not pay out what is there instead');
const aliceBefore = await balanceOf(alice.address);
const wtx = await (await house.connect(alice).withdrawBalance(0)).wait();
const gas = wtx.gasUsed * wtx.gasPrice;
assert((await balanceOf(alice.address)) === aliceBefore + won4 - gas, 'Cash out sends the whole balance to the wallet');
await reverts(house.connect(alice).withdrawBalance(0), 'Nothing to withdraw', 'Nothing left to cash out');
await invariant('ride and cash out');

console.log('\n--- Settlement edge cases ---');
// Settlement is permissionless: a wallet with no stake in the bet at all ("Settle it yourself" in the
// app, for when the keeper is slow) can record the prices and settle it just as well as the keeper.
const bSelf = await place(bob, BTC, UP, mon(1));
await warpTo(bSelf.endTs + 2);
await (await house.connect(frank).recordAndSettle([update(BTC, 'BTC', bSelf.startTs, 4_000_000_000_000n), update(BTC, 'BTC', bSelf.endTs, 4_001_000_000_000n)], [bSelf.id])).wait();
assert((await house.bets(bSelf.id)).status === S.Won, "A bystander wallet (neither the bettor, the owner nor the keeper) can fully settle someone else's bet");

const b5 = await place(carol, ETH, UP, mon(2));
await warpTo(b5.endTs + 2);
await (await house.connect(keeper).recordAndSettle([update(ETH, 'ETH', b5.startTs, 300_000_000_000n)], [b5.id])).wait();
assert((await house.bets(b5.id)).status === S.Pending, 'End price missing: the bet waits, the batch does not revert');
await warpTo(b5.endTs + 12);
await reverts(house.connect(keeper).recordAndSettle([update(ETH, 'ETH', b5.endTs + 10, 300_000_000_000n, keys.slice(0, 3))], []), 'Not enough oracle signatures', 'Fewer than 4 of 5 signatures rejected');
await reverts(house.connect(keeper).recordAndSettle([update(ETH, 'BTC', b5.endTs + 10, 300_000_000_000n)], []), 'Signer not authorised', 'A report for another feed does not verify');
// The exact end report never appears: a report 10 s later is recorded; it counts only after the grace
await (await house.connect(keeper).recordAndSettle([update(ETH, 'ETH', b5.endTs + 10, 301_000_000_000n)], [b5.id])).wait();
assert((await house.bets(b5.id)).status === S.Pending, 'A later report is not used before the grace period ends');
await warpTo(b5.endTs + 301);
await (await house.connect(keeper).recordAndSettle([], [b5.id])).wait();
assert((await house.bets(b5.id)).status === S.Won, 'After the grace, the earliest later report settles the bet');
assert((await house.prices(ETH, b5.endTs)) === 301_000_000_000n, 'The substitute is fixed as the price at that time');
await (await house.connect(keeper).recordAndSettle([update(ETH, 'ETH', b5.endTs, 299_000_000_000n)], [])).wait();
assert((await house.prices(ETH, b5.endTs)) === 301_000_000_000n, 'A report arriving later cannot change a price already used');

const b6 = await place(carol, ETH, DOWN, mon(2));
await warpTo(b6.endTs + 5);
await (await house.connect(keeper).recordAndSettle([], [b6.id])).wait();
assert((await house.bets(b6.id)).status === S.Pending, 'No prices: pending before the void timeout');
await warpTo(b6.endTs + 20 * 3600 + 1);
const carolBal = await house.balances(carol.address);
await (await house.connect(keeper).recordAndSettle([], [b6.id, b6.id, 9999n])).wait();
assert((await house.bets(b6.id)).status === S.Void && (await house.balances(carol.address)) === carolBal + mon(2), 'No oracle price for 20 h: void, stake returned; repeated and unknown ids are skipped');
await invariant('substitute and void');

console.log('\n--- Owner cannot retime a pending bet ---');
{
  const [origGrace, origVoid, origLpLock] = await Promise.all([house.priceGrace(), house.voidAfter(), house.lpLockSeconds()]);
  const b7 = await place(frank, ETH, UP, mon(1));
  await warpTo(b7.endTs + 2);
  // Shrink the timeouts sharply after the bet was placed; it must keep the values it started with
  await (await house.setTimeouts(2 * 60, 3600, origLpLock)).wait();
  await warpTo(b7.endTs + 3601);
  await (await house.connect(keeper).recordAndSettle([], [b7.id])).wait();
  assert((await house.bets(b7.id)).status === S.Pending, "Shrinking voidAfter after the bet was placed does not void it early; it keeps its own 20 h");
  await (await house.setTimeouts(origGrace, origVoid, origLpLock)).wait();
  await warpTo(b7.endTs + Number(origVoid) + 1);
  // Ganache's estimator occasionally undershoots the void path specifically (same margin-free-estimate
  // flakiness documented on place() above); add the same kind of buffer rather than trust it blindly.
  const voidEst = await house.connect(keeper).recordAndSettle.estimateGas([], [b7.id]);
  await (await house.connect(keeper).recordAndSettle([], [b7.id], { gasLimit: voidEst + 200_000n })).wait();
  assert((await house.bets(b7.id)).status === S.Void, "It still voids at its own original 20 h timeout, not any value set after it was placed");
  await invariant('owner cannot retime a pending bet');
}

console.log('\n--- Streak jackpot ---');
// Fill the pot with losing bets from bob
for (let i = 0; i < 4; i++) {
  const b = await place(bob, ETH, UP, mon(15));
  await resolve(b, 300_000_000_000n, 290_000_000_000n, ETH, 'ETH');
}
const pot = await house.jackpotPot();
assert(pot > mon(0.6), `Pot funded by stakes: ${ethers.formatEther(pot)} MON`);
// Hedging: a second bet placed while one is pending is not a streak bet
const h1 = await place(lp2, BTC, UP, mon(1));
const h2 = await place(lp2, BTC, DOWN, mon(1));
assert(h1.streakBet && !h2.streakBet, 'The opposite-side hedge placed while a bet is pending is not a streak bet');
// The two bets are placed back to back, so a window boundary can fall between them: record prices for
// both bets' own start/end times, or the second one is left pending.
await warpTo(Math.max(h1.endTs, h2.endTs) + 2);
const hedgeTimes = [...new Set([h1.startTs, h1.endTs, h2.startTs, h2.endTs])].sort((a, b) => a - b);
await (await house.connect(keeper).recordAndSettle(hedgeTimes.map((t) => update(BTC, 'BTC', t, t === h1.startTs || t === h2.startTs ? 100n : 101n)), [h2.id, h1.id])).wait();
assert((await house.streak(lp2.address)) === 1n, 'Only the streak bet counts (the losing hedge did not reset it, and it gave no extra step)');
// Dave (fresh wallet) wins 5 streak bets in a row; smallest stake 0.5 MON caps the jackpot at 10 MON
const stakes = [mon(1), mon(0.5), mon(2), mon(1), mon(1)];
let jackpotEvent = null;
let potBefore = 0n;
for (let i = 0; i < 5; i++) {
  const b = await place(dave, BTC, UP, stakes[i]);
  await warpTo(b.endTs + 2);
  potBefore = await house.jackpotPot();
  const rc = await (await house.connect(keeper).recordAndSettle([update(BTC, 'BTC', b.startTs, 1000n + BigInt(i) * 10n), update(BTC, 'BTC', b.endTs, 1005n + BigInt(i) * 10n)], [b.id])).wait();
  const ev = rc.logs.map((l) => { try { return house.interface.parseLog(l); } catch (_) { return null; } }).find((e) => e?.name === 'JackpotWon');
  if (ev) { jackpotEvent = ev; assert(i === 4, `Jackpot only on the fifth win (paid on win ${i + 1})`); }
  else if (i < 4) assert((await house.streak(dave.address)) === BigInt(i + 1), `Streak ${i + 1}`);
}
assert(jackpotEvent && jackpotEvent.args.streak === 5n, 'Fifth win in a row pays the jackpot');
const share = (potBefore * 2500n) / 10000n;
const expected = share < mon(10) ? share : mon(10);
assert(jackpotEvent && jackpotEvent.args.amount === expected, `Jackpot = 25% of the pot, capped at 20x the smallest streak stake (${ethers.formatEther(jackpotEvent?.args.amount ?? 0n)} MON)`);
assert((await house.streak(dave.address)) === 0n, 'Streak restarts after the jackpot');
await invariant('jackpot');

console.log('\n--- Owner cannot retime an in-progress streak ---');
{
  const [origStreak, origShare, origCap] = await Promise.all([house.jackpotStreak(), house.jackpotShareBps(), house.jackpotCapMultiple()]);
  const winErin = async () => {
    const b = await place(erin, BTC, UP, mon(1));
    const potBefore = await house.jackpotPot();
    await warpTo(b.endTs + 2);
    const rc = await (await house.connect(keeper).recordAndSettle([update(BTC, 'BTC', b.startTs, 2_000_000_000_000n), update(BTC, 'BTC', b.endTs, 2_001_000_000_000n)], [b.id])).wait();
    const ev = rc.logs.map((l) => { try { return house.interface.parseLog(l); } catch (_) { return null; } }).find((e) => e?.name === 'JackpotWon');
    return { ev, potBefore };
  };
  await winErin();
  await winErin();
  assert((await house.streak(erin.address)) === 2n, "Erin is 2 wins into a streak (started under the rules' default target of 5)");
  // A hostile/careless owner lowers the streak target and raises the payout share mid-streak
  await (await house.setJackpotRules(3, 4000, 5)).wait();
  const third = await winErin();
  assert(!third.ev && (await house.streak(erin.address)) === 3n, "Lowering the streak target mid-streak does not pay it early: erin's streak keeps the target it started with");
  await winErin();
  const fifth = await winErin();
  assert(fifth.ev && fifth.ev.args.streak === 5n, "Erin's jackpot pays on her fifth win, the target her streak actually started with");
  const expected = (() => {
    const share = (fifth.potBefore * origShare) / 10000n;
    const cap = mon(1) * origCap; // her smallest stake throughout was 1 MON
    return share < cap ? share : cap;
  })();
  assert(fifth.ev.args.amount === expected, `The jackpot pays the rules erin's streak started with (25% / 20x), not the 40% / 5x the owner set mid-streak (${ethers.formatEther(fifth.ev.args.amount)} MON)`);
  await (await house.setJackpotRules(origStreak, origShare, origCap)).wait();
  await invariant('owner cannot retime an in-progress streak');
}

console.log('\n--- Moving odds (one market maker per bet window) ---');
{
  // Fast-moving odds for this section: window liquidity = 5% of the free vault
  await (await house.setOdds(1000, 500)).wait();
  // A shorter minLead leaves more real-clock margin before the 10 s window rolls over while this
  // section's several sequential bets are mined one by one (minLead itself eats into that margin).
  const [origMargin, origWinFee, origJackpotCut, origMaxWin, origMinBet, origMinLead] = await Promise.all(
    [house.marginBps(), house.winFeeBps(), house.jackpotCutBps(), house.maxWinBps(), house.minBet(), house.minLead()]);
  await (await house.setParams(origMargin, origWinFee, origJackpotCut, origMaxWin, origMinBet, 3)).wait();
  const SOL = ethers.id('SOL-market');
  await (await house.setMarket(SOL, feedIdBytes32('SOL'), true)).wait();
  // Start just after a report mark, so a few quick bets all land in the same window
  const freshWindow = async () => { const t = await now(); await warpTo(Math.ceil((t + 1) / 10) * 10 + 1); };
  await freshWindow();
  // Ganache's clock keeps running in real time, and this section's ~14 sequential bets can take longer than
  // the 10 s window on a slow machine. Re-pin the clock inside the window before each bet so timing
  // cannot move a bet into the next window.
  const windowPin = (await now()) + 1;
  const pinClock = () => provider.send('evm_setTime', [windowPin * 1000]);
  const qUp = await house.quote(SOL, UP, 30, mon(1));
  const qDown = await house.quote(SOL, DOWN, 30, mon(1));
  assert(qUp.refused === '' && qUp.payout === qDown.payout && qUp.priceBps === 5000n, `Fresh window: both sides quote the same (${ethers.formatEther(qUp.payout)} MON for 1)`);
  const solBets = [];
  const bets = [];
  let refusedAt = null;
  for (let i = 0; i < 12 && refusedAt === null; i++) {
    const q = await house.quote(SOL, UP, 30, mon(1));
    if (q.refused) { refusedAt = i; break; }
    await pinClock();
    bets.push({ q, bet: await place(dave, SOL, UP, mon(1)) });
    solBets.push(bets[bets.length - 1].bet);
  }
  const first = bets[0];
  const last = bets[bets.length - 1];
  assert(first.bet.startTs === last.bet.startTs, 'All these bets landed in the same window');
  assert(last.bet.payout < first.bet.payout, `Each Rise bet in the window pays less than the one before (${ethers.formatEther(first.bet.payout)} -> ${ethers.formatEther(last.bet.payout)} MON for 1)`);
  for (const { q, bet } of bets.slice(0, 3)) {
    if (q.startTs === BigInt(bet.startTs)) assert(q.payout === bet.payout, `The quote matched the placed bet exactly (${ethers.formatEther(bet.payout)} MON)`);
  }
  const down = await house.quote(SOL, DOWN, 30, mon(1));
  const up = await house.quote(SOL, UP, 30, mon(0.1));
  assert(down.refused === '' && down.payout > first.bet.payout, `The other side now pays more: Fall ${ethers.formatEther(down.payout)} MON for 1 vs ${ethers.formatEther(first.bet.payout)} at even`);
  assert(refusedAt !== null, `After ${bets.length} Rise bets the band stops more Rise in this window: "${(await house.quote(SOL, UP, 30, mon(1))).refused}"`);
  await reverts(house.connect(dave).placeBet(SOL, UP, 30, 0, 0, { value: mon(1) }), 'Odds at limit on this side', 'A bet past the band is refused, not given worse odds');
  const priceNow = up.priceBps;
  assert(priceNow <= 6000n, `The Rise price stays inside the band (${Number(priceNow) / 100}%, band 40%-60%)`);
  await pinClock();
  const fall = await place(erin, SOL, DOWN, mon(2));
  solBets.push(fall);
  assert(fall.startTs === first.bet.startTs, 'The other side is still open in the same window');
  await checkPrice(fall, SOL, DOWN, mon(2), 'A Fall bet against the crowd');
  await invariant('moving odds');

  // No sequence of bets in a window can lock in a profit: try random both-sides sequences on-chain
  let bestEdge = -Infinity;
  for (let seq = 0; seq < 6; seq++) {
    await freshWindow();
    let payUp = 0n, payDown = 0n, staked = 0n;
    for (let i = 0; i < 6; i++) {
      const side = Math.random() < 0.5 ? UP : DOWN;
      const stake = mon((0.1 + Math.random() * 2.5).toFixed(2));
      const q = await house.quote(SOL, side, 30, stake);
      if (q.refused) continue;
      const bet = await place(frank, SOL, side, stake);
      solBets.push(bet);
      if (side === UP) payUp += bet.payout; else payDown += bet.payout;
      staked += stake;
    }
    const worse = payUp < payDown ? payUp : payDown;
    const edge = Number(ethers.formatEther(worse - staked));
    bestEdge = Math.max(bestEdge, edge);
  }
  assert(bestEdge < 0, `Across 6 random both-sides sequences, the best guaranteed result was a loss (${bestEdge.toFixed(4)} MON): no arbitrage`);
  await (await house.setOdds(1000, 20000)).wait();
  await (await house.setParams(origMargin, origWinFee, origJackpotCut, origMaxWin, origMinBet, origMinLead)).wait();
  // Settle everything opened here (equal prices: ties, stakes back) so later sections start clean
  await warpTo(Math.max(...solBets.map((b) => b.endTs)) + 2);
  const times = [...new Set(solBets.flatMap((b) => [b.startTs, b.endTs]))];
  const solUpdates = times.map((t) => update(SOL, 'SOL', t, 15_000_000_000n));
  const solIds = solBets.map((b) => b.id);
  // A fixed gas limit here would be sized for whatever bet count the random sequences above happened to
  // produce on the run that set it, not this one - estimate instead, the way every real caller must.
  const solEst = await house.connect(keeper).recordAndSettle.estimateGas(solUpdates, solIds);
  await (await house.connect(keeper).recordAndSettle(solUpdates, solIds, { gasLimit: solEst + 500_000n })).wait();
  assert((await house.lockedPayouts()) === 0n, `All ${solBets.length} bets of this section settled; nothing left reserved`);
  await invariant('moving odds settled');
}

console.log('\n--- Vault capacity under one-sided demand ---');
{
  // A separate, fresh house sized like the real deployment (25 MON vault, 10% max win per bet), so this
  // is not diluted by the large vault other sections have already built up. The odds band is widened to
  // its contract maximum so the *per-window* AMM limit (already covered by "Moving odds" above) is not
  // what stops this - the point here is the global, vault-wide reservation check, so demand is spread
  // across several windows (two markets x three durations) the way many different real bets would be.
  const stress = await (await new ethers.ContractFactory(abi, bin, owner).deploy(signerAddrs, 4)).waitForDeployment();
  await (await stress.setMarket(BTC, feedIdBytes32('BTC'), true)).wait();
  await (await stress.setMarket(ETH, feedIdBytes32('ETH'), true)).wait();
  await (await stress.addLiquidity({ value: mon(25) })).wait();
  await (await stress.setParams(300, 300, 100, 1000, mon(0.1), 5)).wait(); // matches the live deployment
  await (await stress.setOdds(2000, 50000)).wait(); // widest band/window-liquidity the contract allows

  const bettors = [alice, bob, carol, dave, erin, frank, lp2];
  const windows = [[BTC, 'BTC', 10], [ETH, 'ETH', 30], [BTC, 'BTC', 60], [ETH, 'ETH', 10], [BTC, 'BTC', 30], [ETH, 'ETH', 60]];
  const placed = [];
  let refusedText = null;
  let lastWindow = null;
  for (let i = 0; i < 200 && !refusedText; i++) {
    const who = bettors[i % bettors.length];
    const win = windows[i % windows.length];
    const [marketId, feed, duration] = win;
    try {
      const est = await stress.connect(who).placeBet.estimateGas(marketId, UP, duration, 0, 0, { value: mon(1) });
      const rc = await (await stress.connect(who).placeBet(marketId, UP, duration, 0, 0, { value: mon(1), gasLimit: est + 100_000n })).wait();
      const ev = rc.logs.map((l) => { try { return stress.interface.parseLog(l); } catch (_) { return null; } }).find((e) => e?.name === 'BetPlaced');
      placed.push({ id: ev.args.betId, marketId, feed, startTs: Number(ev.args.startTs), duration: Number(ev.args.duration), endTs: Number(ev.args.startTs) + Number(ev.args.duration) });
      lastWindow = win;
    } catch (err) {
      // Ganache's estimateGas rejection puts the actual require() reason in a different place than a
      // normal sendTransaction revert; check every field the way the reverts() helper above already does.
      refusedText = `${err?.shortMessage || ''} ${err?.message || ''} ${err?.info?.error?.message || ''} ${err?.info?.error?.data?.reason || ''}`;
    }
  }
  assert(/Bet exceeds house limit/.test(refusedText || ''),
    `${placed.length} same-side bets from ${bettors.length} wallets across ${windows.length} windows accepted, then the vault-wide limit refused more ("${(refusedText || '').slice(0, 80)}") instead of over-committing`);
  const locked = await stress.lockedPayouts();
  const vaultAssets = await stress.vaultAssets();
  assert(locked <= vaultAssets, `Every accepted bet's payout is still fully reserved: locked ${ethers.formatEther(locked)} <= vault ${ethers.formatEther(vaultAssets)} MON`);

  // The bets above already alternated between BTC and ETH windows the whole way, and still hit one
  // shared wall - proof the limit is on the vault as a whole, not counted separately per market.

  // The other side of that same window is still open: the crowd only saturated one side, not the house
  const stillOpen = await stress.quote(lastWindow[0], DOWN, lastWindow[2], mon(0.1));
  assert(stillOpen.refused === '', 'The other side of the same window is still open for betting');

  // Worst case for the house: every one of those bets wins. The reservation made at placement is only
  // a real guarantee if the vault can actually pay every one of them when this happens. Mixed durations
  // mean one bet's end mark can be another's start mark on the same feed, so every distinct timestamp
  // gets its own strictly increasing price (by time, per feed) - every UP bet's end is then guaranteed
  // to price higher than its own start, however marks are shared between bets.
  const byFeed = { BTC: new Set(), ETH: new Set() };
  for (const b of placed) { byFeed[b.feed].add(b.startTs); byFeed[b.feed].add(b.endTs); }
  const updates = [];
  for (const feed of ['BTC', 'ETH']) {
    const marketId = feed === 'BTC' ? BTC : ETH;
    const times = [...byFeed[feed]].sort((a, b) => a - b);
    times.forEach((t, i) => updates.push(update(marketId, feed, t, 3_000_000_000_000n + BigInt(i) * 1_000_000_000n)));
  }
  await warpTo(Math.max(...placed.map((b) => b.endTs)) + 2);
  const ids = placed.map((b) => b.id);
  await (await stress.connect(keeper).recordAndSettle(updates, ids, { gasLimit: 25_000_000 })).wait();
  let allWon = true;
  for (const b of placed) if ((await stress.bets(b.id)).status !== S.Won) allWon = false;
  assert(allWon, `Even in the worst case for the house, every one of the ${placed.length} accepted bets settles as a win - none reverts or gets stuck unpaid`);

  const heldNow = await balanceOf(await stress.getAddress());
  const [vNow, balNow, potNow, treNow] = await Promise.all([stress.vaultAssets(), stress.totalBalances(), stress.jackpotPot(), stress.treasury()]);
  assert(heldNow === vNow + balNow + potNow + treNow,
    `The contract still holds exactly what it owes after paying every winner: held ${ethers.formatEther(heldNow)} = vault ${ethers.formatEther(vNow)} + balances ${ethers.formatEther(balNow)} + pot ${ethers.formatEther(potNow)} + treasury ${ethers.formatEther(treNow)}`);
}

console.log('\n--- Liquidity providers ---');
{
  const totalBefore = await house.totalShares();
  const assetsBefore = await house.vaultAssets();
  await (await house.connect(lp2).addLiquidity({ value: mon(100) })).wait();
  const lpShares = await house.shares(lp2.address);
  assert(lpShares === (mon(100) * totalBefore) / assetsBefore, 'With nothing pending, a deposit buys shares at vault assets / shares');
  await reverts(house.connect(lp2).removeLiquidity(lpShares), 'Deposit still locked', 'A fresh deposit is locked (no in-and-out around known outcomes)');
  await warpTo((await now()) + 3700);

  // A bet is pending and its result is already signed (a win for the player): the LP tries to leave first
  const pend = await place(alice, BTC, UP, mon(10));
  const [assets, locked, total] = await Promise.all([house.vaultAssets(), house.lockedPayouts(), house.totalShares()]);
  const before = await balanceOf(lp2.address);
  // Explicit gas: ganache estimates on its wall clock, ignoring evm_setTime
  const rc = await (await house.connect(lp2).removeLiquidity(lpShares, { gasLimit: 200000 })).wait();
  const got = (await balanceOf(lp2.address)) - before + rc.gasUsed * rc.gasPrice;
  assert(got === (lpShares * (assets - locked)) / total, 'A withdrawal is priced as if every pending bet wins: leaving before a signed win avoids nothing');
  // Its share of the reserve stays behind; when the bet then loses, the remaining LPs keep it
  const ownerShares = await house.shares(owner.address);
  await warpTo(pend.endTs + 2);
  await (await house.connect(keeper).recordAndSettle([update(BTC, 'BTC', pend.startTs, 5n), update(BTC, 'BTC', pend.endTs, 4n)], [pend.id])).wait();
  assert((await house.totalShares()) === ownerShares, 'Only the owner holds shares now');
  const exitValue = (await house.vaultAssets()) - (await house.lockedPayouts());
  assert(exitValue > assetsBefore, 'The house edge (and the exiting LP\'s reserve) accrues to the LPs that stayed');

  // Deposits while a bet is pending are priced as if it loses: no cheap entry ahead of a signed loss
  const pend2 = await place(bob, BTC, DOWN, mon(10));
  const [a2, t2] = await Promise.all([house.vaultAssets(), house.totalShares()]);
  await (await house.connect(carol).addLiquidity({ value: mon(50) })).wait();
  assert((await house.shares(carol.address)) === (mon(50) * t2) / a2, 'A deposit during a pending bet pays the price as if the bet loses (vault assets incl. its stake)');
  await warpTo(pend2.endTs + 2);
  await (await house.connect(keeper).recordAndSettle([update(BTC, 'BTC', pend2.startTs, 5n), update(BTC, 'BTC', pend2.endTs, 4n)], [pend2.id])).wait();
  await invariant('LP flows');

  await reverts(house.connect(carol).removeLiquidity((await house.shares(carol.address)) + 1n), 'Not enough shares', 'Removing more shares than held reverts');
}

console.log('\n--- LP fully exits while a bet is pending, then it loses ---');
{
  // A separate house so this is not entangled with the shares other sections already hold.
  const iso = await (await new ethers.ContractFactory(abi, bin, owner).deploy(signerAddrs, 4)).waitForDeployment();
  await (await iso.setMarket(BTC, feedIdBytes32('BTC'), true)).wait();
  await (await iso.connect(lp2).addLiquidity({ value: mon(25) })).wait();
  await warpTo((await now()) + 3700); // clear lp2's deposit lock

  const tx = await iso.connect(alice).placeBet(BTC, UP, 30, 0, 0, { value: mon(0.3) }); // under the default 2% maxStake on a 25 MON vault
  const rc = await tx.wait();
  const ev = rc.logs.map((l) => { try { return iso.interface.parseLog(l); } catch (_) { return null; } }).find((e) => e?.name === 'BetPlaced');
  const bet = { id: ev.args.betId, startTs: Number(ev.args.startTs), endTs: Number(ev.args.startTs) + Number(ev.args.duration) };

  // The sole LP fully exits while that bet is still pending - correctly gets only the free share
  const lpShares = await iso.shares(lp2.address);
  await (await iso.connect(lp2).removeLiquidity(lpShares, { gasLimit: 200000 })).wait();
  const vaultAfterExit = await iso.vaultAssets();
  const lockedAfterExit = await iso.lockedPayouts();
  assert((await iso.totalShares()) === 0n && vaultAfterExit === lockedAfterExit && vaultAfterExit > 0n,
    `Full exit while a bet is pending: total shares hit zero, and what is left (${ethers.formatEther(vaultAfterExit)} MON) is exactly that bet's reserve - none of it was free to hand the exiting LP`);

  // The bet then loses: its reserve is released but never paid out, so it just sits there unclaimed
  await warpTo(bet.endTs + 2);
  await (await iso.connect(keeper).recordAndSettle([update(BTC, 'BTC', bet.startTs, 3_000_000_000_000n), update(BTC, 'BTC', bet.endTs, 2_900_000_000_000n)], [bet.id])).wait();
  const orphaned = await iso.vaultAssets();
  assert(orphaned > 0n && (await iso.totalShares()) === 0n, `The lost bet's reserve (${ethers.formatEther(orphaned)} MON) is sitting in the vault with no shares to claim it`);
  const treasuryBefore = await iso.treasury();

  // A new depositor must not inherit that leftover as a windfall on top of their own deposit
  const depositAmt = mon(10);
  await (await iso.connect(carol).addLiquidity({ value: depositAmt })).wait();
  assert((await iso.shares(carol.address)) === depositAmt, 'The new depositor mints shares 1:1 against only their own deposit');
  assert((await iso.vaultAssets()) === depositAmt, "Their deposit alone backs their shares - the orphaned balance did not quietly become part of it");
  assert((await iso.treasury()) === treasuryBefore + orphaned, 'The orphaned balance went to the treasury (house profit) instead of gifting the next LP a windfall');
}

console.log('\n--- Owner bounds ---');
await reverts(house.connect(alice).setParams(300, 300, 100, 200, mon(0.1), 5), 'Only owner', 'Only the owner tunes parameters');
await reverts(house.setParams(50, 300, 100, 200, mon(0.1), 5), 'Invalid margin', 'The house margin cannot go under 1% (the house always has an edge)');
await reverts(house.setParams(300, 1500, 100, 200, mon(0.1), 5), 'Invalid win fee', 'The win fee cannot exceed 10% of the profit');
await reverts(house.setOdds(2500, 20000), 'Invalid band', 'The odds band cannot pass 0.5 +/- 0.2 (never under ~1.4x)');
await reverts(house.connect(alice).withdrawTreasury(alice.address), 'Only owner', 'Only the owner withdraws the treasury');
{
  const t = await house.treasury();
  const before = await balanceOf(lp2.address);
  await (await house.withdrawTreasury(lp2.address)).wait();
  assert(t > 0n && (await balanceOf(lp2.address)) === before + t && (await house.treasury()) === 0n, `Treasury (${ethers.formatEther(t)} MON of win fees) withdrawn by the owner to a chosen address`);
  await invariant('treasury withdrawal');
}
await reverts(house.setMarket(BTC, feedIdBytes32('ETH'), true), 'Feed is fixed per market', "A market's feed cannot be swapped");
await reverts(house.setTimeouts(30, 20 * 3600, 3600), 'Invalid grace', 'The substitute grace cannot be under 2 min (time for anyone to post the exact report)');
await reverts(house.setTimeouts(300, 600, 3600), 'Invalid void timeout', 'A bet cannot be voided within the hour (the house cannot let winners lapse into refunds)');
await (await house.setPaused(true)).wait();
await reverts(house.connect(alice).placeBet(BTC, UP, 30, 0, 0, { value: mon(1) }), 'Paused', 'Paused: no new bets');
await (await house.setPaused(false)).wait();
await reverts(house.connect(alice).setPaused(true), 'Only owner', 'Only the owner can pause');

// Every remaining bound on every admin setter, and who is allowed to call it
await reverts(house.setParams(300, 300, 400, 200, mon(0.1), 5), 'Invalid jackpot cut', 'The jackpot cut cannot exceed 3% of every stake');
await reverts(house.setParams(300, 300, 100, 0, mon(0.1), 5), 'Invalid max win', 'Max win per bet cannot be zero');
await reverts(house.setParams(300, 300, 100, 1100, mon(0.1), 5), 'Invalid max win', 'Max win per bet cannot exceed 10% of the free vault');
await reverts(house.setParams(300, 300, 100, 200, 0, 5), 'Invalid min bet', 'The minimum bet cannot be zero');
await reverts(house.setParams(300, 300, 100, 200, mon(0.1), 2), 'Invalid lead', 'The lead time cannot be under 3 s');
await reverts(house.setParams(300, 300, 100, 200, mon(0.1), 61), 'Invalid lead', 'The lead time cannot exceed 60 s');
await reverts(house.connect(alice).setOdds(1000, 20000), 'Only owner', 'Only the owner sets the odds band');
await reverts(house.setOdds(1000, 400), 'Invalid liquidity', 'A window cannot be given less than 5% of the free vault as liquidity');
await reverts(house.setOdds(1000, 60000), 'Invalid liquidity', 'A window cannot be given more than 500% of the free vault as liquidity');
await reverts(house.connect(alice).setMarket(ethers.id('fake-market'), feedIdBytes32('FAKE'), true), 'Only owner', 'Only the owner lists a market');
await reverts(house.setMarket(ethers.id('zero-feed-market'), ethers.ZeroHash, true), 'Invalid feed', 'A market cannot be listed with an empty feed');
await reverts(house.connect(alice).setDuration(45, true), 'Only owner', 'Only the owner offers a duration');
await reverts(house.setDuration(15, true), 'Invalid duration', 'A duration must land on the 10 s report grid');
await reverts(house.setDuration(0, true), 'Invalid duration', 'A duration of zero is invalid');
await reverts(house.setDuration(2 * 3600, true), 'Invalid duration', 'A duration over an hour is invalid');
await reverts(house.connect(alice).setJackpotRules(5, 2500, 20), 'Only owner', 'Only the owner tunes the jackpot rules');
await reverts(house.setJackpotRules(2, 2500, 20), 'Invalid streak', 'The jackpot streak cannot be under 3 wins');
await reverts(house.setJackpotRules(21, 2500, 20), 'Invalid streak', 'The jackpot streak cannot exceed 20 wins');
await reverts(house.setJackpotRules(5, 0, 20), 'Invalid share', 'The jackpot share cannot be zero');
await reverts(house.setJackpotRules(5, 5100, 20), 'Invalid share', 'The jackpot share cannot exceed 50% of the pot');
await reverts(house.setJackpotRules(5, 2500, 0), 'Invalid cap', 'The jackpot cap multiple cannot be zero');
await reverts(house.setJackpotRules(5, 2500, 1001), 'Invalid cap', 'The jackpot cap multiple cannot exceed 1000x');
await reverts(house.connect(alice).setTimeouts(300, 20 * 3600, 3600), 'Only owner', 'Only the owner tunes the timeouts');
await reverts(house.setTimeouts(300, 24 * 3600, 3600), 'Invalid void timeout', 'The void timeout cannot exceed 23 h (the oracle only keeps 24 h of history)');
await reverts(house.setTimeouts(300, 20 * 3600, 8 * 24 * 3600), 'Invalid LP lock', 'The LP lock cannot exceed 7 days');
await reverts(house.connect(alice).proposeOracleSigners(signerAddrs, 4), 'Only owner', 'Only the owner proposes an oracle signer change');
await reverts(house.applyOracleSigners.staticCall(), 'No pending signer change', 'A signer change cannot be applied with none pending');
await reverts(house.cancelOracleSignerProposal.staticCall(), 'No pending signer change', 'A signer change cannot be cancelled with none pending');
await (await house.proposeOracleSigners(signerAddrs, 4)).wait();
await reverts(house.applyOracleSigners.staticCall(), 'Signer change still timelocked', 'A proposed signer change cannot be applied before its 2-day delay');
await (await house.cancelOracleSignerProposal()).wait();

// Two-step ownership: a typo cannot brick it, and only the proposed address can accept
await reverts(house.transferOwnership(ethers.ZeroAddress), 'Invalid owner', 'Ownership cannot be proposed to the zero address');
await reverts(house.connect(alice).transferOwnership(bob.address), 'Only owner', 'Only the owner starts an ownership transfer');
await (await house.transferOwnership(alice.address)).wait();
await reverts(house.connect(bob).acceptOwnership(), 'Not pending owner', 'Only the proposed address can accept ownership');
await (await house.connect(alice).acceptOwnership()).wait();
assert((await house.owner()) === alice.address, 'Ownership transfers to the accepted address');
await reverts(house.setPaused(false), 'Only owner', 'The old owner loses access the instant the new one accepts');
await (await house.connect(alice).transferOwnership(owner.address)).wait();
await (await house.connect(owner).acceptOwnership()).wait();
assert((await house.owner()) === owner.address, 'Ownership transfers back cleanly (not a one-way trip)');

console.log('\n--- Real RedStone packages (captured from the free gateway) ---');
{
  const fixture = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'redstone_primary_prod_packages.json'), 'utf8'));
  const parsed = fixture.BTC.map(parsePackage);
  const pkgTs = Number(parsed[0].report.timestampMs / 1000n);
  const gp = ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 2, defaultBalance: 1000 }, chain: { time: new Date((pkgTs + 5) * 1000) } });
  const [o] = await new ethers.BrowserProvider(gp).listAccounts();
  const real = await (await new ethers.ContractFactory(abi, bin, o).deploy(REDSTONE_PRIMARY_SIGNERS, 4)).waitForDeployment();
  const M = ethers.id('BTC-real');
  await (await real.setMarket(M, feedIdBytes32('BTC'), true)).wait();
  await reverts(real.recordAndSettle.staticCall([{ marketId: M, ts: pkgTs, reports: parsed.slice(0, 3).map((p) => p.report) }], []), 'Not enough oracle signatures', 'Production threshold (4 of 5): 3 real signatures are rejected');
  const four = parsed.slice(1, 5);
  await (await real.recordAndSettle([{ marketId: M, ts: pkgTs, reports: four.map((p) => p.report) }], [])).wait();
  const price = await real.prices(M, pkgTs);
  assert(price === medianUnits(four.map((p) => p.report.value)), `4 real RedStone signatures record the median BTC price ($${Number(price) / 1e8})`);
  await gp.disconnect();
}

console.log(`\nHOUSE EVM VERDICT: ${passed}/${total} checks passed`);
