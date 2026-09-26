/**
 * scripts/price_relay.js
 * RedStone price relay for the browser. No API key: it reads RedStone's free public gateway.
 *
 * The gateway returns every feed it carries (about 2 MB, 420 KB compressed) every time and cannot be
 * filtered, which is too heavy for every browser to poll. This relay polls it once, keeps only the
 * markets' feeds, checks every signature, and serves:
 *
 *   GET /stream                    Server-Sent Events: a snapshot, then { feed, p, t } on each new report
 *   GET /history?feed=BTC          Recent prices [[tsMs, price], ...] (10s apart, up to 24h)
 *   GET /reports?feed=BTC&ts=SEC   The signed reports for that timestamp, ready for lockRoundWithUpdate /
 *                                  settleRoundWithUpdate. The gateway has no past reports; this archive does.
 *   GET /health                    Gateway status
 *
 * Prices are the median of all signers, exactly as the contract computes them.
 *
 * Usage:  npm run relay        (then NEXT_PUBLIC_PRICE_RELAY_URL=http://localhost:8787 for the app)
 * Env:    PORT (8787), ALLOWED_ORIGIN (* by default; set to your site's origin in production)
 */

import http from 'http';
import { SUPPORTED_MARKETS } from '../src/config.js';
import { ReportArchive } from './lib/report_archive.js';

const PORT = Number(process.env.PORT || 8787);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const DAY = 24 * 3600e3;

const feeds = Object.values(SUPPORTED_MARKETS).map((m) => m.feed);
const clients = new Set();
const latest = new Map(); // feed -> { p, t }

function broadcast(msg) {
  const line = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of clients) res.write(line);
}

// 24h change from our own archive; unknown (null) until the relay has run for 24 hours
function change24h(feed) {
  const series = prices.series(feed);
  const now = latest.get(feed);
  if (!now || !series.length || series[0][0] > now.t - DAY + 60e3) return null;
  let then = series[0];
  for (const point of series) {
    if (point[0] > now.t - DAY) break;
    then = point;
  }
  return ((now.p - then[1]) / then[1]) * 100;
}

function snapshot() {
  const out = {};
  for (const [feed, v] of latest) out[feed] = { ...v, change24h: change24h(feed) };
  return out;
}

const prices = new ReportArchive({
  feeds,
  keepMs: 2 * 3600e3,
  seriesKeepMs: DAY,
  onComplete: (feed, t, p) => {
    const prev = latest.get(feed);
    if (prev && prev.t >= t) return;
    latest.set(feed, { p, t });
    broadcast({ feed, p, t });
  }
});
prices.start();

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Cache-Control', 'no-store');
  const url = new URL(req.url, `http://${req.headers.host}`);
  const feed = url.searchParams.get('feed');

  if (url.pathname === '/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    const heartbeat = setInterval(() => res.write(`event: stats\ndata: ${JSON.stringify(snapshot())}\n\n`), 15000);
    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
    });
    return;
  }

  if (url.pathname === '/history') {
    if (!feeds.includes(feed)) return send(res, 404, { error: 'unknown feed' });
    return send(res, 200, prices.series(feed));
  }

  if (url.pathname === '/reports') {
    if (!feeds.includes(feed)) return send(res, 404, { error: 'unknown feed' });
    const reports = prices.reportsAt(feed, url.searchParams.get('ts'));
    if (!reports) return send(res, 404, { error: 'no complete report set captured for that timestamp' });
    return send(res, 200, reports);
  }

  if (url.pathname === '/health') {
    return send(res, 200, { gateway: prices.status, feeds, clients: clients.size, latest: snapshot() });
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => console.log(`[relay] listening on http://localhost:${PORT}, feeds: ${feeds.join(', ')}`));
