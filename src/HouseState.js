/**
 * HouseState.js
 * The app's view of the house contract for the connected wallet: the house rules (margin, win fee, odds band, limits,
 * jackpot), the player's in-game balance, streak and LP position, and their bets with results.
 *
 * Nothing is polled. House and player state are read when the page opens, when a wallet connects, and
 * again when the relay pushes an event that touches them (a bet, a settlement, a cash-out). Timing
 * (next strike, a bet's countdown) follows from the contract's rules and the local clock.
 */

import { ethers } from 'ethers';

const INTERVAL = 10;
const toMon = (v) => Number(ethers.formatEther(v));

export class HouseState {
  constructor({ web3, history, onUpdate, onResult, onStrike }) {
    this.web3 = web3;
    this.history = history;
    this.onUpdate = onUpdate;
    this.onResult = onResult;
    this.onStrike = onStrike;
    this.rules = null;   // { margin, winFee, band, minBet, minLead, maxStake, jackpot, ... } (MON amounts)
    this.player = null;  // { balance, streak, streakMinStake, pendingBets, shares, lpUnlockAt }
    this.error = null;
    this.announced = new Set();
    history.onBets((batch) => this.onBets(batch));
    history.onHouse((h) => {
      if (!h) return;
      this.applyHouse(h);
      this.onUpdate(this);
    });
  }

  async start() {
    await this.readHouse();
    await this.readPlayer();
  }

  async readHouse() {
    try {
      const h = this.history.house || await this.web3.fetchHouse();
      this.applyHouse(h);
      this.error = null;
    } catch (err) {
      this.error = `Could not read the house contract: ${err.message}`;
    }
    this.onUpdate(this);
  }

  applyHouse(h) {
    this.rules = {
      margin: Number(h.marginBps) / 10000,
      winFee: Number(h.winFeeBps) / 10000,
      band: Number(h.maxSkewBps) / 10000,
      treasury: toMon(h.treasury),
      jackpotCut: Number(h.jackpotCutBps) / 10000,
      minBet: toMon(h.minBet),
      minLead: Number(h.minLead),
      maxStake: toMon(h.maxStake),
      maxWin: Number(h.maxWinBps) / 10000,
      jackpot: toMon(h.jackpotPot),
      jackpotStreak: Number(h.jackpotStreak),
      jackpotShare: Number(h.jackpotShareBps) / 10000,
      jackpotCapMultiple: Number(h.jackpotCapMultiple),
      vault: toMon(h.vaultAssets),
      reserved: toMon(h.lockedPayouts),
      vaultValue: toMon(h.vaultValue),
      totalShares: h.totalShares,
      wagered: toMon(h.totalWagered),
      paidOut: toMon(h.totalPaidOut),
      settled: Number(h.betsSettled),
      paused: h.paused,
      lpLockSeconds: Number(h.lpLockSeconds),
      priceGrace: Number(h.priceGrace)
    };
  }

  async readPlayer() {
    const account = this.web3.account;
    if (!account || !this.web3.contractAddress) {
      this.player = null;
      this.onUpdate(this);
      return;
    }
    try {
      const p = await this.web3.fetchPlayer(account);
      if (this.web3.account !== account) return; // wallet changed meanwhile
      this.player = {
        balanceWei: p.balance,
        balance: toMon(p.balance),
        streak: Number(p.streak),
        streakMinStake: toMon(p.streakMinStake),
        pendingBets: Number(p.pendingBets),
        shares: p.shares,
        lpUnlockAt: Number(p.lpUnlockAt) * 1000
      };
    } catch (err) {
    }
    this.onUpdate(this);
  }

  /**
   * A transaction that takes `wei` out of the in-game balance was just sent (cash-out, or a bet paid
   * from it): show the lower balance at once, so the same MON cannot be spent twice from a stale screen,
   * then re-read the real value once the transaction is in a block.
   */
  spent(wei) {
    if (!this.player) return;
    const left = this.player.balanceWei > wei ? this.player.balanceWei - wei : 0n;
    this.player = { ...this.player, balanceWei: left, balance: toMon(left) };
    this.onUpdate(this);
    setTimeout(() => this.readPlayer(), 2500);
  }

  onBets(batch) {
    const me = this.web3.account?.toLowerCase();
    const mine = (b) => me && b.user?.toLowerCase() === me;
    if (!batch.initial) {
      for (const b of batch.settled) {
        if (!mine(b) || this.announced.has(b.betId)) continue;
        this.announced.add(b.betId);
        this.onResult?.(b);
      }
      for (const key of batch.prices) {
        const bet = this.myBets().find((b) => b.status === 'Pending' && `${b.marketId}:${b.startTs}` === key);
        if (bet) this.onStrike?.(bet);
      }
    } else {
      // Results already on-chain when the page opened are history, not news
      for (const b of this.history.bets.values()) if (b.status !== 'Pending') this.announced.add(b.betId);
    }
    if (batch.initial || [...batch.placed, ...batch.settled].some(mine) || batch.money) this.readPlayer();
    else this.onUpdate(this);
  }

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------

  myBets() {
    return this.web3.account ? this.history.betsList(this.web3.account) : [];
  }

  /** Strike time a bet placed now gets: the first report mark at least minLead seconds ahead */
  nextStrikeAt(nowMs = Date.now()) {
    if (!this.rules) return null;
    const t = Math.floor(nowMs / 1000) + this.rules.minLead;
    return Math.ceil(t / INTERVAL) * INTERVAL * 1000;
  }

  /** The player's running bet on a market whose result comes next (with several, the one ending first) */
  liveBet(marketId) {
    const id = marketId.toLowerCase();
    const running = this.myBets().filter((b) => b.marketId === id && b.status === 'Pending');
    return running.sort((a, b) => a.endTs - b.endTs)[0] || null;
  }

  strikeOf(bet) {
    return this.history.price(bet.marketId, bet.startTs);
  }

  /** Phase of a pending bet by the clock: before its strike, running, or waiting for the result */
  phaseOf(bet, nowMs = Date.now()) {
    if (bet.status !== 'Pending') return 'done';
    if (nowMs < bet.startTs * 1000) return 'closed';
    if (nowMs < bet.endTs * 1000) return 'locked';
    return 'settling';
  }

  /**
   * Payout per 1 MON (after the win fee) at a given price of the side (0.5 = even), as the contract prices
   * a tiny bet: gross 1/(p(1+margin)), less the win fee on the profit
   */
  payoutAt(p) {
    const r = this.rules;
    if (!r) return null;
    const gross = 1 / (p * (1 + r.margin));
    return 1 + (gross - 1) * (1 - r.winFee);
  }

  /** Jackpot a streak would pay now (share of the pot, capped by the smallest stake in the streak) */
  jackpotFor(minStake) {
    if (!this.rules) return null;
    return Math.min(this.rules.jackpot * this.rules.jackpotShare, minStake * this.rules.jackpotCapMultiple);
  }
}
