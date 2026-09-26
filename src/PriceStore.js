/**
 * PriceStore.js
 * Price history shared by the line and candle views: 1s and 1m OHLC(V) bars, preloaded from the
 * same source as live prices (Coinbase candles and trades, or Binance klines when Binance is chosen), then
 * updated from live ticks. RedStone reports come every 10 seconds and carry no trade volume, so in
 * RedStone mode points are 10s apart and the volume strip stays empty.
 */

import { API_CONFIG } from './config.js';

const MAX_1S = 3600;
const MAX_1M = 1000;
const MAX_FILL = 720; // flat candles per gap: 1 hour of 5 s candles

export class PriceStore {
  constructor() {
    this.bars1s = [];
    this.bars1m = [];
    this.loadToken = 0;
    this.loading = false; // true while history for the current market is being fetched
  }

  reset() {
    this.bars1s = [];
    this.bars1m = [];
  }

  /** Preload history from the active price source for a market ({ feed, binanceTradeStream }) */
  async load(market) {
    const token = ++this.loadToken;
    this.reset();
    if (!market) return;
    this.loading = true;
    try {
      await this.loadFrom(market, token);
    } finally {
      if (token === this.loadToken) this.loading = false;
    }
  }

  async loadFrom(market, token) {
    if (API_CONFIG.priceSource === 'coinbase' && market.coinbase) {
      try {
        const base = `${API_CONFIG.coinbaseRestUrl}/products/${market.coinbase}`;
        const [candles, trades] = await Promise.all([
          fetch(`${base}/candles?granularity=60`, { signal: AbortSignal.timeout(8000) }).then((r) => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); }),
          fetch(`${base}/trades?limit=1000`, { signal: AbortSignal.timeout(8000) }).then((r) => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); })
        ]);
        if (token !== this.loadToken) return;
        const live = { s: this.bars1s, m: this.bars1m };
        // 1m bars from candles ([time, low, high, open, close, volume], newest first)
        const m1 = candles.map((c) => ({ t: c[0] * 1000, o: c[3], h: c[2], l: c[1], c: c[4], v: c[5] })).reverse();
        // 1s bars from the latest trades (newest first)
        this.bars1s = [];
        for (const tr of [...trades].reverse()) this.update(this.bars1s, 1000, parseFloat(tr.price), parseFloat(tr.size) || 0, Date.parse(tr.time), MAX_1S);
        this.bars1m = m1;
        this.bars1s = this.merge(this.bars1s, live.s);
        this.bars1m = this.merge(this.bars1m, live.m);
      } catch (err) {
        console.warn(`Price history unavailable for ${market.symbol}:`, err.message);
      }
      return;
    }
    let urls;
    let parse;
    if (API_CONFIG.priceSource === 'binance' && market.binanceTradeStream) {
      const base = `${API_CONFIG.binanceRestUrl}/klines?symbol=${market.binanceTradeStream.split('@')[0].toUpperCase()}`;
      urls = [`${base}&interval=1s&limit=1000`, `${base}&interval=1m&limit=500`];
      parse = (rows) => rows.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
    } else {
      return;
    }
    try {
      const [s1, m1] = await Promise.all(urls.map(async (u) => {
        const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
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

  /**
   * OHLCV candles for a timeframe in seconds (5, 15 or 60). An interval with no trade is a flat candle
   * at the last traded price with zero volume, as exchanges draw it: thinly traded markets (MON/USD
   * trades every few seconds) would otherwise show scattered bars with gaps between them.
   */
  candles(tf, now = Date.now()) {
    const ms = tf * 1000;
    return PriceStore.fillGaps(tf === 60 ? this.bars1m : this.aggregate(ms), ms, now);
  }

  static fillGaps(bars, ms, now) {
    if (!bars.length) return bars;
    const out = [];
    const last = Math.floor(now / ms) * ms;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const prev = out[out.length - 1];
      // At most MAX_FILL flat candles per gap (a long outage shows as a gap, not hours of flat bars)
      if (prev) for (let t = prev.t + ms, n = 0; t < b.t && n < MAX_FILL; t += ms, n++) out.push({ t, o: prev.c, h: prev.c, l: prev.c, c: prev.c, v: 0 });
      out.push(b);
    }
    const end = out[out.length - 1];
    for (let t = end.t + ms, n = 0; t <= last && n < MAX_FILL; t += ms, n++) out.push({ t, o: end.c, h: end.c, l: end.c, c: end.c, v: 0 });
    return out;
  }

  aggregate(ms) {
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
