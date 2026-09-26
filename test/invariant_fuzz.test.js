/**
 * test/invariant_fuzz.test.js
 * Randomized stateful test of the real compiled contract (SEC-17). Players, keepers and the owner take
 * random actions in random order: bets, time jumps, locks and settles with pinned, late and too-late
 * reports (random 4-of-5 or 5-of-5 signer sets, ties), challenges, finalizes, emergency refunds, claims,
 * batch claims, owner parameter/fee changes and withdrawals. Reverts are allowed (many actions are
 * invalid on purpose); what is checked after every step:
 *
 *   SOLVENCY   contract balance >= everything it owes: unclaimed stakes of unresolved and refundable
 *              rounds, unclaimed winnings of settled rounds, creator fees, treasury fees, keeper rewards
 *   NO LEAK    balance - owed <= 1 wei per winning bet (payouts round down, SEC-12)
 *   EXACT PAY  every payout equals the contract's formula for that bet at that moment
 *   ONE WAY    a round anyone was refunded from never settles (SEC-29), a settled round never refunds
 *
 * Run: npm run compile && npm run test:fuzz            (FUZZ_SEED=n FUZZ_STEPS=n to vary)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ganache from 'ganache';
import { ethers } from 'ethers';
import { signReport, feedIdBytes32 } from '../src/oracle.js';

const buildDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build');
const SEED = Number(process.env.FUZZ_SEED || 20260926);
const STEPS = Number(process.env.FUZZ_STEPS || 600);

// Deterministic PRNG (mulberry32) so a failure is reproducible with its seed
let state = SEED >>> 0;
const rand = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (a) => a[Math.floor(rand() * a.length)];
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

let failures = 0;
const fail = (step, msg) => {
  failures++;
  console.error(`\x1b[31m[FAIL]\x1b[0m step ${step}: ${msg}`);
};

const load = (name) => ({
  abi: JSON.parse(fs.readFileSync(path.join(buildDir, `${name}.abi`), 'utf8')),
  bin: fs.readFileSync(path.join(buildDir, `${name}.bin`), 'utf8').trim()
});

const keys = [1, 2, 3, 4, 5].map((i) => new ethers.SigningKey(ethers.id(`fuzz-signer-${i}`)));
const signerAddrs = keys.map((k) => ethers.computeAddress(k.publicKey));

async function main() {
  const gp = ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 12, defaultBalance: 1e6 }, chain: { allowUnlimitedContractSize: false } });
  const provider = new ethers.BrowserProvider(gp);
  const accounts = await provider.listAccounts();
  const [owner, creator, keeperA, keeperB, ...players] = accounts;
  const A = load('MonadUpDownAMM_sol_MonadUpDownAMM');
  const amm = await (await new ethers.ContractFactory(A.abi, A.bin, owner).deploy(signerAddrs, 4)).waitForDeployment();
  const ammAddr = await amm.getAddress();
  const now = async () => Number((await gp.request({ method: 'eth_getBlockByNumber', params: ['latest', false] })).timestamp);
  // Raw reads: ethers' provider caches balances within a block on Ganache
  const balanceOf = async (a) => BigInt(await gp.request({ method: 'eth_getBalance', params: [a, 'latest'] }));
  const warp = async (s) => { await provider.send('evm_increaseTime', [s]); await provider.send('evm_mine', []); };

  const feed = feedIdBytes32('BTC');
  const markets = [];
  for (const [symbol, duration] of [['FUZZ-A', 60], ['FUZZ-B', 30]]) {
    await (await amm.connect(creator).createMarket(feed, 'Fuzz', symbol, duration)).wait();
    markets.push(ethers.solidityPackedKeccak256(['bytes32', 'string', 'uint256'], [feed, symbol, duration]));
  }

  // Model: every (market, round) someone bet in, and who bet
  const betsIn = new Map(); // `${m}:${r}` -> Set(address)
  const refundedFrom = new Set(); // rounds any refund was paid from
  let winningClaims = 0;
  const addrOf = new Map();
  for (const a of accounts) addrOf.set(a, await a.getAddress());

  const reportsAt = (tsSec, price) => {
    const subset = rand() < 0.3 ? keys : keys.filter((_, i) => i !== int(0, 4));
    return subset.map((k) => signReport(k, 'BTC', price, BigInt(tsSec) * 1000n));
  };
  const price = () => BigInt(int(60000, 60010)) * 10n ** 8n; // narrow range: ties happen
  const pinned = (t, w) => Math.ceil(Number(t) / Number(w)) * Number(w);
  const tryTx = async (p) => { try { await (await p).wait(); return true; } catch (_) { return false; } };

  /** What the contract owes right now, computed independently from its public state */
  async function owed() {
    const t = await now();
    let total = 0n;
    let unclaimedWinners = 0;
    for (const [key, users] of betsIn) {
      const [m, r] = key.split(':');
      const round = await amm.rounds(m, r);
      const status = Number(round.status);
      const oneSided = round.totalUp === 0n || round.totalDown === 0n;
      const refundable = status === 4
        || (status === 1 && t > Number(round.betCloseTimestamp) && oneSided)
        || ((status === 1 || status === 2) && t > Number(round.expiryTimestamp));
      for (const u of users) {
        const b = await amm.userBets(m, r, u);
        if (b.claimed || b.amount === 0n) continue;
        if (status === 3 && !refundable) {
          if (Number(b.side) === Number(round.winningSide)) {
            const win = Number(round.winningSide) === 1 ? round.totalUp : round.totalDown;
            total += (b.amount * round.netPayoutPool) / win;
            unclaimedWinners++; // rounding down leaves < 1 wei per winning bet in the contract
          }
        } else {
          total += b.amount; // refundable, or unresolved (worst case: every stake comes back)
        }
      }
    }
    for (const m of markets) total += (await amm.markets(m)).creatorFeesAccrued + (await amm.treasuryFees(m));
    for (const a of accounts) total += await amm.keeperRewards(addrOf.get(a));
    return { total, dustBound: BigInt(winningClaims + unclaimedWinners) };
  }

  async function checkSolvency(step) {
    const bal = await balanceOf(ammAddr);
    const { total: o, dustBound } = await owed();
    if (bal < o) fail(step, `INSOLVENT: balance ${bal} < owed ${o}`);
    else if (bal - o > dustBound) fail(step, `LEAK: balance exceeds owed by ${bal - o} wei, more than ${dustBound} wei of rounding dust (1 per winning bet)`);
  }

  /** Expected payout for a claim, from state before it */
  async function expectedPayout(m, r, user) {
    const t = await now();
    const round = await amm.rounds(m, r);
    const b = await amm.userBets(m, r, user);
    const status = Number(round.status);
    const oneSided = round.totalUp === 0n || round.totalDown === 0n;
    const refundable = status === 4 || (status === 1 && t + 1 > Number(round.betCloseTimestamp) && oneSided)
      || ((status === 1 || status === 2) && t + 1 > Number(round.expiryTimestamp));
    if (b.claimed || b.amount === 0n) return { amount: 0n };
    if (refundable) return { amount: b.amount, refund: true, status };
    if (status === 3 && Number(b.side) === Number(round.winningSide)) {
      const win = Number(round.winningSide) === 1 ? round.totalUp : round.totalDown;
      return { amount: (b.amount * round.netPayoutPool) / win, win: true };
    }
    return { amount: 0n };
  }

  const counts = {};
  for (let step = 1; step <= STEPS; step++) {
    const m = pick(markets);
    const mk = await amm.markets(m);
    const rId = mk.currentRoundId;
    const round = await amm.rounds(m, rId);
    const roll = rand();
    let action;

    if (roll < 0.10) {
      // A whole contested round, as players and a keeper would play it (interleaved with the random
      // actions around it): opposite bets, lock at lock time, settle with a pinned or late report
      action = 'fullRound';
      const add = (rc, user) => {
        const ev = rc.logs.map((l) => { try { return amm.interface.parseLog(l); } catch (_) { return null; } }).find((e) => e?.name === 'BetPlaced');
        const key = `${m}:${ev.args.roundId}`;
        if (!betsIn.has(key)) betsIn.set(key, new Set());
        betsIn.get(key).add(addrOf.get(user));
        return ev.args.roundId;
      };
      try {
        const [u1, u2] = [pick(players), pick(players)];
        const r1 = add(await (await amm.connect(u1).betUp(m, rId, { value: ethers.parseEther(String(int(1, 30) / 10)) })).wait(), u1);
        if (u2 !== u1) add(await (await amm.connect(u2).betDown(m, r1, { value: ethers.parseEther(String(int(1, 30) / 10)) })).wait(), u2);
        const rr = await amm.rounds(m, r1);
        const w = Number(rr.priceWindow);
        await warp(Math.max(0, Number(rr.lockTimestamp) - (await now())) + int(1, 5));
        await tryTx(amm.connect(keeperA).lockRoundWithUpdate(m, r1, reportsAt(pinned(rr.lockTimestamp, w) + (rand() < 0.8 ? 0 : w), price())));
        await warp(Math.max(0, Number(rr.closeTimestamp) - (await now())) + int(1, 5));
        const p = rand() < 0.1 && (await amm.rounds(m, r1)).lockPrice > 0n ? (await amm.rounds(m, r1)).lockPrice / 10n ** 28n : price();
        await tryTx(amm.connect(keeperB).settleRoundWithUpdate(m, r1, reportsAt(pinned(rr.closeTimestamp, w) + (rand() < 0.8 ? 0 : w), p)));
      } catch (_) { /* paused, or the round was not open */ }
    } else if (roll < 0.30) {
      action = 'bet';
      // Half the time two players take opposite sides, so rounds are contested and can settle
      const pair = rand() < 0.5;
      const bettors = pair ? [[pick(players), 'betUp'], [pick(players), 'betDown']] : [[pick(players), rand() < 0.5 ? 'betUp' : 'betDown']];
      let target = rId;
      for (const [user, side] of bettors) {
        const value = ethers.parseEther(String(int(1, 50) / 10));
        try {
          const rc = await (await amm.connect(user)[side](m, target, { value })).wait();
          const ev = rc.logs.map((l) => { try { return amm.interface.parseLog(l); } catch (_) { return null; } }).find((e) => e?.name === 'BetPlaced');
          target = ev.args.roundId;
          const key = `${m}:${ev.args.roundId}`;
          if (!betsIn.has(key)) betsIn.set(key, new Set());
          betsIn.get(key).add(addrOf.get(user));
        } catch (_) { /* closed / opposite side / paused */ }
      }
    } else if (roll < 0.45) {
      action = 'warp';
      await warp(rand() < 0.08 ? 700 : pick([1, 5, 10, 20, 35, 60, 90]));
    } else if (roll < 0.57) {
      action = 'lock';
      // Usually act right at the lock time, as a keeper would; sometimes at a random moment
      const t0 = await now();
      if (rand() < 0.7 && t0 < Number(round.lockTimestamp)) await warp(Number(round.lockTimestamp) - t0 + int(0, 30));
      const at = pinned(round.lockTimestamp, round.priceWindow) + pick([0, 0, 10, 20, 30, 40, -10]) * (Number(round.priceWindow) / 10);
      await tryTx(amm.connect(pick([keeperA, keeperB, ...players])).lockRoundWithUpdate(m, rId, reportsAt(at, price())));
    } else if (roll < 0.69) {
      action = 'settle';
      const t1 = await now();
      if (rand() < 0.7 && t1 < Number(round.closeTimestamp)) await warp(Number(round.closeTimestamp) - t1 + int(0, 40));
      const at = pinned(round.closeTimestamp, round.priceWindow) + pick([0, 0, 10, 20, 30, 40]) * (Number(round.priceWindow) / 10);
      const p = rand() < 0.15 && round.lockPrice > 0n ? round.lockPrice / 10n ** 28n : price();
      await tryTx(amm.connect(pick([keeperA, keeperB])).settleRoundWithUpdate(m, rId, reportsAt(at, p)));
    } else if (roll < 0.73) {
      action = 'finalize';
      await tryTx(amm.connect(pick([keeperA, keeperB])).finalizeRound(m, rId));
    } else if (roll < 0.76) {
      action = 'emergencyRefund';
      await tryTx(amm.connect(pick(players)).emergencyRefund(m, rId));
    } else if (roll < 0.90) {
      action = 'claim';
      const candidates = [...betsIn.entries()].flatMap(([key, us]) => [...us].map((u) => [key, u]));
      if (candidates.length) {
        const [key, u] = pick(candidates);
        const [cm, cr] = key.split(':');
        const signer = accounts.find((a) => addrOf.get(a) === u);
        const exp = await expectedPayout(cm, cr, u);
        const before = await balanceOf(u);
        const statusBefore = Number((await amm.rounds(cm, cr)).status);
        try {
          const rc = await (await amm.connect(signer).claimPayout(cm, cr)).wait();
          const got = (await balanceOf(u)) - before + rc.fee;
          if (got !== exp.amount) fail(step, `claim ${key} paid ${got}, formula says ${exp.amount}`);
          if (exp.refund) refundedFrom.add(key);
          if (exp.win) winningClaims++;
          if (exp.refund && statusBefore === 3) fail(step, `refund paid from settled round ${key}`);
        } catch (_) {
          if (exp.amount > 0n) fail(step, `claim ${key} reverted although ${exp.amount} is due`);
        }
      }
    } else if (roll < 0.93) {
      action = 'claimBatch';
      const u = pick(players);
      const rounds = [...betsIn.keys()].filter((k) => k.startsWith(m) && betsIn.get(k).has(addrOf.get(u))).map((k) => BigInt(k.split(':')[1]));
      if (rounds.length) {
        let expected = 0n;
        const wins = [];
        const refunds = [];
        for (const r of rounds) {
          const e = await expectedPayout(m, r, addrOf.get(u));
          expected += e.amount;
          if (e.win) wins.push(r);
          if (e.refund) refunds.push(r);
        }
        const before = await balanceOf(addrOf.get(u));
        try {
          const rc = await (await amm.connect(u).claimBatch(m, rounds)).wait();
          const got = (await balanceOf(addrOf.get(u))) - before + rc.fee;
          if (got !== expected) fail(step, `claimBatch paid ${got}, formula says ${expected}`);
          winningClaims += wins.length;
          for (const r of refunds) refundedFrom.add(`${m}:${r}`);
        } catch (_) {
          if (expected > 0n) fail(step, `claimBatch reverted although ${expected} is due`);
        }
      }
    } else if (roll < 0.96) {
      action = 'owner';
      const which = int(0, 3);
      if (which === 0) await tryTx(amm.connect(owner).setProtocolParameters(int(5, 20), pick([5, 10, 15]), int(5, 20) * 60, ethers.parseEther('0.1')));
      if (which === 1) await tryTx(amm.connect(owner).setProtocolFees(int(1, 50), int(1, 50), int(0, 300)));
      if (which === 2) await tryTx(amm.connect(owner).withdrawTreasury(m, addrOf.get(owner)));
      if (which === 3) await tryTx(amm.connect(owner).setPaused(rand() < 0.3));
    } else {
      action = 'rewards';
      await tryTx(amm.connect(pick([keeperA, keeperB, ...players])).claimKeeperRewards());
      await tryTx(amm.connect(creator).claimCreatorFees(m));
    }
    counts[action] = (counts[action] || 0) + 1;

    // ONE WAY: a round refunded from must never be settled
    for (const key of refundedFrom) {
      const [rm, rr] = key.split(':');
      if (Number((await amm.rounds(rm, rr)).status) === 3) fail(step, `round ${key} settled after a refund was paid from it`);
    }
    await checkSolvency(step);
    if (failures > 5) break;
  }

  // Wind down: expire everything, pay everyone, and the contract must end with only dust
  await tryTx(amm.connect(owner).setPaused(false));
  await warp(3 * 3600);
  for (const [key, us] of betsIn) {
    const [m, r] = key.split(':');
    for (const u of us) {
      const e = await expectedPayout(m, r, u);
      if (e.amount > 0n) {
        await tryTx(amm.connect(accounts.find((a) => addrOf.get(a) === u)).claimPayout(m, r));
        if (e.win) winningClaims++;
      }
    }
  }
  for (const m of markets) {
    await tryTx(amm.connect(owner).withdrawTreasury(m, addrOf.get(owner)));
    await tryTx(amm.connect(creator).claimCreatorFees(m));
  }
  for (const a of accounts) await tryTx(amm.connect(a).claimKeeperRewards());
  await checkSolvency('end');
  const dust = await balanceOf(ammAddr);
  const settled = [...betsIn.keys()].length;
  console.log(`Actions: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  const settledRounds = (await Promise.all([...betsIn.keys()].map(async (k) => Number((await amm.rounds(...k.split(':'))).status)))).filter((st) => st === 3).length;
  console.log(`Rounds with bets: ${settled} (settled ${settledRounds}); refunded-from rounds: ${refundedFrom.size}; winning claims: ${winningClaims}; left in contract after everyone withdrew: ${dust} wei`);
  if (dust > BigInt(winningClaims)) fail('end', `${dust} wei left, more than rounding dust`);
  console.log(`\nINVARIANT FUZZ VERDICT (seed ${SEED}, ${STEPS} steps): ${failures === 0 ? 'all invariants held' : `${failures} violation(s)`}`);
  if (failures) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
