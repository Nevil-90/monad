/**
 * test/app_logic.test.js
 * Unit tests for the app code that decides what users see and sign: market IDs, the oracle report
 * format, odds, position classification and payouts, price sanity checks and RPC throttling.
 *
 * Run: npm test
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
import { SUPPORTED_MARKETS } from '../src/config.js';
import { toUnits, fromUnits, signReport, reportDigest, parsePackage, medianUnits, feedIdBytes32, fetchReportsAt, REDSTONE_PRIMARY_SIGNERS } from '../src/oracle.js';
import { MarketState } from '../src/MarketState.js';
import { LiveRounds } from '../src/LiveRounds.js';
import { CircuitBreaker } from '../src/CircuitBreaker.js';
import { isRateLimited } from '../src/rpc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
let total = 0;
function check(condition, message) {
  total++;
  if (condition) {
    passed++;
    console.log(`[PASS] ${message}`);
  } else {
    console.error(`\x1b[31m[FAIL]\x1b[0m ${message}`);
    process.exitCode = 1;
  }
}
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));

console.log('--- Markets ---');
for (const [key, m] of Object.entries(SUPPORTED_MARKETS)) {
  const expected = ethers.solidityPackedKeccak256(['bytes32', 'string', 'uint256'], [feedIdBytes32(m.feed), m.symbol, m.roundDuration]);
  check(m.marketId === expected, `${key}: marketId matches keccak256(feed, symbol, duration) as the contract derives it`);
  check(Boolean(m.feed && m.coinbase), `${key}: has a RedStone feed and a Coinbase product`);
}

console.log('\n--- Oracle report format ---');
check(toUnits('84161.4084229') === 8416140842290n, 'toUnits converts a 7-decimal value exactly (no float rounding)');
check(toUnits('0.02669386') === 2669386n, 'toUnits keeps all 8 decimals of a small price');
check(toUnits('120') === 12000000000n, 'toUnits handles whole numbers');
let threw = false;
try { toUnits('1e-7'); } catch (_) { threw = true; }
check(threw, 'toUnits refuses exponent notation instead of guessing');
check(close(fromUnits(8416140842290n), 84161.4084229), 'fromUnits inverts toUnits');
const key = new ethers.SigningKey(ethers.id('unit-test-signer'));
const rep = signReport(key, 'BTC', 8400000000000n, 1790421980000n);
check(ethers.recoverAddress(reportDigest('BTC', 8400000000000n, 1790421980000n), rep.signature) === ethers.computeAddress(key.publicKey),
  'A signed report recovers to its signer');
check(ethers.recoverAddress(reportDigest('BTC', 8400000000001n, 1790421980000n), rep.signature) !== ethers.computeAddress(key.publicKey),
  'Changing the value by one unit breaks the signature');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'redstone_primary_prod_packages.json'), 'utf8'));
for (const feed of ['BTC', 'MON']) {
  const parsed = fixture[feed].map(parsePackage);
  const authorised = new Set(REDSTONE_PRIMARY_SIGNERS.map((a) => a.toLowerCase()));
  check(parsed.length === 5 && parsed.every((p) => authorised.has(p.signer.toLowerCase())),
    `Real ${feed} packages from the gateway recover to the 5 authorised signers`);
}
check(medianUnits([5n, 1n, 3n]) === 3n && medianUnits([4n, 1n, 3n, 2n]) === 2n && medianUnits([]) === null,
  'Median matches the contract (odd: middle, even: floor of the mean of the two middle values)');

console.log('\n--- Odds ---');
const ms = new MarketState({}, { skipFeed: true });
const btc = ms.markets.BTC;
check(btc.price === null && btc.roundId === null && btc.lockPrice === null, 'Markets start empty: no preset prices or rounds');
Object.assign(btc, { poolUp: 12, poolDown: 10 });
check(ms.getLiveOdds().multUp === null, 'No multiplier is shown until the contract fee is read');
ms.feeBps = 150;
const odds = ms.getLiveOdds();
check(close(odds.multUp, (22 * 0.985) / 12) && close(odds.multDown, (22 * 0.985) / 10), 'Multipliers use the pools and the fee: net pool / side pool');
check(close(ms.multiplierAfter('UP', 3), (25 * 0.985) / 15), 'Multiplier after a stake includes that stake on both totals');
Object.assign(btc, { poolUp: 5, poolDown: 0 });
check(ms.getLiveOdds().multUp === null, 'One-sided pool: no multiplier (the round would be refunded)');

console.log('\n--- Positions and payouts ---');
const BTC_ID = SUPPORTED_MARKETS.BTC.marketId.toLowerCase();
const me = '0x000000000000000000000000000000000000a11c';
const other = '0x000000000000000000000000000000000000b0b0';
const rec = (type, roundId, extra) => ({ type, user: me, marketId: BTC_ID, roundId, block: roundId, ...extra });
const history = {
  records: [
    rec('bet', 1, { side: 'UP', amount: 2 }), rec('bet', 1, { side: 'UP', amount: 1 }),
    { ...rec('bet', 1, { side: 'DOWN', amount: 4 }), user: other },
    rec('bet', 2, { side: 'DOWN', amount: 1 }),
    rec('bet', 3, { side: 'UP', amount: 1.5 }),
    rec('bet', 4, { side: 'UP', amount: 1 }),
    rec('bet', 5, { side: 'UP', amount: 0.7 }), rec('refund', 5, { amount: 0.7 })
  ],
  rounds: new Map([
    [`${BTC_ID}:1`, { status: 'settled', winningSide: 'UP', up: 3, down: 4 }],
    [`${BTC_ID}:2`, { status: 'settled', winningSide: 'UP', up: 5, down: 1 }],
    [`${BTC_ID}:3`, { status: null, up: 1.5, down: 0 }],
    [`${BTC_ID}:4`, { status: null, up: 1, down: 2 }],
    [`${BTC_ID}:5`, { status: 'cancelled', up: 0.7, down: 0 }]
  ]),
  marketLabel: () => 'BTC/USD'
};
const live = new LiveRounds({ web3: { fetchOnChainRound: async () => ({ feeBps: 150 }) }, history });
live.state = { marketId: SUPPORTED_MARKETS.BTC.marketId, roundId: 4, closedBetting: false };
live.feeRates.set(`${BTC_ID}:1`, 150);
const pos = Object.fromEntries(live.positions(me).map((p) => [p.roundId, p]));
// Contract: fee = min(total * bps / 10000, losingPool); payout = stake * (total - fee) / winningPool
const payout1 = (3 * (7 - Math.min((7 * 150) / 10000, 4))) / 3;
check(pos[1].status === 'Won' && close(pos[1].payout, payout1) && pos[1].amount === 3, 'Won round: stakes summed, payout by the contract formula');
check(pos[2].status === 'Lost', 'Lost round');
check(pos[3].status === 'Refunded', 'One-sided past round: refundable directly (SEC-26)');
check(pos[4].status === 'Active', 'Current round with betting open: active, not refundable');
check(pos[5].status === 'Refunded' && pos[5].claimed && pos[5].payout === 0.7, 'Claimed refund: shows the exact amount transferred');
live.state.closedBetting = true;
Object.assign(history.rounds.get(`${BTC_ID}:4`), { down: 0 });
check(live.positions(me).find((p) => p.roundId === 4).status === 'Refunded', 'Current round, one-sided after betting closed: refundable');
const unread = new LiveRounds({ web3: { fetchOnChainRound: async () => null }, history });
unread.state = live.state;
check(unread.positions(me).find((p) => p.roundId === 1).payout === null, 'Win payout is not estimated until the round fee is read from the contract');

console.log('\n--- Round phases (from the contract timestamps, no polling) ---');
const base = { status: 1, totalUp: 1n, totalDown: 1n, betCloseTimestamp: 100, lockTimestamp: 110, closeTimestamp: 170, expiryTimestamp: 770, closePublishTime: 0 };
const ph = (r, t) => LiveRounds.phaseOf({ ...base, ...r }, t).phase;
check(ph({}, 90) === 'open' && ph({}, 105) === 'closed', 'Open until betCloseTimestamp, then closed until the strike locks');
check(ph({ totalDown: 0n }, 105) === 'idle', 'One-sided after betting closed: idle (refundable, next bet opens a new round)');
check(ph({ status: 2 }, 150) === 'locked' && ph({ status: 2 }, 175) === 'settling', 'Locked until close time, then settling');
check(ph({ status: 2, closePublishTime: 180 }, 190) === 'confirming', 'A proposed (late) close report shows as confirming (SEC-28 challenge period)');
check(ph({ status: 2 }, 771) === 'expired' && ph({ status: 1 }, 771) === 'expired', 'Contested and unresolved past expiry: refundable (SEC-29)');
check(ph({ status: 3 }, 200) === 'ended', 'Settled: ended');
live.state = { marketId: SUPPORTED_MARKETS.BTC.marketId, roundId: 4, closedBetting: true, expired: true };
Object.assign(history.rounds.get(`${BTC_ID}:4`), { down: 2 });
check(live.positions(me).find((p) => p.roundId === 4).status === 'Refunded', 'Current contested round past expiry: shown as refundable');

console.log('\n--- Report history lookup ---');
{
  const t = 1790431040000n;
  const pkg = (k, feed, ts) => {
    const r = signReport(k, feed, 8395250000000n, ts);
    return { timestampMilliseconds: Number(ts), signature: ethers.encodeBase64(r.signature), dataPoints: [{ dataFeedId: feed, value: '83952.5' }] };
  };
  const keys = [1, 2, 3].map((i) => new ethers.SigningKey(ethers.id(`hist-${i}`)));
  const signers = keys.slice(0, 2).map((k) => ethers.computeAddress(k.publicKey));
  const body = { BTC: [pkg(keys[0], 'BTC', t), pkg(keys[1], 'BTC', t - 10000n), pkg(keys[2], 'BTC', t)] };
  let asked = null;
  const got = await fetchReportsAt(['BTC'], t, { signers, fetchImpl: async (url) => { asked = url; return { ok: true, json: async () => body }; } });
  check(asked.endsWith(`/v2/data-packages/historical/redstone-primary-prod/${t}`), 'Asks the gateway history for the exact timestamp');
  check(got.BTC.length === 1 && got.BTC[0].signer === signers[0], 'Keeps only authorised signers at exactly that timestamp (other times and unknown keys dropped)');
  let failed = false;
  try { await fetchReportsAt(['BTC'], t, { fetchImpl: async () => ({ ok: false, status: 513, statusText: 'too old' }) }); } catch (_) { failed = true; }
  check(failed, 'A gateway error is raised, not turned into an empty result');
}

console.log('\n--- Early result from the signed close report ---');
{
  const { API_CONFIG } = await import('../src/config.js');
  API_CONFIG.priceRelayUrl = 'http://relay.test';
  const oracleKeys = [1, 2, 3, 4, 5].map((i) => new ethers.SigningKey(ethers.id(`early-${i}`)));
  const oracleAddrs = oracleKeys.map((k) => ethers.computeAddress(k.publicKey));
  const closeTs = 1790444520;
  const strike = 8406841000000n; // $84,068.41
  const run = async (reports) => {
    const results = [];
    const lr = new LiveRounds({ web3: {}, history: null, onRoundEnd: (d) => results.push(d) });
    lr.oracle = Promise.resolve({ set: new Set(oracleAddrs.map((a) => a.toLowerCase())), threshold: 4 });
    lr.state = { marketKey: 'BTC', marketId: SUPPORTED_MARKETS.BTC.marketId, roundId: 7 };
    globalThis.fetch = async () => ({ ok: true, json: async () => reports.map((r) => ({ value: String(r.value), timestampMs: String(r.timestampMs), signature: r.signature })) });
    await lr.tryEarlyResult('k', SUPPORTED_MARKETS.BTC, closeTs, { roundId: 7, lockPrice: strike * 10n ** 28n });
    return results;
  };
  const signed = (keys, value, ts = closeTs) => keys.map((k) => signReport(k, 'BTC', value, BigInt(ts) * 1000n));
  let got = await run(signed(oracleKeys.slice(0, 4), 8405467000000n));
  check(got.length === 1 && got[0].winner === 'DOWN' && got[0].confirming && close(got[0].closePrice, 84054.67),
    'Four authorised signatures at the close second: Fall wins at $84,054.67, marked as confirming on-chain');
  got = await run(signed(oracleKeys.slice(0, 3), 8405467000000n));
  check(got.length === 0, 'Three signatures (below the contract threshold): no early result');
  got = await run([...signed(oracleKeys.slice(0, 3), 8499999000000n), ...signed([new ethers.SigningKey(ethers.id('rogue'))], 8499999000000n)]);
  check(got.length === 0, 'A report from an unknown signer: no early result');
  got = await run(signed(oracleKeys.slice(0, 4), 8499999000000n, closeTs + 10));
  check(got.length === 0, 'Reports for another second: no early result');
  got = await run(signed(oracleKeys.slice(0, 4), strike));
  check(got.length === 1 && got[0].winner === 'REFUND', 'Close equal to the strike: a tie (refund), as the contract decides');
}

console.log('\n--- Price sanity ---');
const cb = new CircuitBreaker();
check(cb.validateTick('BTC', 84000, null, Date.now(), true).valid, 'First price is accepted');
check(!cb.validateTick('BTC', 84000 * 1.3, 84000, Date.now(), false).valid, 'A 30% jump in one tick is rejected');
check(cb.validateTick('BTC', 84050, 84000, Date.now(), false).valid, 'A normal move is accepted');

console.log('\n--- RPC throttling ---');
check(isRateLimited({ info: { error: { code: -32011, message: 'requests limited to 15/sec' } } }), 'Recognises Monad\'s 15/sec limit response');
check(isRateLimited({ message: 'server response 429 Too Many Requests' }), 'Recognises HTTP 429');
check(!isRateLimited({ shortMessage: 'execution reverted: "Betting window closed"' }), 'A real revert is not treated as throttling');

console.log(`\nAPP LOGIC VERDICT: ${passed}/${total} checks passed`);
