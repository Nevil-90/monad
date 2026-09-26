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

// Mock Pyth update payload (see MockPythOracle.parsePriceFeedUpdatesUnique)
function pythUpdate(feedId, price, publishTime, prevPublishTime, expo = -8) {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'int64', 'uint64', 'int32', 'uint64', 'uint64'],
    [feedId, price, 8n, expo, BigInt(publishTime), BigInt(prevPublishTime)]
  );
}
// The canonical "first price at/after target" update
const firstAt = (feedId, price, target, offset = 1) =>
  pythUpdate(feedId, price, BigInt(target) + BigInt(offset), BigInt(target) - 1n);

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

  const P = load('MockPythOracle_sol_MockPythOracle');
  const A = load('MonadUpDownAMM_sol_MonadUpDownAMM');
  const H = load('HostileKeeper_sol_HostileKeeper');
  const pyth = await (await new ethers.ContractFactory(P.abi, P.bin, owner).deploy()).waitForDeployment();
  const amm = await (await new ethers.ContractFactory(A.abi, A.bin, owner).deploy(await pyth.getAddress())).waitForDeployment();
  const ammAddr = await amm.getAddress();

  const feed = ethers.keccak256(ethers.toUtf8Bytes('BTC/USD'));
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
    await (await amm.connect(signer).lockRoundWithUpdate(mId, rId, [firstAt(feed, price, r.lockTimestamp)], { value: 1n })).wait();
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
    check('SEC-01', await reverts(() => amm.connect(bob).settleRoundWithUpdate.staticCall(m, rId, [], { value: 0n }), 'Price update required'),
      'Settling with no price update reverts');
    const replayLock = firstAt(feed, 6425000000000n, r.lockTimestamp);
    check('SEC-01', await reverts(() => amm.connect(bob).settleRoundWithUpdate.staticCall(m, rId, [replayLock], { value: 1n })),
      'Re-submitting the lock-time price as the close price reverts (no forced tie)');
    const staleBeforeClose = pythUpdate(feed, 6425000000000n, r.closeTimestamp - 20n, r.closeTimestamp - 100n);
    check('SEC-01', await reverts(() => amm.connect(bob).settleRoundWithUpdate.staticCall(m, rId, [staleBeforeClose], { value: 1n })),
      'A price published before closeTimestamp is rejected');
    check('SEC-01', Number((await amm.rounds(m, rId)).status) === 2, 'Round is still Locked after all forced-tie attempts');
  });

  // ---------------------------------------------------------------------------
  // SEC-02: Keeper cherry-picks the lock/close price from a window of valid prices
  // ---------------------------------------------------------------------------
  await section('SEC-02', async () => {
    const m = await newMarket();
    const { rId, round } = await contestedRound(m);
    await warpTo(round.lockTimestamp);

    const knownBeforeBetsClosed = pythUpdate(feed, 6000000000000n, round.lockTimestamp - 15n, round.lockTimestamp - 100n);
    check('SEC-02', await reverts(() => amm.connect(keeper).lockRoundWithUpdate.staticCall(m, rId, [knownBeforeBetsClosed], { value: 1n })),
      'Lock price published before lockTimestamp (already known to bettors) is rejected');
    const notFirst = pythUpdate(feed, 7000000000000n, round.lockTimestamp + 4n, round.lockTimestamp + 2n);
    check('SEC-02', await reverts(() => amm.connect(keeper).lockRoundWithUpdate.staticCall(m, rId, [notFirst], { value: 1n })),
      'A later (non-first) price inside the window is rejected: prevPublishTime must be < lockTimestamp');
    const pastWindow = pythUpdate(feed, 7000000000000n, round.lockTimestamp + round.priceWindow + 1n, round.lockTimestamp - 1n);
    check('SEC-02', await reverts(() => amm.connect(keeper).lockRoundWithUpdate.staticCall(m, rId, [pastWindow], { value: 1n })),
      'A price beyond lockTimestamp + priceWindow is rejected');
    const otherFeed = firstAt(ethers.keccak256(ethers.toUtf8Bytes('ETH/USD')), 248000000000n, round.lockTimestamp);
    check('SEC-02', await reverts(() => amm.connect(keeper).lockRoundWithUpdate.staticCall(m, rId, [otherFeed], { value: 1n })),
      'A price for a different Pyth feed is rejected');

    // Delaying the lock call gives no choice either: the same pinned price is the only valid one
    await increaseTime(40);
    await (await amm.connect(keeper).lockRoundWithUpdate(m, rId, [firstAt(feed, 6425000000000n, round.lockTimestamp)], { value: 1n })).wait();
    const r = await amm.rounds(m, rId);
    check('SEC-02', r.lockPublishTime === round.lockTimestamp + 1n && r.lockPrice === 6425000000000n * 10n ** 28n,
      'Lock price is exactly the first update at/after lockTimestamp, regardless of when lock was called');

    await warpTo(r.closeTimestamp + 30n);
    const laterFavourable = pythUpdate(feed, 9000000000000n, r.closeTimestamp + 5n, r.closeTimestamp + 3n);
    check('SEC-02', await reverts(() => amm.connect(settler).settleRoundWithUpdate.staticCall(m, rId, [laterFavourable], { value: 1n })),
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
    await (await hostile.connect(stranger).lock(ammAddr, m, rId, [firstAt(feed, 6425000000000n, round.lockTimestamp)], { value: 1n, gasLimit: 600000 })).wait();
    check('SEC-03', (await amm.rounds(m, rId)).lockKeeper === hostileAddr, 'Hostile contract is the recorded lock keeper');

    await warpTo(round.closeTimestamp);
    // Pre-fix, the bounty push forwarded 63/64 of all gas to the hostile locker, so settle failed at any
    // realistic limit. Post-fix no call is made to the locker and a normal 800k limit is enough.
    let settledOk = false;
    try {
      const rc = await (await amm.connect(settler).settleRoundWithUpdate(
        m, rId, [firstAt(feed, 6500000000000n, round.closeTimestamp)], { value: 1n, gasLimit: 800000 }
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
    await (await amm.connect(keeper).lockRoundWithUpdate(m, rId, [firstAt(feed, 6425000000000n, round.lockTimestamp)], { value: 1n })).wait();
    check('SEC-04', Number((await amm.rounds(m, rId)).status) === 2, 'Lock 200s late still locks at the pinned price (no forced cancel)');

    await warpTo(round.closeTimestamp + 600n); // old maxSettleDelay was 120s
    await (await amm.connect(settler).settleRoundWithUpdate(m, rId, [firstAt(feed, 6300000000000n, round.closeTimestamp)], { value: 1n })).wait();
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
    await (await amm.connect(owner).setProtocolParameters(10, 10, 2 * 3600, ethers.parseEther('0.001'))).wait();
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
    await (await amm.connect(settler).settleRoundWithUpdate(m, rId, [firstAt(feed, 6500000000000n, round.closeTimestamp)], { value: 1n })).wait();
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
