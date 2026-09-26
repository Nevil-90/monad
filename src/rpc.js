/**
 * rpc.js
 * JSON-RPC provider for Monad's public endpoints, which allow 15 requests per second and answer the
 * excess with HTTP 429 / code -32011 ("requests limited to 15/sec"). ethers reports that on eth_call
 * as a misleading "missing revert data". This provider recognises exactly that response and retries
 * the same request after a short, growing pause. Any other error is thrown immediately.
 */

import { ethers } from 'ethers';

const MAX_RETRIES = 6;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function isRateLimited(err) {
  const parts = [err?.message, err?.shortMessage, err?.info?.error?.message, err?.error?.message, err?.info?.error?.code, err?.error?.code];
  return parts.some((p) => p !== undefined && /limited to|too many requests|\b429\b|-32011/i.test(String(p)));
}

export class MonadRpcProvider extends ethers.JsonRpcProvider {
  constructor(url, chainId) {
    // One request per HTTP call so a throttled response maps to exactly one retried request
    super(url, chainId, { staticNetwork: true, batchMaxCount: 1 });
  }

  async send(method, params) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await super.send(method, params);
      } catch (err) {
        if (!isRateLimited(err) || attempt >= MAX_RETRIES) throw err;
        await sleep(150 * 2 ** attempt + Math.random() * 150);
      }
    }
  }
}
