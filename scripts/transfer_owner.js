/**
 * scripts/transfer_owner.js
 * Hands the contract's owner role to a multisig (SEC-16), using the two-step transfer (SEC-07).
 *
 *   1. checks the new owner is a deployed Safe that needs at least 2 signatures (refuses a plain
 *      wallet or a 1-of-n Safe, which would be no safer than the current single key)
 *   2. calls transferOwnership(safe) from the current owner
 *   3. prints the transaction the Safe's signers must approve: acceptOwnership() on the contract
 *
 * Until the Safe accepts, the current owner stays in control, so a wrong address changes nothing.
 * What the owner can and cannot do is listed in SECURITY_FIXES.md (SEC-16): it cannot touch pool
 * money in any case; the multisig protects the fee settings, pause and the 2-day oracle signer change.
 *
 * Usage: npm run transfer-owner -- 0xSAFE [--network testnet]   (current owner key in DEPLOYER_PRIVATE_KEY or KEEPER_PRIVATE_KEY)
 */

import { ethers } from 'ethers';
import { ENVIRONMENTS } from '../src/config.js';
import { AMM_ABI } from '../src/contracts/AMMAbi.js';
import { MonadRpcProvider } from '../src/rpc.js';

const args = process.argv.slice(2);
const safe = args.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
const net = ENVIRONMENTS[args.includes('--network') ? args[args.indexOf('--network') + 1] : 'testnet'];
const key = process.env.DEPLOYER_PRIVATE_KEY || process.env.KEEPER_PRIVATE_KEY;
if (!safe || !net || !key || !net.contractAddress) {
  console.error('Usage: npm run transfer-owner -- 0xSAFE [--network testnet]  (owner key and NEXT_PUBLIC_CONTRACT_ADDRESS in .env)');
  process.exit(1);
}

const provider = new MonadRpcProvider(net.rpcUrl, net.chainId);
const wallet = new ethers.Wallet(key, provider);
const amm = new ethers.Contract(net.contractAddress, AMM_ABI, wallet);
const safeAbi = ['function getOwners() view returns (address[])', 'function getThreshold() view returns (uint256)'];

if ((await amm.owner()).toLowerCase() !== wallet.address.toLowerCase()) throw new Error(`${wallet.address} is not the current owner.`);
if ((await provider.getCode(safe)) === '0x') throw new Error(`${safe} has no code: it is a plain wallet, not a multisig.`);
let owners;
let threshold;
try {
  const s = new ethers.Contract(safe, safeAbi, provider);
  [owners, threshold] = await Promise.all([s.getOwners(), s.getThreshold()]);
} catch (_) {
  throw new Error(`${safe} does not answer as a Safe (getOwners/getThreshold).`);
}
console.log(`Safe ${safe}: ${threshold} of ${owners.length} signatures required`);
for (const o of owners) console.log(`  signer ${o}`);
if (threshold < 2n) throw new Error('A 1-of-n Safe is no safer than a single key. Use at least 2 required signatures.');

const est = await amm.transferOwnership.estimateGas(safe);
const rc = await (await amm.transferOwnership(safe, { gasLimit: (est * 110n) / 100n })).wait();
console.log(`[OK] transferOwnership(${safe}) sent: ${rc.hash}`);
console.log('\nNow, in the Safe app, create a transaction for the signers to approve:');
console.log(`  to:    ${net.contractAddress}`);
console.log('  value: 0');
console.log(`  data:  ${amm.interface.encodeFunctionData('acceptOwnership', [])}   (acceptOwnership())`);
console.log(`Until it executes, ${wallet.address} remains the owner.`);
