/**
 * rpc.js
 * JSON-RPC provider for Monad's public endpoints, which allow 15 requests per second and answer the
 * excess with HTTP 429 / code -32011 ("requests limited to 15/sec"). ethers reports that on eth_call
 * as a misleading "missing revert data". This provider recognises exactly that response and retries
 * the same request after a short, growing pause. It also retries plain transient network failures
 * (a request timeout, a dropped connection) the same way - a public endpoint under load can hiccup
 * on those too, and without this a single one used to crash the whole keeper/relay process. Any other
 * error is thrown immediately. It also paces its own requests (at most MAX_PER_SECOND) so a page or
 * script does not trip the limit.
 */

import { ethers } from 'ethers';

const MAX_RETRIES = 6;
const MAX_PER_SECOND = 6;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function isRateLimited(err) {
  const parts = [err?.message, err?.shortMessage, err?.info?.error?.message, err?.error?.message, err?.info?.error?.code, err?.error?.code];
  return parts.some((p) => p !== undefined && /limited to|too many requests|\b429\b|-32011/i.test(String(p)));
}

export function isTransientNetworkError(err) {
  const codes = [err?.code, err?.error?.code, err?.cause?.code];
  if (codes.some((c) => c !== undefined && /^(TIMEOUT|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ENETUNREACH|EPIPE)$/.test(String(c)))) return true;
  const parts = [err?.message, err?.shortMessage, err?.error?.message];
  return parts.some((p) => p !== undefined && /request timeout|network (error|timeout)|socket hang up|ECONNRESET/i.test(String(p)));
}

export class MonadRpcProvider extends ethers.JsonRpcProvider {
  constructor(url, chainId) {
    // One request per HTTP call so a throttled response maps to exactly one retried request
    super(url, chainId, { staticNetwork: true, batchMaxCount: 1 });
  }

  // ethers only recognises "insufficient funds" for a failed send; Monad's node says "insufficient
  // balance" instead, so that real (and common) error was falling through to ethers' generic
  // "could not coalesce error" / UNKNOWN_ERROR, hiding the actual cause behind a message that looks
  // like a provider bug instead of "this wallet is out of gas money". Likewise a genuine nonce
  // collision (two txs racing for the same nonce) comes back as "An existing transaction had higher
  // priority", not anything ethers' own nonce-too-low pattern recognises.
  getRpcError(payload, _error) {
    const message = _error?.error?.message;
    if ((payload.method === 'eth_sendRawTransaction' || payload.method === 'eth_sendTransaction') && typeof message === 'string') {
      if (/insufficient balance/i.test(message)) {
        return ethers.makeError('insufficient funds for intrinsic transaction cost', 'INSUFFICIENT_FUNDS', {
          transaction: payload.params[0], info: { payload, error: _error.error }
        });
      }
      if (/existing transaction had higher priority/i.test(message)) {
        return ethers.makeError('nonce has already been used', 'NONCE_EXPIRED', {
          transaction: payload.params[0], info: { payload, error: _error.error }
        });
      }
    }
    return super.getRpcError(payload, _error);
  }

  /** Waits until sending one more request keeps this client under MAX_PER_SECOND */
  async pace() {
    this.sent ||= [];
    for (;;) {
      const now = Date.now();
      while (this.sent.length && now - this.sent[0] >= 1000) this.sent.shift();
      if (this.sent.length < MAX_PER_SECOND) {
        this.sent.push(now);
        return;
      }
      await sleep(1000 - (now - this.sent[0]) + 5);
    }
  }

  async send(method, params) {
    for (let attempt = 0; ; attempt++) {
      await this.pace();
      try {
        return await super.send(method, params);
      } catch (err) {
        if (!(isRateLimited(err) || isTransientNetworkError(err)) || attempt >= MAX_RETRIES) throw err;
        await sleep(150 * 2 ** attempt + Math.random() * 150);
      }
    }
  }
}
