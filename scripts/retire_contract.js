/**
 * scripts/retire_contract.js
 * Retires an old MonadPulseHouse deployment after a redeploy. Contracts cannot be deleted, so an old one
 * keeps any bug it had and anyone can still call it directly. Retiring it:
 *
 *   1. pauses it: no new bets or liquidity deposits (settlement, cash-outs and vault withdrawals stay
 *      open, so players and LPs can always take out what they are owed)
 *   2. withdraws its treasury (win fees) to the owner
 *
 * Usage: npm run retire -- 0xOLD_CONTRACT [--network testnet]   (owner key in DEPLOYER_PRIVATE_KEY or KEEPER_PRIVATE_KEY)
 */

import { ethers } from 'ethers';
import { ENVIRONMENTS } from '../src/config.js';
import { HOUSE_ABI } from '../src/contracts/HouseAbi.js';
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

const provider = new MonadRpcProvider(net.rpcUrl, net.chainId);
const wallet = new ethers.Wallet(key, provider);
const c = new ethers.Contract(address, HOUSE_ABI, wallet);
// A handful of sends were seen rejected as "insufficient balance" on well-funded wallets on Monad
// testnet, not really about the gasLimit value (see house_keeper.js for the closest thing to a root
// cause: overlapping transactions racing the same wallet key). Kept as a cheap defensive buffer.
const MIN_GAS_LIMIT = 200_000n;
const send = async (label, method, ...callArgs) => {
  const est = await c[method].estimateGas(...callArgs);
  const buffered = (est * 110n) / 100n;
  const gasLimit = buffered > MIN_GAS_LIMIT ? buffered : MIN_GAS_LIMIT;
  const rc = await (await c[method](...callArgs, { gasLimit })).wait();
  console.log(`  [OK] ${label} (tx ${rc.hash})`);
};

if ((await provider.getCode(address)) === '0x') throw new Error(`No contract at ${address}`);
if ((await c.owner()).toLowerCase() !== wallet.address.toLowerCase()) throw new Error(`${wallet.address} is not the owner of ${address}`);
console.log(`Retiring ${address} on ${net.name}; balance ${ethers.formatEther(await provider.getBalance(address))} MON`);

if (!(await c.paused())) await send('Paused: no new bets or liquidity deposits', 'setPaused', true);
else console.log('  [OK] Already paused');

const fees = await c.treasury();
if (fees > 0n) await send(`Treasury ${ethers.formatEther(fees)} MON withdrawn`, 'withdrawTreasury', wallet.address);
else console.log('  [--] Treasury is empty');

console.log(`Done. ${ethers.formatEther(await provider.getBalance(address))} MON remains: player balances and any unwithdrawn vault liquidity (both claimable any time).`);
