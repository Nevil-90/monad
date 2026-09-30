/**
 * MarketState.js
 * The markets as the UI shows them, from real sources only:
 *   - price, ticks, 24h change: the live price feed (checked by CircuitBreaker)
 * Bets, strikes and results come from the house contract (HouseState). Nothing is simulated or
 * preset: until real data arrives a field is null and the UI shows a placeholder instead of a guess.
 */

import { LivePriceFeed } from './LivePriceFeed.js';
import { CircuitBreaker } from './CircuitBreaker.js';
import { SUPPORTED_MARKETS } from './config.js';

export class MarketState {
  constructor(listeners = {}, { skipFeed = false } = {}) {
    this.listeners = listeners;
    this.activeMarketKey = 'BTC';
    this.circuitBreaker = new CircuitBreaker();

    this.markets = {};
    for (const [key, m] of Object.entries(SUPPORTED_MARKETS)) {
      this.markets[key] = {
        key,
        marketId: m.marketId,
        symbol: m.symbol,
        decimals: m.decimals,
        price: null,
        ticks: [],
        change24h: null,
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

  emit(event, data) {
    if (this.listeners[event]) this.listeners[event](data);
  }
}
