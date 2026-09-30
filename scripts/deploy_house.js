/**
 * deploy_house.js
 * Deploys MonadPulseHouse with RedStone's primary-prod signer set (4 of 5), registers the markets from
 * src/config.js and seeds the vault.
 *
 * Usage:
 *   npm run deploy -- --dry-run                         pre-flight checks only
 *   npm run deploy -- --network testnet --seed 100      deploy and put 100 MON in the vault
 * Env: DEPLOYER_PRIVATE_KEY (never on the command line).
 *
 * The largest win one bet may take is 2% of the free vault, so the seed sets the table limit:
 * a 100 MON vault takes stakes up to ~2.2 MON at 1.90x.
 */

import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ENVIRONMENTS, SUPPORTED_MARKETS } from '../src/config.js';
import { REDSTONE_PRIMARY_SIGNERS, feedIdBytes32, fetchLatestReports } from '../src/oracle.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
if (args.includes('--private-key')) throw new Error('--private-key is not supported. Set DEPLOYER_PRIVATE_KEY in the environment instead.');
const isDryRun = args.includes('--dry-run');
const targetNet = arg('--network') || 'testnet';
const seed = arg('--seed');
const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
const config = ENVIRONMENTS[targetNet];
if (!config) throw new Error(`Unknown --network "${targetNet}". Use one of: ${Object.keys(ENVIRONMENTS).join(', ')}.`);
if (!isDryRun && !privateKey) throw new Error('DEPLOYER_PRIVATE_KEY is not set. Set it to deploy, or pass --dry-run.');
if (!isDryRun && !seed) throw new Error('Pass --seed <MON> for the vault (it sets the largest bet the house accepts).');

const signers = REDSTONE_PRIMARY_SIGNERS;
const threshold = 4;
// The network fee of a bet must stay a small share of the smallest bet; never below 0.1 MON. The fee
// comes from the chain: the node's gas estimate for a real placeBet on the new contract (+10%, the limit
// the app sends; Monad charges the full limit) at the current gas price.
const MAX_FEE_SHARE = 0.05;
const FLOOR = ethers.parseEther('0.1');
// A handful of sends were seen rejected as "insufficient balance" on well-funded wallets on Monad
// testnet, not really about the gasLimit value (see house_keeper.js for the closest thing to a root
// cause: overlapping transactions racing the same wallet key). Kept as a cheap defensive buffer - keep
// it in step with the same constant in Web3Manager.js if it changes.
const MIN_GAS_LIMIT = 200_000n;
const minBetFor = (feeWei) => {
  const raw = (feeWei * 100n) / BigInt(MAX_FEE_SHARE * 100);
  const step = 10n ** 16n;
  const rounded = ((raw + step - 1n) / step) * step;
  return rounded > FLOOR ? rounded : FLOOR;
};

const abi = JSON.parse(fs.readFileSync(path.join(rootDir, 'build', 'MonadPulseHouse_sol_MonadPulseHouse.abi'), 'utf8'));
const bytecode = fs.readFileSync(path.join(rootDir, 'build', 'MonadPulseHouse_sol_MonadPulseHouse.bin'), 'utf8').trim();

console.log(`MonadPulseHouse -> ${config.name} (chain ${config.chainId}) | ${isDryRun ? 'DRY-RUN' : 'LIVE'} | oracle ${threshold} of ${signers.length}`);
console.log(`Bytecode ${(bytecode.length - 2) / 2} bytes`);

const provider = new ethers.JsonRpcProvider(config.rpcUrl, undefined, { staticNetwork: true });
const network = await provider.getNetwork();
if (Number(network.chainId) !== Number(config.chainId)) throw new Error(`RPC returned chainId ${network.chainId}, expected ${config.chainId}.`);
const feeds = Object.values(SUPPORTED_MARKETS).map((m) => m.feed);
const latest = await fetchLatestReports(feeds, { signers });
for (const feed of feeds) {
  if (latest[feed].length < threshold) throw new Error(`RedStone: only ${latest[feed].length} of ${signers.length} signed ${feed} reports right now (need ${threshold}).`);
}
console.log(`[OK] RedStone signs ${feeds.join(', ')} with at least ${threshold} of ${signers.length} nodes`);
const gasPrice = (await provider.getFeeData()).gasPrice;
console.log(`[OK] Gas price ${ethers.formatUnits(gasPrice, 'gwei')} gwei (from the chain)`);

if (isDryRun) {
  const tx = await new ethers.ContractFactory(abi, bytecode).getDeployTransaction(signers, threshold);
  console.log(`[OK] Deployment simulates (gas ${await provider.estimateGas(tx)})`);
  process.exit(0);
}

const wallet = new ethers.Wallet(privateKey, provider);
const seedWei = ethers.parseEther(seed);
const balance = await provider.getBalance(wallet.address);
console.log(`Deployer ${wallet.address}: ${ethers.formatEther(balance)} MON`);
if (balance < seedWei + ethers.parseEther('2')) throw new Error(`Deployer needs the ${seed} MON seed plus ~2 MON for gas.`);

const house = await new ethers.ContractFactory(abi, bytecode, wallet).deploy(signers, threshold);
const deployTx = house.deploymentTransaction();
console.log(`Deploy tx ${deployTx.hash}`);
await house.waitForDeployment();
const address = await house.getAddress();
const deployBlock = (await deployTx.wait()).blockNumber;
console.log(`[OK] MonadPulseHouse at ${address} (block ${deployBlock})`);

for (const m of Object.values(SUPPORTED_MARKETS)) {
  await (await house.setMarket(m.marketId, feedIdBytes32(m.feed), true)).wait();
  console.log(`[OK] Market ${m.symbol} (${m.marketId.slice(0, 10)}…)`);
}
await (await house.addLiquidity({ value: seedWei })).wait();

// Minimum bet from the chain's own estimate of a first bet (the costliest: fresh storage)
const probeMarket = Object.values(SUPPORTED_MARKETS)[0].marketId;
const probeStake = (await house.maxStake()) / 2n;
const betGas = await house.placeBet.estimateGas(probeMarket, 1, 30, 0n, 0n, { value: probeStake });
const livePrice = (await provider.getFeeData()).gasPrice;
const buffered = (betGas * 110n) / 100n;
const realGasLimit = buffered > MIN_GAS_LIMIT ? buffered : MIN_GAS_LIMIT;
const feeWei = realGasLimit * livePrice;
const minBet = minBetFor(feeWei);
const BPS = 10_000n;
const [margin, winFee, cut, maxWinDefault, lead, free] = await Promise.all(
  [house.marginBps(), house.winFeeBps(), house.jackpotCutBps(), house.maxWinBps(), house.minLead(), house.freeLiquidity()]);
// minBet is set from live gas, independent of the vault's size; maxStake (what maxWinBps allows) is not.
// A small vault or a high gas price can put minBet above the default 2% maxWinBps's maxStake, leaving no
// bet size that fits at all. If 2% is not enough, jump straight to the contract's 10% ceiling (not the
// bare minimum that would technically fit minBet - that leaves a bet range only a few % wide, barely
// usable) so the seed still buys a real range of bet sizes, not just a sliver around the minimum.
const requiredMaxWin = (minBet * BPS * (BPS - margin) + free * (BPS + margin) - 1n) / (free * (BPS + margin));
if (requiredMaxWin > 1_000n) {
  throw new Error(`minBet (${ethers.formatEther(minBet)} MON, from live gas) would exceed maxStake even at the ` +
    `10% ceiling on this ${seed} MON vault. Re-run with a larger --seed (or wait for lower gas).`);
}
const maxWin = requiredMaxWin > maxWinDefault ? 1_000n : maxWinDefault;
await (await house.setParams(margin, winFee, cut, maxWin, minBet, lead)).wait();
console.log(`[OK] A bet costs ${betGas} gas (chain estimate) = ${ethers.formatEther(feeWei)} MON at ${ethers.formatUnits(livePrice, 'gwei')} gwei -> minBet ${ethers.formatEther(minBet)} MON`);
if (maxWin !== maxWinDefault) console.log(`[OK] Raised max win to ${Number(maxWin) / 100}% of the free vault so minBet still fits (default 2% would not have)`);
const maxStakeNow = await house.maxStake();
if (minBet > maxStakeNow) throw new Error(`Still broken after the fix: minBet ${ethers.formatEther(minBet)} > maxStake ${ethers.formatEther(maxStakeNow)}. This should not happen; please report it.`);
console.log(`[OK] Vault seeded with ${seed} MON; largest stake now ${ethers.formatEther(maxStakeNow)} MON`);

console.log('\nPoint the app, relay and keeper at it (.env):');
console.log(`  NEXT_PUBLIC_CONTRACT_ADDRESS=${address}`);
console.log(`  NEXT_PUBLIC_CONTRACT_DEPLOY_BLOCK=${deployBlock}`);
console.log(`Explorer: ${config.explorerUrl}/address/${address}`);
