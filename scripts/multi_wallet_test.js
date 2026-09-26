/**
 * scripts/multi_wallet_test.js
 * End-to-end check on the deployed contract with several real wallets, as separate users would play.
 *
 *  1. Creates player wallets (keys in data/test-wallets.json, git-ignored) and funds them from
 *     KEEPER_PRIVATE_KEY's wallet.
 *  2. Plays one round at once on three markets: two contested (players on both sides) and one
 *     one-sided (every player on the same side).
 *  3. Waits for the keeper (npm run keeper / dev:testnet must be running) to lock and settle.
 *  4. Every player claims; each payout is checked to the wei against the contract's own formula,
 *     losers must be unable to claim, refunds must equal stakes, and the fee split must add up.
 *  5. Returns the players' remaining MON to the funding wallet.
 *
 * Usage: npm run test:wallets            (reads .env; needs the keeper running)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
import { getConfig, SUPPORTED_MARKETS } from '../src/config.js';
import { AMM_ABI } from '../src/contracts/AMMAbi.js';
import { MonadRpcProvider } from '../src/rpc.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLAYERS = 5;
const FUND_EACH = ethers.parseEther('3.2');
const cfg = getConfig();
if (!cfg.contractAddress || !process.env.KEEPER_PRIVATE_KEY) {
  console.error('Needs NEXT_PUBLIC_CONTRACT_ADDRESS and KEEPER_PRIVATE_KEY in .env');
  process.exit(1);
}

const provider = new MonadRpcProvider(cfg.rpcUrl, cfg.chainId);
const funder = new ethers.Wallet(process.env.KEEPER_PRIVATE_KEY, provider);
const amm = new ethers.Contract(cfg.contractAddress, AMM_ABI, provider);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
const check = (ok, msg) => { ok ? passed++ : failed++; console.log(`${ok ? '[PASS]' : '\x1b[31m[FAIL]\x1b[0m'} ${msg}`); };

// Player wallets, reused between runs
const keyFile = path.join(root, 'data', 'test-wallets.json');
fs.mkdirSync(path.dirname(keyFile), { recursive: true });
let keys = fs.existsSync(keyFile) ? JSON.parse(fs.readFileSync(keyFile, 'utf8')) : [];
while (keys.length < PLAYERS) keys.push(ethers.Wallet.createRandom().privateKey);
fs.writeFileSync(keyFile, JSON.stringify(keys, null, 2), { mode: 0o600 });
const players = keys.slice(0, PLAYERS).map((k) => new ethers.Wallet(k, provider));

async function fund() {
  for (const p of players) {
    const bal = await provider.getBalance(p.address);
    if (bal < FUND_EACH - ethers.parseEther('0.02')) {
      await (await funder.sendTransaction({ to: p.address, value: FUND_EACH - bal })).wait();
    }
  }
  log(`Players funded (${PLAYERS} wallets, ${ethers.formatEther(FUND_EACH)} MON target each)`);
}

// Scenario: side per player for each market ('UP' / 'DOWN'), stakes in MON
const PLAN = {
  // Stakes at or above the deployed minBet (0.42 MON at 102 gwei, SEC-11)
  BTC: [['UP', '0.80'], ['DOWN', '0.50'], ['UP', '0.60'], ['DOWN', '0.90'], ['UP', '0.45']],
  ETH: [['DOWN', '0.90'], ['UP', '0.50'], ['DOWN', '0.45'], ['UP', '0.70'], ['DOWN', '0.50']],
  SOL: [['UP', '0.50'], ['UP', '0.45'], ['UP', '0.60'], null, null] // one-sided: must refund
};

/**
 * A round that can safely take bets now: open with at least 20 s of betting left, or expired and
 * one-sided/empty (the bet opens a new round). Otherwise wait, as a careful user would: a bet that
 * lands after the cutoff reverts and still pays the fee.
 */
async function currentBettableRound(marketId) {
  for (;;) {
    const m = await amm.markets(marketId);
    const r = await amm.rounds(marketId, m.currentRoundId);
    const now = Date.now() / 1000;
    const oneSided = r.totalUp === 0n || r.totalDown === 0n;
    if (Number(r.status) === 1 && now < Number(r.betCloseTimestamp) - 20) return m.currentRoundId;
    if (Number(r.status) === 1 && oneSided && now > Number(r.betCloseTimestamp)) return m.currentRoundId;
    await sleep(5000);
  }
}

async function placeBets() {
  const placed = {};
  for (const [key, plan] of Object.entries(PLAN)) {
    const marketId = SUPPORTED_MARKETS[key].marketId;
    let roundId = await currentBettableRound(marketId);
    placed[key] = { marketId, bets: [] };
    log(`${key}: betting into round ${roundId}`);
    for (let i = 0; i < players.length; i++) {
      if (!plan[i]) continue;
      const [side, amount] = plan[i];
      const c = amm.connect(players[i]);
      const tx = await (side === 'UP' ? c.betUp : c.betDown)(marketId, roundId, { value: ethers.parseEther(amount) });
      const rc = await tx.wait();
      // The first bet may have replaced an expired round (SEC-24/26): read where it landed
      const ev = rc.logs.map((l) => { try { return amm.interface.parseLog(l); } catch (_) { return null; } }).find((e) => e?.name === 'BetPlaced');
      roundId = ev.args.roundId;
      placed[key].bets.push({ player: i, side, amount: ethers.parseEther(amount), roundId });
    }
    placed[key].roundId = roundId;
    log(`${key}: ${placed[key].bets.length} bets in round ${roundId}`);
  }
  return placed;
}

async function waitResolved(placed) {
  // Settlement takes ~2.5 min; if a report was missed, the round becomes refundable after the timeout
  const deadline = Date.now() + 16 * 60e3;
  for (;;) {
    const states = await Promise.all(Object.entries(placed).map(async ([key, p]) => {
      const r = await amm.rounds(p.marketId, p.roundId);
      const oneSided = r.totalUp === 0n || r.totalDown === 0n;
      const now = Date.now() / 1000;
      const timedOut = now > Number(r.expiryTimestamp);
      const refundable = Number(r.status) === 4 || (oneSided && now > Number(r.betCloseTimestamp)) || timedOut;
      return [key, Number(r.status) === 3 || refundable];
    }));
    if (states.every(([, done]) => done)) return;
    if (Date.now() > deadline) throw new Error(`Rounds not resolved in time: ${JSON.stringify(states)} (is the keeper running?)`);
    await sleep(5000);
  }
}

async function claimAndVerify(placed) {
  for (const [key, p] of Object.entries(placed)) {
    const r = await amm.rounds(p.marketId, p.roundId);
    const status = Number(r.status);
    const settled = status === 3;
    const winner = settled ? (Number(r.winningSide) === 1 ? 'UP' : 'DOWN') : null;
    log(`${key} round ${p.roundId}: ${settled ? `settled, ${winner === 'UP' ? 'Rise' : 'Fall'} won` : 'refundable'}; pool ${ethers.formatEther(r.totalPool)} MON`);

    // Fee split: everything not paid to winners went to creator, treasury and keepers
    if (settled) {
      const winPool = winner === 'UP' ? r.totalUp : r.totalDown;
      const losePool = r.totalPool - winPool;
      const expectedFee = (r.totalPool * BigInt(r.feeBps)) / 10000n;
      const fee = expectedFee > losePool ? losePool : expectedFee;
      check(r.netPayoutPool === r.totalPool - fee, `${key}: net payout pool = pool − fee (fee ${ethers.formatEther(fee)} MON, capped at the losing pool)`);
    }

    let paidOut = 0n;
    // Each player's stake and side as recorded by the contract (includes any earlier bets in the round)
    const byPlayer = new Map();
    for (const b of p.bets) {
      const onChain = await amm.userBets(p.marketId, p.roundId, players[b.player].address);
      byPlayer.set(b.player, { side: Number(onChain.side) === 1 ? 'UP' : 'DOWN', amount: onChain.amount });
    }
    for (const [i, bet] of byPlayer) {
      const c = amm.connect(players[i]);
      const winPool = winner === 'UP' ? r.totalUp : r.totalDown;
      const expected = !settled ? bet.amount : bet.side === winner ? (bet.amount * r.netPayoutPool) / winPool : 0n;
      if (expected === 0n) {
        let reverted = false;
        try { await c.claimPayout.staticCall(p.marketId, p.roundId); } catch (_) { reverted = true; }
        check(reverted, `${key}: player ${i} (${bet.side}, lost) cannot claim`);
        continue;
      }
      const before = await provider.getBalance(players[i].address);
      const rc = await (await c.claimPayout(p.marketId, p.roundId)).wait();
      const got = (await provider.getBalance(players[i].address)) - before + rc.fee;
      paidOut += got;
      check(got === expected, `${key}: player ${i} (${bet.side}) ${settled ? 'won' : 'refunded'} exactly ${ethers.formatEther(got)} MON (expected ${ethers.formatEther(expected)})`);
      let again = false;
      try { await c.claimPayout.staticCall(p.marketId, p.roundId); } catch (_) { again = true; }
      check(again, `${key}: player ${i} cannot claim twice`);
    }
    if (settled) {
      const dust = r.netPayoutPool - paidOut;
      check(dust >= 0n && dust < BigInt(byPlayer.size), `${key}: winners received the whole net pool (rounding dust ${dust} wei)`);
    } else {
      const staked = [...byPlayer.values()].reduce((a, b) => a + b.amount, 0n);
      check(paidOut === staked, `${key}: every stake refunded in full (${ethers.formatEther(paidOut)} MON)`);
    }
  }
}

async function solvency() {
  // The contract must hold at least the keeper rewards owed to the funder wallet plus everything unclaimed
  const bal = await provider.getBalance(cfg.contractAddress);
  const owedKeeper = await amm.keeperRewards(funder.address);
  check(bal >= owedKeeper, `Contract balance ${ethers.formatEther(bal)} MON covers keeper rewards owed (${ethers.formatEther(owedKeeper)} MON)`);
}

async function sweep() {
  let returned = 0n;
  for (const p of players) {
    const bal = await provider.getBalance(p.address);
    const gasPrice = (await provider.getFeeData()).gasPrice;
    const cost = 21000n * gasPrice * 2n;
    if (bal > cost) {
      await (await p.sendTransaction({ to: funder.address, value: bal - cost, gasLimit: 21000n })).wait();
      returned += bal - cost;
    }
  }
  log(`Returned ${ethers.formatEther(returned)} MON to ${funder.address}`);
}

const totalHeld = async () => {
  let sum = await provider.getBalance(funder.address);
  for (const p of players) sum += await provider.getBalance(p.address);
  return sum;
};
const start = await totalHeld();
log(`Funding wallet ${funder.address}: ${ethers.formatEther(start)} MON · contract ${cfg.contractAddress}`);
await fund();
const placed = await placeBets();
log('Waiting for the keeper to lock and settle (about 2.5 minutes)…');
await waitResolved(placed);
await claimAndVerify(placed);
await solvency();
await sweep();
const end = await totalHeld();
log(`Test cost across funder and players (network fees, protocol fees, net of keeper rewards): ${ethers.formatEther(start - end)} MON`);
console.log(`\nMULTI-WALLET VERDICT: ${passed}/${passed + failed} checks passed`);
if (failed) process.exitCode = 1;
