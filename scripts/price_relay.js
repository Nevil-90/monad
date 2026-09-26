/**
 * scripts/price_relay.js
 * Pyth price relay for the browser. Since the Pyth Core upgrade (2026-08-26) Hermes requires an API
 * key, which must never ship in frontend code. This relay holds the key, subscribes once to the
 * Hermes price stream for every configured market, and serves:
 *
 *   GET /stream              Server-Sent Events: a snapshot, then { id, p, t } price ticks
 *   GET /history?id=0x…&tf=1s|1m   Recent OHLC bars built from the stream (up to 2h of 1s, 24h of 1m)
 *   GET /health              Upstream status and feed count
 *
 * Every price shown in the UI is then the same Pyth price the contract settles on.
 *
 * Usage:
 *   npm run relay          (reads PYTH_API_KEY from .env)
 *   npm run dev            (with VITE_PRICE_RELAY_URL=http://localhost:8787 in .env)
 *
 * Env: PYTH_API_KEY (required), PORT (8787), PYTH_HERMES_URL (https://pyth.dourolabs.app/hermes),
 *      ALLOWED_ORIGIN (* by default; set to your site's origin in production)
 */

import http from 'http';
import { API_CONFIG, SUPPORTED_MARKETS } from '../src/config.js';

const API_KEY = process.env.PYTH_API_KEY;
const PORT = Number(process.env.PORT || 8787);
const HERMES = API_CONFIG.pythHermesUrl.replace(/\/$/, '');
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const MAX_1S = 7200;
const MAX_1M = 1440;

if (!API_KEY) {
  console.error('PYTH_API_KEY is required. Get one at Pyth Terminal (free trial available).');
  process.exit(1);
}

const ids = Object.values(SUPPORTED_MARKETS).map((m) => m.pythId.toLowerCase().replace(/^0x/, ''));
const feeds = new Map(ids.map((id) => [id, { price: null, time: null, change24h: null, bars1s: [], bars1m: [] }]));
const clients = new Set();
let upstream = { connected: false, lastTick: 0, error: null };

// ---------------------------------------------------------------------------
// Upstream: Hermes price stream
// ---------------------------------------------------------------------------
function pushBar(bars, ms, price, t, max) {
  const start = Math.floor(t / ms) * ms;
  const last = bars[bars.length - 1];
  if (last && last[0] === start) {
    last[2] = Math.max(last[2], price);
    last[3] = Math.min(last[3], price);
    last[4] = price;
  } else if (!last || start > last[0]) {
    const o = last ? last[4] : price;
    bars.push([start, o, Math.max(o, price), Math.min(o, price), price]);
    if (bars.length > max) bars.splice(0, bars.length - max);
  }
}

function onPrice(id, price, t) {
  const f = feeds.get(id);
  if (!f || !Number.isFinite(price) || price <= 0) return;
  f.price = price;
  f.time = t;
  pushBar(f.bars1s, 1000, price, t, MAX_1S);
  pushBar(f.bars1m, 60000, price, t, MAX_1M);
  upstream.lastTick = Date.now();
  broadcast({ id: `0x${id}`, p: price, t });
}

async function connectUpstream(attempt = 0) {
  const url = `${HERMES}/v2/updates/price/stream?${ids.map((id) => `ids[]=${id}`).join('&')}&parsed=true&encoding=hex`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'text/event-stream' } });
    if (!res.ok) throw new Error(`Hermes ${res.status} ${res.statusText}`);
    upstream = { ...upstream, connected: true, error: null };
    console.log(`[relay] streaming ${ids.length} Pyth feeds from ${HERMES}`);
    attempt = 0;

    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = event.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        if (!data) continue;
        try {
          for (const p of JSON.parse(data).parsed || []) {
            const price = Number(p.price.price) * 10 ** Number(p.price.expo);
            onPrice(p.id.toLowerCase().replace(/^0x/, ''), price, Number(p.price.publish_time) * 1000);
          }
        } catch (_) {
          // Ignore malformed events
        }
      }
    }
    throw new Error('Hermes stream ended');
  } catch (err) {
    upstream = { ...upstream, connected: false, error: err.message };
    const delay = Math.min(30000, 1000 * 2 ** attempt);
    console.error(`[relay] upstream error: ${err.message}; retrying in ${delay / 1000}s`);
    setTimeout(() => connectUpstream(attempt + 1), delay);
  }
}

/** 24h change from Pyth's own price 24 hours ago, refreshed every 10 minutes */
async function refreshChange24h() {
  const ts = Math.floor(Date.now() / 1000) - 86400;
  try {
    const url = `${HERMES}/v2/updates/price/${ts}?${ids.map((id) => `ids[]=${id}`).join('&')}&parsed=true`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${API_KEY}` } });
    if (!res.ok) return;
    for (const p of (await res.json()).parsed || []) {
      const f = feeds.get(p.id.toLowerCase().replace(/^0x/, ''));
      const then = Number(p.price.price) * 10 ** Number(p.price.expo);
      if (f && f.price && then > 0) f.change24h = ((f.price - then) / then) * 100;
    }
  } catch (_) {
    // Keep the previous value
  }
}

// ---------------------------------------------------------------------------
// Downstream: browsers
// ---------------------------------------------------------------------------
function broadcast(msg) {
  const line = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of clients) res.write(line);
}

function snapshot() {
  const out = {};
  for (const [id, f] of feeds) if (f.price) out[`0x${id}`] = { p: f.price, t: f.time, change24h: f.change24h };
  return out;
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Cache-Control', 'no-store');
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    const heartbeat = setInterval(() => {
      res.write(`event: stats\ndata: ${JSON.stringify(snapshot())}\n\n`);
    }, 15000);
    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
    });
    return;
  }

  if (url.pathname === '/history') {
    const id = (url.searchParams.get('id') || '').toLowerCase().replace(/^0x/, '');
    const f = feeds.get(id);
    if (!f) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"unknown feed"}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(url.searchParams.get('tf') === '1m' ? f.bars1m : f.bars1s));
    return;
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ upstream, feeds: feeds.size, clients: clients.size }));
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => console.log(`[relay] listening on http://localhost:${PORT}`));
connectUpstream();
// The 24h change needs a current price, so refresh again once the stream has delivered one
setTimeout(refreshChange24h, 15000);
setInterval(refreshChange24h, 10 * 60 * 1000);
