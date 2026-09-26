/**
 * MarketState.js
 * The markets as the UI shows them, from real sources only:
 *   - price, ticks, 24h change: the live price feed (checked by CircuitBreaker)
 *   - roundId, pools, bettors, strike, fee: the active market's current on-chain round, written in
 *     by main.js from LiveRounds
 * Nothing is simulated or preset: until real data arrives a field is null (or zero for pools),
 * and the UI shows a placeholder instead of a guess.
 */

import { LivePriceFeed } from './LivePriceFeed.js';
import { CircuitBreaker } from './CircuitBreaker.js';
import { SUPPORTED_MARKETS } from './config.js';

export class MarketState {
  constructor(listeners = {}, { skipFeed = false } = {}) {
    this.listeners = listeners;
    this.activeMarketKey = 'BTC';
    this.feeBps = null; // the current round's fee, read from the contract
    this.circuitBreaker = new CircuitBreaker();

    this.markets = {};
    for (const [key, m] of Object.entries(SUPPORTED_MARKETS)) {
      this.markets[key] = {
        key,
        marketId: m.marketId,
        symbol: m.symbol,
        decimals: m.decimals,
        roundDuration: m.roundDuration,
        price: null,
        ticks: [],
        change24h: null,
        roundId: null,
        poolUp: 0,
        poolDown: 0,
        upBettors: 0,
        downBettors: 0,
        lockPrice: null,
        unavailable: null
      };
    }
    // A market the price source cannot cover stays listed but cannot be selected
    for (const [k, reason] of Object.entries(LivePriceFeed.unavailableMarkets())) {
      if (this.markets[k]) this.markets[k].unavailable = reason;
    }

    if (!skipFeed) {
      this.feed = new LivePriceFeed(
        (tick) => this.handleLiveTick(tick),
        (status) => this.emit('feedStatus', status)
      );
    }
  }

  handleLiveTick({ marketKey, price, vol, time, stats, isInitialSync }) {
    const m = this.markets[marketKey];
    if (!m) return;
    const validation = this.circuitBreaker.validateTick(marketKey, price, m.price, time, isInitialSync);
    if (!validation.valid) return;

    m.price = price;
    m.ticks.push(price);
    if (m.ticks.length > 150) m.ticks.shift();
    if (stats?.[marketKey]?.change !== undefined) m.change24h = stats[marketKey].change;

    this.emit('tick', {
      marketKey,
      market: m,
      isActiveMarket: marketKey === this.activeMarketKey,
      price,
      allMarkets: this.markets,
      vol: vol || 0
    });
  }

  getActiveMarket() {
    return this.markets[this.activeMarketKey];
  }

  setActiveMarket(key) {
    if (!this.markets[key] || this.markets[key].unavailable || key === this.activeMarketKey) return;
    this.activeMarketKey = key;
    this.emit('marketChanged', this.getActiveMarket());
  }

  /**
   * Payout per 1 MON on each side from the on-chain pools, with the contract's fee. Null when the
   * fee is not read yet or a side is empty (no meaningful multiplier).
   */
  getLiveOdds(marketKey = this.activeMarketKey) {
    const m = this.markets[marketKey];
    const total = m.poolUp + m.poolDown;
    if (this.feeBps === null) return { totalPool: total, multUp: null, multDown: null };
    const net = total * (1 - this.feeBps / 10000);
    return {
      totalPool: total,
      multUp: m.poolUp > 0 && m.poolDown > 0 ? net / m.poolUp : null,
      multDown: m.poolUp > 0 && m.poolDown > 0 ? net / m.poolDown : null
    };
  }

  /** Payout per 1 MON after adding `stake` to `side`, as the contract would compute it */
  multiplierAfter(side, stake, marketKey = this.activeMarketKey) {
    const m = this.markets[marketKey];
    if (this.feeBps === null) return null;
    const sidePool = (side === 'UP' ? m.poolUp : m.poolDown) + stake;
    if (sidePool <= 0) return null;
    return ((m.poolUp + m.poolDown + stake) * (1 - this.feeBps / 10000)) / sidePool;
  }

  emit(event, data) {
    if (this.listeners[event]) this.listeners[event](data);
  }
}
