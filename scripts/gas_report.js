/**
 * scripts/gas_report.js
 * Gas used by every user and keeper action, measured on an in-memory chain with the compiled contract.
 * Monad charges the gas LIMIT (not gas used), so these numbers are what each action costs at best.
 *
 * Usage: npm run compile && node scripts/gas_report.js [gasPriceGwei]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ganache from 'ganache';
import { ethers } from 'ethers';
import { signReport, feedIdBytes32 } from '../src/oracle.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gwei = Number(process.argv[2] || 102);
const load = (n) => ({ abi: JSON.parse(fs.readFileSync(path.join(root, 'build', `${n}.abi`), 'utf8')), bin: `0x${fs.readFileSync(path.join(root, 'build', `${n}.bin`), 'utf8').trim().replace(/^0x/, '')}` });

const gp = ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 6, defaultBalance: 1000 } });
const provider = new ethers.BrowserProvider(gp);
const [owner, a, b, c, keeper] = await provider.listAccounts();
const keys = [1, 2, 3, 4, 5].map((i) => new ethers.SigningKey(ethers.id(`gas-signer-${i}`)));
const A = load('MonadUpDownAMM_sol_MonadUpDownAMM');
const amm = await (await new ethers.ContractFactory(A.abi, A.bin, owner).deploy(keys.map((k) => ethers.computeAddress(k.publicKey)), 5)).waitForDeployment();
const warp = async (ts) => {
  const now = Number((await gp.request({ method: 'eth_getBlockByNumber', params: ['latest', false] })).timestamp);
  if (ts > now) await provider.send('evm_increaseTime', [Number(ts) - now]);
  await provider.send('evm_mine', []);
};
const reports = (price, ts) => keys.map((k) => signReport(k, 'BTC', price, BigInt(ts) * 1000n));
const rows = [];
const measure = async (label, who, txPromise) => {
  const rc = await (await txPromise).wait();
  rows.push([label, who, rc.gasUsed]);
  return rc;
};

await measure('Create market (+ round 1)', 'market creator', amm.createMarket(feedIdBytes32('BTC'), 'Bitcoin', 'BTC/USD', 60));
const m = ethers.solidityPackedKeccak256(['bytes32', 'string', 'uint256'], [feedIdBytes32('BTC'), 'BTC/USD', 60]);
await measure('Bet, first on its side', 'bettor', amm.connect(a).betUp(m, 1, { value: ethers.parseEther('1') }));
await measure('Bet, first on the other side', 'bettor', amm.connect(b).betDown(m, 1, { value: ethers.parseEther('1') }));
await measure('Bet, joining a side (slippage guard)', 'bettor', amm.connect(c).betUpWithMinOdds(m, 1, 1n, { value: ethers.parseEther('1') }));
await measure('Bet, adding to own bet', 'bettor', amm.connect(a).betUp(m, 1, { value: ethers.parseEther('1') }));
let r = await amm.rounds(m, 1);
await warp(r.lockTimestamp);
await measure('Lock (5 signed reports)', 'keeper', amm.connect(keeper).lockRoundWithUpdate(m, 1, reports(8400000000000n, await amm.lockReportTimestamp(m, 1))));
await warp(r.closeTimestamp);
await measure('Settle (+ opens next round)', 'keeper', amm.connect(keeper).settleRoundWithUpdate(m, 1, reports(8410000000000n, await amm.closeReportTimestamp(m, 1))));
await measure('Claim a win', 'winner', amm.connect(a).claimPayout(m, 1));
// one-sided round -> cancelled -> refund
await amm.connect(a).betUp(m, 2, { value: ethers.parseEther('1') });
r = await amm.rounds(m, 2);
await warp(r.lockTimestamp);
await measure('Cancel one-sided round (+ opens next)', 'keeper', amm.connect(keeper).lockRoundWithUpdate(m, 2, []));
await measure('Claim a refund', 'bettor', amm.connect(a).claimPayout(m, 2));
// idle round replaced by the next bet
r = await amm.rounds(m, 3);
await warp(r.betCloseTimestamp + 5n);
await measure('Bet on an expired empty round (opens a new one)', 'bettor', amm.connect(b).betDown(m, 3, { value: ethers.parseEther('1') }));
await measure('Claim keeper rewards', 'keeper', amm.connect(keeper).claimKeeperRewards());

const mon = (g) => (Number(g) * gwei / 1e9).toFixed(4);
console.log(`Gas per action (fee at ${gwei} gwei; Monad charges the gas limit, so this is the minimum)\n`);
console.log('Action'.padEnd(48) + 'Paid by'.padEnd(16) + 'Gas'.padStart(9) + '   MON');
for (const [label, who, g] of rows) console.log(label.padEnd(48) + who.padEnd(16) + g.toString().padStart(9) + '   ' + mon(g));
await gp.disconnect();
