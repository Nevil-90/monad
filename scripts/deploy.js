/**
 * deploy.js
 * Production-Ready Deployment & On-Chain Market Initialization Engine for Monad AMM
 * 
 * Supports:
 * - Live deployment with signer: DEPLOYER_PRIVATE_KEY=<HEX_KEY> node scripts/deploy.js --network testnet
 * - Local devnet / simulation: node scripts/deploy.js --dry-run
 * 
 * Flow:
 * 1. Validates RPC connectivity and gas parameters.
 * 2. Deploys MonadUpDownAMM with RedStone's primary-prod signer set (4 of 5 signatures required).
 * 3. Initializes canonical markets (BTC, ETH, SOL, MON) and marks them verified.
 * 4. Outputs verified contract addresses and deployment receipt.
 */

import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ENVIRONMENTS, SUPPORTED_MARKETS, TYPICAL_GAS, ROUND_RULES } from '../src/config.js';
import { REDSTONE_PRIMARY_SIGNERS, feedIdBytes32, fetchLatestReports, fetchReportsAt } from '../src/oracle.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

console.log('================================================================================');
console.log('MONADPULSE AMM: PRODUCTION & TESTNET DEPLOYMENT ENGINE');
console.log('================================================================================\n');

async function deploy() {
  const args = process.argv.slice(2);
  const targetNet = args.includes('--network') ? args[args.indexOf('--network') + 1] : 'testnet';
  // SEC-10: keys from the environment only; argv leaks into shell history and `ps`
  if (args.includes('--private-key')) {
    throw new Error('--private-key is not supported. Set DEPLOYER_PRIVATE_KEY in the environment instead.');
  }
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  const isDryRun = args.includes('--dry-run');
  if (!isDryRun && !privateKey) {
    throw new Error('DEPLOYER_PRIVATE_KEY is not set. Set it to deploy, or pass --dry-run to only run pre-flight checks.');
  }

  const config = ENVIRONMENTS[targetNet];
  if (!config) throw new Error(`Unknown --network "${targetNet}". Use one of: ${Object.keys(ENVIRONMENTS).join(', ')}.`);
  const signers = REDSTONE_PRIMARY_SIGNERS;
  // 4 of 5 (SEC-27): all 5 left rounds unsettleable whenever one node skipped a report (seen on
  // testnet); 4 tolerates one missing node, and the keeper's choice of which 4 moves the median only
  // within the spread between the nodes' values.
  const threshold = 4;
  // SEC-11: network fees to bet and claim must stay a small share of the smallest bet. minBet is set so
  // that at the gas price at deploy time they are at most MAX_FEE_SHARE of it (owner can re-tune later
  // with setProtocolParameters as gas prices move).
  const MAX_FEE_SHARE = 0.05;
  const minBetFor = (gasPrice) => {
    const feeWei = (BigInt(TYPICAL_GAS.bet + TYPICAL_GAS.claim) * gasPrice * 110n) / 100n;
    const raw = (feeWei * 100n) / BigInt(MAX_FEE_SHARE * 100);
    const step = 10n ** 16n; // round up to 0.01 MON
    return ((raw + step - 1n) / step) * step;
  };
  console.log(`[1] Selected Target Environment: ${config.name}`);
  console.log(`    Chain ID: ${config.chainId} (${config.chainIdHex})`);
  console.log(`    RPC Endpoint: ${config.rpcUrl}`);
  console.log(`    Oracle: RedStone primary-prod, ${threshold} of ${signers.length} signatures required`);
  console.log(`    Deployment Mode: ${isDryRun ? 'DRY-RUN / PRE-FLIGHT VERIFICATION' : 'LIVE BROADCAST'}`);

  // Load compiled artifacts
  const buildDir = path.join(rootDir, 'build');
  const ammBinPath = path.join(buildDir, 'MonadUpDownAMM_sol_MonadUpDownAMM.bin');
  const ammAbiPath = path.join(buildDir, 'MonadUpDownAMM_sol_MonadUpDownAMM.abi');

  if (!fs.existsSync(ammBinPath) || !fs.existsSync(ammAbiPath)) {
    throw new Error('Contract artifacts not found in build/. Run `npm run compile` first.');
  }

  const bytecode = fs.readFileSync(ammBinPath, 'utf8').trim();
  const abi = JSON.parse(fs.readFileSync(ammAbiPath, 'utf8'));

  console.log(`\n[2] Contract Artifacts Loaded:`);
  console.log(`    Bytecode Size: ${(bytecode.length - 2) / 2} bytes`);
  console.log(`    ABI Functions: ${abi.filter(x => x.type === 'function').length} functions`);

  console.log('\n[3] Verifying market IDs against src/config.js:');
  for (const [key, m] of Object.entries(SUPPORTED_MARKETS)) {
    const canonicalKey = ethers.keccak256(
      ethers.solidityPacked(['bytes32', 'string', 'uint256'], [feedIdBytes32(m.feed), m.symbol, m.roundDuration])
    );
    if (canonicalKey !== m.marketId) throw new Error(`${m.symbol}: marketId in src/config.js does not match ${canonicalKey}`);
    console.log(`    - ${m.symbol} | feed ${m.feed} | market ID ${canonicalKey.slice(0, 18)}... matches config`);
  }

  if (isDryRun) {
    console.log('\n[4] Pre-Flight Checks (each one must pass):');
    const provider = new ethers.JsonRpcProvider(config.rpcUrl, undefined, { staticNetwork: true });
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== Number(config.chainId)) {
      throw new Error(`RPC returned chainId ${network.chainId}, expected ${config.chainId}.`);
    }
    console.log(`    [OK] RPC reachable, chainId ${network.chainId}`);
    const feeds = Object.values(SUPPORTED_MARKETS).map((m) => m.feed);
    const latest = await fetchLatestReports(feeds, { signers });
    for (const feed of feeds) {
      if (latest[feed].length < threshold) throw new Error(`RedStone: only ${latest[feed].length} of ${signers.length} signed ${feed} reports right now (need ${threshold}).`);
    }
    console.log(`    [OK] RedStone gateway: at least ${threshold} of ${signers.length} signers currently sign ${feeds.join(', ')}`);
    const past = (Math.floor(Date.now() / 10000) * 10000) - 3600e3;
    const hist = await fetchReportsAt(feeds, past, { signers });
    for (const feed of feeds) {
      if (hist[feed].length < threshold) throw new Error(`RedStone history: only ${hist[feed].length} signed ${feed} reports for ${past / 1000} (need ${threshold}).`);
    }
    console.log(`    [OK] RedStone history: complete reports for an hour ago (${past / 1000}); the keeper can settle any round of the last 24 h`);
    const gasPrice = (await provider.getFeeData()).gasPrice;
    console.log(`    [OK] Gas price ${ethers.formatUnits(gasPrice, 'gwei')} gwei -> minBet ${ethers.formatEther(minBetFor(gasPrice))} MON (fees <= ${MAX_FEE_SHARE * 100}% of the smallest bet)`);
    const factory = new ethers.ContractFactory(abi, bytecode);
    const deployTx = await factory.getDeployTransaction(signers, threshold);
    const gas = await provider.estimateGas(deployTx);
    console.log(`    [OK] Deployment simulates successfully (estimated gas ${gas})`);
    console.log('\n================================================================================');
    console.log('DRY-RUN COMPLETE: pre-flight checks passed');
    console.log('To broadcast live to Monad Testnet:');
    console.log('  npm run deploy -- --network testnet   (DEPLOYER_PRIVATE_KEY in .env)');
    console.log('================================================================================');
    return;
  }

  // Live On-Chain Deployment
  console.log('\n[4] Connecting Deployer Signer...');
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  const balanceWei = await provider.getBalance(wallet.address);
  console.log(`    Deployer Address: ${wallet.address}`);
  console.log(`    Account Balance:  ${ethers.formatEther(balanceWei)} MON`);

  if (balanceWei === 0n) {
    throw new Error('Deployer balance is 0 MON. Please fund your wallet via the Monad faucet before deploying.');
  }

  console.log('\n[5] Broadcasting MonadUpDownAMM Deployment Transaction...');
  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const contract = await factory.deploy(signers, threshold);
  console.log(`    Tx Broadcast: ${contract.deploymentTransaction()?.hash}`);
  console.log('    Waiting for confirmation on Monad...');

  await contract.waitForDeployment();
  const deployedAddress = await contract.getAddress();
  console.log(`    [SUCCESS] MonadUpDownAMM Deployed to: ${deployedAddress}`);

  const gasPrice = (await provider.getFeeData()).gasPrice;
  const minBet = minBetFor(gasPrice);
  const [priceWindow, timeout] = await Promise.all([contract.priceWindowSeconds(), contract.emergencyTimeout()]);
  await (await contract.setProtocolParameters(ROUND_RULES.lockBuffer, priceWindow, timeout, minBet)).wait();
  await (await contract.setBettingWindow(ROUND_RULES.bettingWindow)).wait();
  console.log(`    [OK] minBet ${ethers.formatEther(minBet)} MON at ${ethers.formatUnits(gasPrice, 'gwei')} gwei (SEC-11)`);
  console.log(`    [OK] Rounds: betting ${ROUND_RULES.bettingWindow} s, closes ${ROUND_RULES.lockBuffer} s before the strike`);

  console.log('\n[6] Initializing Canonical Multi-Markets On-Chain...');
  for (const [key, m] of Object.entries(SUPPORTED_MARKETS)) {
    console.log(`    Creating Market: ${m.symbol} (${m.name}, duration: ${m.roundDuration}s)...`);
    const tx = await contract.createMarket(feedIdBytes32(m.feed), m.name, m.symbol, m.roundDuration);
    await tx.wait();
    await (await contract.setMarketVerified(m.marketId, true)).wait();
    console.log(`    [OK] Market ${m.symbol} initialized. Tx: ${tx.hash}`);
  }

  console.log('\n================================================================================');
  console.log('DEPLOYMENT COMPLETE: MONADPULSE MULTI-MARKET AMM LIVE ON-CHAIN');
  console.log(`Contract Address: ${deployedAddress}`);
  console.log(`Explorer Link:    ${config.explorerUrl}/address/${deployedAddress}`);
  const deployBlock = (await contract.deploymentTransaction().wait()).blockNumber;
  console.log('Point the frontend at this deployment:');
  console.log(`  NEXT_PUBLIC_CONTRACT_ADDRESS=${deployedAddress}`);
  console.log(`  NEXT_PUBLIC_CONTRACT_DEPLOY_BLOCK=${deployBlock}`);
  console.log('================================================================================\n');
}

deploy().catch(err => {
  console.error('\n[DEPLOYMENT FAILED]', err);
  process.exit(1);
});
