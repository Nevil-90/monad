/**
 * Dashboard.js
 * Transparency view: every bet, win, jackpot, cash-out and vault deposit on the house contract.
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
  jackpot: { label: 'Jackpot', cls: 'win' },
  refund: { label: 'Stake back', cls: 'refund' },
  cashout: { label: 'Cash out', cls: 'fee' },
  lpIn: { label: 'Vault deposit', cls: 'market', in: true },
  lpOut: { label: 'Vault withdrawal', cls: 'market' }
};
const LP_TYPES = new Set(['lpIn', 'lpOut']);
const STATUS_LABEL = { Pending: 'Running', Won: 'Won', Lost: 'Lost', Push: 'Tie · stake back', Void: 'No price · stake back' };

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
        : this.betRows();
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
      table.innerHTML = this.betTable(slice);
    }

    const from = rows.length ? this.page * PAGE_SIZE + 1 : 0;
    const to = Math.min(rows.length, (this.page + 1) * PAGE_SIZE);
    const noun = this.tab === 'activity' ? 'events' : this.tab === 'wallets' ? 'wallets' : 'bets';
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
    const house = h.house;
    const mon = (v) => Number(v) / 1e18;
    this.el('ds-paid').textContent = house ? `${fmtMon(mon(house.totalPaidOut))} MON` : '—';
    this.el('ds-volume').textContent = house ? `${fmtMon(mon(house.totalWagered))} MON` : '—';
    // Counts are all-time once the full history is loaded; until then they would undercount
    const complete = h.status === 'live';
    this.el('ds-wallets').textContent = complete ? fmtInt(s.walletCount) : '—';
    this.el('ds-bets').textContent = complete ? fmtInt(s.betsCount) : '—';

    // Money flow: what players staked and what the house paid them (credited to their in-game balance)
    const inTotal = s.riseIn + s.fallIn;
    const outTotal = s.wins + s.refunds + s.jackpots;
    const scale = Math.max(inTotal, outTotal, 1e-9);
    const seg = (v, cls, title) => (v > 0 ? `<span class="flow-seg ${cls}" style="width:${(v / scale) * 100}%" title="${escapeHtml(title)}"></span>` : '');
    this.el('flow-in').innerHTML = seg(s.riseIn, 'rise', `Rise bets ${fmtMon(s.riseIn)} MON`) + seg(s.fallIn, 'fall', `Fall bets ${fmtMon(s.fallIn)} MON`);
    this.el('flow-out').innerHTML = seg(s.wins, 'win', `Wins ${fmtMon(s.wins)} MON`) + seg(s.jackpots, 'fee', `Jackpots ${fmtMon(s.jackpots)} MON`) + seg(s.refunds, 'refund', `Stakes back ${fmtMon(s.refunds)} MON`);
    this.el('flow-in-total').textContent = `${fmtMon(inTotal)} MON`;
    this.el('flow-out-total').textContent = `${fmtMon(outTotal)} MON`;
    const vault = house ? `${fmtMon(mon(house.vaultAssets))}` : '—';
    this.el('flow-legend').innerHTML = [
      ['rise', 'Rise bets', s.riseIn], ['fall', 'Fall bets', s.fallIn],
      ['win', 'Wins', s.wins], ['fee', 'Jackpots', s.jackpots], ['refund', 'Stakes back', s.refunds]
    ].map(([cls, label, v]) => `<span class="legend-item"><span class="legend-dot ${cls}"></span>${label} <b class="num">${fmtMon(v)}</b></span>`).join('')
      + `<span class="legend-item legend-held">House vault <b class="num">${vault}</b></span>`;
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
    if (this.query) return 'Nothing matches that search.';
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
        if (this.type === 'lp' ? !LP_TYPES.has(r.type) : r.type !== this.type) return false;
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
    const val = (w) => (key === 'winrate' ? (w.wins + w.losses ? w.wins / (w.wins + w.losses) : -1) : key === 'out' ? w.won + w.refunded + w.jackpots : w[key]);
    return rows.sort((a, b) => (val(a) - val(b)) * dir);
  }

  betRows() {
    let rows = this.history.betsList();
    if (this.market !== 'all') rows = rows.filter((b) => b.marketId === this.market);
    if (this.query) rows = rows.filter((b) => (b.tx || '').toLowerCase().startsWith(this.query) || (b.settleTx || '').toLowerCase().startsWith(this.query) || (b.user || '').toLowerCase().includes(this.query));
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
      const isIn = Boolean(ACTIVITY[r.type]?.in);
      const amount = `<span class="amt-val"><span class="dir ${isIn ? 'in' : 'out'}">${isIn ? 'Put in' : 'Paid'}</span> <b class="num">${fmtMon(r.amount)}</b></span>`;
      return `<tr>
        <td data-label="Time">${this.timeCell(r.block)}</td>
        <td data-label="Activity">${what}</td>
        <td data-label="Wallet">${r.user ? this.walletCell(r.user) : '—'}</td>
        <td data-label="Market">${r.marketId ? escapeHtml(this.history.marketLabel(r.marketId)) : '—'}</td>
        <td data-label="Bet" class="num">${r.betId !== undefined ? `#${fmtInt(r.betId)}` : '—'}</td>
        <td data-label="Amount (MON)" class="amt">${amount}</td>
        <td data-label="Transaction">${this.txCell(r.tx)}</td>
      </tr>`;
    }).join('');
    return `<table class="dtable"><thead><tr>
      <th>Time</th><th>Activity</th><th>Wallet</th><th>Market</th><th>Bet</th><th class="amt">Amount (MON)</th><th>Transaction</th>
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
        <td data-label="Paid" class="amt num">${fmtMon(w.won + w.refunded + w.jackpots)}</td>
        <td data-label="Net" class="amt num ${net > 0 ? 'pos' : net < 0 ? 'neg' : ''}">${net > 0 ? '+' : net < 0 ? '−' : ''}${fmtMon(Math.abs(net))}</td>
        <td data-label="Win rate" class="num">${decided ? `${Math.round((w.wins / decided) * 100)}% <span class="muted">(${w.wins}/${decided})</span>` : '—'}</td>
        <td data-label="Last active">${this.timeCell(w.lastBlock)}</td>
      </tr>`;
    }).join('');
    return `<table class="dtable"><thead><tr>
      <th>Wallet</th>${th('bets', 'Bets')}${th('staked', 'Put in', 'amt')}${th('out', 'Paid', 'amt')}${th('net', 'Net', 'amt')}${th('winrate', 'Win rate')}${th('lastBlock', 'Last active')}
    </tr></thead><tbody>${body}</tbody></table>
    <p class="table-note">Paid = wins, jackpots and stakes returned on ties, credited to the player's in-game balance at settlement.</p>`;
  }

  betTable(rows) {
    const fmtP = (p) => (p === null || p === undefined ? '—' : p.toLocaleString('en-US', { maximumFractionDigits: 6 }));
    const body = rows.map((b) => {
      const cls = b.status === 'Won' ? 'win' : b.status === 'Lost' ? 'fall' : b.status === 'Pending' ? '' : 'refund';
      return `<tr>
        <td data-label="Bet" class="num">#${fmtInt(b.betId)}</td>
        <td data-label="Wallet">${b.user ? this.walletCell(b.user) : '—'}</td>
        <td data-label="Call"><span class="act ${b.side === 'UP' ? 'rise' : 'fall'}">${b.side === 'UP' ? '▲ Rise' : '▼ Fall'}</span> <span class="muted">${escapeHtml(this.history.marketLabel(b.marketId))} · ${b.duration ?? '—'}s</span></td>
        <td data-label="Strike → Result" class="num">${fmtP(b.startPrice ?? this.history.price(b.marketId, b.startTs))} → ${fmtP(b.endPrice)}</td>
        <td data-label="Outcome"><span class="act ${cls}">${STATUS_LABEL[b.status] || b.status}</span></td>
        <td data-label="Stake → Paid (MON)" class="amt num">${fmtMon(b.stake ?? 0)} → ${b.status === 'Pending' ? '—' : fmtMon(b.paid)}</td>
        <td data-label="Time">${this.timeCell(b.settleBlock || b.block)}</td>
        <td data-label="Transaction">${this.txCell(b.settleTx || b.tx)}</td>
      </tr>`;
    }).join('');
    return `<table class="dtable"><thead><tr>
      <th>Bet</th><th>Wallet</th><th>Call</th><th>Strike → Result</th><th>Outcome</th><th class="amt">Stake → Paid (MON)</th><th>Time</th><th>Transaction</th>
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
}
