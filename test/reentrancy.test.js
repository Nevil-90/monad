import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import solc from 'solc';
import ganache from 'ganache';
import { ethers } from 'ethers';

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractsDir = path.join(rootDir, 'contracts');
const sources = {
  'SignedPriceOracle.sol': { content: fs.readFileSync(path.join(contractsDir, 'SignedPriceOracle.sol'), 'utf8') },
  'MonadPulseHouse.sol': { content: fs.readFileSync(path.join(contractsDir, 'MonadPulseHouse.sol'), 'utf8') },
  'ReentrancyAttacker.sol': { content: fs.readFileSync(path.join(rootDir, 'test/fixtures/ReentrancyAttacker.sol'), 'utf8') }
};
const input = {
  language: 'Solidity',
  sources,
  settings: { viaIR: true, optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } }
};
const output = JSON.parse(solc.compile(JSON.stringify(input)));
if (output.errors?.some((e) => e.severity === 'error')) {
  console.error(output.errors.filter((e) => e.severity === 'error').map((e) => e.formattedMessage).join('\n'));
  process.exit(1);
}
const houseArtifact = output.contracts['MonadPulseHouse.sol']['MonadPulseHouse'];
const attackerArtifact = output.contracts['ReentrancyAttacker.sol']['ReentrancyAttacker'];
console.log('Compiled both contracts OK.');

const eth = ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 10, defaultBalance: 100000 }, chain: { vmErrorsOnRPCResponse: true } });
const provider = new ethers.BrowserProvider(eth);
const [owner] = await provider.listAccounts();

const keys = [1, 2, 3, 4, 5].map((i) => new ethers.SigningKey(ethers.id(`oracle-signer-${i}`)));
const signerAddrs = keys.map((k) => ethers.computeAddress(k.publicKey));

const house = await (await new ethers.ContractFactory(houseArtifact.abi, houseArtifact.evm.bytecode.object, owner).deploy(signerAddrs, 4)).waitForDeployment();
const houseAddr = await house.getAddress();
console.log('House deployed at', houseAddr);

const attacker = await (await new ethers.ContractFactory(attackerArtifact.abi, attackerArtifact.evm.bytecode.object, owner).deploy(houseAddr)).waitForDeployment();
const attackerAddr = await attacker.getAddress();
console.log('Attacker deployed at', attackerAddr);

// Fund the attacker contract itself with native MON so it can call deposit()
await (await owner.sendTransaction({ to: attackerAddr, value: ethers.parseEther('50') })).wait();

// Attacker deposits liquidity
await (await attacker.deposit({ value: ethers.parseEther('10') })).wait();
const shareAmount = await attacker.shareAmount();
console.log('Attacker LP shares:', shareAmount.toString());

// Fast-forward past the 1-hour LP lock (ganache time warp - no live risk, this is all in-memory)
const now = () => provider.send('eth_getBlockByNumber', ['latest', false]).then((b) => parseInt(b.timestamp, 16));
const lpLockSeconds = await house.lpLockSeconds();
await provider.send('evm_setTime', [(await now() + Number(lpLockSeconds) + 10) * 1000]);
await provider.send('evm_mine', []);
console.log('Warped past LP lock.');

// Now trigger the real attack: removeLiquidity's low-level call will hit the attacker's receive(),
// which immediately tries to call removeLiquidity again before the first call returns.
let attackReverted = false;
let revertReason = '';
try {
  await (await attacker.attack(shareAmount)).wait();
} catch (err) {
  attackReverted = true;
  revertReason = err.shortMessage || err.message;
}

console.log('\n--- RESULTS ---');
console.log('Outer attack() call reverted:', attackReverted, attackReverted ? `(${revertReason})` : '');
console.log('Attacker receive() fired (reentered=true):', await attacker.reentered());
console.log('The REENTRANT removeLiquidity call inside receive() succeeded:', await attacker.reentrantCallSucceeded());

const sharesLeft = await house.shares(attackerAddr);
console.log('Attacker LP shares remaining on-chain:', sharesLeft.toString(), '(expected either 0 if a clean single withdrawal went through, or', shareAmount.toString(), 'if the whole attack tx reverted)');

const vaultAssets = await house.vaultAssets();
const totalShares = await house.totalShares();
console.log('vaultAssets', ethers.formatEther(vaultAssets), 'totalShares', totalShares.toString());

const verdict = !(await attacker.reentrantCallSucceeded());
console.log('\nVERDICT: reentrancy guard', verdict ? 'HELD - the reentrant call was blocked' : 'FAILED - the reentrant call succeeded, this is a real vulnerability');
process.exit(verdict ? 0 : 1);
