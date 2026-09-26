/**
 * test/contract_evm.test.js
 * Comprehensive On-Chain EVM Integration & Security Audit Test Suite
 * 
 * Runs on in-memory Ganache EVM using real compiled bytecode from build/
 * Verifies all security fixes and protocol invariants on the actual EVM:
 * 1. Contract deployment with an oracle signer set
 * 2. Permissionless market creation & Round #1 auto-initialization
 * 3. Bidirectional betting (Up & Down) with storage checks
 * 4. Slippage / Min-odds protection against pool sniping (VULN-03)
 * 5. Anti-frontrunning lock buffer enforcement
 * 6. Fixed observation schedule with pinned lock/close prices (SEC-01/02)
 * 7. Late settlement still resolves to the pinned price (SEC-04); genuine tie refunds
 * 8. 100% fee snapshotting invariance across rounds (VULN-04)
 * 9. Dual-keeper bounty accrual + pull withdrawal (SEC-03)
 * 10. Winner payout claims & 100% solvency proof
 * 11. Signed oracle reports: pinned timestamp, signer threshold, duplicates, median
 * 12. Real RedStone packages (captured from the free gateway) verify on-chain
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ganache from 'ganache';
import { ethers } from 'ethers';
import { signReport, parsePackage, feedIdBytes32, medianUnits, REDSTONE_PRIMARY_SIGNERS } from '../src/oracle.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const buildDir = path.join(rootDir, 'build');

console.log('================================================================================');
console.log('MONADPULSE: REAL EVM ON-CHAIN INTEGRATION & VULNERABILITY AUDIT SUITE');
console.log('================================================================================\n');

let passedTests = 0;
let totalTests = 0;

function assert(condition, message) {
  totalTests++;
  if (condition) {
    console.log(`[PASS] ${message}`);
    passedTests++;
  } else {
    console.error(`\x1b[31m[FAIL]\x1b[0m ${message}`);
    process.exitCode = 1;
  }
}

async function runEvmTests() {
  // 1. Initialize in-memory Ganache EVM
  const ganacheProvider = ganache.provider({
    logging: { quiet: true },
    wallet: {
      totalAccounts: 10,
      defaultBalance: 100000 // 100k ETH per test account
    }
  });

  const provider = new ethers.BrowserProvider(ganacheProvider);
  const accounts = await provider.listAccounts();
  const owner = accounts[0];
  const user1 = accounts[1]; // UP bettor
  const user2 = accounts[2]; // DOWN bettor
  const keeper1 = accounts[3]; // Locker
  const keeper2 = accounts[4]; // Settler
  const creator = accounts[5]; // Market Creator

  async function increaseTime(seconds) {
    await provider.send('evm_increaseTime', [seconds]);
    await provider.send('evm_mine', []);
  }

  async function getLatestBlock() {
    const raw = await ganacheProvider.request({ method: 'eth_getBlockByNumber', params: ['latest', false] });
    return {
      number: parseInt(raw.number, 16),
      timestamp: parseInt(raw.timestamp, 16)
    };
  }

  // Local oracle network: 5 signing keys, all required (the production default)
  const signerKeys = [1, 2, 3, 4, 5].map((i) => new ethers.SigningKey(ethers.id(`oracle-signer-${i}`)));
  const signerAddrs = signerKeys.map((k) => ethers.computeAddress(k.publicKey));
  const INTERVAL = 10n;
  const pinned = (target) => ((BigInt(target) + INTERVAL - 1n) / INTERVAL) * INTERVAL;
  // Every signer's report for the pinned timestamp of `target` (8-decimal price)
  const reports = (price, target, keys = signerKeys) =>
    keys.map((k) => signReport(k, 'BTC', price, pinned(target) * 1000n));

  // Exact raw balance query avoiding BrowserProvider client-side cache
  async function getBalance(addr) {
    const target = typeof addr === 'string' ? addr : await addr.getAddress();
    const hex = await ganacheProvider.request({ method: 'eth_getBalance', params: [target, 'latest'] });
    return BigInt(hex);
  }

  // 2. Load ABIs and Bytecodes
  const ammAbi = JSON.parse(fs.readFileSync(path.join(buildDir, 'MonadUpDownAMM_sol_MonadUpDownAMM.abi'), 'utf8'));
  let ammBytecode = fs.readFileSync(path.join(buildDir, 'MonadUpDownAMM_sol_MonadUpDownAMM.bin'), 'utf8');
  if (!ammBytecode.startsWith('0x')) ammBytecode = `0x${ammBytecode}`;

  // 3. Deploy MonadUpDownAMM with the oracle signer set
  console.log('--- Step 1: Deploying Contracts onto EVM ---');
  const ammFactory = new ethers.ContractFactory(ammAbi, ammBytecode, owner);
  const amm = await ammFactory.deploy(signerAddrs, 5);
  await amm.waitForDeployment();
  const ammAddr = await amm.getAddress();
  assert(Boolean(ammAddr && ammAddr.startsWith('0x')), `MonadUpDownAMM deployed at ${ammAddr}`);
  assert((await amm.signerThreshold()) === 5n && (await amm.oracleSigners()).length === 5, 'Oracle signer set registered (5 signers, all required)');

  // Test 1: Permissionless Market Creation & Round #1 Initialization
  console.log('\n--- Step 2: Market Creation & Round Initialization ---');
  const btcFeedId = feedIdBytes32('BTC');
  const roundDuration = 60; // 60s rounds
  
  const createTx = await amm.connect(creator).createMarket(btcFeedId, 'Bitcoin', 'BTC/USD', roundDuration);
  await createTx.wait();
  
  const marketId = ethers.solidityPackedKeccak256(
    ['bytes32', 'string', 'uint256'],
    [btcFeedId, 'BTC/USD', roundDuration]
  );
  
  const marketData = await amm.markets(marketId);
  assert(marketData.active === true, 'BTC/USD market is active on-chain');
  assert(marketData.currentRoundId === 1n, 'Market initialized with Round #1');
  assert(marketData.creator === (await creator.getAddress()), 'Market creator correctly registered for royalties');

  const round1 = await amm.rounds(marketId, 1);
  assert(Number(round1.status) === 1, 'Round #1 status is Open (status = 1)');
  assert(round1.feeBps === 150n, 'Round #1 snapshotted protocol fee at 1.5% (150 BPS)');

  // Test 2: Placing Bets & Anti-Frontrunning Buffer
  console.log('\n--- Step 3: Betting & Anti-Frontrunning Buffer ---');
  await amm.connect(user1).betUp(marketId, 1, { value: ethers.parseEther('10') });
  await amm.connect(user2).betDown(marketId, 1, { value: ethers.parseEther('10') });

  let r1 = await amm.rounds(marketId, 1);
  assert(r1.totalUp === ethers.parseEther('10'), 'User 1 placed 10 MON on UP');
  assert(r1.totalDown === ethers.parseEther('10'), 'User 2 placed 10 MON on DOWN');
  assert(r1.totalPool === ethers.parseEther('20'), 'Total pool is exactly 20 MON');

  // Verify opposite-side betting block
  let opposingReverted = false;
  try {
    await amm.connect(user1).betDown(marketId, 1, { value: ethers.parseEther('1') });
  } catch (err) {
    opposingReverted = true;
  }
  assert(opposingReverted, 'Opposing side bet in same round reverts');

  // Test 3: Slippage / Min-Odds Protection (VULN-03 Fix)
  console.log('\n--- Step 4: Slippage / Min-Odds Protection (VULN-03 Fix) ---');
  // At 10 Up vs 10 Down, Up multiplier is ~1.97x (1.97 * 1e18)
  // Attempting to require minimum multiplier of 3.0x must revert!
  let slippageReverted = false;
  try {
    const minMultWad = ethers.parseEther('3.0'); // 3.0x
    await amm.connect(user1).betUpWithMinOdds(marketId, 1, minMultWad, { value: ethers.parseEther('5') });
  } catch (err) {
    slippageReverted = true;
  }
  assert(slippageReverted, 'Slippage protection reverts when post-bet multiplier is below minExpectedMultiplier');

  // Order with acceptable slippage (1.5x) succeeds
  const safeMultWad = ethers.parseEther('1.5');
  await amm.connect(user1).betUpWithMinOdds(marketId, 1, safeMultWad, { value: ethers.parseEther('2') });
  r1 = await amm.rounds(marketId, 1);
  assert(r1.totalUp === ethers.parseEther('12'), 'Acceptable slippage order executes successfully (12 MON Up)');
  assert(r1.upBettors === 1n && r1.downBettors === 1n, 'Bettor counters count each wallet once per round (1 Up, 1 Down)');

  // Advance time into the 10-second anti-frontrunning cutoff (lock is on the 10 s report grid)
  {
    const blk = await provider.getBlock('latest');
    await increaseTime(Number(r1.betCloseTimestamp) - blk.timestamp + 2);
  }
  let bufferReverted = false;
  try {
    await amm.connect(user2).betDown(marketId, 1, { value: ethers.parseEther('1') });
  } catch (err) {
    bufferReverted = true;
  }
  assert(bufferReverted, 'Bet inside 10s cutoff window is strictly rejected');

  // Test 4: Locking Round & Guaranteed Observation Window (VULN-06 Fix)
  console.log('\n--- Step 5: Lock Round & Observation Window Guarantee ---');
  await increaseTime(10); // Now 62s elapsed (past lockTimestamp 60s)

  // Keeper 1 locks the round with the price pinned to lockTimestamp
  const lockPriceInitial = 6425000000000n; // $64,250
  const lockTx = await amm.connect(keeper1).lockRoundWithUpdate(marketId, 1, reports(lockPriceInitial, r1.lockTimestamp));
  await lockTx.wait();

  r1 = await amm.rounds(marketId, 1);
  assert(Number(r1.status) === 2, 'Round #1 successfully locked (status = 2)');
  assert(r1.lockKeeper === (await keeper1.getAddress()), 'Keeper 1 recorded as lock keeper for 50% gas bounty');
  assert(r1.lockPublishTime === pinned(r1.lockTimestamp), 'Lock price pinned to the report at the first 10s mark at/after lockTimestamp');
  assert(r1.lockPrice === lockPriceInitial * 10n ** 28n, 'Lock price stored at 36-decimal scale');

  // Invariant: observation window is the fixed schedule [lockTimestamp, lockTimestamp + roundDuration]
  assert(r1.closeTimestamp === r1.lockTimestamp + BigInt(roundDuration), 'Observation window is exactly one full 60s duration');

  // Test 5: Settlement & Dual-Keeper Gas Bounty Split
  console.log('\n--- Step 6: Settle Round & Gas Rebate Split ---');
  await increaseTime(65); // Move past new closeTimestamp

  // Price surges to $65,500 (UP wins!)
  const closePriceSurge = 6550000000000n;

  // Keeper 2 calls settle
  const settleTx = await amm.connect(keeper2).settleRoundWithUpdate(marketId, 1, reports(closePriceSurge, r1.closeTimestamp));
  await settleTx.wait();

  r1 = await amm.rounds(marketId, 1);
  assert(Number(r1.status) === 3, 'Round #1 Settled successfully (status = 3)');
  assert(Number(r1.winningSide) === 1, 'Winning side is UP (Side.Up = 1)');

  // Verify dual-keeper fee split:
  // Total pool = 12 (Up) + 10 (Down) = 22 MON
  // Total fee (1.5%) = 22 * 0.015 = 0.33 MON
  // Keeper fee (0.1%) = 22 * 0.001 = 0.022 MON
  // Split = 0.011 MON to Keeper 1 (locker), 0.011 MON to Keeper 2 (settler), credited for withdrawal
  assert(await amm.keeperRewards(await keeper1.getAddress()) === ethers.parseEther('0.011'), 'Keeper 1 (locker) credited 50% keeper bounty (0.011 MON)');
  assert(await amm.keeperRewards(await keeper2.getAddress()) === ethers.parseEther('0.011'), 'Keeper 2 (settler) credited remaining 50% keeper bounty (0.011 MON)');

  const keeper1BalBefore = await getBalance(keeper1);
  const kClaimRcpt = await (await amm.connect(keeper1).claimKeeperRewards()).wait();
  const keeper1Gain = await getBalance(keeper1) - keeper1BalBefore + kClaimRcpt.fee;
  assert(keeper1Gain === ethers.parseEther('0.011'), 'Keeper 1 withdrew exactly 0.011 MON via claimKeeperRewards()');

  // Test 6: Round Chaining & Round #2 Auto-Start
  console.log('\n--- Step 7: Next Round Opened by the Next Bet ---');
  const mAfter = await amm.markets(marketId);
  assert(mAfter.currentRoundId === 1n, 'Settling does not open a round (the next bet does; keeps settlement cheap)');

  // Test 7: Winner Claim & Protocol Solvency
  console.log('\n--- Step 8: Winner Payout Claim & Solvency ---');
  const user1BalBefore = await getBalance(user1);
  
  const claimTx = await amm.connect(user1).claimPayout(marketId, 1);
  const claimReceipt = await claimTx.wait();
  const claimGas = claimReceipt.fee;

  const user1BalAfter = await getBalance(user1);
  const user1Payout = user1BalAfter - user1BalBefore + claimGas;

  // Total pool 22 MON, Total Fee 0.33 MON -> Net Payout = 21.67 MON
  // User 1 owns 100% of Up pool (12 MON), so receives all 21.67 MON!
  assert(user1Payout === ethers.parseEther('21.67'), 'User 1 received exact expected winning payout of 21.67 MON');
  assert(await amm.totalWinnings(marketId) === ethers.parseEther('21.67'), 'totalWinnings tracks the settled net payout pool (21.67 MON)');

  // Double claim blocked
  let doubleClaimReverted = false;
  try {
    const tx = await amm.connect(user1).claimPayout(marketId, 1);
    await tx.wait();
  } catch (err) {
    doubleClaimReverted = true;
  }
  assert(doubleClaimReverted, 'Double claim on same round is strictly prevented');

  // Test 8: Late settlement resolves to the pinned price; genuine tie refunds (SEC-04)
  console.log('\n--- Step 9: Late Settlement & Tie Refund (SEC-04) ---');
  await (await amm.connect(user1).betUp(marketId, 2, { value: ethers.parseEther('5') })).wait();
  await (await amm.connect(user2).betDown(marketId, 2, { value: ethers.parseEther('5') })).wait();

  const r2Info = await amm.rounds(marketId, 2);
  const curBlk2 = await getLatestBlock();
  await increaseTime(Number(r2Info.lockTimestamp) - curBlk2.timestamp + 5);
  await (await amm.connect(keeper1).lockRoundWithUpdate(marketId, 2, reports(6425000000000n, r2Info.lockTimestamp))).wait();

  // Settle 190s late: the old contract cancelled here; now the pinned close price decides the round.
  // The feed did not move between the two pinned observations, so it is a genuine tie.
  await increaseTime(250);
  await (await amm.connect(keeper2).settleRoundWithUpdate(marketId, 2, reports(6425000000000n, r2Info.closeTimestamp))).wait();

  const r2After = await amm.rounds(marketId, 2);
  assert(Number(r2After.status) === 4, 'Round #2 cancelled on genuine price tie (status = 4)');

  // Invariant: Both users get 100% full refund on cancelled round
  const user1RefundBalBefore = await getBalance(user1);
  const refundTx1 = await amm.connect(user1).claimPayout(marketId, 2);
  const refundRcpt1 = await refundTx1.wait();
  const refundGas1 = refundRcpt1.fee;
  const user1RefundBalAfter = await getBalance(user1);

  assert(user1RefundBalAfter - user1RefundBalBefore + refundGas1 === ethers.parseEther('5'), 'User 1 received 100% refund on cancelled round');

  // Test 9: Signed oracle reports
  console.log('\n--- Step 10: Signed Oracle Reports ---');
  await (await amm.connect(user1).betUp(marketId, 3, { value: ethers.parseEther('1') })).wait();
  await (await amm.connect(user2).betDown(marketId, 3, { value: ethers.parseEther('1') })).wait();
  const r3 = await amm.rounds(marketId, 3);
  const blkNow = await getLatestBlock();
  await increaseTime(Number(r3.lockTimestamp) - blkNow.timestamp + 5);

  const lockFails = async (reps, reason) => {
    try {
      await amm.connect(keeper1).lockRoundWithUpdate.staticCall(marketId, 3, reps);
      return false;
    } catch (err) {
      return `${err.reason || ''} ${err.shortMessage || ''} ${err.message || ''}`.includes(reason);
    }
  };
  const pinMs = pinned(r3.lockTimestamp) * 1000n;
  assert(await lockFails(signerKeys.map((k) => signReport(k, 'BTC', 6425000000000n, pinMs + 40000n)), 'Report not at pinned timestamp'),
    'Reports more than 30 s after the pinned mark are rejected (a later mark is only a challengeable fallback, SEC-28)');
  assert(await lockFails(reports(6425000000000n, r3.lockTimestamp, signerKeys.slice(0, 4)), 'Not enough oracle signatures'),
    '4 of 5 signatures rejected: every signer must sign (no choice of signer subset)');
  const dup = reports(6425000000000n, r3.lockTimestamp);
  dup[4] = dup[0];
  assert(await lockFails(dup, 'Duplicate oracle signer'), 'The same signer twice is rejected');
  const rogue = new ethers.SigningKey(ethers.id('rogue'));
  assert(await lockFails([...reports(6425000000000n, r3.lockTimestamp).slice(0, 4), signReport(rogue, 'BTC', 6425000000000n, pinMs)], 'Signer not authorised'),
    'A report from an unknown key is rejected');
  const forged = reports(6425000000000n, r3.lockTimestamp);
  forged[2] = { ...forged[2], value: 9999900000000n };
  assert(await lockFails(forged, 'Signer not authorised'), 'A report whose value was altered after signing is rejected');
  const wrongFeed = signerKeys.map((k) => signReport(k, 'ETH', 6425000000000n, pinMs));
  assert(await lockFails(wrongFeed, 'Signer not authorised'), 'Reports signed for another feed are rejected');

  // Median of five slightly different node values
  const values = [6425000000000n, 6425100000000n, 6424900000000n, 6425300000000n, 6424000000000n];
  await (await amm.connect(keeper1).lockRoundWithUpdate(marketId, 3, signerKeys.map((k, i) => signReport(k, 'BTC', values[i], pinMs)))).wait();
  assert((await amm.rounds(marketId, 3)).lockPrice === 6425000000000n * 10n ** 28n, 'Lock price is the median of the signed values');

  // Test 10: Creator Royalty Claims
  console.log('\n--- Step 11: Creator Fee Royalties Claim ---');
  const creatorBalBefore = await getBalance(creator);
  const claimCreatorTx = await amm.connect(creator).claimCreatorFees(marketId);
  const creatorRcpt = await claimCreatorTx.wait();
  const creatorGas = creatorRcpt.fee;
  const creatorBalAfter = await getBalance(creator);

  // Round 1 volume was 22 MON, creator fee = 0.1% = 0.022 MON
  assert(creatorBalAfter - creatorBalBefore + creatorGas === ethers.parseEther('0.022'), 'Creator successfully claimed 0.1% royalties (0.022 MON)');

  // Test 12: Continuous play
  console.log('\n--- Step 12: Continuous Play (next round opens while the current one runs) ---');
  const failsWith = async (fn, reason) => { try { await fn(); return false; } catch (err) { return `${err.reason || ''} ${err.shortMessage || ''} ${err.message || ''}`.includes(reason); } };
  await (await amm.connect(owner).setProtocolParameters(5, 10, 600, ethers.parseEther('0.001'))).wait();
  await (await amm.connect(owner).setBettingWindow(10)).wait();
  await (await amm.connect(creator).createMarket(btcFeedId, 'Bitcoin', 'BTC/FAST', 20)).wait();
  const fast = ethers.solidityPackedKeccak256(['bytes32', 'string', 'uint256'], [btcFeedId, 'BTC/FAST', 20]);
  const f1 = await amm.rounds(fast, 1);
  const toStrike = Number(f1.lockTimestamp - f1.startTimestamp);
  assert(Number(f1.lockTimestamp) % 10 === 0 && toStrike >= 10 && toStrike < 20, `Strike ${toStrike} s after the round opens (10-19 s), on the 10 s report grid`);
  assert(f1.closeTimestamp - f1.lockTimestamp === 20n && f1.lockTimestamp - f1.betCloseTimestamp === 5n, 'Result 20 s after the strike; betting closes 5 s before the strike');
  await (await amm.connect(user1).betUp(fast, 1, { value: ethers.parseEther('2') })).wait();
  await (await amm.connect(user2).betDown(fast, 1, { value: ethers.parseEther('1') })).wait();
  assert(await failsWith(() => amm.connect(user1).betUp.staticCall(fast, 2, { value: ethers.parseEther('1') }), 'Current round still taking bets'),
    'The next round cannot open while the current one still takes bets');
  let blk = await getLatestBlock();
  await increaseTime(Number(f1.betCloseTimestamp) - blk.timestamp + 1);
  assert(await failsWith(() => amm.connect(user2).betDown.staticCall(fast, 1, { value: ethers.parseEther('1') }), 'Betting window closed'),
    'A late bet aimed at the closed round is rejected (never moved into another round)');
  await (await amm.connect(user2).betUp(fast, 2, { value: ethers.parseEther('1') })).wait();
  await (await amm.connect(user1).betDown(fast, 2, { value: ethers.parseEther('3') })).wait();
  assert((await amm.markets(fast)).currentRoundId === 2n && Number((await amm.rounds(fast, 1)).status) === 1,
    'A bet for the next round opens round 2 while round 1 is still running');
  assert(await failsWith(() => amm.connect(user1).betUp.staticCall(fast, 3, { value: ethers.parseEther('1') }), 'Current round still taking bets'),
    'Round 3 cannot open while round 2 takes bets');
  blk = await getLatestBlock();
  await increaseTime(Number(f1.lockTimestamp) - blk.timestamp + 1);
  await (await amm.connect(keeper1).lockRoundWithUpdate(fast, 1, reports(6400000000000n, f1.lockTimestamp))).wait();
  blk = await getLatestBlock();
  await increaseTime(Number(f1.closeTimestamp) - blk.timestamp + 1);
  await (await amm.connect(keeper2).settleRoundWithUpdate(fast, 1, reports(6410000000000n, f1.closeTimestamp))).wait();
  const f1done = await amm.rounds(fast, 1);
  assert(Number(f1done.status) === 3 && Number(f1done.winningSide) === 1 && (await amm.markets(fast)).currentRoundId === 2n,
    'Round 1 settles by its id (Rise won) and settling opens no round; round 2 is unaffected');
  const f2 = await amm.rounds(fast, 2);
  blk = await getLatestBlock();
  await increaseTime(Number(f2.lockTimestamp) - blk.timestamp + 1);
  await (await amm.connect(keeper1).lockRoundWithUpdate(fast, 2, reports(6410000000000n, f2.lockTimestamp))).wait();
  blk = await getLatestBlock();
  await increaseTime(Number(f2.closeTimestamp) - blk.timestamp + 1);
  await (await amm.connect(keeper2).settleRoundWithUpdate(fast, 2, reports(6405000000000n, f2.closeTimestamp))).wait();
  const f2done = await amm.rounds(fast, 2);
  const u1Before = await getBalance(user1);
  const batchRc = await (await amm.connect(user1).claimBatch(fast, [1n, 2n])).wait();
  const u1Got = (await getBalance(user1)) - u1Before + batchRc.fee;
  const expected = (ethers.parseEther('2') * f1done.netPayoutPool) / f1done.totalUp + (ethers.parseEther('3') * f2done.netPayoutPool) / f2done.totalDown;
  assert(Number(f2done.winningSide) === 2 && u1Got === expected, `User 1 won both overlapping rounds and claimed them in one transaction: exactly ${ethers.formatEther(u1Got)} MON`);
  await (await amm.connect(owner).setBettingWindow(0)).wait();

  await ganacheProvider.disconnect();
  await realRedStonePackages();

  console.log('\n================================================================================');
  console.log(`REAL EVM TEST VERDICT: ${passedTests}/${totalTests} TESTS PASSED SECURELY ON-CHAIN`);
  console.log('================================================================================\n');
}

// Test 11: packages captured from RedStone's free gateway verify against the production signer set
async function realRedStonePackages() {
  console.log('\n--- Step 12: Real RedStone Packages On-Chain ---');
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'redstone_primary_prod_packages.json'), 'utf8'));
  const parsed = fixture.BTC.map(parsePackage);
  const pkgTs = Number(parsed[0].report.timestampMs / 1000n);
  // Chain clock set so the round's lock report is exactly the captured one
  const gp = ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 4, defaultBalance: 1000 }, chain: { time: new Date((pkgTs - 65) * 1000) } });
  const provider = new ethers.BrowserProvider(gp);
  const [owner, a, b, keeper] = await provider.listAccounts();
  const load = (n) => [JSON.parse(fs.readFileSync(path.join(buildDir, `${n}.abi`), 'utf8')), `0x${fs.readFileSync(path.join(buildDir, `${n}.bin`), 'utf8').trim().replace(/^0x/, '')}`];
  const [abi, bin] = load('MonadUpDownAMM_sol_MonadUpDownAMM');
  const amm = await (await new ethers.ContractFactory(abi, bin, owner).deploy(REDSTONE_PRIMARY_SIGNERS, 5)).waitForDeployment();
  await (await amm.createMarket(feedIdBytes32('BTC'), 'Bitcoin', 'BTC/USD', 60)).wait();
  const marketId = ethers.solidityPackedKeccak256(['bytes32', 'string', 'uint256'], [feedIdBytes32('BTC'), 'BTC/USD', 60]);
  // A second contract with the production threshold (SEC-27: 4 of 5), opened in the same minute so
  // its lock report is the same captured timestamp
  const amm4 = await (await new ethers.ContractFactory(abi, bin, owner).deploy(REDSTONE_PRIMARY_SIGNERS, 4)).waitForDeployment();
  await (await amm4.createMarket(feedIdBytes32('BTC'), 'Bitcoin', 'BTC/USD', 60)).wait();
  await (await amm.connect(a).betUp(marketId, 1, { value: ethers.parseEther('1') })).wait();
  await (await amm.connect(b).betDown(marketId, 1, { value: ethers.parseEther('1') })).wait();
  const lockReportTs = await amm.lockReportTimestamp(marketId, 1);
  await (await amm4.connect(a).betUp(marketId, 1, { value: ethers.parseEther('1') })).wait();
  await (await amm4.connect(b).betDown(marketId, 1, { value: ethers.parseEther('1') })).wait();
  assert(Number(lockReportTs) === pkgTs, `Round's lock report timestamp matches the captured package (${pkgTs})`);
  await provider.send('evm_increaseTime', [70]);
  await provider.send('evm_mine', []);
  await (await amm.connect(keeper).lockRoundWithUpdate(marketId, 1, parsed.map((p) => p.report))).wait();
  const r = await amm.rounds(marketId, 1);
  const expected = medianUnits(parsed.map((p) => p.report.value)) * 10n ** 28n;
  assert(Number(r.status) === 2 && r.lockPrice === expected, `Real RedStone BTC reports (5 signers) locked the round at $${Number(expected / 10n ** 30n) / 1e6}`);

  assert(Number(await amm4.lockReportTimestamp(marketId, 1)) === pkgTs, 'Threshold-4 contract locks on the same captured report timestamp');
  let threeRejected = false;
  try {
    await amm4.connect(keeper).lockRoundWithUpdate.staticCall(marketId, 1, parsed.slice(0, 3).map((p) => p.report));
  } catch (err) {
    threeRejected = `${err.reason || ''} ${err.shortMessage || ''} ${err.message || ''}`.includes('Not enough oracle signatures');
  }
  assert(threeRejected, '4-of-5 contract: 3 real signatures are rejected (Not enough oracle signatures)');
  const four = parsed.slice(1, 5);
  await (await amm4.connect(keeper).lockRoundWithUpdate(marketId, 1, four.map((p) => p.report))).wait();
  const r4 = await amm4.rounds(marketId, 1);
  assert(Number(r4.status) === 2 && r4.lockPrice === medianUnits(four.map((p) => p.report.value)) * 10n ** 28n,
    '4-of-5 contract: one node missing, the other 4 real signatures lock the round at their median');

  await gp.disconnect();
}

runEvmTests().catch((err) => {
  console.error('\x1b[31m[FATAL ERROR]\x1b[0m', err);
  process.exit(1);
});
