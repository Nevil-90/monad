/**
 * scripts/dev_house_chain.js
 * Local chain for developing the house UI: Ganache on :8545 (chain id 10143, wall-clock time),
 * MonadPulseHouse deployed with 5 local oracle keys (4 required), the markets from src/config.js,
 * a seeded vault, simulated players betting, and a local settler that records prices signed by the
 * local keys and settles every bet as it ends, like the real keeper.
 *
 * Prices follow each market's live Coinbase price (one request per market per report time), so the
 * strike and result sit close to what the chart shows; if Coinbase is unreachable the last price is
 * reused and the settler says so.
 *
 * Usage:
 *   npm run compile && npm run dev:house-chain
 *   then start the relay and the app with the printed variables.
 * Env: DEV_PLAYERS=0 disables the simulated players; DEV_SETTLE=0 disables the settler (bets stay
 *      pending, e.g. to test settling from the app).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ganache from 'ganache';
import { ethers } from 'ethers';
import { SUPPORTED_MARKETS } from '../src/config.js';
import { signReport, feedIdBytes32, toUnits } from '../src/oracle.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.DEV_CHAIN_PORT || 8545);
const PLAYERS = Number(process.env.DEV_PLAYERS ?? 6);
const abi = JSON.parse(fs.readFileSync(path.join(root, 'build', 'MonadPulseHouse_sol_MonadPulseHouse.abi'), 'utf8'));
const bin = fs.readFileSync(path.join(root, 'build', 'MonadPulseHouse_sol_MonadPulseHouse.bin'), 'utf8').trim();

const oracleKeys = [1, 2, 3, 4, 5].map((i) => new ethers.SigningKey(ethers.id(`dev-oracle-signer-${i}`)));
const server = ganache.server({
  logging: { quiet: true },
  chain: { chainId: 10143 },
  wallet: { totalAccounts: PLAYERS + 2, defaultBalance: 100000 }
});
await new Promise((resolve, reject) => server.listen(PORT, (err) => (err ? reject(err) : resolve())));
const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${PORT}`, undefined, { batchMaxCount: 1, cacheTimeout: -1 });
// A block every second even when nobody transacts, like a real chain (Monad: ~0.4 s): Ganache only mines
// on transactions, and a stale latest block would make contract calls see an old block.timestamp
setInterval(() => provider.send('evm_mine', []).catch(() => {}), 1000);
const [owner, settler, ...players] = await Promise.all(Array.from({ length: PLAYERS + 2 }, (_, i) => provider.getSigner(i)));

const house = await (await new ethers.ContractFactory(abi, bin, owner).deploy(oracleKeys.map((k) => ethers.computeAddress(k.publicKey)), 4)).waitForDeployment();
const address = await house.getAddress();
const deployBlock = await provider.getBlockNumber();
const markets = Object.values(SUPPORTED_MARKETS);
for (const m of markets) await (await house.setMarket(m.marketId, feedIdBytes32(m.feed), true)).wait();
await (await house.setTimeouts(120, 3600, 60)).wait(); // shortest allowed grace and void, 1 min LP lock for local testing
await (await house.addLiquidity({ value: ethers.parseEther('5000') })).wait();

// Price at a report time: the market's live Coinbase price
const lastPrice = new Map();
async function priceUnits(m) {
  try {
    const r = await fetch(`https://api.exchange.coinbase.com/products/${m.coinbase}/ticker`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`${r.status}`);
    const p = (await r.json()).price;
    lastPrice.set(m.feed, p);
    return toUnits(p);
  } catch (err) {
    const p = lastPrice.get(m.feed);
    if (!p) throw new Error(`no price for ${m.feed} yet (${err.message})`);
    console.warn(`[settler] Coinbase unavailable for ${m.feed} (${err.message}); reusing ${p}`);
    return toUnits(p);
  }
}

// Record every market's price at each 10 s mark, then settle the bets that ended
const byId = new Map(markets.map((m) => [m.marketId.toLowerCase(), m]));
let busy = false;
let seenBets = 0;
const pending = new Map(); // betId -> end time
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const ts = Math.floor(Date.now() / 10000) * 10;
    const updates = [];
    for (const m of markets) {
      if ((await house.prices(m.marketId, ts)) > 0n) continue;
      const units = await priceUnits(m);
      updates.push({ marketId: m.marketId, ts, reports: oracleKeys.slice(0, 4).map((k) => signReport(k, m.feed, units, BigInt(ts) * 1000n)) });
    }
    // New bets are read once; after that only their end times are checked
    const count = Number(await house.betCount());
    for (; seenBets < count; seenBets++) {
      const b = await house.bets(seenBets);
      pending.set(seenBets, Number(b.startTs) + Number(b.duration));
    }
    const due = [...pending].filter(([, end]) => end <= ts).map(([id]) => id);
    if (updates.length || due.length) {
      const rc = await (await house.connect(settler).recordAndSettle(updates, due, { gasLimit: 8_000_000 })).wait();
      const settled = rc.logs.map((l) => { try { return house.interface.parseLog(l); } catch (_) { return null; } }).filter((e) => e?.name === 'BetSettled');
      for (const e of settled) pending.delete(Number(e.args.betId));
      if (settled.length) console.log(`[settler] ${ts}: ${settled.map((e) => `#${e.args.betId} ${['', '', 'won', 'lost', 'push', 'void'][Number(e.args.status)]}`).join(', ')}`);
    }
  } catch (err) {
    console.error('[settler]', err.shortMessage || err.message);
  } finally {
    busy = false;
  }
}
// Just after each 10 s mark (a local timer standing in for the oracle's publication)
const schedule = () => setTimeout(async () => { await tick(); schedule(); }, 10000 - (Date.now() % 10000) + 300);
if (process.env.DEV_SETTLE === '0') {
  console.log('[settler] off (DEV_SETTLE=0): bets stay pending until someone settles them');
} else {
  await tick();
  schedule();
}

// Simulated players: a bet every few seconds, sometimes riding their balance
if (PLAYERS > 0) {
  const loop = async () => {
    const p = players[Math.floor(Math.random() * players.length)];
    const m = markets[Math.floor(Math.random() * markets.length)];
    try {
      const bal = await house.balances(await p.getAddress());
      const ride = bal >= ethers.parseEther('0.2') && Math.random() < 0.5;
      const stake = ride ? bal : ethers.parseEther((0.1 + Math.random() * 1.5).toFixed(2));
      const max = await house.maxStake();
      const s = stake > max ? max : stake;
      await (await house.connect(p).placeBet(m.marketId, Math.random() < 0.5 ? 1 : 2, [10, 30, 30, 60][Math.floor(Math.random() * 4)], ride ? s : 0n, 0n, { value: ride ? 0n : s })).wait();
    } catch (err) {
      console.error('[players]', err.shortMessage || err.message);
    }
    setTimeout(loop, 3000 + Math.random() * 6000);
  };
  loop();
}

console.log(`\nLocal house chain on http://127.0.0.1:${PORT} (chain 10143), contract ${address}, deploy block ${deployBlock}`);
console.log('Start the relay and app with:');
console.log(`  NEXT_PUBLIC_RPC_URL=http://127.0.0.1:${PORT} NEXT_PUBLIC_CONTRACT_ADDRESS=${address} NEXT_PUBLIC_CONTRACT_DEPLOY_BLOCK=${deployBlock}`);
console.log(`Funded test accounts (unlocked on this chain): ${[owner, settler, ...players].length}, e.g. ${await (players[0] || owner).getAddress()}`);
