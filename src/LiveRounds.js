/**
 * LiveRounds.js
 * The app's view of the contract: the active market's current round and the connected wallet's
 * positions, built from the contract's events. Nothing here is simulated, and nothing is polled: the
 * round is read once when a market opens, then again only when the relay pushes an event for that
 * market (a bet, lock, settlement, new round). Phases between events (betting closes, close time)
 * follow from the round's own timestamps and the local clock (tick()).
 *
 * Continuous play: the next round opens (with the next bet) as soon as the current one stops taking
 * bets, while the current one still locks, runs and settles. The state therefore has two parts: the
 * round you can bet on (derive(): 'open' or 'next') and the running round ('live').
 *
 * A round's own phases, from the contract's timestamps:
 *   open      bets accepted until betCloseTimestamp
 *   closed    betting over, waiting for the lock report (strike) at lockTimestamp
 *   locked    strike set, the round runs until closeTimestamp
 *   settling  close time passed, waiting for the keeper to submit the close report
 *   confirming a close price came from a late report (the exact one was missed); anyone can replace it
 *             with an earlier one until finalizeAfter, then it settles (SEC-28)
 *   expired   contested but unresolved past expiryTimestamp: every stake is refundable (SEC-29)
 *   idle      betting closed with one side (or both) empty: the round can never be contested, its
 *             bettors refund directly, and the next bet opens a fresh round (SEC-24/26)
 */

import { ethers } from 'ethers';
import { SUPPORTED_MARKETS, API_CONFIG } from './config.js';
import { reportDigest, medianUnits } from './oracle.js';

// The signed close report is complete ~1.5 s after close (measured). The result is read from it at
// these moments after close (one request each, stopping at the first complete, verified set).
const EARLY_RESULT_AT_MS = [1500, 2500, 3500, 5000, 8000];

// A failed read (RPC down or rate-limited) is retried once after this long
const RETRY_MS = 5000;
const PRICE_SCALE = 36;

const toMon = (v) => Number(ethers.formatEther(v));
const toPrice = (v) => (v > 0n ? Number(ethers.formatUnits(v, PRICE_SCALE)) : null);

export class LiveRounds {
  constructor({ web3, history, onUpdate, onRoundEnd, onRoundConfirmed }) {
    this.web3 = web3;
    this.history = history;
    this.onUpdate = onUpdate;
    this.onRoundEnd = onRoundEnd;
    this.onRoundConfirmed = onRoundConfirmed;
    this.early = null; // { key, winner } result read from the signed close report, before settlement
    this.announced = new Set(); // `${marketId}:${roundId}` results already shown
    this.state = null;        // current round of the active market
    this.watched = new Map(); // `${marketId}:${roundId}` rounds shown live, to announce their result
    this.feeRates = new Map(); // `${marketId}:${roundId}` -> snapshotted fee bps, read from the round
    this.raw = null;          // last round read from the contract
    history?.onMarketEvents?.((ids) => {
      const id = this.marketKey && SUPPORTED_MARKETS[this.marketKey]?.marketId.toLowerCase();
      if (!id || !ids.has(id)) return;
      this.announceFromEvents();
      this.sync();
    });
  }

  /**
   * The result, the moment it is decided: RedStone's report signed at the close time (from the relay),
   * checked here exactly as the contract checks it (authorised signers, threshold, report time, median)
   * and compared with the on-chain strike. The same data then settles the round on-chain a few seconds
   * later; the UI marks the result as confirming until that RoundSettled event arrives.
   */
  scheduleEarlyResult() {
    const live = this.state?.live;
    const r = this.liveRaw;
    if (!API_CONFIG.priceRelayUrl || !live || !r || live.phase !== 'settling' || !(r.lockPrice > 0n)) return;
    const key = `${this.state.marketId.toLowerCase()}:${live.roundId}`;
    if (this.earlyFor === key) return;
    this.earlyFor = key;
    const market = SUPPORTED_MARKETS[this.state.marketKey];
    const closeTs = Math.ceil(r.closeTimestamp / r.priceWindow) * r.priceWindow;
    for (const delay of EARLY_RESULT_AT_MS) {
      setTimeout(() => this.tryEarlyResult(key, market, closeTs, r), Math.max(0, closeTs * 1000 + delay - Date.now()));
    }
  }

  async tryEarlyResult(key, market, closeTs, r) {
    if (this.early?.key === key || this.announced.has(key) || this.state?.marketId?.toLowerCase() !== key.split(':')[0]) return;
    try {
      const signers = await this.oracleSet();
      const res = await fetch(`${API_CONFIG.priceRelayUrl}/reports?feed=${market.feed}&ts=${closeTs}`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return;
      const reports = await res.json();
      const seen = new Set();
      const values = [];
      for (const rep of reports) {
        const units = BigInt(rep.value);
        if (BigInt(rep.timestampMs) !== BigInt(closeTs) * 1000n) return;
        const signer = ethers.recoverAddress(reportDigest(market.feed, units, BigInt(rep.timestampMs)), rep.signature).toLowerCase();
        if (!signers.set.has(signer) || seen.has(signer)) return;
        seen.add(signer);
        values.push(units);
      }
      if (values.length < signers.threshold) return;
      if (this.early?.key === key || this.announced.has(key)) return;
      const close = medianUnits(values);
      const strike = r.lockPrice / 10n ** 28n; // the contract stores 8-decimal values scaled to 36 decimals
      const winner = close === strike ? 'REFUND' : close > strike ? 'UP' : 'DOWN';
      this.early = { key, winner };
      this.announced.add(key);
      this.onRoundEnd?.({
        marketKey: this.state.marketKey,
        roundId: r.roundId,
        winner,
        lockPrice: toPrice(r.lockPrice),
        closePrice: Number(ethers.formatUnits(close, 8)),
        confirming: true
      });
    } catch (_) {
      // A later attempt, or the RoundSettled event, gives the result
    }
  }

  /** The contract's oracle signers and threshold, read once */
  async oracleSet() {
    if (!this.oracle) {
      this.oracle = (async () => {
        const iface = this.web3.iface;
        const [s, t] = await Promise.all([
          this.web3.ethCall(iface.encodeFunctionData('oracleSigners', [])),
          this.web3.ethCall(iface.encodeFunctionData('signerThreshold', []))
        ]);
        return {
          set: new Set(iface.decodeFunctionResult('oracleSigners', s)[0].map((a) => a.toLowerCase())),
          threshold: Number(iface.decodeFunctionResult('signerThreshold', t)[0])
        };
      })().catch((err) => { this.oracle = null; throw err; });
    }
    return this.oracle;
  }

  /**
   * Announces the result of the round shown running the moment its RoundSettled / RoundCancelled event
   * is pushed, from the event's own data (close price, winner), without waiting for contract reads.
   */
  announceFromEvents() {
    const st = this.state;
    const liveId = st?.live?.roundId ?? this.lastLiveId;
    if (!st || st.error || !liveId) return;
    const key = `${st.marketId.toLowerCase()}:${liveId}`;
    const h = this.history?.rounds.get(key);
    if (!h || (h.status !== 'settled' && h.status !== 'cancelled') || !(h.up > 0 && h.down > 0)) return;
    const chainWinner = h.status === 'settled' ? h.winningSide : 'REFUND';
    if (this.early?.key === key) {
      // Shown early from the signed report; the chain has now settled it
      this.onRoundConfirmed?.({ marketKey: st.marketKey, roundId: liveId, winner: chainWinner, matches: chainWinner === this.early.winner, closePrice: h.closePrice ?? null, lockPrice: h.lockPrice ?? null });
      this.early = { ...this.early, key: `${key}:confirmed` };
      return;
    }
    if (this.announced.has(key)) return;
    this.announced.add(key);
    this.onRoundEnd?.({ marketKey: st.marketKey, roundId: liveId, winner: chainWinner, lockPrice: h.lockPrice ?? null, closePrice: h.closePrice ?? null });
  }

  start(marketKey) {
    this.marketKey = marketKey;
    this.state = null;
    this.raw = null;
    this.prevRaw = null;
    this.liveRaw = null;
    this.lastLiveId = null;
    this.syncing = false;
    this.again = false;
    clearTimeout(this.retry);
    this.sync();
  }

  stop() {
    clearTimeout(this.retry);
    this.state = null;
    this.raw = null;
  }

  /** A round's own phase at `now` (seconds), from the contract's timestamps */
  static phaseOf(r, now) {
    const oneSided = r.totalUp === 0n || r.totalDown === 0n;
    const expired = (r.status === 1 || r.status === 2) && !oneSided && now > r.expiryTimestamp;
    if (expired) return { phase: 'expired', expired };
    if (r.status === 1 && oneSided && now > r.betCloseTimestamp) return { phase: 'idle', expired };
    if (r.status === 1 && now <= r.betCloseTimestamp) return { phase: 'open', expired };
    if (r.status === 1) return { phase: 'closed', expired };
    if (r.status === 2 && now < r.closeTimestamp) return { phase: 'locked', expired };
    if (r.status === 2 && r.closePublishTime > 0) return { phase: 'confirming', expired };
    if (r.status === 2) return { phase: 'settling', expired };
    return { phase: 'ended', expired };
  }

  /**
   * What the app shows, from the current round and the one before it (continuous play):
   *   - the round you can bet on: the current one while it takes bets ('open'); otherwise the next
   *     one, which your bet opens ('next')
   *   - the running round ('live'): the latest contested round that no longer takes bets and is not
   *     resolved yet (locking, running, settling); its strike and result time are on the chart
   */
  static derive(cur, prev, now) {
    const bettable = cur.status === 1 && now <= cur.betCloseTimestamp;
    let liveRaw = null;
    for (const r of [cur, prev]) {
      if (!r) continue;
      const contested = r.totalUp > 0n && r.totalDown > 0n;
      if (contested && (r.status === 1 || r.status === 2) && now > r.betCloseTimestamp) { liveRaw = r; break; }
    }
    const live = liveRaw ? (() => {
      const { phase, expired } = LiveRounds.phaseOf(liveRaw, now);
      return {
        roundId: liveRaw.roundId, phase, expired,
        lockAt: liveRaw.lockTimestamp * 1000, closeAt: liveRaw.closeTimestamp * 1000, finalizeAt: liveRaw.finalizeAfter * 1000,
        lockPrice: toPrice(liveRaw.lockPrice), poolUp: toMon(liveRaw.totalUp), poolDown: toMon(liveRaw.totalDown)
      };
    })() : null;
    return {
      phase: bettable ? 'open' : 'next',
      roundId: bettable ? cur.roundId : cur.roundId + 1, // the round a bet goes into
      currentRoundId: cur.roundId,
      startAt: cur.startTimestamp * 1000,
      betCloseAt: cur.betCloseTimestamp * 1000,
      lockAt: cur.lockTimestamp * 1000,
      closeAt: cur.closeTimestamp * 1000,
      poolUp: bettable ? toMon(cur.totalUp) : 0,
      poolDown: bettable ? toMon(cur.totalDown) : 0,
      upBettors: bettable ? cur.upBettors : 0,
      downBettors: bettable ? cur.downBettors : 0,
      feeBps: bettable ? cur.feeBps : null,
      closedBetting: !bettable,
      // The strike line is the running round's; a round still taking bets has none yet
      lockPrice: live ? live.lockPrice : null,
      expired: Boolean(live?.expired),
      live,
      liveRaw
    };
  }

  apply(now) {
    const d = LiveRounds.derive(this.raw, this.prevRaw, now);
    this.liveRaw = d.liveRaw;
    delete d.liveRaw;
    if (d.live) this.lastLiveId = d.live.roundId;
    return d;
  }

  /** Moves phases forward with the clock between events; reads nothing */
  tick() {
    if (!this.raw || !this.state || this.state.error) return;
    const before = this.state;
    const d = this.apply(Date.now() / 1000);
    if (d.phase === before.phase && d.live?.phase === before.live?.phase && d.live?.roundId === before.live?.roundId) return;
    this.state = { ...before, ...d };
    if (d.live?.phase === 'settling') this.scheduleEarlyResult();
    this.onUpdate?.(this.state);
  }

  async sync() {
    if (this.syncing) {
      this.again = true; // an event arrived mid-read: read once more afterwards
      return;
    }
    this.syncing = true;
    const key = this.marketKey;
    try {
      const market = SUPPORTED_MARKETS[key];
      const m = await this.web3.fetchOnChainMarket(market.marketId);
      if (!m) throw new Error('Could not read the market from the contract.');
      const cur = Number(m.currentRoundId);
      const [r, prev] = await Promise.all([
        this.web3.fetchOnChainRound(market.marketId, cur),
        cur > 1 ? this.web3.fetchOnChainRound(market.marketId, cur - 1) : Promise.resolve(null)
      ]);
      if (!r) throw new Error('Could not read the current round from the contract.');
      if (key !== this.marketKey) return; // market switched while reading
      this.raw = r;
      this.prevRaw = prev;
      const shownLive = this.state?.marketId === market.marketId ? this.state.live?.roundId : null;
      this.state = { marketKey: key, marketId: market.marketId, error: null, ...this.apply(Date.now() / 1000) };

      // The round we showed running has left the view: announce how it ended if no event did
      if (shownLive && shownLive !== this.state.live?.roundId) {
        const k = `${market.marketId.toLowerCase()}:${shownLive}`;
        if (!this.announced.has(k) && this.early?.key !== k) {
          const ended = await this.web3.fetchOnChainRound(market.marketId, shownLive);
          if (ended && (ended.status === 3 || ended.status === 4) && ended.totalUp > 0n && ended.totalDown > 0n && !this.announced.has(k)) {
            this.announced.add(k);
            this.onRoundEnd?.({
              marketKey: key,
              roundId: ended.roundId,
              winner: ended.status === 3 ? (ended.winningSide === 1 ? 'UP' : 'DOWN') : 'REFUND',
              lockPrice: toPrice(ended.lockPrice),
              closePrice: toPrice(ended.closePrice)
            });
          }
        }
      }
    } catch (err) {
      if (key === this.marketKey) this.state = { ...(this.state || {}), error: err.message };
      clearTimeout(this.retry);
      this.retry = setTimeout(() => this.sync(), RETRY_MS);
    } finally {
      // Always released, including when the market switched mid-read
      this.syncing = false;
    }
    if (key === this.marketKey) {
      this.onUpdate?.(this.state);
      if (this.state?.live?.phase === 'settling') this.scheduleEarlyResult();
    }
    if (this.again) {
      this.again = false;
      this.sync();
    }
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
      // A contested round unresolved past its expiry is refundable (SEC-29): the running round's
      // contract read says whether it expired
      const expired = Boolean(cur?.live && p.roundId === cur.live.roundId && cur.live.expired);
      if (round?.status === 'cancelled' || (!round?.status && ((oneSided && bettingClosed) || expired))) {
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
