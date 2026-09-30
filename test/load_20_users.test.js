/**
 * test/load_20_users.test.js
 * 20 wallets betting concurrently on a local Ganache chain with the real MonadPulseHouse bytecode.
 * Reports: how many bets landed, why others were refused, odds movement, settlement gas, and that the
 * contract stays solvent with nothing left reserved. (npm run compile first.)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ganache from 'ganache';
import { ethers } from 'ethers';
import { signReport, feedIdBytes32 } from '../src/oracle.js';

const buildDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build');
const USERS = Number(process.env.LOAD_USERS || 20);
const ROUNDS = Number(process.env.LOAD_ROUNDS || 4);
const VAULT_MON = Number(process.env.LOAD_VAULT_MON || 110); // the live testnet vault is ~20
const PILE = process.env.LOAD_MODE === 'pile'; // everyone hits BTC / 30s / mostly Rise in the same instant
const SLIPPAGE = process.env.LOAD_SLIPPAGE !== '0'; // quote first and set a 2% payout floor, like the UI
const mon = (v) => ethers.parseEther(String(v));
const UP = 1;
const DOWN = 2;
const S = ['None', 'Pending', 'Won', 'Lost', 'Push', 'Void'];

const eth = ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: USERS + 2, defaultBalance: 100000 }, chain: { vmErrorsOnRPCResponse: true } });
const provider = new ethers.BrowserProvider(eth);
const accounts = await provider.listAccounts();
const [owner, keeper, ...users] = accounts;
const keys = [1, 2, 3, 4, 5].map((i) => new ethers.SigningKey(ethers.id(`oracle-signer-${i}`)));
const abi = JSON.parse(fs.readFileSync(path.join(buildDir, 'MonadPulseHouse_sol_MonadPulseHouse.abi'), 'utf8'));
const bin = fs.readFileSync(path.join(buildDir, 'MonadPulseHouse_sol_MonadPulseHouse.bin'), 'utf8');
const house = await (await new ethers.ContractFactory(abi, bin, owner).deploy(keys.map((k) => ethers.computeAddress(k.publicKey)), 4)).waitForDeployment();
const addr = await house.getAddress();
const MARKETS = { BTC: ethers.id('BTC-market'), ETH: ethers.id('ETH-market'), SOL: ethers.id('SOL-market') };
for (const [sym, id] of Object.entries(MARKETS)) await (await house.setMarket(id, feedIdBytes32(sym), true)).wait();
await (await house.addLiquidity({ value: mon(VAULT_MON) })).wait();
// Same settings as the live testnet deployment (margin 3%, win fee 3%, jackpot cut 1%, max win 10% of the free vault, min bet 0.7, min lead 5 s)
await (await house.setParams(300, 300, 100, 1000, mon(0.7), 5)).wait();
await (await house.setOdds(1000, 20000)).wait();

const now = async () => parseInt((await eth.request({ method: 'eth_getBlockByNumber', params: ['latest', false] })).timestamp, 16);
async function warpTo(t) { if (t > await now()) await provider.send('evm_setTime', [t * 1000]); await provider.send('evm_mine', []); }
const update = (marketId, sym, ts, units) => ({ marketId, ts, reports: keys.slice(0, 4).map((k) => signReport(k, sym, BigInt(units), BigInt(ts) * 1000n)) });
const balanceOf = async (a) => BigInt(await eth.request({ method: 'eth_getBalance', params: [a, 'latest'] }));

const minBet = await house.minBet();
console.log(`Vault ${VAULT_MON} MON | max stake ${ethers.formatEther(await house.maxStake())} MON | min bet ${ethers.formatEther(minBet)} MON | ${USERS} users x ${ROUNDS} rounds\n`);

const reasons = new Map();
const placed = [];
let attempts = 0;
const rng = (() => { let s = 12345; return () => (s = (s * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32; })();
const t0 = Date.now();
for (let r = 0; r < ROUNDS; r++) {
  const results = await Promise.all(users.map(async (u) => {
    attempts++;
    const sym = PILE ? 'BTC' : ['BTC', 'ETH', 'SOL'][Math.floor(rng() * 3)];
    const side = rng() < (PILE ? 0.85 : 0.7) ? UP : DOWN; // lopsided crowd on purpose
    const cap = Math.min(Number(ethers.formatEther(await house.maxStake())) - 0.01, 2);
    const stake = mon((Number(ethers.formatEther(minBet)) + rng() * Math.max(0, cap - Number(ethers.formatEther(minBet)))).toFixed(2)); // like the UI: never above the max bet
    const dur = PILE ? 30 : [10, 30, 60][Math.floor(rng() * 3)];
    try {
      let minPayout = 0n;
      if (SLIPPAGE) { const q = await house.quote(MARKETS[sym], side, dur, stake); if (q.refused) throw new Error(q.refused); minPayout = (q.payout * 98n) / 100n; }
      const rc = await (await house.connect(u).placeBet(MARKETS[sym], side, dur, 0, minPayout, { value: stake, gasLimit: 700_000n })).wait();
      const ev = rc.logs.map((l) => { try { return house.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'BetPlaced');
      return { ok: true, id: ev.args.betId, sym, side, startTs: Number(ev.args.startTs), endTs: Number(ev.args.startTs) + Number(ev.args.duration), stake, payout: ev.args.payout, user: u.address };
    } catch (e) {
      const txt = `${e?.shortMessage || ''} ${e?.info?.error?.message || ''} ${e?.message || ''}`;
      const m = txt.match(/(Odds at limit on this side|Odds moved|Bet exceeds house limit|Bet below minimum|Duration not offered|Bet start too soon|Payout below minimum|insufficient)/);
      return { ok: false, why: m ? m[1] : txt.slice(0, 80) };
    }
  }));
  for (const x of results) { if (x.ok) placed.push(x); else reasons.set(x.why, (reasons.get(x.why) || 0) + 1); }
  console.log(`round ${r + 1}: ${results.filter((x) => x.ok).length}/${USERS} bets landed`);
}
console.log(`\nplacing ${attempts} bets took ${((Date.now() - t0) / 1000).toFixed(1)}s (local chain)`);
console.log(`landed ${placed.length}/${attempts}; refused ${attempts - placed.length}:`, Object.fromEntries(reasons));
console.log(`reserved for pending payouts: ${ethers.formatEther(await house.lockedPayouts())} of ${ethers.formatEther(await house.vaultAssets())} MON vault`);

// Odds fairness: payout per 1 MON stake, by side
const perMon = (b) => Number(ethers.formatEther(b.payout)) / Number(ethers.formatEther(b.stake));
const ups = placed.filter((b) => b.side === UP).map(perMon);
const downs = placed.filter((b) => b.side === DOWN).map(perMon);
const avg = (a) => (a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(3) : 'n/a');
console.log(`avg payout multiple: Rise (70% of crowd) ${avg(ups)}x | Fall (30% of crowd) ${avg(downs)}x`);

// Settle like the keeper: prices for every start/end, up to 60 bets per tx, random price moves
await warpTo(Math.max(...placed.map((b) => b.endTs)) + 2);
const times = new Map();
for (const b of placed) for (const t of [b.startTs, b.endTs]) times.set(`${b.sym}:${t}`, { sym: b.sym, t });
const updates = [...times.values()].map(({ sym, t }) => update(MARKETS[sym], sym, t, 1_000_000_000n + BigInt(Math.floor(rng() * 40_000_000) - 20_000_000)));
let gas = 0n;
let txs = 0;
const ids = placed.map((b) => b.id);
for (let i = 0; i < ids.length; i += 60) {
  const chunk = ids.slice(i, i + 60);
  const ups2 = i === 0 ? updates : [];
  const est = await house.connect(keeper).recordAndSettle.estimateGas(ups2, chunk);
  const rc = await (await house.connect(keeper).recordAndSettle(ups2, chunk, { gasLimit: est + 300_000n })).wait();
  gas += rc.gasUsed;
  txs++;
}
const counts = {};
for (const b of placed) { const s = S[Number((await house.bets(b.id)).status)]; counts[s] = (counts[s] || 0) + 1; }
console.log(`\nsettled ${placed.length} bets in ${txs} keeper tx(s), ${gas} gas total (${placed.length ? gas / BigInt(placed.length) : 0n} gas/bet incl. prices)`);
console.log('outcomes:', counts);

// Invariants
const [held, vault, balances, pot, locked, treasury] = await Promise.all([balanceOf(addr), house.vaultAssets(), house.totalBalances(), house.jackpotPot(), house.lockedPayouts(), house.treasury()]);
let ok = true;
const check = (c, m) => { console.log(`${c ? '[PASS]' : '[FAIL]'} ${m}`); if (!c) { ok = false; process.exitCode = 1; } };
check(held === vault + balances + pot + treasury, `Solvency: held ${ethers.formatEther(held)} = vault + balances + pot + treasury`);
check(locked === 0n, 'Nothing left reserved after settling everything');
check(!counts.Pending, 'No bet left pending');
check(placed.length > 0, 'At least some bets landed');
let paidOut = 0n;
for (const u of users) {
  const b = await house.balances(u.address);
  if (b > 0n) { await (await house.connect(u).withdrawBalance(b)).wait(); paidOut += b; }
}
check((await house.totalBalances()) === 0n, `All ${users.length} users cashed out (${ethers.formatEther(paidOut)} MON paid)`);
console.log(`\nLOAD VERDICT: ${ok ? 'PASS' : 'FAIL'}`);
process.exit(process.exitCode || 0);
