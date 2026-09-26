/**
 * ChainHistory.js
 * Reads the AMM contract's events straight from the chain so every number the UI shows can be
 * traced to a transaction. Nothing is stored server-side.
 *
 * - Starts with the most recent `historyWindowBlocks`, follows new blocks, and loads older
 *   history on demand back to `deployBlock`.
 * - Requests logs in `logChunkBlocks` ranges to respect public RPC limits.
 * - Classifies each PayoutClaimed as a win or a refund from how its round ended.
 *
 * For very long histories, point the dashboard at an indexer that serves the same records.
 */

import { ethers } from 'ethers';
import { SUPPORTED_MARKETS, getConfig } from './config.js';

const POLL_MS = 4000;
const CONCURRENCY = 4;
const toMon = (v) => Number(ethers.formatEther(v));
const toPrice = (v) => Number(ethers.formatUnits(v, 36));

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

export class ChainHistory {
  constructor(web3) {
    this.web3 = web3;
    const cfg = getConfig();
    this.deployBlock = cfg.deployBlock;
    this.chunk = Math.max(1, cfg.logChunkBlocks || 100);
    this.window = Math.max(this.chunk, cfg.historyWindowBlocks || 5000);

    this.records = [];              // money movements and market creations, newest first
    this.seen = new Set();          // `${tx}:${logIndex}`
    this.rounds = new Map();        // `${marketId}:${roundId}` -> round summary
    this.markets = new Map();       // marketId -> { symbol, name, creator, listed }
    this.blockTimes = new Map();
    this.oldest = null;
    this.newest = null;
    this.status = 'idle';           // idle | syncing | live | error
    this.error = null;
    this.listeners = new Set();
    this.started = false;
    this.totals = { paidToWinners: null, settledVolume: null };

    for (const m of Object.values(SUPPORTED_MARKETS)) {
      this.markets.set(m.marketId.toLowerCase(), { symbol: m.symbol, name: m.name, creator: null, listed: true });
    }
  }

  get provider() { return this.web3.readOnlyProvider; }
  get address() { return this.web3.contractAddress; }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify() {
    for (const fn of this.listeners) fn(this);
  }

  hasOlder() {
    return this.oldest !== null && this.oldest > this.deployBlock;
  }

  marketLabel(marketId) {
    const m = this.markets.get(String(marketId).toLowerCase());
    return m ? m.symbol : `${String(marketId).slice(0, 10)}…`;
  }

  isListed(marketId) {
    return Boolean(this.markets.get(String(marketId).toLowerCase())?.listed);
  }

  // ---------------------------------------------------------------------------
  // Sync
  // ---------------------------------------------------------------------------

  async start() {
    if (this.started) return;
    this.started = true;
    if (!this.provider || !this.address) {
      this.status = 'error';
      this.error = 'No contract address configured (NEXT_PUBLIC_CONTRACT_ADDRESS).';
      this.notify();
      return;
    }
    if (this.deployBlock === null || !Number.isFinite(this.deployBlock)) {
      this.status = 'error';
      this.error = 'Contract deploy block not configured (NEXT_PUBLIC_CONTRACT_DEPLOY_BLOCK).';
      this.notify();
      return;
    }
    this.status = 'syncing';
    this.notify();
    try {
      const latest = await this.provider.getBlockNumber();
      const from = Math.max(this.deployBlock, latest - this.window + 1);
      await this.scan(from, latest);
      this.oldest = from;
      this.newest = latest;
      this.status = 'live';
      this.error = null;
      await this.refreshTotals();
    } catch (err) {
      this.status = 'error';
      this.error = `Could not read contract events (${err.shortMessage || err.message}). Retrying…`;
      this.started = false;
      setTimeout(() => this.start(), 8000);
    }
    this.notify();
    if (this.status === 'live' && !this.pollTimer) {
      this.pollTimer = setInterval(() => this.poll(), POLL_MS);
    }
  }

  async poll() {
    if (this.polling || this.newest === null) return;
    this.polling = true;
    try {
      const latest = await this.provider.getBlockNumber();
      if (latest > this.newest) {
        await this.scan(this.newest + 1, latest);
        this.newest = latest;
        await this.refreshTotals();
      }
      if (this.status !== 'live') {
        this.status = 'live';
        this.error = null;
      }
    } catch (_) {
      this.status = 'error';
      this.error = 'Connection to the Monad RPC dropped. Retrying…';
    }
    this.polling = false;
    this.notify();
  }

  async loadOlder() {
    if (!this.hasOlder() || this.loadingOlder) return;
    this.loadingOlder = true;
    this.notify();
    try {
      const to = this.oldest - 1;
      const from = Math.max(this.deployBlock, to - this.window + 1);
      await this.scan(from, to);
      this.oldest = from;
    } catch (_) {
      this.error = 'Could not load older history. Try again.';
    }
    this.loadingOlder = false;
    this.notify();
  }

  async scan(from, to) {
    const ranges = [];
    for (let a = from; a <= to; a += this.chunk) ranges.push([a, Math.min(to, a + this.chunk - 1)]);
    const batches = await mapLimit(ranges, CONCURRENCY, ([a, b]) =>
      this.provider.getLogs({ address: this.address, fromBlock: a, toBlock: b }));
    const pendingClaims = [];
    for (const logs of batches) {
      for (const log of logs) {
        const rec = this.ingest(log);
        if (rec && rec.type === 'claim') pendingClaims.push(rec);
      }
    }
    this.records.sort((x, y) => (y.block - x.block) || (y.logIndex - x.logIndex));
    await this.classifyClaims(pendingClaims);
  }

  ingest(log) {
    const key = `${log.transactionHash}:${log.index ?? log.logIndex}`;
    if (this.seen.has(key)) return null;
    this.seen.add(key);

    let ev;
    try {
      ev = this.web3.iface.parseLog(log);
    } catch (_) {
      return null;
    }
    if (!ev) return null;

    const base = { id: key, block: log.blockNumber, logIndex: log.index ?? log.logIndex, tx: log.transactionHash };
    const a = ev.args;
    const round = (marketId, roundId) => {
      const k = `${String(marketId).toLowerCase()}:${roundId}`;
      if (!this.rounds.has(k)) {
        this.rounds.set(k, { key: k, marketId: String(marketId).toLowerCase(), roundId: Number(roundId), status: null, bettors: new Set(), up: 0, down: 0 });
      }
      return this.rounds.get(k);
    };

    let rec = null;
    switch (ev.name) {
      case 'BetPlaced': {
        const side = Number(a.side) === 1 ? 'UP' : 'DOWN';
        const amount = toMon(a.amount);
        const r = round(a.marketId, a.roundId);
        r.bettors.add(a.user.toLowerCase());
        if (side === 'UP') r.up += amount; else r.down += amount;
        rec = { ...base, type: 'bet', user: a.user, side, amount, marketId: String(a.marketId).toLowerCase(), roundId: Number(a.roundId) };
        break;
      }
      case 'PayoutClaimed':
        rec = { ...base, type: 'claim', user: a.user, amount: toMon(a.amount), marketId: String(a.marketId).toLowerCase(), roundId: Number(a.roundId) };
        break;
      case 'CreatorFeesClaimed':
        rec = { ...base, type: 'creatorFee', user: a.creator, amount: toMon(a.amount), marketId: String(a.marketId).toLowerCase() };
        break;
      case 'TreasuryWithdrawn':
        rec = { ...base, type: 'treasury', user: a.recipient, amount: toMon(a.amount), marketId: String(a.marketId).toLowerCase() };
        break;
      case 'KeeperRewardClaimed':
        rec = { ...base, type: 'keeperReward', user: a.keeper, amount: toMon(a.amount) };
        break;
      case 'MarketCreated': {
        const id = String(a.marketId).toLowerCase();
        const known = this.markets.get(id);
        this.markets.set(id, { symbol: a.symbol, name: a.name, creator: a.creator, listed: Boolean(known?.listed) });
        rec = { ...base, type: 'market', user: a.creator, amount: 0, marketId: id, symbol: a.symbol };
        break;
      }
      case 'RoundLocked': {
        const r = round(a.marketId, a.roundId);
        r.lockPrice = toPrice(a.lockPrice);
        r.lockBlock = base.block;
        break;
      }
      case 'RoundSettled': {
        const r = round(a.marketId, a.roundId);
        r.status = 'settled';
        r.closePrice = toPrice(a.closePrice);
        r.winningSide = Number(a.winningSide) === 1 ? 'UP' : 'DOWN';
        r.settleTx = base.tx;
        r.settleBlock = base.block;
        r.keeper = a.keeper;
        break;
      }
      case 'RoundCancelled': {
        const r = round(a.marketId, a.roundId);
        r.status = 'cancelled';
        r.reason = a.reason;
        r.settleTx = base.tx;
        r.settleBlock = base.block;
        break;
      }
      default:
        break;
    }
    if (rec) this.records.push(rec);
    return rec;
  }

  /** Claims pay either winnings (settled round) or refunds (cancelled round) */
  async classifyClaims(claims) {
    const unknown = [];
    for (const c of claims) {
      const r = this.rounds.get(`${c.marketId}:${c.roundId}`);
      if (r && r.status) c.type = r.status === 'settled' ? 'win' : 'refund';
      else unknown.push(c);
    }
    await mapLimit(unknown, CONCURRENCY, async (c) => {
      const onChain = await this.web3.fetchOnChainRound(c.marketId, c.roundId);
      if (!onChain) return;
      const r = this.rounds.get(`${c.marketId}:${c.roundId}`);
      if (r && !r.status) {
        r.status = onChain.status === 3 ? 'settled' : onChain.status === 4 ? 'cancelled' : null;
        if (onChain.winningSide) r.winningSide = onChain.winningSide === 1 ? 'UP' : 'DOWN';
      }
      c.type = onChain.status === 3 ? 'win' : 'refund';
    });
  }

  async refreshTotals() {
    const iface = this.web3.iface;
    let paid = 0;
    let volume = 0;
    let ok = false;
    for (const marketId of this.markets.keys()) {
      try {
        const hex = await this.web3.ethCall(iface.encodeFunctionData('totalWinnings', [marketId]));
        if (hex && hex !== '0x') {
          paid += toMon(iface.decodeFunctionResult('totalWinnings', hex)[0]);
          ok = true;
        }
        const m = await this.web3.fetchOnChainMarket(marketId);
        if (m && m.totalVolume !== undefined) volume += toMon(m.totalVolume);
      } catch (_) {
        // Market not on this contract
      }
    }
    this.totals = ok ? { paidToWinners: paid, settledVolume: volume } : { paidToWinners: null, settledVolume: null };
  }

  async blockTime(n) {
    if (this.blockTimes.has(n)) return this.blockTimes.get(n);
    const p = this.provider.getBlock(n).then((b) => (b ? Number(b.timestamp) * 1000 : null)).catch(() => null);
    this.blockTimes.set(n, p);
    const t = await p;
    this.blockTimes.set(n, t);
    return t;
  }

  // ---------------------------------------------------------------------------
  // Views over the loaded history
  // ---------------------------------------------------------------------------

  summary() {
    const s = { betsCount: 0, riseIn: 0, fallIn: 0, wins: 0, refunds: 0, fees: 0, wallets: new Set() };
    for (const r of this.records) {
      if (r.user) s.wallets.add(r.user.toLowerCase());
      if (r.type === 'bet') {
        s.betsCount++;
        if (r.side === 'UP') s.riseIn += r.amount; else s.fallIn += r.amount;
      } else if (r.type === 'win') s.wins += r.amount;
      else if (r.type === 'refund') s.refunds += r.amount;
      else if (r.type === 'creatorFee' || r.type === 'treasury' || r.type === 'keeperReward') s.fees += r.amount;
    }
    return { ...s, walletCount: s.wallets.size };
  }

  wallets() {
    const map = new Map();
    const get = (addr) => {
      const k = addr.toLowerCase();
      if (!map.has(k)) map.set(k, { address: addr, bets: 0, staked: 0, won: 0, refunded: 0, fees: 0, wins: 0, losses: 0, lastBlock: 0, rounds: new Set() });
      return map.get(k);
    };
    for (const r of this.records) {
      if (!r.user) continue;
      const w = get(r.user);
      w.lastBlock = Math.max(w.lastBlock, r.block);
      if (r.type === 'bet') {
        w.bets++;
        w.staked += r.amount;
        // Win rate counts each round once, however many bets the wallet placed in it
        const roundKey = `${r.marketId}:${r.roundId}`;
        const round = this.rounds.get(roundKey);
        if (round?.status === 'settled' && !w.rounds.has(roundKey)) {
          w.rounds.add(roundKey);
          if (round.winningSide === r.side) w.wins++; else w.losses++;
        }
      } else if (r.type === 'win') w.won += r.amount;
      else if (r.type === 'refund') w.refunded += r.amount;
      else if (r.type === 'creatorFee' || r.type === 'treasury' || r.type === 'keeperReward') w.fees += r.amount;
    }
    return [...map.values()].map(({ rounds, ...w }) => ({ ...w, net: w.won + w.refunded - w.staked }));
  }

  roundsList() {
    return [...this.rounds.values()]
      .filter((r) => r.status)
      .sort((a, b) => (b.settleBlock || 0) - (a.settleBlock || 0));
  }
}
