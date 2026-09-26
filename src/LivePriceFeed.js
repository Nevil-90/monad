/**
 * LivePriceFeed.js
 * Live prices for the UI.
 *
 * Coinbase (NEXT_PUBLIC_PRICE_SOURCE=coinbase): the chart follows Coinbase's public WebSocket, every
 * trade in USD with ~0.1 s delay and no API key. Rounds are decided by RedStone's signed price at the
 * lock and close times; those official prices reach the app as contract events (strike, close).
 * RedStone has no free push feed, and this app does not poll, so there is no live official ticker.
 *
 * Binance public streams only when chosen explicitly (NEXT_PUBLIC_PRICE_SOURCE=binance). Binance has
 * no MON market, so MON/USD is shown as unavailable in that mode instead of being approximated.
 * The source never switches on its own: if the chosen one is down, the UI shows it as down.
 *
 * Latency is measured, not simulated: the age of the price when it arrives here.
 */

import { API_CONFIG, SUPPORTED_MARKETS } from './config.js';

const finiteOrNull = (v) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : null);

const BINANCE_SYMBOLS = { BTCUSDT: 'BTC', ETHUSDT: 'ETH', SOLUSDT: 'SOL' };

export class LivePriceFeed {
  /** Markets the configured source cannot price, with the reason shown to the user */
  static unavailableMarkets() {
    if (API_CONFIG.priceSource === 'binance') return { MON: 'Binance has no MON/USD market. Use NEXT_PUBLIC_PRICE_SOURCE=coinbase to trade it.' };
    return {};
  }

  constructor(onTickCallback, onStatusCallback) {
    this.onTick = onTickCallback;
    this.onStatus = onStatusCallback;
    this.isConnected = false;
    this.lastTickTime = 0;
    this.latencyMs = null;
    this.source = { coinbase: 'Coinbase', binance: 'Binance' }[API_CONFIG.priceSource] || null;
    this.prices = {};
    this.stats24h = {};
    for (const k of Object.keys(SUPPORTED_MARKETS)) {
      this.prices[k] = 0;
      this.stats24h[k] = { change: null };
    }
    this.marketByFeed = new Map(Object.entries(SUPPORTED_MARKETS).map(([k, m]) => [m.feed, k]));

    if (this.source === 'Coinbase') this.connectCoinbase(0);
    else if (this.source === 'Binance') this.connectBinance();
    else {
      // Deferred so listeners wired in the caller's constructor receive it
      setTimeout(() => this.updateStatus(), 0);
      return;
    }

    // Report staleness if the stream goes quiet (checks the local clock; nothing is fetched)
    const staleAfter = 10000;
    this.watchdog = setInterval(() => {
      const stale = Date.now() - this.lastTickTime > staleAfter;
      if (stale && this.isConnected) {
        this.isConnected = false;
        this.updateStatus();
      }
    }, 2000);
  }

  // ---------------------------------------------------------------------------
  // Coinbase public WebSocket (every trade)
  // ---------------------------------------------------------------------------
  connectCoinbase(attempt) {
    const products = Object.entries(SUPPORTED_MARKETS).filter(([, m]) => m.coinbase);
    const byProduct = new Map(products.map(([k, m]) => [m.coinbase, k]));
    this.cb = new WebSocket(API_CONFIG.coinbaseWsUrl);
    this.cb.onopen = () => {
      attempt = 0;
      this.cb.send(JSON.stringify({ type: 'subscribe', product_ids: [...byProduct.keys()], channels: ['ticker'] }));
      this.isConnected = true;
      this.updateStatus();
    };
    let lastStatus = 0;
    this.cb.onmessage = (event) => {
      try {
        const m = JSON.parse(event.data);
        if (m.type !== 'ticker') return;
        const k = byProduct.get(m.product_id);
        const price = parseFloat(m.price);
        const t = Date.parse(m.time);
        if (!k || !(price > 0) || !Number.isFinite(t)) return;
        const open = parseFloat(m.open_24h);
        if (open > 0) this.stats24h[k] = { change: ((price - open) / open) * 100 };
        this.prices[k] = price;
        this.latencyMs = Math.max(0, Date.now() - t);
        this.dispatchTick(k, price, parseFloat(m.last_size) || 0, t, false);
        if (Date.now() - lastStatus > 1000) {
          lastStatus = Date.now();
          this.updateStatus();
        }
      } catch (_) {
        // Ignore malformed messages
      }
    };
    this.cb.onclose = () => {
      this.isConnected = false;
      this.updateStatus();
      if (this.destroyed) return;
      setTimeout(() => this.connectCoinbase(attempt + 1), Math.min(15000, 1000 * 2 ** attempt));
    };
  }

  // ---------------------------------------------------------------------------
  // Binance (explicit opt-in)
  // ---------------------------------------------------------------------------
  async connectBinance() {
    try {
      const url = `${API_CONFIG.binanceRestUrl}/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(Object.keys(BINANCE_SYMBOLS)))}`;
      const res = await fetch(url);
      if (res.ok) {
        for (const item of await res.json()) {
          const k = BINANCE_SYMBOLS[item.symbol];
          const price = parseFloat(item.lastPrice);
          if (!k || !(price > 0)) continue;
          this.prices[k] = price;
          this.stats24h[k] = { change: finiteOrNull(item.priceChangePercent) };
          this.dispatchTick(k, price, 0, Date.now(), true);
        }
      }
    } catch (_) {
      // Network or regional block: the stream below may still work
    }
    this.openBinanceSocket(0);
  }

  openBinanceSocket(attempt) {
    const streams = Object.keys(BINANCE_SYMBOLS).flatMap((s) => [`${s.toLowerCase()}@trade`, `${s.toLowerCase()}@ticker`]).join('/');
    this.ws = new WebSocket(`${API_CONFIG.binanceWsUrl}/stream?streams=${streams}`);
    this.ws.onopen = () => {
      attempt = 0;
      this.isConnected = true;
      this.updateStatus();
    };
    this.ws.onmessage = (event) => {
      try {
        const { stream = '', data } = JSON.parse(event.data);
        const k = BINANCE_SYMBOLS[data?.s];
        if (!k) return;
        if (stream.includes('@trade')) {
          const price = parseFloat(data.p);
          if (!(price > 0)) return;
          this.prices[k] = price;
          if (!Number.isFinite(data.T)) return;
          this.latencyMs = Math.max(0, Date.now() - data.T);
          this.dispatchTick(k, price, parseFloat(data.q) || 0, data.T, false);
        } else if (stream.includes('@ticker')) {
          this.stats24h[k] = { change: finiteOrNull(data.P) };
        }
      } catch (_) {
        // Ignore malformed messages
      }
    };
    this.ws.onclose = () => {
      this.isConnected = false;
      this.updateStatus();
      if (this.destroyed) return;
      setTimeout(() => this.openBinanceSocket(attempt + 1), Math.min(15000, 1200 * 2 ** attempt));
    };
  }

  // ---------------------------------------------------------------------------

  dispatchTick(marketKey, price, vol, time, isInitialSync = false) {
    this.lastTickTime = Date.now();
    if (!this.isConnected) {
      this.isConnected = true;
      this.updateStatus();
    }
    if (this.onTick) {
      this.onTick({
        marketKey,
        price,
        vol: vol || 0,
        time: time || Date.now(),
        isInitialSync,
        stats: this.stats24h,
        source: this.source
      });
    }
  }

  updateStatus() {
    if (this.onStatus) {
      this.onStatus({
        status: !this.source ? 'NOT_CONFIGURED' : this.isConnected ? 'LIVE' : 'RECONNECTING',
        latency: this.latencyMs,
        isConnected: this.isConnected,
        source: this.source
      });
    }
  }

  destroy() {
    this.destroyed = true;
    if (this.es) this.es.close();
    if (this.cb) this.cb.close();
    if (this.ws) this.ws.close();
    clearInterval(this.watchdog);
  }
}
