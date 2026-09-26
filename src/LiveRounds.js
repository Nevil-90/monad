/**
 * LiveRounds.js
 * Live mode's view of the contract: the active market's current round, read from Monad every 2 seconds,
 * and the connected wallet's positions, built from the contract's events. Nothing here is simulated;
 * Demo mode keeps using AMMState's in-browser rounds.
 *
 * Round phases, all from the contract's own timestamps:
 *   open      bets accepted until betCloseTimestamp
 *   closed    betting over, waiting for the lock report (strike) at lockTimestamp
 *   locked    strike set, the round runs until closeTimestamp
 *   settling  close time passed, waiting for the keeper to submit the close report
 *   idle      betting closed with one side (or both) empty: the round can never be contested, its
 *             bettors refund directly, and the next bet opens a fresh round (SEC-24/26)
 */

import { ethers } from 'ethers';
import { SUPPORTED_MARKETS } from './config.js';

// Monad's public RPC allows 15 requests/s per visitor; 2 reads every 2 s leaves room for everything else
const SYNC_MS = 2000;
const PRICE_SCALE = 36;

const toMon = (v) => Number(ethers.formatEther(v));
const toPrice = (v) => (v > 0n ? Number(ethers.formatUnits(v, PRICE_SCALE)) : null);

export class LiveRounds {
  constructor({ web3, history, onUpdate, onRoundEnd }) {
    this.web3 = web3;
    this.history = history;
    this.onUpdate = onUpdate;
    this.onRoundEnd = onRoundEnd;
    this.state = null;        // current round of the active market
    this.watched = new Map(); // `${marketId}:${roundId}` rounds shown live, to announce their result
    this.feeRates = new Map(); // `${marketId}:${roundId}` -> snapshotted fee bps, read from the round
  }

  start(marketKey) {
    this.marketKey = marketKey;
    this.state = null;
    this.syncing = false;
    clearInterval(this.timer);
    this.sync();
    this.timer = setInterval(() => this.sync(), SYNC_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.state = null;
  }

  async sync() {
    if (this.syncing) return;
    this.syncing = true;
    const key = this.marketKey;
    try {
      const market = SUPPORTED_MARKETS[key];
      const m = await this.web3.fetchOnChainMarket(market.marketId);
      if (!m) throw new Error('Could not read the market from the contract.');
      const r = await this.web3.fetchOnChainRound(market.marketId, m.currentRoundId);
      if (!r) throw new Error('Could not read the current round from the contract.');
      if (key !== this.marketKey) return; // market switched while reading

      const now = Date.now() / 1000;
      const total = toMon(r.totalPool);
      let phase;
      const oneSided = r.totalUp === 0n || r.totalDown === 0n;
      if (r.status === 1 && oneSided && now > r.betCloseTimestamp) phase = 'idle';
      else if (r.status === 1 && now <= r.betCloseTimestamp) phase = 'open';
      else if (r.status === 1) phase = 'closed';
      else if (r.status === 2 && now < r.closeTimestamp) phase = 'locked';
      else if (r.status === 2) phase = 'settling';
      else phase = 'ended';

      const prev = this.state;
      this.state = {
        marketKey: key,
        marketId: market.marketId,
        roundId: r.roundId,
        status: r.status,
        phase,
        betCloseAt: r.betCloseTimestamp * 1000,
        lockAt: r.lockTimestamp * 1000,
        closeAt: r.closeTimestamp * 1000,
        lockPrice: toPrice(r.lockPrice),
        poolUp: toMon(r.totalUp),
        poolDown: toMon(r.totalDown),
        upBettors: r.upBettors,
        downBettors: r.downBettors,
        feeBps: r.feeBps,
        closedBetting: now > r.betCloseTimestamp,
        error: null
      };

      // A round we showed has moved on: read how it ended and announce it
      if (prev && prev.marketId === market.marketId && prev.roundId !== r.roundId && prev.phase !== 'idle') {
        const ended = await this.web3.fetchOnChainRound(market.marketId, prev.roundId);
        if (ended && (ended.status === 3 || ended.status === 4) && ended.totalPool > 0n) {
          this.onRoundEnd?.({
            marketKey: key,
            roundId: ended.roundId,
            winner: ended.status === 3 ? (ended.winningSide === 1 ? 'UP' : 'DOWN') : 'REFUND',
            lockPrice: toPrice(ended.lockPrice),
            closePrice: toPrice(ended.closePrice)
          });
        }
      }
    } catch (err) {
      if (key === this.marketKey) this.state = { ...(this.state || {}), error: err.message };
    } finally {
      // Always released, including when the market switched mid-read
      this.syncing = false;
    }
    if (key === this.marketKey) this.onUpdate?.(this.state);
  }

  async readFeeRate(key, marketId, roundId) {
    if (this.feeRates.has(key) || this.reading?.has(key)) return;
    (this.reading ||= new Set()).add(key);
    const r = await this.web3.fetchOnChainRound(marketId, roundId);
    this.reading.delete(key);
    if (r) {
      this.feeRates.set(key, r.feeBps);
      this.onUpdate?.(this.state);
    }
  }

  /**
   * The wallet's positions from the contract's events, in the ledger's shape. Payouts use the
   * contract's own formula (fee capped at the losing pool); claimed amounts are the exact transfers.
   */
  positions(account) {
    if (!account || !this.history) return [];
    const me = account.toLowerCase();
    const byRound = new Map();
    for (const rec of this.history.records) {
      if (!rec.user || rec.user.toLowerCase() !== me) continue;
      if (rec.type !== 'bet' && rec.type !== 'win' && rec.type !== 'refund' && rec.type !== 'claim') continue;
      const key = `${rec.marketId}:${rec.roundId}`;
      if (!byRound.has(key)) byRound.set(key, { marketId: rec.marketId, roundId: rec.roundId, side: null, amount: 0, claimed: null, block: rec.block });
      const p = byRound.get(key);
      if (rec.type === 'bet') {
        p.side = rec.side;
        p.amount += rec.amount;
      } else {
        p.claimed = rec.amount;
      }
      p.block = Math.max(p.block, rec.block);
    }

    const keyOf = (marketId) => Object.keys(SUPPORTED_MARKETS).find((k) => SUPPORTED_MARKETS[k].marketId.toLowerCase() === marketId);
    const out = [];
    for (const [key, p] of byRound) {
      if (!p.side) continue;
      const round = this.history.rounds.get(key);
      const marketKey = keyOf(p.marketId);
      let status = 'Active';
      let payout = 0;
      // One-sided once betting closed: refundable directly (SEC-26). Past rounds of this market have
      // closed betting; the current round's state comes from the contract read.
      const cur = this.state && this.state.marketId?.toLowerCase() === p.marketId ? this.state : null;
      const bettingClosed = !cur || p.roundId < cur.roundId || (p.roundId === cur.roundId && cur.closedBetting);
      const oneSided = round && (round.up === 0 || round.down === 0);
      if (round?.status === 'cancelled' || (!round?.status && oneSided && bettingClosed)) {
        status = 'Refunded';
        payout = p.amount;
      } else if (round?.status === 'settled') {
        if (round.winningSide === p.side) {
          status = 'Won';
          const total = round.up + round.down;
          const winPool = p.side === 'UP' ? round.up : round.down;
          // The round's fee rate, read from the contract; unknown until read, and then no estimate is shown
          const feeBps = this.feeRates.get(key);
          if (feeBps === undefined) this.readFeeRate(key, p.marketId, p.roundId);
          const fee = feeBps === undefined ? null : Math.min((total * feeBps) / 10000, total - winPool);
          payout = fee === null || winPool <= 0 ? null : (p.amount * (total - fee)) / winPool;
        } else {
          status = 'Lost';
        }
      }
      if (p.claimed !== null) payout = p.claimed;
      out.push({
        id: key,
        marketKey,
        market: marketKey ? SUPPORTED_MARKETS[marketKey].symbol : this.history.marketLabel(p.marketId),
        marketId: p.marketId,
        roundId: p.roundId,
        side: p.side,
        amount: p.amount,
        status,
        payout,
        claimed: p.claimed !== null,
        entryMult: '—',
        block: p.block
      });
    }
    return out.sort((a, b) => b.block - a.block);
  }
}
