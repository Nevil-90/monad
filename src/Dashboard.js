/**
 * Dashboard.js
 * Transparency view: who put money in, who took money out, and where fees went.
 * Everything is derived from ChainHistory (contract events) and links to the explorer.
 */

const PAGE_SIZE = 25;

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtMon = (v) => Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtInt = (v) => Number(v).toLocaleString('en-US');
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const ACTIVITY = {
  bet: { in: true },
  win: { label: 'Won', cls: 'win' },
  refund: { label: 'Refund', cls: 'refund' },
  claim: { label: 'Payout', cls: 'refund' },
  creatorFee: { label: 'Creator fee', cls: 'fee' },
  treasury: { label: 'Treasury', cls: 'fee' },
  keeperReward: { label: 'Keeper reward', cls: 'fee' },
  market: { label: 'New market', cls: 'market' }
};
const FEE_TYPES = new Set(['creatorFee', 'treasury', 'keeperReward']);

export class Dashboard {
  constructor({ history, explorerUrl, getAccount }) {
    this.history = history;
    this.explorer = explorerUrl;
    this.getAccount = getAccount;
    this.tab = 'activity';
    this.page = 0;
    this.query = '';
    this.market = 'all';
    this.type = 'all';
    this.sort = { key: 'staked', dir: -1 };
    this.visible = false;
    this.renderQueued = false;

    this.el = (id) => document.getElementById(id);
    this.bind();
    history.onChange(() => this.queueRender());
  }

  bind() {
    document.querySelectorAll('.dash-tab').forEach((t) => t.addEventListener('click', () => {
      this.tab = t.dataset.dtab;
      this.page = 0;
      document.querySelectorAll('.dash-tab').forEach((x) => {
        x.classList.toggle('active', x === t);
        x.setAttribute('aria-selected', String(x === t));
      });
      this.render();
    }));
    this.el('dash-search').addEventListener('input', (e) => {
      this.query = e.target.value.trim().toLowerCase();
      this.page = 0;
      this.render();
    });
    // Shortcut: filter everything to the connected wallet (toggles off when pressed again)
    this.el('dash-mine').addEventListener('click', () => {
      const me = (this.getAccount() || '').toLowerCase();
      if (!me) return;
      this.query = this.query === me ? '' : me;
      this.el('dash-search').value = this.query;
      this.page = 0;
      this.render();
    });
    this.el('dash-market').addEventListener('change', (e) => { this.market = e.target.value; this.page = 0; this.render(); });
    this.el('dash-type').addEventListener('change', (e) => { this.type = e.target.value; this.page = 0; this.render(); });
    this.el('dash-prev').addEventListener('click', () => { this.page = Math.max(0, this.page - 1); this.render(); });
    this.el('dash-next').addEventListener('click', () => { this.page += 1; this.render(); });
    this.el('dash-older').addEventListener('click', () => this.history.loadOlder());

    this.el('dash-table').addEventListener('click', (e) => {
      const wallet = e.target.closest('[data-wallet]');
      if (wallet) {
        e.preventDefault();
        this.el('dash-search').value = wallet.dataset.wallet;
        this.query = wallet.dataset.wallet.toLowerCase();
        this.page = 0;
        this.tab = 'activity';
        document.querySelectorAll('.dash-tab').forEach((x) => {
          x.classList.toggle('active', x.dataset.dtab === 'activity');
          x.setAttribute('aria-selected', String(x.dataset.dtab === 'activity'));
        });
        this.render();
        return;
      }
      const sort = e.target.closest('[data-sort]');
      if (sort) {
        const key = sort.dataset.sort;
        this.sort = { key, dir: this.sort.key === key ? -this.sort.dir : -1 };
        this.render();
      }
    });
  }

  show(visible) {
    this.visible = visible;
    if (visible) {
      this.history.start();
      this.render();
    }
  }

  queueRender() {
    if (!this.visible || this.renderQueued) return;
    this.renderQueued = true;
    setTimeout(() => {
      this.renderQueued = false;
      this.render();
    }, 300);
  }

  // ---------------------------------------------------------------------------

  render() {
    const me = (this.getAccount() || '').toLowerCase();
    const mine = this.el('dash-mine');
    mine.disabled = !me;
    mine.title = me ? 'Show only your wallet' : 'Connect a wallet to see your activity';
    mine.classList.toggle('active', Boolean(me) && this.query === me);
    mine.setAttribute('aria-pressed', String(Boolean(me) && this.query === me));
    if (!this.visible) return;
    this.renderHeader();
    this.renderStats();
    this.renderMarketOptions();
    this.el('dash-type').classList.toggle('hidden', this.tab !== 'activity');

    const rows = this.tab === 'activity' ? this.activityRows()
      : this.tab === 'wallets' ? this.walletRows()
        : this.roundRows();
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    this.page = Math.min(this.page, pages - 1);
    const slice = rows.slice(this.page * PAGE_SIZE, (this.page + 1) * PAGE_SIZE);

    const table = this.el('dash-table');
    if (!rows.length) {
      table.innerHTML = `<div class="empty">${this.emptyText()}</div>`;
    } else if (this.tab === 'activity') {
      table.innerHTML = this.activityTable(slice);
    } else if (this.tab === 'wallets') {
      table.innerHTML = this.walletTable(slice);
    } else {
      table.innerHTML = this.roundTable(slice);
    }

    const from = rows.length ? this.page * PAGE_SIZE + 1 : 0;
    const to = Math.min(rows.length, (this.page + 1) * PAGE_SIZE);
    const noun = this.tab === 'activity' ? 'events' : this.tab === 'wallets' ? 'wallets' : 'rounds';
    this.el('dash-count').textContent = rows.length ? `${fmtInt(from)}–${fmtInt(to)} of ${fmtInt(rows.length)} ${noun}` : `0 ${noun}`;
    this.el('dash-page').textContent = `${this.page + 1} / ${pages}`;
    this.el('dash-prev').disabled = this.page === 0;
    this.el('dash-next').disabled = this.page >= pages - 1;

    const h = this.history;
    const olderBtn = this.el('dash-older');
    olderBtn.classList.toggle('hidden', !h.hasOlder());
    olderBtn.disabled = Boolean(h.loadingOlder);
    olderBtn.textContent = h.loadingOlder ? 'Loading…' : 'Load older history';
    this.el('dash-range').textContent = h.oldest !== null
      ? `Loaded blocks ${fmtInt(h.oldest)} – ${fmtInt(h.newest)}${h.hasOlder() ? '' : ' · complete history since deployment'}`
      : '';

    this.fillBlockTimes();
    if (this.tab === 'rounds') this.fillRoundDetails(slice);
  }

  renderHeader() {
    const h = this.history;
    const sync = this.el('dash-sync');
    const dot = this.el('dash-sync-dot');
    dot.className = `sync-dot ${h.status}`;
    if (h.status === 'live') sync.textContent = `Live · block ${fmtInt(h.newest)}`;
    else if (h.status === 'syncing') {
      const pr = h.progress;
      sync.textContent = pr && pr.total ? `Reading Monad blocks… ${Math.round((pr.done / pr.total) * 100)}%` : 'Reading contract events…';
    }
    else if (h.status === 'error') sync.textContent = h.error || 'Connection problem';
    else sync.textContent = 'Connecting…';
    const link = this.el('dash-contract');
    link.textContent = h.address ? `Contract ${short(h.address)} ↗` : 'No contract configured';
    if (h.address) link.href = `${this.explorer}/address/${h.address}`;
  }

  renderStats() {
    const h = this.history;
    const s = h.summary();
    this.el('ds-paid').textContent = h.totals.paidToWinners === null ? '—' : `${fmtMon(h.totals.paidToWinners)} MON`;
    this.el('ds-volume').textContent = h.totals.settledVolume === null ? '—' : `${fmtMon(h.totals.settledVolume)} MON`;
    this.el('ds-wallets').textContent = fmtInt(s.walletCount);
    this.el('ds-bets').textContent = fmtInt(s.betsCount);

    // Money flow: what came in, what left, and what is still in the contract
    const inTotal = s.riseIn + s.fallIn;
    const outTotal = s.wins + s.refunds + s.fees;
    const scale = Math.max(inTotal, outTotal, 1e-9);
    const seg = (v, cls, title) => (v > 0 ? `<span class="flow-seg ${cls}" style="width:${(v / scale) * 100}%" title="${escapeHtml(title)}"></span>` : '');
    this.el('flow-in').innerHTML = seg(s.riseIn, 'rise', `Rise bets ${fmtMon(s.riseIn)} MON`) + seg(s.fallIn, 'fall', `Fall bets ${fmtMon(s.fallIn)} MON`);
    this.el('flow-out').innerHTML = seg(s.wins, 'win', `To winners ${fmtMon(s.wins)} MON`) + seg(s.refunds, 'refund', `Refunds ${fmtMon(s.refunds)} MON`) + seg(s.fees, 'fee', `Fees paid out ${fmtMon(s.fees)} MON`);
    this.el('flow-in-total').textContent = `${fmtMon(inTotal)} MON`;
    this.el('flow-out-total').textContent = `${fmtMon(outTotal)} MON`;
    const held = Math.max(0, inTotal - outTotal);
    this.el('flow-legend').innerHTML = [
      ['rise', 'Rise bets', s.riseIn], ['fall', 'Fall bets', s.fallIn],
      ['win', 'Paid to winners', s.wins], ['refund', 'Refunds', s.refunds], ['fee', 'Fees paid out', s.fees]
    ].map(([cls, label, v]) => `<span class="legend-item"><span class="legend-dot ${cls}"></span>${label} <b class="num">${fmtMon(v)}</b></span>`).join('')
      + `<span class="legend-item legend-held">Still in contract (unclaimed or open rounds) <b class="num">${fmtMon(held)}</b></span>`;
  }

  renderMarketOptions() {
    const select = this.el('dash-market');
    const opts = [['all', 'All markets']];
    for (const [id, m] of this.history.markets) opts.push([id, m.listed ? m.symbol : `${m.symbol} (unverified)`]);
    const sig = opts.map((o) => o.join('=')).join('|');
    if (select.dataset.sig === sig) return;
    select.dataset.sig = sig;
    select.innerHTML = opts.map(([v, l]) => `<option value="${escapeHtml(v)}">${escapeHtml(l)}</option>`).join('');
    select.value = this.market;
  }

  emptyText() {
    const h = this.history;
    if (h.status === 'syncing' || h.status === 'idle') return 'Reading contract events…';
    if (h.status === 'error') return escapeHtml(h.error || 'Could not reach the network.');
    if (this.query) return 'Nothing matches that search in the loaded history.';
    return h.hasOlder() ? 'No activity in these blocks yet. Load older history to look further back.' : 'No activity on this contract yet.';
  }

  // ---------------------------------------------------------------------------
  // Rows
  // ---------------------------------------------------------------------------

  matchesQuery(rec) {
    const q = this.query;
    if (!q) return true;
    if (/^0x[0-9a-f]{64}$/.test(q)) return rec.tx.toLowerCase() === q;
    return (rec.user || '').toLowerCase().includes(q) || rec.tx.toLowerCase().startsWith(q);
  }

  activityRows() {
    return this.history.records.filter((r) => {
      if (this.market !== 'all' && r.marketId !== this.market) return false;
      if (this.type !== 'all') {
        if (this.type === 'fee' ? !FEE_TYPES.has(r.type) : r.type !== this.type) return false;
      }
      return this.matchesQuery(r);
    });
  }

  walletRows() {
    let rows = this.history.wallets();
    if (this.market !== 'all') {
      // Recompute for one market from its records
      const ids = new Set(this.history.records.filter((r) => r.marketId === this.market && r.user).map((r) => r.user.toLowerCase()));
      rows = rows.filter((w) => ids.has(w.address.toLowerCase()));
    }
    if (this.query) rows = rows.filter((w) => w.address.toLowerCase().includes(this.query));
    const { key, dir } = this.sort;
    const val = (w) => (key === 'winrate' ? (w.wins + w.losses ? w.wins / (w.wins + w.losses) : -1) : key === 'out' ? w.won + w.refunded : w[key]);
    return rows.sort((a, b) => (val(a) - val(b)) * dir);
  }

  roundRows() {
    // Rounds nobody bet on are rolled forward by keepers; they move no money, so they are hidden
    let rows = this.history.roundsList().filter((r) => !(r.status === 'cancelled' && r.bettors.size === 0 && (!r.exact || r.exact.pool === 0)));
    if (this.market !== 'all') rows = rows.filter((r) => r.marketId === this.market);
    if (this.query) rows = rows.filter((r) => (r.settleTx || '').toLowerCase().startsWith(this.query) || [...r.bettors].some((b) => b.includes(this.query)));
    return rows;
  }

  // ---------------------------------------------------------------------------
  // Tables
  // ---------------------------------------------------------------------------

  walletCell(addr) {
    const you = this.getAccount() && addr.toLowerCase() === this.getAccount().toLowerCase();
    return `<span class="wallet-cell">
      <a href="#" class="wallet-link num" data-wallet="${escapeHtml(addr)}" title="Show all activity for ${escapeHtml(addr)}">${short(addr)}</a>${you ? '<span class="you-tag">You</span>' : ''}
      <a class="ext" href="${this.explorer}/address/${escapeHtml(addr)}" target="_blank" rel="noopener" aria-label="View wallet on explorer">↗</a>
    </span>`;
  }

  txCell(tx) {
    return `<a class="tx-link num" href="${this.explorer}/tx/${escapeHtml(tx)}" target="_blank" rel="noopener" title="${escapeHtml(tx)}">${tx.slice(0, 8)}… ↗</a>`;
  }

  timeCell(block) {
    return `<span class="blk num" data-block="${block}">#${fmtInt(block)}</span>`;
  }

  activityTable(rows) {
    const body = rows.map((r) => {
      let what;
      if (r.type === 'bet') {
        what = `<span class="act ${r.side === 'UP' ? 'rise' : 'fall'}">${r.side === 'UP' ? '▲ Bet Rise' : '▼ Bet Fall'}</span>`;
      } else {
        const a = ACTIVITY[r.type] || { label: r.type, cls: '' };
        what = `<span class="act ${a.cls}">${a.label}</span>`;
      }
      const isIn = r.type === 'bet';
      const amount = r.type === 'market'
        ? `<span class="muted">${escapeHtml(r.symbol || '')}</span>`
        : `<span class="amt-val"><span class="dir ${isIn ? 'in' : 'out'}">${isIn ? 'Put in' : 'Took out'}</span> <b class="num">${fmtMon(r.amount)}</b></span>`;
      return `<tr>
        <td data-label="Time">${this.timeCell(r.block)}</td>
        <td data-label="Activity">${what}</td>
        <td data-label="Wallet">${r.user ? this.walletCell(r.user) : '—'}</td>
        <td data-label="Market">${r.marketId ? escapeHtml(this.history.marketLabel(r.marketId)) : '—'}</td>
        <td data-label="Round" class="num">${r.roundId !== undefined ? fmtInt(r.roundId) : '—'}</td>
        <td data-label="Amount (MON)" class="amt">${amount}</td>
        <td data-label="Transaction">${this.txCell(r.tx)}</td>
      </tr>`;
    }).join('');
    return `<table class="dtable"><thead><tr>
      <th>Time</th><th>Activity</th><th>Wallet</th><th>Market</th><th>Round</th><th class="amt">Amount (MON)</th><th>Transaction</th>
    </tr></thead><tbody>${body}</tbody></table>`;
  }

  walletTable(rows) {
    const th = (key, label, cls = '') => {
      const on = this.sort.key === key;
      return `<th class="${cls}"><button class="sort-btn${on ? ' on' : ''}" data-sort="${key}">${label}${on ? (this.sort.dir < 0 ? ' ↓' : ' ↑') : ''}</button></th>`;
    };
    const body = rows.map((w) => {
      const decided = w.wins + w.losses;
      const net = w.net;
      return `<tr>
        <td data-label="Wallet">${this.walletCell(w.address)}</td>
        <td data-label="Bets" class="num">${fmtInt(w.bets)}</td>
        <td data-label="Put in" class="amt num">${fmtMon(w.staked)}</td>
        <td data-label="Took out" class="amt num">${fmtMon(w.won + w.refunded)}</td>
        <td data-label="Net" class="amt num ${net > 0 ? 'pos' : net < 0 ? 'neg' : ''}">${net > 0 ? '+' : net < 0 ? '−' : ''}${fmtMon(Math.abs(net))}</td>
        <td data-label="Win rate" class="num">${decided ? `${Math.round((w.wins / decided) * 100)}% <span class="muted">(${w.wins}/${decided})</span>` : '—'}</td>
        <td data-label="Last active">${this.timeCell(w.lastBlock)}</td>
      </tr>`;
    }).join('');
    return `<table class="dtable"><thead><tr>
      <th>Wallet</th>${th('bets', 'Bets')}${th('staked', 'Put in', 'amt')}${th('out', 'Took out', 'amt')}${th('net', 'Net', 'amt')}${th('winrate', 'Win rate')}${th('lastBlock', 'Last active')}
    </tr></thead><tbody>${body}</tbody></table>
    <p class="table-note">Took out = claimed wins + refunds. Unclaimed winnings are not counted until the wallet claims them.</p>`;
  }

  roundTable(rows) {
    const body = rows.map((r) => {
      const result = r.status === 'settled'
        ? `<span class="act ${r.winningSide === 'UP' ? 'rise' : 'fall'}">${r.winningSide === 'UP' ? '▲ Rise won' : '▼ Fall won'}</span>`
        : `<span class="act refund" title="${escapeHtml(r.reason || '')}">Refunded</span>`;
      const fmtP = (p) => (p === undefined ? '—' : p.toLocaleString('en-US', { maximumFractionDigits: 6 }));
      return `<tr>
        <td data-label="Round" class="num">${fmtInt(r.roundId)}</td>
        <td data-label="Market">${escapeHtml(this.history.marketLabel(r.marketId))}</td>
        <td data-label="Strike → Close" class="num">${fmtP(r.lockPrice)} → ${fmtP(r.closePrice)}</td>
        <td data-label="Result">${result}</td>
        <td data-label="Pool (MON)" class="amt num" data-round-pool="${escapeHtml(r.key)}">${fmtMon(r.up + r.down)}</td>
        <td data-label="Players" class="num" data-round-players="${escapeHtml(r.key)}">${fmtInt(r.bettors.size)}</td>
        <td data-label="Time">${this.timeCell(r.settleBlock)}</td>
        <td data-label="Settlement">${r.settleTx ? this.txCell(r.settleTx) : '—'}</td>
      </tr>`;
    }).join('');
    return `<table class="dtable"><thead><tr>
      <th>Round</th><th>Market</th><th>Strike → Close</th><th>Result</th><th class="amt">Pool (MON)</th><th>Players</th><th>Time</th><th>Settlement</th>
    </tr></thead><tbody>${body}</tbody></table>`;
  }

  // ---------------------------------------------------------------------------
  // Lazy details for visible rows only
  // ---------------------------------------------------------------------------

  async fillBlockTimes() {
    const cells = [...document.querySelectorAll('#dash-table [data-block]')];
    const blocks = [...new Set(cells.map((c) => Number(c.dataset.block)))];
    const today = new Date().toDateString();
    await Promise.all(blocks.map(async (b) => {
      const t = await this.history.blockTime(b);
      if (!t) return;
      const d = new Date(t);
      const text = d.toDateString() === today
        ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      document.querySelectorAll(`#dash-table [data-block="${b}"]`).forEach((c) => {
        c.textContent = text;
        c.title = `Block ${b.toLocaleString('en-US')}`;
      });
    }));
  }

  /** Bets may predate the loaded history, so read exact pool and player totals from the contract */
  async fillRoundDetails(rounds) {
    await Promise.all(rounds.map(async (r) => {
      if (!r.exact) {
        const onChain = await this.history.web3.fetchOnChainRound(r.marketId, r.roundId);
        if (!onChain) return;
        r.exact = {
          pool: Number(onChain.totalPool) / 1e18,
          players: onChain.upBettors !== null ? onChain.upBettors + onChain.downBettors : null
        };
      }
      const pool = document.querySelector(`[data-round-pool="${CSS.escape(r.key)}"]`);
      const players = document.querySelector(`[data-round-players="${CSS.escape(r.key)}"]`);
      if (pool) pool.textContent = fmtMon(r.exact.pool);
      if (players && r.exact.players !== null) players.textContent = fmtInt(r.exact.players);
    }));
  }
}
