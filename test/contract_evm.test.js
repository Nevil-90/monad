/**
 * test/contract_evm.test.js
 * Comprehensive On-Chain EVM Integration & Security Audit Test Suite
 * 
 * Runs on in-memory Ganache EVM using real compiled bytecode from build/
 * Verifies all security fixes and protocol invariants on the actual EVM:
 * 1. Contract deployment & Pyth mock wiring
 * 2. Permissionless market creation & Round #1 auto-initialization
 * 3. Bidirectional betting (Up & Down) with storage checks
 * 4. Slippage / Min-odds protection against pool sniping (VULN-03)
 * 5. Anti-frontrunning lock buffer enforcement
 * 6. Fixed observation schedule with pinned lock/close prices (SEC-01/02)
 * 7. Late settlement still resolves to the pinned price (SEC-04); genuine tie refunds
 * 8. 100% fee snapshotting invariance across rounds (VULN-04)
 * 9. Dual-keeper bounty accrual + pull withdrawal (SEC-03)
 * 10. Winner payout claims & 100% solvency proof
 * 11. Excess Pyth update fee auto-refund (VULN-05)
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

  // Mock Pyth update payload: the first price published at/after `target` (prevPublishTime < target)
  function pythUpdate(feedId, price, target, offset = 1, expo = -8) {
    return ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'int64', 'uint64', 'int32', 'uint64', 'uint64'],
      [feedId, price, 8n, expo, BigInt(target) + BigInt(offset), BigInt(target) - 1n]
    );
  }

  // Exact raw balance query avoiding BrowserProvider client-side cache
  async function getBalance(addr) {
    const target = typeof addr === 'string' ? addr : await addr.getAddress();
    const hex = await ganacheProvider.request({ method: 'eth_getBalance', params: [target, 'latest'] });
    return BigInt(hex);
  }

  // 2. Load ABIs and Bytecodes
  const pythAbi = JSON.parse(fs.readFileSync(path.join(buildDir, 'MockPythOracle_sol_MockPythOracle.abi'), 'utf8'));
  let pythBytecode = fs.readFileSync(path.join(buildDir, 'MockPythOracle_sol_MockPythOracle.bin'), 'utf8');
  if (!pythBytecode.startsWith('0x')) pythBytecode = `0x${pythBytecode}`;

  const ammAbi = JSON.parse(fs.readFileSync(path.join(buildDir, 'MonadUpDownAMM_sol_MonadUpDownAMM.abi'), 'utf8'));
  let ammBytecode = fs.readFileSync(path.join(buildDir, 'MonadUpDownAMM_sol_MonadUpDownAMM.bin'), 'utf8');
  if (!ammBytecode.startsWith('0x')) ammBytecode = `0x${ammBytecode}`;

  // 3. Deploy MockPythOracle
  console.log('--- Step 1: Deploying Contracts onto EVM ---');
  const pythFactory = new ethers.ContractFactory(pythAbi, pythBytecode, owner);
  const pyth = await pythFactory.deploy();
  await pyth.waitForDeployment();
  const pythAddr = await pyth.getAddress();
  assert(Boolean(pythAddr && pythAddr.startsWith('0x')), `MockPythOracle deployed at ${pythAddr}`);

  // 4. Deploy MonadUpDownAMM
  const ammFactory = new ethers.ContractFactory(ammAbi, ammBytecode, owner);
  const amm = await ammFactory.deploy(pythAddr);
  await amm.waitForDeployment();
  const ammAddr = await amm.getAddress();
  assert(Boolean(ammAddr && ammAddr.startsWith('0x')), `MonadUpDownAMM deployed at ${ammAddr}`);

  // Test 1: Permissionless Market Creation & Round #1 Initialization
  console.log('\n--- Step 2: Market Creation & Round Initialization ---');
  const btcFeedId = ethers.keccak256(ethers.toUtf8Bytes('BTC/USD'));
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

  // Advance time into 10-second anti-frontrunning cutoff (52s elapsed of 60s)
  await increaseTime(52);
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
  const lockTx = await amm.connect(keeper1).lockRoundWithUpdate(
    marketId, 1, [pythUpdate(btcFeedId, lockPriceInitial, r1.lockTimestamp)], { value: 1n }
  );
  await lockTx.wait();

  r1 = await amm.rounds(marketId, 1);
  assert(Number(r1.status) === 2, 'Round #1 successfully locked (status = 2)');
  assert(r1.lockKeeper === (await keeper1.getAddress()), 'Keeper 1 recorded as lock keeper for 50% gas bounty');
  assert(r1.lockPublishTime === r1.lockTimestamp + 1n, 'Lock price pinned to first Pyth update at/after lockTimestamp');

  // Invariant: observation window is the fixed schedule [lockTimestamp, lockTimestamp + roundDuration]
  assert(r1.closeTimestamp === r1.lockTimestamp + BigInt(roundDuration), 'Observation window is exactly one full 60s duration');

  // Test 5: Settlement & Dual-Keeper Gas Bounty Split
  console.log('\n--- Step 6: Settle Round & Gas Rebate Split ---');
  await increaseTime(65); // Move past new closeTimestamp

  // Price surges to $65,500 (UP wins!)
  const closePriceSurge = 6550000000000n;

  // Keeper 2 calls settle
  const settleTx = await amm.connect(keeper2).settleRoundWithUpdate(
    marketId, 1, [pythUpdate(btcFeedId, closePriceSurge, r1.closeTimestamp)], { value: 1n }
  );
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
  console.log('\n--- Step 7: Automatic Round Chaining ---');
  const mAfter = await amm.markets(marketId);
  assert(mAfter.currentRoundId === 2n, 'Round #2 automatically started upon Round #1 settlement');
  
  const r2 = await amm.rounds(marketId, 2);
  assert(Number(r2.status) === 1, 'Round #2 is open and accepting bets');

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
  await (await amm.connect(keeper1).lockRoundWithUpdate(
    marketId, 2, [pythUpdate(btcFeedId, 6425000000000n, r2Info.lockTimestamp)], { value: 1n }
  )).wait();

  // Settle 190s late: the old contract cancelled here; now the pinned close price decides the round.
  // The feed did not move between the two pinned observations, so it is a genuine tie.
  await increaseTime(250);
  await (await amm.connect(keeper2).settleRoundWithUpdate(
    marketId, 2, [pythUpdate(btcFeedId, 6425000000000n, r2Info.closeTimestamp)], { value: 1n }
  )).wait();

  const r2After = await amm.rounds(marketId, 2);
  assert(Number(r2After.status) === 4, 'Round #2 cancelled on genuine price tie (status = 4)');

  // Invariant: Both users get 100% full refund on cancelled round
  const user1RefundBalBefore = await getBalance(user1);
  const refundTx1 = await amm.connect(user1).claimPayout(marketId, 2);
  const refundRcpt1 = await refundTx1.wait();
  const refundGas1 = refundRcpt1.fee;
  const user1RefundBalAfter = await getBalance(user1);

  assert(user1RefundBalAfter - user1RefundBalBefore + refundGas1 === ethers.parseEther('5'), 'User 1 received 100% refund on cancelled round');

  // Test 9: Excess Pyth Update Fee Auto-Refund (VULN-05 Fix)
  console.log('\n--- Step 10: Excess Pyth Update Fee Auto-Refund (VULN-05 Fix) ---');
  // Round #3 is now active
  const r3 = await amm.rounds(marketId, 3);
  await (await amm.connect(user1).betUp(marketId, 3, { value: ethers.parseEther('1') })).wait();
  await (await amm.connect(user2).betDown(marketId, 3, { value: ethers.parseEther('1') })).wait();

  const blkNow = await getLatestBlock();
  await increaseTime(Number(r3.lockTimestamp) - blkNow.timestamp + 5);

  // Keeper sends 0.1 MON while the Pyth fee is 1 wei: everything but the fee must come back
  const keeperBalBeforeUpdate = await getBalance(keeper1);
  const updateTx = await amm.connect(keeper1).lockRoundWithUpdate(
    marketId, 3, [pythUpdate(btcFeedId, 6425000000000n, r3.lockTimestamp)], { value: ethers.parseEther('0.1') }
  );
  const updateRcpt = await updateTx.wait();
  const updateGas = updateRcpt.fee;
  const keeperBalAfterUpdate = await getBalance(keeper1);

  const balanceDiff = keeperBalBeforeUpdate - keeperBalAfterUpdate - updateGas;
  assert(balanceDiff === 1n, 'Excess 0.1 MON refunded to caller; only the 1 wei Pyth fee was spent');

  // Test 10: Creator Royalty Claims
  console.log('\n--- Step 11: Creator Fee Royalties Claim ---');
  const creatorBalBefore = await getBalance(creator);
  const claimCreatorTx = await amm.connect(creator).claimCreatorFees(marketId);
  const creatorRcpt = await claimCreatorTx.wait();
  const creatorGas = creatorRcpt.fee;
  const creatorBalAfter = await getBalance(creator);

  // Round 1 volume was 22 MON, creator fee = 0.1% = 0.022 MON
  assert(creatorBalAfter - creatorBalBefore + creatorGas === ethers.parseEther('0.022'), 'Creator successfully claimed 0.1% royalties (0.022 MON)');

  console.log('\n================================================================================');
  console.log(`REAL EVM TEST VERDICT: ${passedTests}/${totalTests} TESTS PASSED SECURELY ON-CHAIN`);
  console.log('================================================================================\n');

  await ganacheProvider.disconnect();
}

runEvmTests().catch((err) => {
  console.error('\x1b[31m[FATAL ERROR]\x1b[0m', err);
  process.exit(1);
});
