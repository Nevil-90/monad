/**
 * scripts/price_relay.js
 * The app's relay. Nothing in it polls:
 *
 *   GET /events/stream?after=BLOCK Server-Sent Events: the AMM contract's event logs after BLOCK, then
 *                                  new events, block height and gas price pushed as Monad's WebSocket
 *                                  delivers them. The Trade view and fee display run on it.
 *   GET /events?after=BLOCK        The same backlog as one JSON response
 *   GET /dashboard/activity        Paginated, filtered rows for the Dashboard's Activity tab (Supabase)
 *   GET /dashboard/bets            Paginated, filtered rows for the Dashboard's Bets tab (Supabase)
 *   GET /dashboard/wallets         Paginated, sorted per-wallet totals for the Wallets tab (SQL aggregate)
 *   GET /dashboard/summary         All-time totals (bets, staked, wins, jackpots, wallets) for the stat
 *                                  tiles, computed in SQL so the browser never downloads full history
 *   GET /reports?feed=BTC&ts=SEC   Signed RedStone reports for that report time, ready for
 *                                  recordAndSettle (fetched once from the gateway's 24 h history and
 *                                  cached), so anyone can settle a bet and the app can show a result early
 *   GET /health                    Stream, index and report-lookup status
 *
 * Why a relay at all: Monad RPCs serve at most 100 blocks per log request, too slow for every browser
 * to scan the contract's history, and RedStone's history responses are ~2 MB (every feed it carries).
 *
 * The /dashboard/* routes are the Dashboard's only read path: it never loads the full event history
 * into the browser. They query Supabase (scripts/lib/dashboard_store.js), the relay's one central,
 * durable store (schema in supabase/schema.sql) that scripts/lib/event_index.js keeps written as it
 * indexes the chain. /events and /events/stream are unrelated to this: they still serve the relay's
 * in-memory log array, unchanged, for the live Trade view.
 *
 * Usage:  npm run relay        (then NEXT_PUBLIC_PRICE_RELAY_URL=http://localhost:8787 for the app)
 * Env:    PORT (8787), ALLOWED_ORIGIN (required in production: your site's origin, e.g. https://app.example),
 *         SUPABASE_URL, SUPABASE_SERVICE_KEY (see .env.example and supabase/schema.sql)
 */

import http from 'http';
import { SUPPORTED_MARKETS, getConfig } from '../src/config.js';
import { ethers } from 'ethers';
import { HOUSE_ABI } from '../src/contracts/HouseAbi.js';
import { MonadRpcProvider } from '../src/rpc.js';
import { ReportSource } from './lib/report_source.js';
import { EventIndex } from './lib/event_index.js';
import * as dashboardStore from './lib/dashboard_store.js';

const PORT = Number(process.env.PORT || 8787);
const production = process.env.NODE_ENV === 'production';
if (production && !process.env.ALLOWED_ORIGIN) {
  console.error('[relay] ALLOWED_ORIGIN must be set in production (the app\'s origin), not left open to every site.');
  process.exit(1);
}
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const HEARTBEAT_MS = 15000; // keeps idle SSE connections open through proxies; carries no data

const feeds = Object.values(SUPPORTED_MARKETS).map((m) => m.feed);
const net = getConfig();
let events = null;
let reportSource = null;
if (net.contractAddress && net.deployBlock !== null) {
  // Serve reports for the contract's own signer set and threshold (read once)
  const amm = new ethers.Contract(net.contractAddress, HOUSE_ABI, new MonadRpcProvider(net.rpcUrl, net.chainId));
  const [signers, threshold] = await Promise.all([amm.oracleSigners(), amm.signerThreshold()]);
  reportSource = new ReportSource({ feeds, signers, threshold: Number(threshold) });
  events = await EventIndex.create({
    rpcUrl: net.rpcUrl,
    wsUrl: net.wsUrl,
    chainId: net.chainId,
    address: net.contractAddress,
    fromBlock: net.deployBlock
  });
  events.start();
} else {
  console.log('[relay] no contract in .env (NEXT_PUBLIC_CONTRACT_ADDRESS / _DEPLOY_BLOCK): /events disabled');
}

const json = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));
function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(json(body));
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') {
    res.writeHead(405);
    return res.end();
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const feed = url.searchParams.get('feed');

  if (url.pathname === '/reports') {
    if (!reportSource) return send(res, 503, { error: 'This relay has no contract configured (NEXT_PUBLIC_CONTRACT_ADDRESS).' });
    if (!feeds.includes(feed)) return send(res, 404, { error: 'unknown feed' });
    const ts = Number(url.searchParams.get('ts'));
    if (!Number.isInteger(ts) || ts % 10 !== 0) return send(res, 400, { error: 'ts must be a report time in seconds (multiple of 10)' });
    reportSource.reportsAt(feed, ts).then((reports) => {
      if (!reports) return send(res, 404, { error: `no complete set of signed reports for ${feed} at ${ts} (not published yet, or older than 24 h)` });
      send(res, 200, reports);
    }, (err) => send(res, 502, { error: err.message }));
    return;
  }

  if (url.pathname === '/events/stream') {
    if (!events) return send(res, 503, { error: 'This relay has no contract configured (NEXT_PUBLIC_CONTRACT_ADDRESS).' });
    const after = Number(url.searchParams.get('after'));
    if (!Number.isFinite(after)) return send(res, 400, { error: 'after must be a block number' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
    const push = (body) => res.write(`data: ${json(body)}\n\n`);
    push({ ...events.since(after), gasPrice: events.gasPrice });
    const onIndexed = ({ logs, head, gasPrice }) => push({ address: events.address, head, logs, gasPrice });
    events.subscribers.add(onIndexed);
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), HEARTBEAT_MS);
    req.on('close', () => {
      clearInterval(heartbeat);
      events.subscribers.delete(onIndexed);
    });
    return;
  }

  if (url.pathname === '/events') {
    if (!events) return send(res, 503, { error: 'This relay has no contract configured (NEXT_PUBLIC_CONTRACT_ADDRESS).' });
    const after = Number(url.searchParams.get('after'));
    if (!Number.isFinite(after)) return send(res, 400, { error: 'after must be a block number' });
    return send(res, 200, events.since(after));
  }

  if (url.pathname.startsWith('/dashboard/')) {
    if (!net.contractAddress || net.deployBlock === null) return send(res, 503, { error: 'This relay has no contract configured (NEXT_PUBLIC_CONTRACT_ADDRESS).' });
    const sp = url.searchParams;
    const base = { chainId: net.chainId, address: net.contractAddress.toLowerCase(), market: sp.get('market'), q: sp.get('q') || undefined };
    const page = { page: sp.get('page'), pageSize: sp.get('pageSize') };
    const handlers = {
      '/dashboard/activity': () => dashboardStore.activityPage({ ...base, type: sp.get('type'), ...page }),
      '/dashboard/bets': () => dashboardStore.betsPage({ ...base, ...page }),
      '/dashboard/wallets': () => dashboardStore.walletsPage({ ...base, sort: sp.get('sort'), dir: Number(sp.get('dir')), ...page }),
      '/dashboard/summary': () => dashboardStore.summary(base)
    };
    const handler = handlers[url.pathname];
    if (!handler) { res.writeHead(404); return res.end(); }
    handler().then((body) => send(res, 200, body), (err) => send(res, 502, { error: `Supabase: ${err.message}` }));
    return;
  }

  if (url.pathname === '/health') {
    const ok = Boolean(events?.stream?.status.connected && events.status.ok);
    return send(res, ok ? 200 : 503, {
      ok,
      stream: events?.stream?.status ?? null,
      events: events ? { ...events.status, head: events.head, count: events.logs.length, subscribers: events.subscribers.size } : null,
      gasPrice: events?.gasPrice ?? null,
      reports: reportSource?.stats ?? null
    });
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => console.log(`[relay] listening on http://localhost:${PORT}`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (events) {
      try { await events.flush(); } catch (err) { console.error(`[relay] flush on shutdown failed: ${err.message}`); }
    }
    process.exit(0);
  });
}
