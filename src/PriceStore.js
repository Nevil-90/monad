/**
 * PriceStore.js
 * Price history shared by the line and candle views: 1s and 1m OHLC(V) bars, preloaded from the
 * same source as live prices (the Pyth relay, or Binance klines in fallback mode), then updated
 * from live ticks. Pyth has no trade volume, so the volume strip stays empty in Pyth mode.
 */

import { API_CONFIG } from './config.js';

const MAX_1S = 3600;
const MAX_1M = 1000;

export class PriceStore {
  constructor() {
    this.bars1s = [];
    this.bars1m = [];
    this.loadToken = 0;
  }

  reset() {
    this.bars1s = [];
    this.bars1m = [];
  }

  /** Preload history from the active price source for a market ({ pythId, binanceTradeStream }) */
  async load(market) {
    const token = ++this.loadToken;
    this.reset();
    if (!market) return;
    let urls;
    let parse;
    if (API_CONFIG.priceRelayUrl) {
      const base = `${API_CONFIG.priceRelayUrl.replace(/\/$/, '')}/history?id=${market.pythId}`;
      urls = [`${base}&tf=1s`, `${base}&tf=1m`];
      parse = (rows) => rows.map((b) => ({ t: b[0], o: b[1], h: b[2], l: b[3], c: b[4], v: 0 }));
    } else if (market.binanceTradeStream) {
      const base = `${API_CONFIG.binanceRestUrl}/klines?symbol=${market.binanceTradeStream.split('@')[0].toUpperCase()}`;
      urls = [`${base}&interval=1s&limit=1000`, `${base}&interval=1m&limit=500`];
      parse = (rows) => rows.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
    } else {
      return;
    }
    try {
      const [s1, m1] = await Promise.all(urls.map(async (u) => {
        const r = await fetch(u);
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json();
      }));
      if (token !== this.loadToken) return;
      this.bars1s = this.merge(parse(s1), this.bars1s);
      this.bars1m = this.merge(parse(m1), this.bars1m);
    } catch (err) {
      // The chart then starts empty and fills from live ticks; nothing is filled in
      console.warn(`Price history unavailable for ${market.symbol}:`, err.message);
    }
  }

  merge(history, live) {
    if (!live.length) return history;
    const firstLive = live[0].t;
    return [...history.filter((b) => b.t < firstLive), ...live];
  }

  push(price, vol = 0, t = Date.now()) {
    this.update(this.bars1s, 1000, price, vol, t, MAX_1S);
    this.update(this.bars1m, 60000, price, vol, t, MAX_1M);
  }

  update(bars, ms, price, vol, t, max) {
    const start = Math.floor(t / ms) * ms;
    const last = bars[bars.length - 1];
    if (last && last.t === start) {
      last.h = Math.max(last.h, price);
      last.l = Math.min(last.l, price);
      last.c = price;
      last.v += vol;
    } else if (!last || start > last.t) {
      const o = last ? last.c : price;
      bars.push({ t: start, o, h: Math.max(o, price), l: Math.min(o, price), c: price, v: vol });
      if (bars.length > max) bars.splice(0, bars.length - max);
    }
  }

  /** OHLCV candles for a timeframe in seconds (5, 15 or 60) */
  candles(tf) {
    if (tf === 60) return this.bars1m;
    const ms = tf * 1000;
    const out = [];
    for (const b of this.bars1s) {
      const t = Math.floor(b.t / ms) * ms;
      const cur = out[out.length - 1];
      if (cur && cur.t === t) {
        cur.h = Math.max(cur.h, b.h);
        cur.l = Math.min(cur.l, b.l);
        cur.c = b.c;
        cur.v += b.v;
      } else {
        out.push({ ...b, t });
      }
    }
    return out;
  }

  /** Points for the line view: 1s closes, or 1m closes when zoomed out */
  points(tf) {
    const bars = tf === 60 ? this.bars1m : this.bars1s;
    const half = tf === 60 ? 30000 : 500;
    return bars.map((b) => ({ t: b.t + half, p: b.c }));
  }

  /** Price at a moment, interpolated between the nearest 1s closes */
  priceAt(t) {
    const bars = t < (this.bars1s[0]?.t ?? Infinity) ? this.bars1m : this.bars1s;
    if (!bars.length) return null;
    let lo = 0;
    let hi = bars.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (bars[mid].t <= t) lo = mid; else hi = mid - 1;
    }
    return bars[lo];
  }
}
