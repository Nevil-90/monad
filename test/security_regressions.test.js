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
    const notFirst = reportsAtTs(7000000000000n, lockTs + 10n);
    check('SEC-02', await reverts(() => amm.connect(keeper).lockRoundWithUpdate.staticCall(m, rId, notFirst), 'Report not at pinned timestamp'),
      'Reports from the next 10s mark are rejected: only the first mark at/after lockTimestamp counts');
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
    check('SEC-02', await reverts(() => amm.connect(settler).settleRoundWithUpdate.staticCall(m, rId, laterFavourable), 'Report not at pinned timestamp'),
      'Settler cannot substitute a later, more favourable close price');
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

    await warpTo(round.closeTimestamp + 600n); // old maxSettleDelay was 120s
    await (await amm.connect(settler).settleRoundWithUpdate(m, rId, firstAt(6300000000000n, round.closeTimestamp))).wait();
    const r = await amm.rounds(m, rId);
    check('SEC-04', Number(r.status) === 3 && Number(r.winningSide) === 2, 'Settle 600s late still settles with the correct winner (DOWN)');
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

    // A round that has bets is never replaced: a late bettor cannot void it
    await warpTo(r2.betCloseTimestamp + 1n);
    check('SEC-24', await reverts(() => amm.connect(bob).betDown.staticCall(m, 2n, { value: ethers.parseEther('1') }), 'Betting window closed'),
      'A late bet on a round that has bets is rejected, not turned into a new round');
    check('SEC-24', Number((await amm.rounds(m, 2n)).status) === 1, 'The round with bets stays open for its keeper');
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
