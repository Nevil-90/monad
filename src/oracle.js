/**
 * oracle.js
 * Signed price reports in RedStone's public data-package format, shared by the app, keeper, tests
 * and local chain. Mirrors contracts/SignedPriceOracle.sol: a report is signed over
 *
 *   dataFeedId (bytes32) | value (uint256, 8 decimals) | timestampMs (6 bytes) | 32 (4 bytes) | 1 (3 bytes)
 *
 * The free gateway serves only the latest reports (one set every 10 seconds), not past ones, so
 * whoever locks or settles a round must capture the report for its timestamp when it is published.
 */

import { ethers } from 'ethers';

export const REDSTONE_GATEWAY = 'https://oracle-gateway-1.a.redstone.finance';
export const REDSTONE_DATA_SERVICE = 'redstone-primary-prod';

// Authorised nodes of redstone-primary-prod (checked 2026-09-26). The deployed contract requires 4 of
// these 5 signatures per report (SECURITY_FIXES.md SEC-22, SEC-27).
export const REDSTONE_PRIMARY_SIGNERS = [
  '0x8BB8F32Df04c8b654987DAaeD53D6B6091e3B774',
  '0xdEB22f54738d54976C4c0fe5ce6d408E40d88499',
  '0x51Ce04Be4b3E32572C4Ec9135221d0691Ba7d202',
  '0xDD682daEC5A90dD295d14DA4b0bec9281017b5bE',
  '0x9c5AE89C4Af6aA32cE58588DBaF90d18a855B6de'
];

export const VALUE_DECIMALS = 8;

export const feedIdBytes32 = (feed) => ethers.encodeBytes32String(feed);

/** Decimal number or string -> 8-decimal integer, exactly (no float arithmetic) */
export function toUnits(value) {
  const text = typeof value === 'bigint' ? `${value}` : String(value);
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`Unsupported oracle value: ${text}`);
  const [int, frac = ''] = text.split('.');
  return BigInt(int + (frac + '0'.repeat(VALUE_DECIMALS)).slice(0, VALUE_DECIMALS));
}

export const fromUnits = (units) => Number(units) / 10 ** VALUE_DECIMALS;

export function reportDigest(feed, units, timestampMs) {
  return ethers.keccak256(ethers.concat([
    feedIdBytes32(feed),
    ethers.toBeHex(units, 32),
    ethers.toBeHex(timestampMs, 6),
    ethers.toBeHex(32, 4),
    ethers.toBeHex(1, 3)
  ]));
}

/** Signs a report with a local key (tests and the local dev chain only) */
export function signReport(signingKey, feed, units, timestampMs) {
  const sig = signingKey.sign(reportDigest(feed, units, timestampMs));
  return { value: units, timestampMs: BigInt(timestampMs), signature: sig.serialized };
}

/** Parses one gateway data package into a contract-ready report, checking its signature */
export function parsePackage(pkg) {
  const point = pkg.dataPoints?.[0];
  if (!point || pkg.dataPoints.length !== 1) throw new Error('Expected a single-feed data package');
  const units = toUnits(point.value);
  const timestampMs = BigInt(pkg.timestampMilliseconds);
  const signature = ethers.hexlify(ethers.decodeBase64(pkg.signature));
  const signer = ethers.recoverAddress(reportDigest(point.dataFeedId, units, timestampMs), signature);
  return { feed: point.dataFeedId, signer, report: { value: units, timestampMs, signature } };
}

/**
 * Latest reports for the given feeds from the free gateway: { BTC: [{ feed, signer, report }], ... }.
 * Packages whose signature does not recover to an authorised signer are dropped.
 */
export async function fetchLatestReports(feeds, { signers = REDSTONE_PRIMARY_SIGNERS, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${REDSTONE_GATEWAY}/v2/data-packages/latest/${REDSTONE_DATA_SERVICE}`);
  if (!res.ok) throw new Error(`RedStone gateway ${res.status} ${res.statusText}`);
  const body = await res.json();
  const allowed = new Set(signers.map((a) => a.toLowerCase()));
  const out = {};
  for (const feed of feeds) {
    out[feed] = (body[feed] || [])
      .map((pkg) => { try { return parsePackage(pkg); } catch (_) { return null; } })
      .filter((p) => p && p.feed === feed && allowed.has(p.signer.toLowerCase()));
  }
  return out;
}

/** Median of 8-decimal values, as the contract computes it */
export function medianUnits(values) {
  const v = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const n = v.length;
  if (!n) return null;
  return n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2n;
}
