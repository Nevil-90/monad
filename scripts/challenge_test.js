/**
 * scripts/challenge_test.js
 * Live check of the SEC-28 challenge path on the deployed contract, with real RedStone reports.
 * Plays a dishonest keeper that locks and settles a contested round on LATER reports than the pinned
 * ones (legal, but challengeable), then starts the real keeper and checks that it replaces each with
 * the pinned report fetched from RedStone's history, so the round settles at the exact prices.
 *
 * Run with NO other keeper running (it would lock first with the pinned report):
 *   npm run test:challenge            (reads .env; uses data/test-wallets.json players 0 and 1)
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
import { getConfig, SUPPORTED_MARKETS } from '../src/config.js';
import { AMM_ABI } from '../src/contracts/AMMAbi.js';
import { MonadRpcProvider } from '../src/rpc.js';
import { fetchReportsAt } from '../src/oracle.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = getConfig();
const provider = new MonadRpcProvider(cfg.rpcUrl, cfg.chainId);
const funder = new ethers.Wallet(process.env.KEEPER_PRIVATE_KEY, provider);
const amm = new ethers.Contract(cfg.contractAddress, AMM_ABI, provider);
const keys = JSON.parse(fs.readFileSync(path.join(root, 'data', 'test-wallets.json'), 'utf8'));
const [p0, p1] = keys.slice(0, 2).map((k) => new ethers.Wallet(k, provider));
const market = SUPPORTED_MARKETS.ETH;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let passed = 0;
let failed = 0;
const check = (ok, msg) => { ok ? passed++ : failed++; console.log(`${ok ? '[PASS]' : '\x1b[31m[FAIL]\x1b[0m'} ${msg}`); };
const waitUntil = async (sec) => { while (Date.now() / 1000 < sec) await sleep(500); };

async function reportsAt(ts) {
  const threshold = Number(await amm.signerThreshold());
  const signers = await amm.oracleSigners();
  for (;;) {
    const sets = await fetchReportsAt([market.feed], ts * 1000, { signers });
    if (sets[market.feed].length >= threshold) return sets[market.feed].map((p) => p.report);
    await sleep(4000);
  }
}

function startKeeper() {
  const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'scripts/keeper_bot.js', '--mode', 'live'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = (d) => String(d).split('\n').filter((l) => /\[(LOCK|SETTLE|IMPROVE|FINALIZE|PROPOSE|ERROR|LATE)/.test(l)).forEach((l) => log('  keeper:', l.trim()));
  child.stdout.on('data', out);
  child.stderr.on('data', out);
  return child;
}

// A fresh contested round with plenty of betting time
let rId;
for (;;) {
  const m = await amm.markets(market.marketId);
  const r = await amm.rounds(market.marketId, m.currentRoundId);
  const now = Date.now() / 1000;
  const oneSided = r.totalUp === 0n || r.totalDown === 0n;
  if ((Number(r.status) === 1 && now < Number(r.betCloseTimestamp) - 15) || (Number(r.status) === 1 && oneSided && now > Number(r.betCloseTimestamp))) {
    rId = m.currentRoundId;
    break;
  }
  await sleep(3000);
}
const minBet = await amm.minBet();
for (const p of [p0, p1]) {
  if ((await provider.getBalance(p.address)) < minBet * 3n) await (await funder.sendTransaction({ to: p.address, value: minBet * 4n })).wait();
}
const rc = await (await amm.connect(p0).betUp(market.marketId, rId, { value: minBet })).wait();
rId = rc.logs.map((l) => { try { return amm.interface.parseLog(l); } catch (_) { return null; } }).find((e) => e?.name === 'BetPlaced').args.roundId;
await (await amm.connect(p1).betDown(market.marketId, rId, { value: minBet })).wait();
let r = await amm.rounds(market.marketId, rId);
const step = Number(r.priceWindow);
const lockPin = Math.ceil(Number(r.lockTimestamp) / step) * step;
const closePin = Math.ceil(Number(r.closeTimestamp) / step) * step;
log(`ETH round ${rId}: contested; lock report ${lockPin}, close report ${closePin}`);

// Dishonest lock: the report 20 s after the pinned one (published ~2 s after its own time)
await waitUntil(lockPin + 20 + 3);
await (await amm.connect(funder).lockRoundWithUpdate(market.marketId, rId, await reportsAt(lockPin + 20))).wait();
r = await amm.rounds(market.marketId, rId);
check(Number(r.status) === 2 && Number(r.lockPublishTime) === lockPin + 20 && r.finalizeAfter > 0n,
  `Locked on the late report (${lockPin + 20}): accepted provisionally, challenge period until ${r.finalizeAfter}`);

// The real keeper must replace it with the pinned report from RedStone's history
let keeper = startKeeper();
for (let i = 0; i < 60 && Number((await amm.rounds(market.marketId, rId)).lockPublishTime) !== lockPin; i++) await sleep(2000);
r = await amm.rounds(market.marketId, rId);
const exactLock = await reportsAt(lockPin);
const median = (vals) => { const v = [...vals].sort((a, b) => (a < b ? -1 : 1)); return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2n; };
check(Number(r.lockPublishTime) === lockPin, `Keeper replaced it with the pinned lock report (${lockPin})`);
log(`  lock price on-chain ${ethers.formatUnits(r.lockPrice, 36)}, pinned report median ${ethers.formatUnits(median(exactLock.map((x) => x.value)), 8)}`);
keeper.kill();

// Dishonest close: again a later report, with the keeper stopped
await waitUntil(closePin + 10 + 3);
await (await amm.connect(funder).settleRoundWithUpdate(market.marketId, rId, await reportsAt(closePin + 10))).wait();
r = await amm.rounds(market.marketId, rId);
check(Number(r.status) === 2 && Number(r.closePublishTime) === closePin + 10, `Close proposed on the late report (${closePin + 10}), not settled`);

keeper = startKeeper();
for (let i = 0; i < 60 && Number((await amm.rounds(market.marketId, rId)).status) === 2; i++) await sleep(2000);
keeper.kill();
r = await amm.rounds(market.marketId, rId);
check([3, 4].includes(Number(r.status)) && Number(r.closePublishTime) === closePin,
  `Keeper replaced it with the pinned close report (${closePin}); round ${Number(r.status) === 3 ? `settled, ${Number(r.winningSide) === 1 ? 'Rise' : 'Fall'} won` : 'tied (refund)'} without waiting for the challenge period`);

// Winner (or both, on a tie) claims
for (const p of [p0, p1]) {
  try { await (await amm.connect(p).claimPayout(market.marketId, rId)).wait(); log(`  ${p.address.slice(0, 8)} claimed`); } catch (_) { /* the loser */ }
}
console.log(`\nCHALLENGE TEST VERDICT: ${passed}/${passed + failed} checks passed`);
if (failed) process.exitCode = 1;
