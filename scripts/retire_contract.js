/**
 * scripts/retire_contract.js
 * Retires an old deployment after a redeploy. Contracts cannot be deleted, so an old one keeps any bug
 * it had (e.g. SEC-29) and anyone can still call it directly. Retiring it:
 *
 *   1. pauses it: no new bets or markets, so no new round can be exploited
 *   2. deactivates its markets: no new rounds are chained
 *   3. withdraws its treasury fees and the keeper's rewards to the owner
 *
 * Claims, refunds, lock and settle stay open while paused (SEC-06), so players can always take out
 * what they are owed. The balance left afterwards is unclaimed player money.
 *
 * Usage: npm run retire -- 0xOLD_CONTRACT [--network testnet]   (owner key in KEEPER_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY)
 */

import { ethers } from 'ethers';
import { ENVIRONMENTS } from '../src/config.js';
import { MonadRpcProvider } from '../src/rpc.js';

const args = process.argv.slice(2);
const address = args.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
const net = ENVIRONMENTS[args.includes('--network') ? args[args.indexOf('--network') + 1] : 'testnet'];
const key = process.env.DEPLOYER_PRIVATE_KEY || process.env.KEEPER_PRIVATE_KEY;
if (!address || !net || !key) {
  console.error('Usage: npm run retire -- 0xOLD_CONTRACT [--network testnet]  (needs the owner key in .env)');
  process.exit(1);
}
if (net.contractAddress && address.toLowerCase() === net.contractAddress.toLowerCase()) {
  console.error('Refusing: that is the contract the app is configured to use (NEXT_PUBLIC_CONTRACT_ADDRESS).');
  process.exit(1);
}

// Only functions every deployment has had; each step reports its own result
const ABI = [
  'function owner() view returns (address)',
  'function paused() view returns (bool)',
  'function setPaused(bool)',
  'function getMarketCount() view returns (uint256)',
  'function allMarketIds(uint256) view returns (bytes32)',
  'function setMarketActive(bytes32,bool)',
  'function treasuryFees(bytes32) view returns (uint256)',
  'function withdrawTreasury(bytes32,address)',
  'function keeperRewards(address) view returns (uint256)',
  'function claimKeeperRewards()'
];

const provider = new MonadRpcProvider(net.rpcUrl, net.chainId);
const wallet = new ethers.Wallet(key, provider);
const c = new ethers.Contract(address, ABI, wallet);
const send = async (label, method, ...callArgs) => {
  const est = await c[method].estimateGas(...callArgs);
  const rc = await (await c[method](...callArgs, { gasLimit: (est * 110n) / 100n })).wait();
  console.log(`  [OK] ${label} (tx ${rc.hash})`);
};

if ((await provider.getCode(address)) === '0x') throw new Error(`No contract at ${address}`);
if ((await c.owner()).toLowerCase() !== wallet.address.toLowerCase()) throw new Error(`${wallet.address} is not the owner of ${address}`);
console.log(`Retiring ${address} on ${net.name}; balance ${ethers.formatEther(await provider.getBalance(address))} MON`);

if (!(await c.paused())) await send('Paused', 'setPaused', true);
else console.log('  [OK] Already paused');

const n = Number(await c.getMarketCount());
for (let i = 0; i < n; i++) {
  const id = await c.allMarketIds(i);
  try {
    await send(`Market ${id.slice(0, 10)}… deactivated`, 'setMarketActive', id, false);
  } catch (err) {
    console.log(`  [--] Market ${id.slice(0, 10)}…: ${err.shortMessage || err.message}`);
  }
  const fees = await c.treasuryFees(id);
  if (fees > 0n) await send(`Treasury ${ethers.formatEther(fees)} MON withdrawn`, 'withdrawTreasury', id, wallet.address);
}
const rewards = await c.keeperRewards(wallet.address);
if (rewards > 0n) await send(`Keeper rewards ${ethers.formatEther(rewards)} MON claimed`, 'claimKeeperRewards');

console.log(`Done. ${ethers.formatEther(await provider.getBalance(address))} MON remains: unclaimed player payouts/refunds (claimable any time).`);
