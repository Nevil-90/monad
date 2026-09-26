/**
 * scripts/rounds_test.js
 * Two live checks on the deployed contract (Monad testnet, keeper running), run at the same time:
 *
 *  A. Same block: 8 wallets sign their bets in advance and send them at the same instant, so they land
 *     in the same Monad block. The round must record every bet, and every payout must be exact.
 *  B. Several rounds, one claim: two wallets play 3 BTC rounds in a row (opposite sides in rounds 1 and
 *     2, only one wallet in round 3, which is refunded). Each then claims everything with one
 *     claimBatch transaction, which must pay exactly the sum of its winnings and refunds; losing
 *     rounds are skipped, and a second claimBatch pays nothing.
 *
 * Usage: npm run test:rounds   (reads .env; players from data/test-wallets.json; needs the keeper)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
import { getConfig, SUPPORTED_MARKETS } from '../src/config.js';
import { AMM_ABI } from '../src/contracts/AMMAbi.js';
import { MonadRpcProvider } from '../src/rpc.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = getConfig();
const provider = new MonadRpcProvider(cfg.rpcUrl, cfg.chainId);
// Raw sends go out together on a plain provider (8 requests, under the RPC's 15/s), not one by one
const rawProvider = new ethers.JsonRpcProvider(cfg.rpcUrl, cfg.chainId, { staticNetwork: true });
const funder = new ethers.Wallet(process.env.KEEPER_PRIVATE_KEY, provider);
const amm = new ethers.Contract(cfg.contractAddress, AMM_ABI, provider);
// 10 player wallets: 8 for the same-block check, 2 of their own for the several-rounds check (both run at
// once, so no wallet is shared). Keys are kept in data/ (git-ignored), created on first use.
const keyFile = path.join(root, 'data', 'test-wallets.json');
const keys = fs.existsSync(keyFile) ? JSON.parse(fs.readFileSync(keyFile, 'utf8')) : [];
while (keys.length < 10) keys.push(ethers.Wallet.createRandom().privateKey);
fs.writeFileSync(keyFile, JSON.stringify(keys, null, 2), { mode: 0o600 });
const players = keys.slice(0, 10).map((k) => new ethers.Wallet(k, provider));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let passed = 0;
let failed = 0;
const check = (ok, msg) => { ok ? passed++ : failed++; console.log(`${ok ? '[PASS]' : '\x1b[31m[FAIL]\x1b[0m'} ${msg}`); };
const eventOf = (rc, name) => rc.logs.map((l) => { try { return amm.interface.parseLog(l); } catch (_) { return null; } }).find((e) => e?.name === name);

/** An open round with at least `margin` seconds of betting left (or an expired one-sided one a bet replaces) */
async function bettableRound(marketId, margin = 25) {
  for (;;) {
    const m = await amm.markets(marketId);
    const r = await amm.rounds(marketId, m.currentRoundId);
    const now = Date.now() / 1000;
    const oneSided = r.totalUp === 0n || r.totalDown === 0n;
    if (Number(r.status) === 1 && now < Number(r.betCloseTimestamp) - margin) return m.currentRoundId;
    if (Number(r.status) === 1 && oneSided && now > Number(r.betCloseTimestamp)) return m.currentRoundId;
    await sleep(3000);
  }
}

async function waitResolved(marketId, roundId) {
  for (let i = 0; i < 200; i++) {
    const r = await amm.rounds(marketId, roundId);
    const now = Date.now() / 1000;
    const oneSided = r.totalUp === 0n || r.totalDown === 0n;
    if ([3, 4].includes(Number(r.status)) || (Number(r.status) === 1 && oneSided && now > Number(r.betCloseTimestamp))) return r;
    await sleep(3000);
  }
  throw new Error(`round ${roundId} not resolved`);
}

/** What `user` is owed for a round right now, by the contract's rules */
async function owed(marketId, roundId, user) {
  const r = await amm.rounds(marketId, roundId);
  const b = await amm.userBets(marketId, roundId, user);
  if (b.amount === 0n || b.claimed) return 0n;
  const status = Number(r.status);
  const oneSided = r.totalUp === 0n || r.totalDown === 0n;
  if (status === 4 || (status === 1 && oneSided && Date.now() / 1000 > Number(r.betCloseTimestamp))) return b.amount;
  if (status === 3 && Number(b.side) === Number(r.winningSide)) {
    return (b.amount * r.netPayoutPool) / (Number(r.winningSide) === 1 ? r.totalUp : r.totalDown);
  }
  return 0n;
}

const balance = async (a) => BigInt(await rawProvider.send('eth_getBalance', [a, 'latest']));

async function fund() {
  const target = ethers.parseEther('2.5');
  for (const p of players) {
    const bal = await provider.getBalance(p.address);
    if (bal < target - ethers.parseEther('0.3')) await (await funder.sendTransaction({ to: p.address, value: target - bal })).wait();
  }
  log('10 players funded');
}

// ---------------------------------------------------------------------------------------------
// A. Same block
// ---------------------------------------------------------------------------------------------
async function sameBlock() {
  const market = SUPPORTED_MARKETS.ETH;
  const plan = [['UP', '0.50'], ['DOWN', '0.60'], ['UP', '0.45'], ['DOWN', '0.45'], ['UP', '0.70'], ['DOWN', '0.55'], ['UP', '0.45'], ['DOWN', '0.80']];
  let rId = await bettableRound(market.marketId);
  // The first bet opens the round if it was an expired one-sided round (SEC-24); the other 7 then race
  const first = await (await amm.connect(players[0]).betUp(market.marketId, rId, { value: ethers.parseEther(plan[0][1]) })).wait();
  rId = eventOf(first, 'BetPlaced').args.roundId;
  const feeData = await provider.getFeeData();
  const est = await amm.connect(players[1]).betDown.estimateGas(market.marketId, rId, { value: ethers.parseEther(plan[1][1]) });
  const signed = await Promise.all(plan.slice(1).map(async ([side, amount], j) => {
    const w = players[j + 1];
    const data = amm.interface.encodeFunctionData(side === 'UP' ? 'betUp' : 'betDown', [market.marketId, rId]);
    return w.signTransaction({
      to: cfg.contractAddress, data, value: ethers.parseEther(amount), chainId: cfg.chainId,
      nonce: await provider.getTransactionCount(w.address, 'pending'),
      gasLimit: (est * 115n) / 100n, maxFeePerGas: feeData.maxFeePerGas, maxPriorityFeePerGas: feeData.maxPriorityFeePerGas, type: 2
    });
  }));
  log(`ETH round ${rId}: sending 7 pre-signed bets at the same instant`);
  const hashes = await Promise.all(signed.map((tx) => rawProvider.send('eth_sendRawTransaction', [tx])));
  const receipts = await Promise.all(hashes.map((h) => provider.waitForTransaction(h)));
  const byBlock = receipts.reduce((a, rc) => ((a[rc.blockNumber] = (a[rc.blockNumber] || 0) + 1), a), {});
  const most = Math.max(...Object.values(byBlock));
  check(receipts.every((rc) => rc.status === 1), `ETH: all 7 simultaneous bets succeeded (blocks: ${JSON.stringify(byBlock)})`);
  check(most >= 2, `ETH: ${most} bets landed in the same block`);
  const r = await amm.rounds(market.marketId, rId);
  // Compare with the stakes the contract recorded per wallet (a wallet may already have been in the round)
  let staked = 0n;
  for (const p of players.slice(0, 8)) staked += (await amm.userBets(market.marketId, rId, p.address)).amount;
  check(r.totalPool === staked && Number(r.upBettors) === 4 && Number(r.downBettors) === 4,
    `ETH: pool ${ethers.formatEther(r.totalPool)} MON = the 8 wallets' recorded stakes; 4 wallets per side`);

  const done = await waitResolved(market.marketId, rId);
  const winner = Number(done.winningSide);
  log(`ETH round ${rId}: ${Number(done.status) === 3 ? `settled, ${winner === 1 ? 'Rise' : 'Fall'} won` : 'refunded'}`);
  let paid = 0n;
  for (let i = 0; i < 8; i++) {
    const exp = await owed(market.marketId, rId, players[i].address);
    if (exp === 0n) {
      const blocked = await amm.connect(players[i]).claimPayout.staticCall(market.marketId, rId).then(() => false, () => true);
      check(blocked, `ETH: player ${i} (${plan[i][0]}, lost) cannot claim`);
      continue;
    }
    const before = await balance(players[i].address);
    const rc = await (await amm.connect(players[i]).claimPayout(market.marketId, rId)).wait();
    const got = (await balance(players[i].address)) - before + rc.fee;
    paid += got;
    check(got === exp, `ETH: player ${i} (${plan[i][0]}) paid exactly ${ethers.formatEther(got)} MON`);
  }
  if (Number(done.status) === 3) {
    const dust = done.netPayoutPool - paid;
    check(dust >= 0n && dust < 8n, `ETH: winners received the whole net pool (${dust} wei rounding)`);
  }
}

// ---------------------------------------------------------------------------------------------
// B. Several rounds, one claim
// ---------------------------------------------------------------------------------------------
async function severalRounds() {
  const market = SUPPORTED_MARKETS.BTC;
  const [a, b] = [players[8], players[9]];
  const rounds = [];
  const plan = [
    { a: ['UP', '0.50'], b: ['DOWN', '0.60'] },
    { a: ['DOWN', '0.45'], b: ['UP', '0.55'] },
    { a: ['UP', '0.45'], b: null } // nobody takes the other side: refunded
  ];
  for (const [k, p] of plan.entries()) {
    let rId = await bettableRound(market.marketId);
    const rc = await (await amm.connect(a)[p.a[0] === 'UP' ? 'betUp' : 'betDown'](market.marketId, rId, { value: ethers.parseEther(p.a[1]) })).wait();
    rId = eventOf(rc, 'BetPlaced').args.roundId;
    if (p.b) await (await amm.connect(b)[p.b[0] === 'UP' ? 'betUp' : 'betDown'](market.marketId, rId, { value: ethers.parseEther(p.b[1]) })).wait();
    log(`BTC round ${rId} (${k + 1} of 3): A ${p.a.join(' ')}${p.b ? `, B ${p.b.join(' ')}` : ', B sits out'}`);
    const r = await waitResolved(market.marketId, rId);
    log(`BTC round ${rId}: ${Number(r.status) === 3 ? `settled, ${Number(r.winningSide) === 1 ? 'Rise' : 'Fall'} won` : 'refundable'}`);
    rounds.push(rId);
  }
  for (const [name, w] of [['A', a], ['B', b]]) {
    const mine = [];
    let expected = 0n;
    for (const rId of rounds) {
      if ((await amm.userBets(market.marketId, rId, w.address)).amount > 0n) {
        mine.push(rId);
        expected += await owed(market.marketId, rId, w.address);
      }
    }
    if (expected === 0n) {
      const blocked = await amm.connect(w).claimBatch.staticCall(market.marketId, mine).then(() => false, () => true);
      check(blocked, `BTC: wallet ${name} lost every round it played: Claim all pays nothing`);
      continue;
    }
    const before = await balance(w.address);
    const rc = await (await amm.connect(w).claimBatch(market.marketId, mine)).wait();
    const got = (await balance(w.address)) - before + rc.fee;
    check(got === expected, `BTC: wallet ${name} claimed ${mine.length} rounds in one transaction: exactly ${ethers.formatEther(got)} MON (winnings + refunds, losses skipped)`);
    const again = await amm.connect(w).claimBatch.staticCall(market.marketId, mine).then(() => false, () => true);
    check(again, `BTC: wallet ${name}'s second Claim all pays nothing`);
  }
}

const start = Date.now();
await fund();
await Promise.all([sameBlock(), severalRounds()]);
// Leftover MON back to the funding wallet
let back = 0n;
const gasPrice = (await provider.getFeeData()).gasPrice;
for (const p of players) {
  const bal = await provider.getBalance(p.address);
  const cost = 21000n * gasPrice * 2n;
  if (bal > cost) {
    await (await p.sendTransaction({ to: funder.address, value: bal - cost, gasLimit: 21000n })).wait();
    back += bal - cost;
  }
}
log(`Returned ${ethers.formatEther(back)} MON to the funding wallet (${Math.round((Date.now() - start) / 1000)} s total)`);
console.log(`\nROUNDS TEST VERDICT: ${passed}/${passed + failed} checks passed`);
if (failed) process.exitCode = 1;
