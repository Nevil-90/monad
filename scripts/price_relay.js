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
 *   GET /events?after=BLOCK        The AMM contract's event logs after BLOCK, for the Dashboard (indexed
 *                                  here because Monad RPCs serve at most 100 blocks per log request)
 *   GET /events/stream?after=BLOCK Server-Sent Events: the same backlog, then new events pushed as
 *                                  blocks are indexed (no polling)
 *   GET /health                    Gateway and index status
 *
 * Prices are the median of all signers, exactly as the contract computes them.
 *
 * Usage:  npm run relay        (then NEXT_PUBLIC_PRICE_RELAY_URL=http://localhost:8787 for the app)
 * Env:    PORT (8787), ALLOWED_ORIGIN (* by default; set to your site's origin in production)
 */

import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { SUPPORTED_MARKETS, getConfig } from '../src/config.js';
import { ReportArchive } from './lib/report_archive.js';
import { EventIndex } from './lib/event_index.js';

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

// Contract event index for the Dashboard; needs the deployed contract in .env
const net = getConfig();
let events = null;
if (net.contractAddress && net.deployBlock !== null) {
  events = new EventIndex({
    rpcUrl: net.rpcUrl,
    chainId: net.chainId,
    address: net.contractAddress,
    fromBlock: net.deployBlock,
    dataDir: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data')
  });
  events.start();
} else {
  console.log('[relay] no contract in .env (NEXT_PUBLIC_CONTRACT_ADDRESS / _DEPLOY_BLOCK): /events disabled');
}

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

  if (url.pathname === '/events/stream') {
    if (!events) return send(res, 503, { error: 'This relay has no contract configured (NEXT_PUBLIC_CONTRACT_ADDRESS).' });
    const after = Number(url.searchParams.get('after'));
    if (!Number.isFinite(after)) return send(res, 400, { error: 'after must be a block number' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
    const push = (body) => res.write(`data: ${JSON.stringify(body)}\n\n`);
    push(events.since(after));
    // New events as they are indexed; an empty push still advances the head (the "Live · block" figure)
    const onIndexed = (logs, head) => push({ address: events.address, head, logs });
    events.subscribers.add(onIndexed);
    req.on('close', () => events.subscribers.delete(onIndexed));
    return;
  }

  if (url.pathname === '/events') {
    if (!events) return send(res, 503, { error: 'This relay has no contract configured (NEXT_PUBLIC_CONTRACT_ADDRESS).' });
    const after = Number(url.searchParams.get('after'));
    if (!Number.isFinite(after)) return send(res, 400, { error: 'after must be a block number' });
    return send(res, 200, events.since(after));
  }

  if (url.pathname === '/health') {
    return send(res, 200, {
      gateway: prices.status,
      events: events ? { ...events.status, head: events.head, count: events.logs.length } : null,
      feeds,
      clients: clients.size,
      latest: snapshot()
    });
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => console.log(`[relay] listening on http://localhost:${PORT}, feeds: ${feeds.join(', ')}`));
