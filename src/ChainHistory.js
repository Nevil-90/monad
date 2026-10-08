/**
 * ChainHistory.js
 * Reads the house contract's events so every number the UI shows can be traced to a transaction.
 * Nothing is stored server-side.
 *
 * - Loads the contract's complete event history in one request from the relay's index
 *   (scripts/lib/event_index.js), then follows new blocks pushed over Server-Sent Events. Monad's
 *   public RPCs serve at most 100 blocks per log request, too slow to scan from the browser. Every
 *   record keeps its transaction hash, so each row links to the explorer.
 * - Bets are tracked from BetPlaced to BetSettled; strike and result prices from PriceRecorded.
 * - House totals (vault, jackpot, all-time wagered and paid) are read from the contract itself when
 *   bets settle.
 */

import { ethers } from 'ethers';
import { API_CONFIG, SUPPORTED_MARKETS, getConfig } from './config.js';

const toMon = (v) => Number(ethers.formatEther(v));
const PRICE_DECIMALS = 8;
const STATUS = ['None', 'Pending', 'Won', 'Lost', 'Push', 'Void'];

export class ChainHistory {
  constructor(web3) {
    this.web3 = web3;
    const cfg = getConfig();
    this.deployBlock = cfg.deployBlock;
    this.relayUrl = API_CONFIG.priceRelayUrl;

    this.records = [];              // money movements, newest first
    this.seen = new Set();          // `${tx}:${logIndex}`
    this.bets = new Map();          // betId -> bet
    this.prices = new Map();        // `${marketId}:${ts}` -> price (number)
    this.markets = new Map();       // marketId -> { symbol, name, listed }
    this.blockTimes = new Map();
    this.oldest = null;
    this.newest = null;
    this.status = 'idle';           // idle | syncing | live | error
    this.error = null;
    this.listeners = new Set();
    this.betListeners = new Set();  // ({ placed: bet[], settled: bet[], prices: key[] }) => void
    this.gasListeners = new Set();
    this.houseListeners = new Set();
    this.gasPrice = null;
    this.started = false;
    this.house = null;              // contract views (fetchHouse), refreshed when bets settle

    for (const m of Object.values(SUPPORTED_MARKETS)) {
      this.markets.set(m.marketId.toLowerCase(), { symbol: m.symbol, name: m.name, listed: true });
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

  /** Called with the bets placed/settled and prices recorded by each batch of new events */
  onBets(fn) {
    this.betListeners.add(fn);
    return () => this.betListeners.delete(fn);
  }

  onGas(fn) {
    this.gasListeners.add(fn);
    if (this.gasPrice !== null) fn(this.gasPrice);
    return () => this.gasListeners.delete(fn);
  }

  marketLabel(marketId) {
    const m = this.markets.get(String(marketId).toLowerCase());
    return m ? m.symbol : `${String(marketId).slice(0, 10)}…`;
  }

  isListed(marketId) {
    return Boolean(this.markets.get(String(marketId).toLowerCase())?.listed);
  }

  price(marketId, ts) {
    return this.prices.get(`${String(marketId).toLowerCase()}:${ts}`) ?? null;
  }

  // ---------------------------------------------------------------------------
  // Sync
  // ---------------------------------------------------------------------------

  async start() {
    if (this.started) return;
    this.started = true;
    if (!this.address) return this.fail('No contract address configured (NEXT_PUBLIC_CONTRACT_ADDRESS).');
    if (this.deployBlock === null || !Number.isFinite(this.deployBlock)) return this.fail('Contract deploy block not configured (NEXT_PUBLIC_CONTRACT_DEPLOY_BLOCK).');
    if (!this.relayUrl) return this.fail('Bets and results are read from the relay: set NEXT_PUBLIC_PRICE_RELAY_URL.');
    this.status = 'syncing';
    this.notify();
    this.connect();
  }

  fail(message) {
    this.status = 'error';
    this.error = message;
    this.notify();
  }

  /** The relay's event stream: the whole history first, then new events as blocks are indexed */
  connect() {
    const after = this.newest === null ? this.deployBlock - 1 : this.newest;
    this.es = new EventSource(`${this.relayUrl}/events/stream?after=${after}`);
    this.es.onmessage = (e) => this.apply(JSON.parse(e.data));
    this.es.onerror = () => {
      this.status = 'error';
      this.error = 'Connection to the relay dropped. Reconnecting…';
      this.notify();
      this.es.close();
      clearTimeout(this.retry);
      this.retry = setTimeout(() => this.connect(), 3000);
    };
  }

  async apply(body) {
    const batch = { placed: [], settled: [], prices: [], initial: this.newest === null };
    try {
      if (body.address.toLowerCase() !== this.address.toLowerCase()) {
        throw new Error(`The relay indexes ${body.address}, not this app's contract ${this.address}.`);
      }
      if (body.gasPrice !== undefined && body.gasPrice !== null) {
        const gas = BigInt(body.gasPrice);
        if (gas !== this.gasPrice) {
          this.gasPrice = gas;
          for (const fn of this.gasListeners) fn(gas);
        }
      }
      for (const log of body.logs) {
        this.blockTimes.set(log.blockNumber, log.timestamp * 1000); // relay sends seconds
        this.ingest(log, batch);
      }
      this.records.sort((x, y) => (y.block - x.block) || (y.logIndex - x.logIndex));
      this.oldest = this.deployBlock;
      this.newest = Math.max(this.newest ?? body.head, body.head);
      // House totals are re-read in the background: views update from the events at once, never
      // waiting behind contract reads (the RPC client is rate-paced)
      if (batch.initial || batch.settled.length || batch.placed.length || batch.money) this.refreshHouse();
      this.status = 'live';
      this.error = null;
    } catch (err) {
      this.status = 'error';
      this.error = err.message;
      this.es?.close();
    }
    if (batch.placed.length || batch.settled.length || batch.prices.length || batch.money || batch.initial) {
      for (const fn of this.betListeners) {
        // One failing view must not stop the others (or the history) from updating
        try { fn(batch); } catch (err) { /* one bad listener must not stop the others */ }
      }
    }
    this.notify();
  }

  /** One read at a time; requests made meanwhile collapse into one more read after it */
  async refreshHouse() {
    if (this.houseReading) {
      this.houseStale = true;
      return;
    }
    this.houseReading = true;
    try {
      do {
        this.houseStale = false;
        try {
          this.house = await this.web3.fetchHouse();
        } catch (err) {
        }
      } while (this.houseStale);
    } finally {
      this.houseReading = false;
    }
    for (const fn of this.houseListeners) fn(this.house);
    this.notify();
  }

  /** Called with the contract's house state each time it has been re-read */
  onHouse(fn) {
    this.houseListeners.add(fn);
    return () => this.houseListeners.delete(fn);
  }

  ingest(log, batch) {
    const key = `${log.transactionHash}:${log.index ?? log.logIndex}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);

    let ev;
    try { ev = this.web3.iface.parseLog(log); } catch (_) { return; }
    if (!ev) return;

    const base = { id: key, block: log.blockNumber, logIndex: log.index ?? log.logIndex, tx: log.transactionHash, time: log.timestamp * 1000 };
    const a = ev.args;
    const marketId = a.marketId ? String(a.marketId).toLowerCase() : undefined;
    let rec = null;
    switch (ev.name) {
      case 'BetPlaced': {
        const bet = {
          betId: Number(a.betId),
          user: a.player,
          marketId,
          side: Number(a.side) === 1 ? 'UP' : 'DOWN',
          stake: toMon(a.stake),
          payout: toMon(a.payout),
          startTs: Number(a.startTs),
          endTs: Number(a.startTs) + Number(a.duration),
          duration: Number(a.duration),
          streakBet: a.streakBet,
          status: 'Pending',
          paid: 0,
          placedAt: base.time,
          tx: base.tx,
          block: base.block
        };
        this.bets.set(bet.betId, { ...this.bets.get(bet.betId), ...bet });
        batch.placed.push(bet);
        rec = { ...base, type: 'bet', user: a.player, side: bet.side, amount: bet.stake, marketId, betId: bet.betId };
        break;
      }
      case 'BetSettled': {
        const bet = this.bets.get(Number(a.betId)) || { betId: Number(a.betId), user: a.player, marketId };
        bet.status = STATUS[Number(a.status)] || 'None';
        bet.paid = toMon(a.paid);
        bet.startPrice = a.startPrice > 0n ? Number(ethers.formatUnits(a.startPrice, PRICE_DECIMALS)) : null;
        bet.endPrice = a.endPrice > 0n ? Number(ethers.formatUnits(a.endPrice, PRICE_DECIMALS)) : null;
        bet.streakAfter = Number(a.streak);
        bet.settleTx = base.tx;
        bet.settleBlock = base.block;
        bet.settledAt = base.time;
        this.bets.set(bet.betId, bet);
        batch.settled.push(bet);
        if (bet.status === 'Won') rec = { ...base, type: 'win', user: a.player, amount: bet.paid, marketId, betId: bet.betId, side: bet.side };
        else if (bet.status === 'Push' || bet.status === 'Void') rec = { ...base, type: 'refund', user: a.player, amount: bet.paid, marketId, betId: bet.betId };
        break;
      }
      case 'JackpotWon':
        rec = { ...base, type: 'jackpot', user: a.player, amount: toMon(a.amount), betId: Number(a.betId), streak: Number(a.streak) };
        batch.money = true;
        break;
      case 'PriceRecorded': {
        const k = `${marketId}:${Number(a.ts)}`;
        this.prices.set(k, Number(ethers.formatUnits(a.price, PRICE_DECIMALS)));
        batch.prices.push(k);
        break;
      }
      case 'BalanceWithdrawn':
        rec = { ...base, type: 'cashout', user: a.player, amount: toMon(a.amount) };
        batch.money = true;
        break;
      case 'LiquidityAdded':
        rec = { ...base, type: 'lpIn', user: a.provider, amount: toMon(a.amount) };
        batch.money = true;
        break;
      case 'LiquidityRemoved':
        rec = { ...base, type: 'lpOut', user: a.provider, amount: toMon(a.amount) };
        batch.money = true;
        break;
      default:
        break;
    }
    if (rec) this.records.push(rec);
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
  // Views
  // ---------------------------------------------------------------------------

  /** Bets, newest first; optionally one wallet's */
  betsList(account = null) {
    const me = account ? account.toLowerCase() : null;
    return [...this.bets.values()]
      .filter((b) => b.user && (!me || b.user.toLowerCase() === me))
      .sort((x, y) => y.betId - x.betId);
  }

  summary() {
    const s = { betsCount: 0, riseIn: 0, fallIn: 0, wins: 0, refunds: 0, jackpots: 0, lpIn: 0, lpOut: 0, wallets: new Set() };
    for (const r of this.records) {
      if (r.type === 'bet') {
        s.wallets.add(r.user.toLowerCase());
        s.betsCount++;
        if (r.side === 'UP') s.riseIn += r.amount; else s.fallIn += r.amount;
      } else if (r.type === 'win') s.wins += r.amount;
      else if (r.type === 'refund') s.refunds += r.amount;
      else if (r.type === 'jackpot') s.jackpots += r.amount;
      else if (r.type === 'lpIn') s.lpIn += r.amount;
      else if (r.type === 'lpOut') s.lpOut += r.amount;
    }
    return { ...s, walletCount: s.wallets.size };
  }

  wallets() {
    const map = new Map();
    const get = (addr) => {
      const k = addr.toLowerCase();
      if (!map.has(k)) map.set(k, { address: addr, bets: 0, staked: 0, won: 0, refunded: 0, jackpots: 0, wins: 0, losses: 0, lastBlock: 0 });
      return map.get(k);
    };
    for (const r of this.records) {
      if (!r.user || r.type === 'lpIn' || r.type === 'lpOut' || r.type === 'cashout') continue;
      const w = get(r.user);
      w.lastBlock = Math.max(w.lastBlock, r.block);
      if (r.type === 'bet') {
        w.bets++;
        w.staked += r.amount;
      } else if (r.type === 'win') w.won += r.amount;
      else if (r.type === 'refund') w.refunded += r.amount;
      else if (r.type === 'jackpot') w.jackpots += r.amount;
    }
    for (const b of this.bets.values()) {
      if (!b.user) continue;
      const w = get(b.user);
      if (b.status === 'Won') w.wins++;
      else if (b.status === 'Lost') w.losses++;
    }
    return [...map.values()].map((w) => ({ ...w, net: w.won + w.refunded + w.jackpots - w.staked }));
  }
}
