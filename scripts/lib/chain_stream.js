/**
 * scripts/lib/chain_stream.js
 * Push-based view of the chain: one WebSocket to Monad's RPC with two subscriptions,
 *   eth_subscribe newHeads   every block header (number, timestamp, base fee)
 *   eth_subscribe logs       every log the AMM contract emits
 * Nothing is polled. If the socket drops, it reconnects with back-off and calls onReconnect(), so the
 * user of the stream can fetch what it missed once (e.g. getLogs over the gap), then carries on.
 */

const MAX_BACKOFF_MS = 30000;
// A socket that has delivered no block for this long is dead even if it was never closed (Monad makes
// a block every ~0.4 s); it is closed and reopened. This checks a local clock, not the network.
const SILENT_MS = 20000;

export function wsUrlFor(rpcUrl) {
  return rpcUrl.replace(/^http/, 'ws');
}

export class ChainStream {
  /**
   * @param {object} o
   * @param {string} o.wsUrl
   * @param {string} o.address           contract whose logs to follow
   * @param {(head) => void} [o.onHead]  { number, timestamp, baseFeePerGas } as numbers/bigint
   * @param {(log) => void} [o.onLog]    raw JSON-RPC log (hex fields); removed logs have removed: true
   * @param {() => void} [o.onReconnect] called after every (re)connection once both subscriptions are live
   */
  constructor({ wsUrl, address, onHead, onLog, onReconnect, log = console }) {
    Object.assign(this, { wsUrl, address, onHead, onLog, onReconnect, log });
    this.attempt = 0;
    this.status = { connected: false, error: null, lastHead: null, lastHeadAt: 0 };
  }

  start() {
    this.stopped = false;
    this.connect();
    this.watchdog = setInterval(() => {
      if (this.status.connected && Date.now() - this.status.lastHeadAt > SILENT_MS) {
        this.log.error('[stream] no block for 20 s; reconnecting');
        this.ws?.close();
      }
    }, 5000);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.watchdog);
    this.ws?.close();
  }

  connect() {
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    const subs = new Map(); // subscription id -> 'head' | 'log'
    let pending = 2;
    ws.onopen = () => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] }));
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_subscribe', params: ['logs', { address: this.address }] }));
    };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch (_) { return; }
      if (m.id === 1 || m.id === 2) {
        if (m.error) {
          this.status.error = `subscribe failed: ${m.error.message}`;
          this.log.error(`[stream] ${this.status.error}`);
          ws.close();
          return;
        }
        subs.set(m.result, m.id === 1 ? 'head' : 'log');
        if (--pending === 0) {
          this.attempt = 0;
          this.status = { ...this.status, connected: true, error: null, lastHeadAt: Date.now() };
          this.onReconnect?.();
        }
        return;
      }
      const kind = subs.get(m.params?.subscription);
      const r = m.params?.result;
      if (!kind || !r) return;
      if (kind === 'head') {
        const head = { number: Number(r.number), timestamp: Number(r.timestamp), baseFeePerGas: r.baseFeePerGas ? BigInt(r.baseFeePerGas) : null };
        this.status.lastHead = head.number;
        this.status.lastHeadAt = Date.now();
        this.onHead?.(head);
      } else {
        this.onLog?.(r);
      }
    };
    ws.onerror = (e) => {
      this.status.error = e?.message || 'WebSocket error';
    };
    ws.onclose = () => {
      this.status.connected = false;
      if (this.stopped) return;
      const wait = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.attempt++);
      this.log.error(`[stream] disconnected (${this.status.error || 'closed'}); reconnecting in ${wait / 1000}s`);
      setTimeout(() => this.connect(), wait);
    };
  }
}
