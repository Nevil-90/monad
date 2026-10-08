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
import { HouseState } from '../src/HouseState.js';
import { ChainHistory } from '../src/ChainHistory.js';
import { HOUSE_ABI } from '../src/contracts/HouseAbi.js';
import { CircuitBreaker } from '../src/CircuitBreaker.js';
import { isRateLimited, isSpuriousInsufficientBalance } from '../src/rpc.js';

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
  check(/^0x[0-9a-f]{64}$/.test(m.marketId), `${key}: marketId is a bytes32 id`);
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

console.log('\n--- Markets start empty ---');
const ms = new MarketState({}, { skipFeed: true });
check(ms.markets.BTC.price === null && ms.markets.BTC.change24h === null, 'Markets start empty: no preset prices');

console.log('\n--- House bets from contract events ---');
{
  const iface = new ethers.Interface(HOUSE_ABI);
  const BTC_ID = SUPPORTED_MARKETS.BTC.marketId;
  const me = ethers.getAddress('0x000000000000000000000000000000000000a11c');
  const other = ethers.getAddress('0x000000000000000000000000000000000000b0b0');
  const e18 = (v) => ethers.parseEther(String(v));
  let n = 0;
  const log = (name, args) => {
    const { data, topics } = iface.encodeEventLog(name, args);
    n++;
    return { data, topics, blockNumber: n, logIndex: 0, transactionHash: ethers.id(`tx${n}`), timestamp: 1790000000 + n };
  };
  const web3 = { iface, account: me, contractAddress: '0x0000000000000000000000000000000000000001', fetchHouse: async () => null, fetchPlayer: async () => ({}) };
  const history = new ChainHistory(web3);
  history.refreshHouse = async () => {};
  const results = [];
  const house = new HouseState({ web3, history, onUpdate: () => {}, onResult: (b) => results.push(b) });
  house.readPlayer = async () => {};
  const placed = (id, who, side, stake, startTs, dur, streakBet = true) =>
    log('BetPlaced', [id, who, BTC_ID, side, e18(stake), e18(stake * 1.9), startTs, dur, streakBet]);
  const settled = (id, who, status, paid, p0, p1, streak) =>
    log('BetSettled', [id, who, BTC_ID, status, e18(paid), p0, p1, streak]);
  await history.apply({
    address: web3.contractAddress, head: 10,
    logs: [placed(0, me, 1, 1, 1000, 30), placed(1, other, 2, 2, 1000, 30), settled(0, me, 2, 1.9, 100n, 101n, 1), settled(1, other, 3, 0, 100n, 101n, 0)]
  });
  check(results.length === 0, 'Results already on-chain when the page opens are not announced');
  const mine = history.betsList(me);
  check(mine.length === 1 && mine[0].status === 'Won' && mine[0].paid === 1.9 && mine[0].side === 'UP', 'A wallet sees only its own bets, with status and amount paid');
  check(history.records.some((r) => r.type === 'win' && r.amount === 1.9) && !history.records.some((r) => r.type === 'win' && r.user.toLowerCase() === other.toLowerCase()), 'A win is a money record; a loss is not');

  await history.apply({ address: web3.contractAddress, head: 20, logs: [placed(2, me, 2, 0.5, 2000, 10), log('PriceRecorded', [BTC_ID, 2000, 5000000000n, false])] });
  const live = house.liveBet(BTC_ID);
  check(live?.betId === 2 && house.strikeOf(live) === 50, 'Running bet on a market, with its recorded strike price');
  check(house.phaseOf(live, 1999_000) === 'closed' && house.phaseOf(live, 2005_000) === 'locked' && house.phaseOf(live, 2011_000) === 'settling', 'Bet phases from its own times: before strike, running, waiting for the result');
  await history.apply({ address: web3.contractAddress, head: 30, logs: [settled(2, me, 4, 0.5, 5000000000n, 5000000000n, 1)] });
  check(results.length === 1 && results[0].betId === 2 && results[0].status === 'Push', 'A new settlement of the wallet\'s bet is announced once');
  check(house.liveBet(BTC_ID) === null, 'No running bet once settled');

  house.rules = { minLead: 5, jackpot: 10, jackpotShare: 0.25, jackpotCapMultiple: 20 };
  check(house.nextStrikeAt(1790000001_000) === 1790000010_000 && house.nextStrikeAt(1790000006_000) === 1790000020_000, 'Next strike: the first 10 s mark at least 5 s ahead (as the contract computes it)');
  check(house.jackpotFor(0.1) === 2 && house.jackpotFor(1) === 2.5, 'Jackpot preview: 25% of the pot, capped at 20x the smallest streak stake');
}

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

console.log('\n--- Price sanity ---');
const cb = new CircuitBreaker();
check(cb.validateTick('BTC', 84000, null, Date.now(), true).valid, 'First price is accepted');
check(!cb.validateTick('BTC', 84000 * 1.3, 84000, Date.now(), false).valid, 'A 30% jump in one tick is rejected');
check(cb.validateTick('BTC', 84050, 84000, Date.now(), false).valid, 'A normal move is accepted');

console.log('\n--- RPC throttling ---');
check(isRateLimited({ info: { error: { code: -32011, message: 'requests limited to 15/sec' } } }), 'Recognises Monad\'s 15/sec limit response');
check(isRateLimited({ message: 'server response 429 Too Many Requests' }), 'Recognises HTTP 429');
check(!isRateLimited({ shortMessage: 'execution reverted: "Betting window closed"' }), 'A real revert is not treated as throttling');
check(isSpuriousInsufficientBalance({ message: 'RPC \'0x279f\' Custom eth_sendRawTransaction: Signer had insufficient balance' }), 'Recognises the spurious "Signer had insufficient balance" rejection, retried instead of shown as a real shortfall');
check(!isSpuriousInsufficientBalance({ shortMessage: 'execution reverted: "Betting window closed"' }), 'A real revert is not mistaken for the spurious balance error');

console.log(`\nAPP LOGIC VERDICT: ${passed}/${total} checks passed`);
