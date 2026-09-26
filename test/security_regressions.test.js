/**
 * test/security_regressions.test.js
 * One regression test per finding in SECURITY_FIXES.md. Each test re-attempts the original exploit
 * against the real compiled contract on an in-memory Ganache EVM and must see it FAIL.
 * If any [SEC-xx] line prints FAIL, that bug has been re-introduced: mark it "Regressed" in the checklist.
 *
 * Run: npm run compile && npm run test:security
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ganache from 'ganache';
import { ethers } from 'ethers';
import { signReport, feedIdBytes32 } from '../src/oracle.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const buildDir = path.join(rootDir, 'build');

let passed = 0;
let total = 0;
function check(id, condition, message) {
  total++;
  if (condition) {
    console.log(`[PASS] [${id}] ${message}`);
    passed++;
  } else {
    console.error(`\x1b[31m[FAIL]\x1b[0m [${id}] ${message}`);
    process.exitCode = 1;
  }
}

// Pass a `.staticCall(...)` so the node returns revert data (ganache omits it on estimateGas)
async function reverts(callFn, expectedReason) {
  try {
    await callFn();
    return false;
  } catch (err) {
    if (!expectedReason) return true;
    const text = `${err.reason || ''} ${err.shortMessage || ''} ${err.message || ''}`;
    return text.includes(expectedReason);
  }
}

// Runs one finding's block; an unexpected throw (e.g. a tx that should succeed reverting) counts as FAIL
async function section(id, fn) {
  try {
    await fn();
  } catch (err) {
    check(id, false, `Unexpected error: ${err.shortMessage || err.message}`);
  }
}

function load(name) {
  const abi = JSON.parse(fs.readFileSync(path.join(buildDir, `${name}.abi`), 'utf8'));
  let bin = fs.readFileSync(path.join(buildDir, `${name}.bin`), 'utf8').trim();
  if (!bin.startsWith('0x')) bin = `0x${bin}`;
  return { abi, bin };
}

// Local oracle network: 5 signing keys, all required (the production default)
const signerKeys = [1, 2, 3, 4, 5].map((i) => new ethers.SigningKey(ethers.id(`oracle-signer-${i}`)));
const signerAddrs = signerKeys.map((k) => ethers.computeAddress(k.publicKey));
const INTERVAL = 10n;
const pinned = (target) => ((BigInt(target) + INTERVAL - 1n) / INTERVAL) * INTERVAL;
// Reports from `keys` for the report timestamp `tsSec` (seconds)
const reportsAtTs = (price, tsSec, { feed = 'BTC', keys = signerKeys } = {}) =>
  keys.map((k) => signReport(k, feed, price, BigInt(tsSec) * 1000n));
// The canonical reports: every signer, at the pinned 10s mark at/after `target`
const firstAt = (price, target) => reportsAtTs(price, pinned(target));

async function main() {
  const ganacheProvider = ganache.provider({
    logging: { quiet: true },
    wallet: { totalAccounts: 10, defaultBalance: 100000 }
  });
  const provider = new ethers.BrowserProvider(ganacheProvider);
  const [owner, alice, bob, keeper, settler, creator, stranger, newOwner] = await provider.listAccounts();

  const increaseTime = async (s) => { await provider.send('evm_increaseTime', [s]); await provider.send('evm_mine', []); };
  const now = async () => Number((await ganacheProvider.request({ method: 'eth_getBlockByNumber', params: ['latest', false] })).timestamp);
  const warpTo = async (ts) => { const n = await now(); if (ts > n) await increaseTime(Number(ts) - n); };

  const A = load('MonadUpDownAMM_sol_MonadUpDownAMM');
  const H = load('HostileKeeper_sol_HostileKeeper');
  const amm = await (await new ethers.ContractFactory(A.abi, A.bin, owner).deploy(signerAddrs, 5)).waitForDeployment();
  const ammAddr = await amm.getAddress();

  const feed = feedIdBytes32('BTC');
  let marketCounter = 0;
  async function newMarket(duration = 60) {
    const symbol = `BTC/USD#${marketCounter++}`;
    await (await amm.connect(creator).createMarket(feed, 'Bitcoin', symbol, duration)).wait();
    return ethers.solidityPackedKeccak256(['bytes32', 'string', 'uint256'], [feed, symbol, duration]);
  }
  async function contestedRound(mId) {
    const rId = (await amm.markets(mId)).currentRoundId;
    await (await amm.connect(alice).betUp(mId, rId, { value: ethers.parseEther('10') })).wait();
    await (await amm.connect(bob).betDown(mId, rId, { value: ethers.parseEther('10') })).wait();
    return { rId, round: await amm.rounds(mId, rId) };
  }
  async function lockAt(mId, rId, price, signer = keeper) {
    const r = await amm.rounds(mId, rId);
    await warpTo(r.lockTimestamp);
    await (await amm.connect(signer).lockRoundWithUpdate(mId, rId, firstAt(price, r.lockTimestamp))).wait();
    return amm.rounds(mId, rId);
  }

  console.log('=== SECURITY REGRESSION SUITE (see SECURITY_FIXES.md) ===\n');

  // ---------------------------------------------------------------------------
  // SEC-01: Loser forces a "tie" refund by settling on the stale stored lock price
  // ---------------------------------------------------------------------------
  await section('SEC-01', async () => {
    const m = await newMarket();
    const { rId } = await contestedRound(m);
    const r = await lockAt(m, rId, 6425000000000n);
    await warpTo(r.closeTimestamp);

    check('SEC-01', amm.interface.getFunction('settleRound(bytes32,uint256)') === null,
      'No settle path that reads the stored (possibly stale) on-chain price exists');
    check('SEC-01', await reverts(() => amm.connect(bob).settleRoundWithUpdate.staticCall(m, rId, []), 'Price update required'),
      'Settling with no price update reverts');
    const replayLock = firstAt(6425000000000n, r.lockTimestamp);
    check('SEC-01', await reverts(() => amm.connect(bob).settleRoundWithUpdate.staticCall(m, rId, replayLock), 'Report not at pinned timestamp'),
      'Re-submitting the lock-time reports as the close price reverts (no forced tie)');
    const staleBeforeClose = reportsAtTs(6425000000000n, pinned(r.closeTimestamp) - 10n);
    check('SEC-01', await reverts(() => amm.connect(bob).settleRoundWithUpdate.staticCall(m, rId, staleBeforeClose), 'Report not at pinned timestamp'),
      'A report from before closeTimestamp is rejected');
    check('SEC-01', Number((await amm.rounds(m, rId)).status) === 2, 'Round is still Locked after all forced-tie attempts');
  });

  // ---------------------------------------------------------------------------
  // SEC-02: Keeper cherry-picks the lock/close price from a window of valid prices
  // ---------------------------------------------------------------------------
  await section('SEC-02', async () => {
    const m = await newMarket();
    const { rId, round } = await contestedRound(m);
    await warpTo(round.lockTimestamp);

    const lockTs = pinned(round.lockTimestamp);
    const knownBeforeBetsClosed = reportsAtTs(6000000000000n, lockTs - 20n);
    check('SEC-02', await reverts(() => amm.connect(keeper).lockRoundWithUpdate.staticCall(m, rId, knownBeforeBetsClosed), 'Report not at pinned timestamp'),
      'Lock reports from before lockTimestamp (already known to bettors) are rejected');
    const tooLate = reportsAtTs(7000000000000n, lockTs + 40n);
    check('SEC-02', await reverts(() => amm.connect(keeper).lockRoundWithUpdate.staticCall(m, rId, tooLate), 'Report not at pinned timestamp'),
      'Reports more than maxReportDelay (30 s) after the pinned mark are rejected');
    const offGrid = reportsAtTs(7000000000000n, lockTs + 5n);
    check('SEC-02', await reverts(() => amm.connect(keeper).lockRoundWithUpdate.staticCall(m, rId, offGrid), 'Report not at pinned timestamp'),
      'Report times off the 10 s grid are rejected');
    const mixed = [...firstAt(6425000000000n, round.lockTimestamp).slice(0, 4), ...reportsAtTs(7000000000000n, lockTs + 10n, { keys: [signerKeys[4]] })];
    check('SEC-02', await reverts(() => amm.connect(keeper).lockRoundWithUpdate.staticCall(m, rId, mixed), 'Report not at pinned timestamp'),
      'Mixing in one report from another timestamp is rejected');
    const otherFeed = reportsAtTs(248000000000n, lockTs, { feed: 'ETH' });
    check('SEC-02', await reverts(() => amm.connect(keeper).lockRoundWithUpdate.staticCall(m, rId, otherFeed), 'Signer not authorised'),
      'Reports signed for a different feed are rejected');
    const subset = reportsAtTs(6425000000000n, lockTs, { keys: signerKeys.slice(0, 3) });
    check('SEC-02', await reverts(() => amm.connect(keeper).lockRoundWithUpdate.staticCall(m, rId, subset), 'Not enough oracle signatures'),
      'A chosen subset of signers (3 of 5) is rejected, so the keeper cannot steer the median');

    // Delaying the lock call gives no choice either: the same pinned reports are the only valid ones
    await increaseTime(40);
    await (await amm.connect(keeper).lockRoundWithUpdate(m, rId, firstAt(6425000000000n, round.lockTimestamp))).wait();
    const r = await amm.rounds(m, rId);
    check('SEC-02', r.lockPublishTime === lockTs && r.lockPrice === 6425000000000n * 10n ** 28n,
      'Lock price is exactly the report at the first 10s mark at/after lockTimestamp, regardless of when lock was called');

    await warpTo(r.closeTimestamp + 30n);
    const laterFavourable = reportsAtTs(9000000000000n, pinned(r.closeTimestamp) + 10n);
    await (await amm.connect(settler).settleRoundWithUpdate(m, rId, laterFavourable)).wait();
    check('SEC-02', Number((await amm.rounds(m, rId)).status) === 2,
      'A later close report is only proposed: the round does not settle on it (SEC-28 challenge period)');
    await (await amm.connect(keeper).settleRoundWithUpdate(m, rId, firstAt(6300000000000n, r.closeTimestamp))).wait();
    const done = await amm.rounds(m, rId);
    check('SEC-02', Number(done.status) === 3 && done.closePrice === 6300000000000n * 10n ** 28n && Number(done.winningSide) === 2,
      'The pinned report replaces the later, favourable one and settles at once: the settler gained nothing');
  });

  // ---------------------------------------------------------------------------
  // SEC-28: The free gateway misses some report times. A later report settles only after a
  // challenge period in which anyone can replace it with an earlier one.
  // ---------------------------------------------------------------------------
  await section('SEC-28', async () => {
    const m = await newMarket();
    const { rId, round } = await contestedRound(m);
    const L = pinned(round.lockTimestamp);
    const C = pinned(round.closeTimestamp);
    check('SEC-28', L === round.lockTimestamp && C === round.closeTimestamp,
      'Lock and close times sit on the 10 s report grid: the settling report is the one signed at close (no extra wait)');
    await warpTo(round.lockTimestamp + 25n);
    // Pinned lock report missed by everyone: the keeper locks on the report 20 s later
    await (await amm.connect(keeper).lockRoundWithUpdate(m, rId, reportsAtTs(6400000000000n, L + 20n))).wait();
    let r = await amm.rounds(m, rId);
    check('SEC-28', Number(r.status) === 2 && r.lockPublishTime === L + 20n && r.finalizeAfter > 0n,
      'Missing pinned lock report: a report within 30 s locks provisionally and opens a challenge period');
    check('SEC-28', await reverts(() => amm.connect(stranger).lockRoundWithUpdate.staticCall(m, rId, reportsAtTs(6500000000000n, L + 30n)), 'Not earlier than the current lock report'),
      'A later lock report cannot replace the current one');
    await (await amm.connect(stranger).lockRoundWithUpdate(m, rId, reportsAtTs(6410000000000n, L + 10n))).wait();
    r = await amm.rounds(m, rId);
    check('SEC-28', r.lockPublishTime === L + 10n && r.lockPrice === 6410000000000n * 10n ** 28n && r.lockKeeper === await stranger.getAddress(),
      'Anyone can replace it with an earlier captured report, and takes the lock bounty');

    await warpTo(round.closeTimestamp + 25n);
    await (await amm.connect(settler).settleRoundWithUpdate(m, rId, reportsAtTs(6300000000000n, C + 10n))).wait();
    r = await amm.rounds(m, rId);
    check('SEC-28', Number(r.status) === 2 && r.closePublishTime === C + 10n,
      'A late close report is proposed, not settled');
    check('SEC-28', await reverts(() => amm.connect(settler).finalizeRound.staticCall(m, rId), 'Challenge period not over'),
      'Nobody can settle on it before the challenge period ends');
    check('SEC-28', await reverts(() => amm.connect(alice).settleRoundWithUpdate.staticCall(m, rId, reportsAtTs(6600000000000n, C + 20n)), 'Not earlier than the current close report'),
      'A later close report cannot replace the proposed one');
    await warpTo(r.finalizeAfter);
    const settlerAddr = await settler.getAddress();
    const before = await amm.keeperRewards(settlerAddr);
    await (await amm.connect(settler).finalizeRound(m, rId)).wait();
    r = await amm.rounds(m, rId);
    check('SEC-28', Number(r.status) === 3 && Number(r.winningSide) === 2 && r.closePrice === 6300000000000n * 10n ** 28n,
      'After the challenge period the earliest captured report settles the round');
    check('SEC-28', (await amm.keeperRewards(settlerAddr)) > before, 'The finalizer is paid the settle bounty');
    check('SEC-28', await reverts(() => amm.connect(settler).finalizeRound.staticCall(m, rId), 'No proposed close price'),
      'A settled round cannot be finalized twice');
    check('SEC-28', await reverts(() => amm.connect(stranger).lockRoundWithUpdate.staticCall(m, rId, reportsAtTs(1n, L)), 'Not open'),
      'The lock price cannot change after settlement');
  });

  // ---------------------------------------------------------------------------
  // SEC-16: The owner key is a single point of trust. Whatever it does mid-round, it cannot take or
  // reduce what bettors are owed: fees and timing are snapshotted, pause never blocks resolution or
  // claims, treasury withdrawals only touch fees, and oracle signers are timelocked (SEC-22).
  // ---------------------------------------------------------------------------
  await section('SEC-16', async () => {
    const m = await newMarket();
    const { rId, round } = await contestedRound(m);
    const originalTimeout = await amm.emergencyTimeout();
    const aliceAddr = await alice.getAddress();
    // Every owner power at once, mid-round
    await (await amm.connect(owner).setProtocolFees(300, 300, 400)).wait();          // 10% total
    await (await amm.connect(owner).setProtocolParameters(60, 60, 300, ethers.parseEther('5'))).wait();
    await (await amm.connect(owner).setPaused(true)).wait();
    await (await amm.connect(owner).setMarketActive(m, false)).wait();
    await lockAt(m, rId, 6425000000000n);
    await warpTo(round.closeTimestamp);
    await (await amm.connect(settler).settleRoundWithUpdate(m, rId, firstAt(6500000000000n, round.closeTimestamp))).wait();
    const r = await amm.rounds(m, rId);
    check('SEC-16', Number(r.status) === 3 && r.feeBps === 150n, 'Round settles at the fee it opened with (1.5%), not the owner\'s new 10%');
    const expected = (ethers.parseEther('10') * r.netPayoutPool) / r.totalUp;
    const before = BigInt(await provider.send('eth_getBalance', [aliceAddr, 'latest']));
    const rc = await (await amm.connect(alice).claimPayout(m, rId)).wait();
    const got = BigInt(await provider.send('eth_getBalance', [aliceAddr, 'latest'])) - before + rc.fee;
    check('SEC-16', got === expected && expected === ethers.parseEther('19.7'), `Winner is paid in full while paused and deactivated: ${ethers.formatEther(got)} MON`);
    const ownerAddr = await owner.getAddress();
    check('SEC-16', await reverts(() => amm.connect(owner).withdrawTreasury.staticCall(ethers.ZeroHash, ownerAddr), 'No treasury fees'),
      'The owner can only withdraw accrued fees, never pool money');
    // Restore for the sections that follow
    await (await amm.connect(owner).setPaused(false)).wait();
    await (await amm.connect(owner).setProtocolFees(10, 10, 130)).wait();
    await (await amm.connect(owner).setProtocolParameters(10, 10, originalTimeout, ethers.parseEther('0.001'))).wait();
  });

  // ---------------------------------------------------------------------------
  // SEC-29: A timed-out round was refundable AND still settleable: a loser refunded, then the
  // round settled and winners were paid out of the refunded stake (i.e. other rounds' money)
  // ---------------------------------------------------------------------------
  await section('SEC-29', async () => {
    const m = await newMarket();
    const { rId, round } = await contestedRound(m);
    await lockAt(m, rId, 6425000000000n);
    const r = await amm.rounds(m, rId);
    check('SEC-29', r.expiryTimestamp === r.closeTimestamp + (await amm.emergencyTimeout()), 'Expiry (close + emergencyTimeout) is fixed at round start');
    await warpTo(r.expiryTimestamp + 1n);
    await (await amm.connect(bob).claimPayout(m, rId)).wait(); // Bob refunds his losing stake
    check('SEC-29', await reverts(() => amm.connect(settler).settleRoundWithUpdate.staticCall(m, rId, firstAt(6000000000000n, round.closeTimestamp)), 'Round expired: refundable'),
      'Once refundable, the round can no longer be settled (no payout from refunded stakes)');
    check('SEC-29', await reverts(() => amm.connect(settler).lockRoundWithUpdate.staticCall(m, rId, firstAt(6000000000000n, round.lockTimestamp)), 'Round expired: refundable'),
      'Nor can its lock price change');
    const got = await amm.connect(alice).claimPayout.staticCall(m, rId).then(() => true, () => false);
    check('SEC-29', got, 'Every bettor still refunds their stake');

    // Owner cannot change an in-flight round's expiry
    const originalTimeout = await amm.emergencyTimeout();
    const m2 = await newMarket();
    const { rId: rId2 } = await contestedRound(m2);
    const locked2 = await lockAt(m2, rId2, 6425000000000n);
    await (await amm.connect(owner).setProtocolParameters(10, 10, 300, ethers.parseEther('0.001'))).wait();
    check('SEC-29', (await amm.rounds(m2, rId2)).expiryTimestamp === locked2.expiryTimestamp,
      'Lowering emergencyTimeout does not change an in-flight round\'s expiry');
    await warpTo(locked2.closeTimestamp + 400n);
    check('SEC-29', await reverts(() => amm.connect(bob).claimPayout.staticCall(m2, rId2), 'Round not yet resolved'),
      'After lowering the timeout to 5 min, a round 400 s past close is still not refundable (owner cannot trigger refunds)');
    await (await amm.connect(owner).setProtocolParameters(10, 10, originalTimeout, ethers.parseEther('0.001'))).wait();
  });

  // ---------------------------------------------------------------------------
  // SEC-03: Hostile locker contract burns gas on bounty push, blocking settlement
  // ---------------------------------------------------------------------------
  await section('SEC-03', async () => {
    const m = await newMarket();
    const { rId, round } = await contestedRound(m);
    const hostile = await (await new ethers.ContractFactory(H.abi, H.bin, stranger).deploy()).waitForDeployment();
    const hostileAddr = await hostile.getAddress();
    await warpTo(round.lockTimestamp);
    await (await hostile.connect(stranger).lock(ammAddr, m, rId, firstAt(6425000000000n, round.lockTimestamp), { gasLimit: 600000 })).wait();
    check('SEC-03', (await amm.rounds(m, rId)).lockKeeper === hostileAddr, 'Hostile contract is the recorded lock keeper');

    await warpTo(round.closeTimestamp);
    // Pre-fix, the bounty push forwarded 63/64 of all gas to the hostile locker, so settle failed at any
    // realistic limit. Post-fix no call is made to the locker and a normal 800k limit is enough.
    let settledOk = false;
    try {
      const rc = await (await amm.connect(settler).settleRoundWithUpdate(
        m, rId, firstAt(6500000000000n, round.closeTimestamp), { gasLimit: 800000 }
      )).wait();
      settledOk = rc.status === 1;
    } catch (err) { settledOk = false; console.error('      settle error:', err.shortMessage || err.message); }
    check('SEC-03', settledOk, 'Honest settle succeeds with a normal 800k gas limit despite a gas-burning locker');
    check('SEC-03', (await amm.keeperRewards(hostileAddr)) > 0n, "Hostile locker's share is credited (pull), not pushed");
    check('SEC-03', (await amm.keeperRewards(await settler.getAddress())) > 0n, "Settler's share is credited and withdrawable");
  });

  // ---------------------------------------------------------------------------
  // SEC-04: Losers force a refund by letting the lock/settle deadline lapse
  // ---------------------------------------------------------------------------
  await section('SEC-04', async () => {
    const m = await newMarket();
    const { rId, round } = await contestedRound(m);
    await warpTo(round.lockTimestamp + 200n); // old maxLockDelay was 30s => used to auto-cancel
    await (await amm.connect(keeper).lockRoundWithUpdate(m, rId, firstAt(6425000000000n, round.lockTimestamp))).wait();
    check('SEC-04', Number((await amm.rounds(m, rId)).status) === 2, 'Lock 200s late still locks at the pinned price (no forced cancel)');

    await warpTo(round.closeTimestamp + 500n); // old maxSettleDelay was 120s; expiry is close + 600s (SEC-29)
    await (await amm.connect(settler).settleRoundWithUpdate(m, rId, firstAt(6300000000000n, round.closeTimestamp))).wait();
    const r = await amm.rounds(m, rId);
    check('SEC-04', Number(r.status) === 3 && Number(r.winningSide) === 2, 'Settle 500s late still settles with the correct winner (DOWN)');
  });

  // ---------------------------------------------------------------------------
  // SEC-05: Owner parameter changes alter in-flight rounds / brick betting windows
  // ---------------------------------------------------------------------------
  await section('SEC-05', async () => {
    const m = await newMarket(60);
    const rId = (await amm.markets(m)).currentRoundId;
    const before = await amm.rounds(m, rId);
    const originalTimeout = await amm.emergencyTimeout();
    await (await amm.connect(owner).setProtocolParameters(60, 60, 2 * 3600, ethers.parseEther('0.001'))).wait();
    const after = await amm.rounds(m, rId);
    check('SEC-05', after.betCloseTimestamp === before.betCloseTimestamp && after.priceWindow === before.priceWindow,
      'Changing lockBuffer / priceWindow does not alter the in-flight round');

    const m30 = await newMarket(30);
    const r30 = await amm.rounds(m30, (await amm.markets(m30)).currentRoundId);
    check('SEC-05', r30.betCloseTimestamp === r30.lockTimestamp - 15n, 'lockBuffer=60 on a 30s market is clamped to 15s (betting window still exists)');
    check('SEC-05', r30.priceWindow === 15n, 'priceWindow=60 on a 30s market is clamped to 15s (lock/close windows cannot overlap)');
    check('SEC-05', !(await reverts(() => amm.connect(alice).betUp.staticCall(m30, r30.roundId, { value: ethers.parseEther('1') }))),
      'Betting on the 30s market works under the extreme parameters');
    await (await amm.connect(owner).setProtocolParameters(10, 10, originalTimeout, ethers.parseEther('0.001'))).wait();
    check('SEC-05', await reverts(() => amm.connect(stranger).setProtocolParameters.staticCall(10, 10, 7200, 1n), 'Only owner'),
      'Non-owner cannot change protocol parameters');
  });

  // ---------------------------------------------------------------------------
  // SEC-06: Emergency pause & market deactivation without freezing user funds
  // ---------------------------------------------------------------------------
  await section('SEC-06', async () => {
    const m = await newMarket();
    const { rId, round } = await contestedRound(m);
    check('SEC-06', await reverts(() => amm.connect(stranger).setPaused.staticCall(true), 'Only owner'), 'Non-owner cannot pause');
    await (await amm.connect(owner).setPaused(true)).wait();
    check('SEC-06', await reverts(() => amm.connect(alice).betUp.staticCall(m, rId, { value: ethers.parseEther('1') }), 'Protocol paused'), 'Bets revert while paused');
    check('SEC-06', await reverts(() => amm.connect(creator).createMarket.staticCall(feed, 'x', 'PAUSED', 60), 'Protocol paused'), 'Market creation reverts while paused');

    await (await amm.connect(owner).setMarketActive(m, false)).wait();
    await lockAt(m, rId, 6425000000000n);
    await warpTo(round.closeTimestamp);
    await (await amm.connect(settler).settleRoundWithUpdate(m, rId, firstAt(6500000000000n, round.closeTimestamp))).wait();
    check('SEC-06', Number((await amm.rounds(m, rId)).status) === 3, 'Lock + settle still work while paused and market deactivated');
    check('SEC-06', (await amm.markets(m)).currentRoundId === rId, 'No new round is chained on a deactivated market');
    check('SEC-06', !(await reverts(() => amm.connect(alice).claimPayout.staticCall(m, rId))), 'Winner can claim while paused');

    await (await amm.connect(owner).setPaused(false)).wait();
    await (await amm.connect(owner).setMarketActive(m, true)).wait();
    await (await amm.connect(stranger).startRound(m)).wait();
    check('SEC-06', (await amm.markets(m)).currentRoundId === rId + 1n, 'After reactivation anyone can restart the round chain');
  });

  // ---------------------------------------------------------------------------
  // SEC-07: Single-step ownership transfer can brick admin control
  // ---------------------------------------------------------------------------
  await section('SEC-07', async () => {
    const ownerAddr = await owner.getAddress();
    await (await amm.connect(owner).transferOwnership(await newOwner.getAddress())).wait();
    check('SEC-07', (await amm.owner()) === ownerAddr, 'transferOwnership alone does not change owner');
    check('SEC-07', await reverts(() => amm.connect(stranger).acceptOwnership.staticCall(), 'Not pending owner'), 'Only the pending owner can accept');
    await (await amm.connect(newOwner).acceptOwnership()).wait();
    check('SEC-07', (await amm.owner()) === (await newOwner.getAddress()), 'Pending owner accepts and becomes owner');
    await (await amm.connect(newOwner).transferOwnership(ownerAddr)).wait();
    await (await amm.connect(owner).acceptOwnership()).wait();
  });

  // ---------------------------------------------------------------------------
  // SEC-08: Market spoofing (any feed under any symbol)
  // ---------------------------------------------------------------------------
  await section('SEC-08', async () => {
    const m = await newMarket();
    check('SEC-08', (await amm.markets(m)).verified === false, 'Permissionless markets start unverified');
    check('SEC-08', await reverts(() => amm.connect(creator).setMarketVerified.staticCall(m, true), 'Only owner'), 'Creator cannot self-verify');
    await (await amm.connect(owner).setMarketVerified(m, true)).wait();
    check('SEC-08', (await amm.markets(m)).verified === true, 'Owner can mark a canonical market as verified');
  });

  // ---------------------------------------------------------------------------
  // SEC-09: Re-creating a deactivated market resets its round counter over live storage
  // ---------------------------------------------------------------------------
  await section('SEC-09', async () => {
    const symbol = 'RECREATE/USD';
    await (await amm.connect(creator).createMarket(feed, 'x', symbol, 60)).wait();
    const m = ethers.solidityPackedKeccak256(['bytes32', 'string', 'uint256'], [feed, symbol, 60]);
    await (await amm.connect(alice).betUp(m, 1, { value: ethers.parseEther('3') })).wait();
    await (await amm.connect(owner).setMarketActive(m, false)).wait();
    check('SEC-09', await reverts(() => amm.connect(stranger).createMarket.staticCall(feed, 'x', symbol, 60), 'Market already exists'),
      'Deactivated market cannot be re-created by anyone');
    check('SEC-09', (await amm.rounds(m, 1)).totalUp === ethers.parseEther('3'), 'Existing round storage is untouched');
  });

  // ---------------------------------------------------------------------------
  // SEC-25: Gas budget. Monad charges the gas limit, and starting a round is paid by the settling
  // keeper or the first bettor. Budgets are ~10% above the packed-struct measurements.
  // ---------------------------------------------------------------------------
  await section('SEC-25', async () => {
    const m = await newMarket();
    const bet1 = await (await amm.connect(alice).betUp(m, 1n, { value: ethers.parseEther('1') })).wait();
    await (await amm.connect(bob).betDown(m, 1n, { value: ethers.parseEther('1') })).wait();
    const r = await amm.rounds(m, 1n);
    await warpTo(r.lockTimestamp);
    const lock = await (await amm.connect(keeper).lockRoundWithUpdate(m, 1n, firstAt(6425000000000n, r.lockTimestamp))).wait();
    await warpTo(r.closeTimestamp);
    const settle = await (await amm.connect(settler).settleRoundWithUpdate(m, 1n, firstAt(6430000000000n, r.closeTimestamp))).wait();
    const r2 = await amm.rounds(m, 2n);
    await warpTo(r2.betCloseTimestamp + 1n);
    const newRoundBet = await (await amm.connect(bob).betDown(m, 2n, { value: ethers.parseEther('1') })).wait();
    const claim = await (await amm.connect(alice).claimPayout(m, 1n)).wait();
    for (const [label, rc, budget] of [['first bet on a side', bet1, 150000n], ['lock', lock, 130000n], ['settle (+ next round)', settle, 380000n], ['bet opening a new round', newRoundBet, 250000n], ['claim', claim, 55000n]]) {
      check('SEC-25', rc.gasUsed <= budget, `${label}: ${rc.gasUsed} gas (budget ${budget})`);
    }
  });

  // ---------------------------------------------------------------------------
  // SEC-21: No past reports on the free gateway -> an uncaptured round refunds after 10 minutes
  // ---------------------------------------------------------------------------
  await section('SEC-21', async () => {
    const m = await newMarket();
    const { rId, round } = await contestedRound(m);
    check('SEC-21', (await amm.emergencyTimeout()) === 600n, 'Emergency timeout defaults to 10 minutes');
    await warpTo(round.closeTimestamp + 300n);
    check('SEC-21', await reverts(() => amm.connect(stranger).emergencyRefund.staticCall(m, rId), 'Emergency timeout has not expired'),
      'An unresolved round cannot be refunded before the timeout');
    await warpTo(round.closeTimestamp + 601n);
    await (await amm.connect(stranger).emergencyRefund(m, rId)).wait();
    check('SEC-21', Number((await amm.rounds(m, rId)).status) === 4, 'After 10 minutes anyone can cancel it for a full refund');
    check('SEC-21', (await amm.markets(m)).currentRoundId === rId + 1n, 'The market continues with a new round');
  });

  // ---------------------------------------------------------------------------
  // SEC-22: Owner swaps in its own oracle key to forge prices
  // ---------------------------------------------------------------------------
  await section('SEC-22', async () => {
    const rogueKey = new ethers.SigningKey(ethers.id('owner-controlled'));
    const rogue = ethers.computeAddress(rogueKey.publicKey);
    check('SEC-22', await reverts(() => amm.connect(stranger).proposeOracleSigners.staticCall([rogue], 1), 'Only owner'),
      'Only the owner can propose a signer change');
    check('SEC-22', await reverts(() => amm.connect(owner).proposeOracleSigners.staticCall([...signerAddrs.slice(0, 4), rogue], 2), 'Invalid signer threshold'),
      'A threshold below a strict majority is rejected');
    await (await amm.connect(owner).proposeOracleSigners([rogue], 1)).wait();
    check('SEC-22', await reverts(() => amm.connect(owner).applyOracleSigners.staticCall(), 'Signer change still timelocked'),
      'A proposed signer change cannot be applied immediately');
    const [pending, , eta] = await amm.pendingOracleSigners();
    check('SEC-22', pending.length === 1 && eta >= BigInt(await now()) + 2n * 86400n - 5n, 'The pending change is public for 2 days');

    // Forged reports from the proposed key are useless until the delay passes
    const m = await newMarket();
    const { rId, round } = await contestedRound(m);
    await warpTo(round.lockTimestamp);
    const forged = [signReport(rogueKey, 'BTC', 1n, pinned(round.lockTimestamp) * 1000n)];
    check('SEC-22', await reverts(() => amm.connect(owner).lockRoundWithUpdate.staticCall(m, rId, forged)),
      'Reports signed by the proposed key are rejected while the change is pending');

    await (await amm.connect(owner).cancelOracleSignersProposal()).wait();
    await increaseTime(2 * 86400 + 1);
    check('SEC-22', await reverts(() => amm.connect(owner).applyOracleSigners.staticCall(), 'No pending signer change'),
      'A cancelled proposal cannot be applied later');
    check('SEC-22', (await amm.oracleSigners()).length === 5 && (await amm.signerThreshold()) === 5n, 'Signer set unchanged');

    // A legitimate rotation (e.g. RedStone replaces a node) goes through after the delay
    const replacement = ethers.computeAddress(new ethers.SigningKey(ethers.id('rotated-node')).publicKey);
    await (await amm.connect(owner).proposeOracleSigners([...signerAddrs.slice(0, 4), replacement], 5)).wait();
    await increaseTime(2 * 86400 + 1);
    await (await amm.connect(owner).applyOracleSigners()).wait();
    const after = await amm.oracleSigners();
    check('SEC-22', after.length === 5 && after[4] === replacement, 'After 2 days the proposed signer set takes effect');
  });

  // ---------------------------------------------------------------------------
  // SEC-24: Idle markets burned keeper gas rolling empty rounds every minute
  // ---------------------------------------------------------------------------
  await section('SEC-24', async () => {
    const m = await newMarket();
    const r1 = await amm.rounds(m, 1n);
    await warpTo(r1.lockTimestamp + 300n); // five idle minutes, no keeper transactions
    await (await amm.connect(alice).betUp(m, 1n, { value: ethers.parseEther('2') })).wait();
    const mk = await amm.markets(m);
    check('SEC-24', mk.currentRoundId === 2n, 'A bet on an expired, empty round starts a fresh round');
    check('SEC-24', Number((await amm.rounds(m, 1n)).status) === 4, 'The empty round is closed as cancelled (no funds in it)');
    const r2 = await amm.rounds(m, 2n);
    check('SEC-24', r2.totalUp === ethers.parseEther('2') && r2.lockTimestamp > r1.lockTimestamp + 300n,
      'The bet lands in the new round, which has a full betting window');
    check('SEC-24', await reverts(() => amm.connect(bob).betDown.staticCall(m, 1n, { value: ethers.parseEther('1') }), 'Round not open for bets'),
      'A stale round id is not redirected');

    // A contested round is never replaced: a late bettor cannot void it
    await (await amm.connect(bob).betDown(m, 2n, { value: ethers.parseEther('1') })).wait();
    await warpTo(r2.betCloseTimestamp + 1n);
    check('SEC-24', await reverts(() => amm.connect(stranger).betDown.staticCall(m, 2n, { value: ethers.parseEther('1') }), 'Betting window closed'),
      'A late bet on a contested round is rejected, not turned into a new round');
    check('SEC-24', Number((await amm.rounds(m, 2n)).status) === 1, 'The contested round stays open for its keeper');
  });

  // ---------------------------------------------------------------------------
  // SEC-26: Refunds must never wait for someone else's transaction
  // ---------------------------------------------------------------------------
  await section('SEC-26', async () => {
    // One-sided round: refundable by the bettor once betting closed, with no cancel transaction
    const m = await newMarket();
    await (await amm.connect(alice).betUp(m, 1n, { value: ethers.parseEther('3') })).wait();
    const r1 = await amm.rounds(m, 1n);
    check('SEC-26', await reverts(() => amm.connect(alice).claimPayout.staticCall(m, 1n), 'Round not yet resolved'),
      'No refund while the other side can still bet');
    await warpTo(r1.betCloseTimestamp + 1n);
    // Raw balance reads (the BrowserProvider caches balances)
    const bal = async () => BigInt(await ganacheProvider.request({ method: 'eth_getBalance', params: [await alice.getAddress(), 'latest'] }));
    const before = await bal();
    const rc = await (await amm.connect(alice).claimPayout(m, 1n)).wait();
    const got = (await bal()) - before + rc.fee;
    check('SEC-26', got === ethers.parseEther('3') && Number((await amm.rounds(m, 1n)).status) === 1,
      'The bettor refunds the full stake directly, without any keeper or cancel transaction');
    check('SEC-26', await reverts(() => amm.connect(alice).claimPayout.staticCall(m, 1n), 'Already claimed'), 'No double refund');
    // The next bet replaces the one-sided round; its refund state is unchanged
    await (await amm.connect(bob).betDown(m, 1n, { value: ethers.parseEther('1') })).wait();
    check('SEC-26', (await amm.markets(m)).currentRoundId === 2n && Number((await amm.rounds(m, 1n)).status) === 4,
      'The next bet cancels the one-sided round and opens a fresh one');
    check('SEC-26', await reverts(() => amm.connect(alice).claimPayout.staticCall(m, 1n), 'Already claimed'), 'Still no double refund after cancellation');

    // Contested round nobody could resolve: refundable directly after the timeout
    const m2 = await newMarket();
    const { rId, round } = await contestedRound(m2);
    await warpTo(round.closeTimestamp + 60n);
    check('SEC-26', await reverts(() => amm.connect(alice).claimPayout.staticCall(m2, rId), 'Round not yet resolved'),
      'A contested round is not refundable before the timeout');
    await warpTo(round.closeTimestamp + (await amm.emergencyTimeout()) + 1n);
    check('SEC-26', !(await reverts(() => amm.connect(alice).claimPayout.staticCall(m2, rId))),
      'After the timeout each bettor refunds directly, without anyone calling emergencyRefund');
  });

  // ---------------------------------------------------------------------------
  // SEC-10: Private keys accepted as CLI arguments (leak to shell history / ps)
  // ---------------------------------------------------------------------------
  for (const f of ['scripts/keeper_bot.js', 'scripts/deploy.js']) {
    const src = fs.readFileSync(path.join(rootDir, f), 'utf8');
    check('SEC-10', !/indexOf\(['"]--private-key['"]\)/.test(src), `${f} does not read a private key from argv`);
  }

  console.log(`\nSECURITY REGRESSION VERDICT: ${passed}/${total} checks passed`);
  await ganacheProvider.disconnect();
}

main().catch((err) => {
  console.error('\x1b[31m[FATAL]\x1b[0m', err);
  process.exit(1);
});
