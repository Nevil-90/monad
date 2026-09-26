/**
 * LivePriceFeed.js
 * Live prices for the UI.
 *
 * Pyth, streamed through scripts/price_relay.js (VITE_PRICE_RELAY_URL). This is the same oracle the
 * contract settles on, so the price users watch is the price that decides the round.
 * Binance public streams only when chosen explicitly (VITE_PRICE_SOURCE=binance). Binance has no MON
 * market, so MON/USD is shown as unavailable in that mode instead of being approximated.
 * The source never switches on its own: if the chosen one is down, the UI shows it as down.
 *
 * Latency is measured, not simulated: time from Binance's trade time to its arrival here. Pyth publish
 * times have 1s resolution, so no latency figure is shown for Pyth.
 */

import { API_CONFIG, SUPPORTED_MARKETS } from './config.js';

const finiteOrNull = (v) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : null);

const BINANCE_SYMBOLS = { BTCUSDT: 'BTC', ETHUSDT: 'ETH', SOLUSDT: 'SOL' };

export class LivePriceFeed {
  static usesPyth() {
    return API_CONFIG.priceSource === 'pyth';
  }

  /** Markets the configured source cannot price, with the reason shown to the user */
  static unavailableMarkets() {
    if (API_CONFIG.priceSource === 'binance') return { MON: 'MON/USD is priced by Pyth only. Connect the Pyth relay to trade it.' };
    return {};
  }

  constructor(onTickCallback, onStatusCallback) {
    this.onTick = onTickCallback;
    this.onStatus = onStatusCallback;
    this.isConnected = false;
    this.lastTickTime = 0;
    this.latencyMs = null;
    this.source = { pyth: 'Pyth', binance: 'Binance' }[API_CONFIG.priceSource] || null;
    this.prices = {};
    this.stats24h = {};
    for (const k of Object.keys(SUPPORTED_MARKETS)) {
      this.prices[k] = 0;
      this.stats24h[k] = { change: null };
    }
    this.marketByFeed = new Map(Object.entries(SUPPORTED_MARKETS).map(([k, m]) => [m.pythId.toLowerCase(), k]));

    if (this.source === 'Pyth') this.connectPyth();
    else if (this.source === 'Binance') this.connectBinance();
    else {
      // Deferred so listeners wired in the caller's constructor receive it
      setTimeout(() => this.updateStatus(), 0);
      return;
    }

    // Report staleness if the stream goes quiet
    this.watchdog = setInterval(() => {
      const stale = Date.now() - this.lastTickTime > 10000;
      if (stale && this.isConnected) {
        this.isConnected = false;
        this.updateStatus();
      }
    }, 2000);
  }

  // ---------------------------------------------------------------------------
  // Pyth via relay (Server-Sent Events)
  // ---------------------------------------------------------------------------
  connectPyth() {
    const base = API_CONFIG.priceRelayUrl.replace(/\/$/, '');
    this.es = new EventSource(`${base}/stream`);

    const applySnapshot = (e, initial) => {
      try {
        const snap = JSON.parse(e.data);
        for (const [id, f] of Object.entries(snap)) {
          const k = this.marketByFeed.get(id.toLowerCase());
          if (!k) continue;
          if (f.change24h !== null && f.change24h !== undefined) this.stats24h[k] = { change: f.change24h };
          if (initial && f.p > 0) {
            this.prices[k] = f.p;
            this.dispatchTick(k, f.p, 0, f.t, true);
          }
        }
      } catch (_) {
        // Ignore malformed snapshots
      }
    };

    this.es.addEventListener('snapshot', (e) => applySnapshot(e, true));
    this.es.addEventListener('stats', (e) => applySnapshot(e, false));
    this.es.onmessage = (e) => {
      try {
        const { id, p, t } = JSON.parse(e.data);
        const k = this.marketByFeed.get(String(id).toLowerCase());
        if (!k || !(p > 0)) return;
        this.prices[k] = p;
        // Pyth publish times have 1s resolution, so no millisecond latency is claimed for them
        this.dispatchTick(k, p, 0, t, false);
      } catch (_) {
        // Ignore malformed ticks
      }
    };
    this.es.onopen = () => {
      this.isConnected = true;
      this.updateStatus();
    };
    this.es.onerror = () => {
      // EventSource reconnects on its own
      this.isConnected = false;
      this.updateStatus();
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
    if (this.ws) this.ws.close();
    clearInterval(this.watchdog);
  }
}
