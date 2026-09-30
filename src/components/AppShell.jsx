/**
 * AppShell.jsx
 * The page markup, rendered on the server so the first paint needs no JavaScript. It never re-renders:
 * src/main.js drives it directly after hydration (canvas engine, live prices, wallet, dashboard).
 */

export default function AppShell() {
  return (
    <>
        <canvas id="horizon" aria-hidden="true"></canvas>

        {/* Boot screen: the logo (a sun over a horizon) comes alive until the network, live prices
            and the current round are ready. Pure CSS, so it shows before any JavaScript runs. */}
        <div className="boot" id="boot" role="status" aria-live="polite">
          <div className="boot-sky" aria-hidden="true"></div>
          <div className="boot-sea" aria-hidden="true"></div>
          <div className="boot-line" aria-hidden="true"><span className="boot-sweep"></span></div>
          <div className="boot-sparks" aria-hidden="true">
            {Array.from({ length: 14 }, (_, i) => <i key={i} className={i % 2 ? 'down' : 'up'} style={{ '--i': i }} />)}
          </div>
          <div className="boot-orb-wrap" aria-hidden="true">
            <span className="boot-ring"></span>
            <span className="boot-ring r2"></span>
            <span className="boot-orb"></span>
            <span className="boot-reflect"></span>
          </div>
          <div className="boot-stage">
            <div className="boot-brand">MonadPulse</div>
            <div className="boot-tag">Rise or fall · 30 seconds · on Monad</div>
            <ul className="boot-steps">
              <li data-boot="network"><span className="boot-check" aria-hidden="true"></span>Connecting to Monad</li>
              <li data-boot="prices"><span className="boot-check" aria-hidden="true"></span>Streaming live prices</li>
              <li data-boot="round"><span className="boot-check" aria-hidden="true"></span>Opening the house</li>
            </ul>
          </div>
        </div>

        <div className="ui">
          {/* Top bar */}
          <header className="topbar">
            <div className="brand-group">
            <a className="brand" href="/" aria-label="MonadPulse home">
              <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
                <circle cx="16" cy="12" r="4.5" />
                <rect x="5" y="19" width="22" height="2" rx="1" />
              </svg>
              <span className="brand-word">MonadPulse</span>
            </a>
            <nav className="views" aria-label="Views">
              <button className="view-btn active" data-view="trade" aria-pressed="true">Trade</button>
              <button className="view-btn" data-view="dashboard" aria-pressed="false">Dashboard</button>
            </nav>
            </div>

            <nav className="markets" id="market-switch" aria-label="Markets">
              <button className="market active" data-market="BTC" aria-pressed="true">
                <span className="market-sym">BTC</span><span className="market-delta" id="delta-BTC">—</span>
              </button>
              <button className="market" data-market="ETH" aria-pressed="false">
                <span className="market-sym">ETH</span><span className="market-delta" id="delta-ETH">—</span>
              </button>
              <button className="market" data-market="SOL" aria-pressed="false">
                <span className="market-sym">SOL</span><span className="market-delta" id="delta-SOL">—</span>
              </button>
              <button className="market" data-market="MON" aria-pressed="false">
                <span className="market-sym">MON</span><span className="market-delta" id="delta-MON">—</span>
              </button>
            </nav>

            <div className="account">
              <div className="balance" title="Available balance">
                <span className="balance-val num" id="balance-val">—</span>
                <span className="balance-unit">MON</span>
              </div>
              <span className="network-badge" id="network-badge" title="Bets are real transactions on this network">—</span>
              <button className="wallet-btn" id="wallet-btn">
                <span className="wallet-dot" id="wallet-dot"></span>
                <span id="wallet-label">Connect</span>
              </button>
              <button className="ledger-btn help-btn" id="help-btn" aria-controls="guide-modal" title="How it works (?)">
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 7.5a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.1.9-1.1 1.7v.3" /><path d="M10 14.6v.1" /></svg>
              </button>
              <button className="ledger-btn" id="ledger-btn" aria-controls="ledger" aria-expanded="false" title="Ledger (L)">
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5h12M4 10h12M4 15h8" /></svg>
                <span className="ledger-count hidden" id="ledger-count">0</span>
              </button>
            </div>
          </header>

          {/* Price readout */}
          <section className="readout" id="readout" aria-live="off">
            <div className="asset">
              <span className="asset-name" id="asset-name">Bitcoin</span>
              <span className="asset-pair" id="asset-pair">BTC / USD</span>
              <span className="asset-change num" id="asset-change">—</span>
            </div>
            <div className="price num" id="hero-price">—</div>
            <div className="strike-row">
              <div className="strike-cell">
                <span className="cell-label">Strike</span>
                <span className="cell-val num" id="strike-val" title="RedStone's signed price at your bet's strike time, verified by the contract">—</span>
              </div>
              <div className="strike-cell">
                <span className="cell-label">Distance</span>
                <span className="cell-val num" id="gap-val">—</span>
              </div>
              <div className="strike-cell">
                <span className="cell-label">Streak</span>
                <span className="cell-val streak num" id="streak-val" title="Wins in a row on one-at-a-time bets. Reach the jackpot streak to win the jackpot.">—</span>
              </div>
            </div>
          </section>

          {/* Pulse board: what winners have been paid */}
          <section className="pulse" id="pulse" aria-label="Streak jackpot and recent wins">
            <header className="pulse-head">
              <span className="pulse-title"><span className="pulse-beat" aria-hidden="true"></span>Jackpot</span>
              <span className="pulse-badge live" id="pulse-badge">On-chain</span>
            </header>
            <div className="pulse-big num" id="pulse-paid">—</div>
            <div className="pulse-big-label" id="pulse-big-label">MON in the streak jackpot</div>
            <div className="pulse-stats">
              <div><span className="pulse-stat num" id="pulse-now">—</span><span className="pulse-stat-label">your streak</span></div>
              <div><span className="pulse-stat num" id="pulse-rounds">—</span><span className="pulse-stat-label">bets settled</span></div>
              <div><span className="pulse-stat num" id="pulse-top">—</span><span className="pulse-stat-label">paid to players</span></div>
            </div>
            <ul className="pulse-feed" id="pulse-feed"></ul>
            <p className="pulse-note" id="pulse-note">Win bets in a row, one at a time, to take a share of the jackpot. 1% of every stake feeds it.</p>
          </section>

          {/* Mobile: rotating latest win */}
          <div className="pulse-ticker hidden" id="pulse-ticker" aria-live="off"></div>

          {/* Live position status */}
          {/* Your bets on this market: one row each, live status, then the result for a few seconds */}
          <div className="position-chip hidden" id="position-chip" role="status" aria-live="polite"></div>

          {/* Settlement result */}
          <div className="result hidden" id="result" role="status" aria-live="polite">
            <div className="result-title" id="result-title">—</div>
            <div className="result-sub" id="result-sub">—</div>
            <div className="result-state" id="result-state" />
          </div>

          {/* Console */}
          <section className="console" id="console" aria-label="Place a prediction">
            <div className="console-main">
              <button className="side-btn rise" id="bet-up" aria-label="Predict rise">
                <span className="side-head"><span className="side-glyph">▲</span><span className="side-name">Rise</span></span>
                <span className="side-mult num" id="up-mult">—</span>
                <span className="side-win num" id="up-win">—</span>
              </button>

              <div className="stake">
                <label className="stake-label" htmlFor="stake-input">Stake</label>
                <div className="stake-field">
                  <input type="number" id="stake-input" className="num" defaultValue="25" min="0" step="1" inputMode="decimal" />
                  <span className="stake-unit">MON</span>
                </div>
                <div className="stake-chips">
                  <button className="chip" data-add="0.5">+0.5</button>
                  <button className="chip" data-add="1">+1</button>
                  <button className="chip" data-add="5">+5</button>
                  <button className="chip" id="stake-max">Max</button>
                  <button className="chip" id="stake-clear" aria-label="Clear stake">×</button>
                </div>
                <p className="stake-fee num hidden" id="stake-fee"></p>
                {/* Who is backing what in the upcoming window: the odds move toward the quieter side */}
                <div className="lean hidden" id="lean" title="Rise and Fall bets in the window a bet placed now joins. The side more people back pays less; the other side pays more.">
                  <div className="lean-bar"><span className="lean-up" id="lean-up"></span><span className="lean-down" id="lean-down"></span></div>
                  <span className="lean-label num" id="lean-label">—</span>
                </div>
                <div className="bet-opts">
                  <div className="dur" id="dur-toggle" role="group" aria-label="Bet length">
                    <button className="dur-btn" data-dur="10" aria-pressed="false">10s</button>
                    <button className="dur-btn active" data-dur="30" aria-pressed="true">30s</button>
                    <button className="dur-btn" data-dur="60" aria-pressed="false">60s</button>
                  </div>
                  <div className="bank" id="bank">
                    <span className="bank-label">In play</span>
                    <span className="bank-val num" id="bank-val">—</span>
                    <button className="chip bank-btn" id="ride-btn" title="Put your whole in-game balance in the stake, then pick Rise or Fall">Use all</button>
                    <button className="chip bank-btn" id="cashout-btn" title="Send your in-game balance to your wallet">Cash out</button>
                  </div>
                </div>
              </div>

              <button className="side-btn fall" id="bet-down" aria-label="Predict fall">
                <span className="side-head"><span className="side-glyph">▼</span><span className="side-name">Fall</span></span>
                <span className="side-mult num" id="down-mult">—</span>
                <span className="side-win num" id="down-win">—</span>
              </button>
            </div>

            <div className="console-status">
              <svg className="phase-ring" viewBox="0 0 24 24" aria-hidden="true">
                <circle className="ring-track" cx="12" cy="12" r="10" />
                <circle className="ring-fill" id="phase-ring-fill" cx="12" cy="12" r="10" />
              </svg>
              <span className="phase-label" id="phase-label">Betting open</span>
              <span className="phase-time num" id="phase-time">—</span>
              <span className="status-sep"></span>
              <span className="round-id num">Max bet <span id="round-id">—</span></span>
              <span className="status-sep"></span>
              <div className="chart-toggle" role="group" aria-label="Chart style">
                <button className="chart-btn active" data-chart="line" aria-pressed="true" title="Line">
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 11 L5 7 L8 9 L15 3" /></svg><span>Line</span>
                </button>
                <button className="chart-btn" data-chart="candles" aria-pressed="false" title="Candles">
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2v12M11 4v10" /><rect x="2.5" y="5" width="3" height="5" /><rect x="9.5" y="6" width="3" height="4" /></svg><span>Candles</span>
                </button>
              </div>
              <div className="chart-toggle" id="tf-toggle" role="group" aria-label="Zoom">
                <button className="chart-btn tf-btn active" data-tf="5" aria-pressed="true">5s</button>
                <button className="chart-btn tf-btn" data-tf="15" aria-pressed="false">15s</button>
                <button className="chart-btn tf-btn" data-tf="60" aria-pressed="false">1m</button>
              </div>
              <span className="status-sep"></span>
              <span className="feed" title="Price feed">
                <span className="feed-dot" id="feed-dot"></span>
                <span className="num" id="feed-latency">—</span>
              </span>
            </div>
          </section>
        </div>

        {/* Transparency dashboard: every money movement, straight from contract events */}
        <main className="dashboard hidden" id="dashboard" aria-label="Transparency dashboard">
          <div className="dash-inner">
            <header className="dash-head">
              <div>
                <h1 className="dash-title">Every MON, on the record</h1>
                <p className="dash-sub">Every row is an event emitted by the house contract on Monad, indexed by the MonadPulse relay. Each one links to its transaction on the Monad explorer, so anyone can check it, and the totals are read from the contract itself.</p>
              </div>
              <div className="dash-source">
                <div className="dash-sync"><span className="sync-dot" id="dash-sync-dot"></span><span id="dash-sync">Connecting…</span></div>
                <a className="dash-contract num" id="dash-contract" target="_blank" rel="noopener">—</a>
              </div>
            </header>

            <section className="dash-stats">
              <div className="dash-stat"><span className="dash-stat-label">Paid to players</span><span className="dash-stat-val num" id="ds-paid">—</span><span className="dash-stat-note">Wins, jackpots, pushes · contract counter</span></div>
              <div className="dash-stat"><span className="dash-stat-label">Wagered</span><span className="dash-stat-val num" id="ds-volume">—</span><span className="dash-stat-note">All time · contract counter</span></div>
              <div className="dash-stat"><span className="dash-stat-label">Players</span><span className="dash-stat-val num" id="ds-wallets">—</span><span className="dash-stat-note">All time · wallets that placed a bet</span></div>
              <div className="dash-stat"><span className="dash-stat-label">Bets placed</span><span className="dash-stat-val num" id="ds-bets">—</span><span className="dash-stat-note">All time · since deployment</span></div>
            </section>

            <section className="dash-flow" aria-label="Money flow since deployment">
              <div className="flow-row">
                <span className="flow-label">Put in</span>
                <div className="flow-bar" id="flow-in"></div>
                <span className="flow-total num" id="flow-in-total">—</span>
              </div>
              <div className="flow-row">
                <span className="flow-label">Paid out</span>
                <div className="flow-bar" id="flow-out"></div>
                <span className="flow-total num" id="flow-out-total">—</span>
              </div>
              <div className="flow-legend" id="flow-legend"></div>
            </section>

            <section className="dash-card">
              <div className="dash-toolbar">
                <div className="tabs" role="tablist">
                  <button className="tab dash-tab active" role="tab" data-dtab="activity" aria-selected="true">Activity</button>
                  <button className="tab dash-tab" role="tab" data-dtab="wallets" aria-selected="false">Wallets</button>
                  <button className="tab dash-tab" role="tab" data-dtab="rounds" aria-selected="false">Bets</button>
                </div>
                <div className="dash-filters">
                  <button className="dash-input dash-mine" id="dash-mine" aria-pressed="false" disabled title="Connect a wallet to see your activity">My activity</button>
                  <input type="search" id="dash-search" className="dash-input num" placeholder="Search wallet or tx (0x…)" autoComplete="off" spellCheck="false" aria-label="Search wallet or transaction" />
                  <select id="dash-market" className="dash-input" aria-label="Market"></select>
                  <select id="dash-type" className="dash-input" aria-label="Activity type">
                    <option value="all">All activity</option>
                    <option value="bet">Bets</option>
                    <option value="win">Wins</option>
                    <option value="jackpot">Jackpots</option>
                    <option value="refund">Pushes and voids</option>
                    <option value="cashout">Cash-outs</option>
                    <option value="lp">Vault deposits and withdrawals</option>
                  </select>
                </div>
              </div>
              <div className="dash-table-wrap" id="dash-table"></div>
              <footer className="dash-pager">
                <span className="dash-count" id="dash-count">—</span>
                <div className="pager-btns">
                  <button className="icon-btn" id="dash-prev" aria-label="Previous page">←</button>
                  <span className="num" id="dash-page">1 / 1</span>
                  <button className="icon-btn" id="dash-next" aria-label="Next page">→</button>
                </div>
              </footer>
              <div className="dash-older">
                <span className="dash-range num" id="dash-range">—</span>
                <button className="ghost-btn" id="dash-older">Load older history</button>
              </div>
            </section>
          </div>
        </main>

        {/* Ledger drawer */}
        <div className="scrim hidden" id="scrim"></div>
        <aside className="ledger" id="ledger" aria-label="Ledger" aria-hidden="true">
          <header className="ledger-head">
            <div className="tabs" role="tablist">
              <button className="tab active" role="tab" data-pane="positions" aria-selected="true">My bets</button>
              <button className="tab" role="tab" data-pane="history" aria-selected="false">Live feed</button>
              <button className="tab" role="tab" data-pane="stats" aria-selected="false">House</button>
            </div>
            <button className="icon-btn" id="ledger-close" aria-label="Close ledger">✕</button>
          </header>

          <div className="pane active" id="pane-positions" role="tabpanel">
            <div className="list" id="positions-list"></div>
          </div>

          <div className="pane" id="pane-history" role="tabpanel">
            <div className="list" id="history-list"></div>
          </div>

          <div className="pane" id="pane-stats" role="tabpanel">
            <div className="stat-group">
              <h3 className="stat-title">The house</h3>
              <p className="stat-note" id="house-note">Every bet is against this vault.</p>
              <dl className="stat-grid">
                <div><dt>Payout</dt><dd className="num" id="stat-pool">—</dd></div>
                <div><dt>Vault</dt><dd className="num" id="stat-split">—</dd></div>
                <div><dt>Reserved for bets</dt><dd className="num" id="stat-impact">—</dd></div>
                <div><dt>Bet range</dt><dd className="num" id="stat-fee">—</dd></div>
              </dl>
            </div>
            <div className="stat-group">
              <h3 className="stat-title">Your record</h3>
              <dl className="stat-grid">
                <div><dt>Settled bets</dt><dd className="num" id="stat-settled">0</dd></div>
                <div><dt>Win rate</dt><dd className="num" id="stat-winrate">—</dd></div>
                <div><dt>Net result</dt><dd className="num" id="stat-net">—</dd></div>
                <div><dt>Current streak</dt><dd className="num" id="stat-streak">—</dd></div>
              </dl>
            </div>
            <div className="stat-group">
              <h3 className="stat-title">Be the house</h3>
              <p className="stat-note" id="lp-note">Anyone can own part of the vault. Add MON and you get a share of it: when players lose, the vault grows and your share is worth more; when they win, it shrinks. Over many bets the 1.90× payout leaves the house about 4% of what is wagered, so the vault tends to grow, but a lucky run can take from it. A deposit stays locked for an hour, so nobody can jump in only around results they can already see.</p>
              <dl className="stat-grid">
                <div><dt>Your share</dt><dd className="num" id="lp-share">—</dd></div>
                <div><dt>Worth</dt><dd className="num" id="lp-value">—</dd></div>
              </dl>
              <div className="lp-form">
                <input type="number" id="lp-amount" className="dash-input num" min="0" step="1" placeholder="MON" inputMode="decimal" aria-label="Amount in MON" />
                <button className="solid-btn" id="lp-add">Add</button>
                <button className="ghost-btn" id="lp-remove">Withdraw all</button>
              </div>
            </div>
          </div>
        </aside>

        {/* How it works */}
        <div className="modal hidden" id="guide-modal" role="dialog" aria-modal="true" aria-labelledby="guide-modal-title">
          <div className="modal-card guide-card">
            <header className="modal-head">
              <h2 className="modal-title" id="guide-modal-title">How it works</h2>
              <button className="icon-btn" data-close="guide-modal" aria-label="Close">✕</button>
            </header>
            <ol className="guide">
              <li>
                <span className="guide-n num">1</span>
                <div><h3>Call it</h3><p>Pick <b className="rise">Rise</b> or <b className="fall">Fall</b> and a length: 10, 30 or 60 seconds. Bet any time. There is no round to wait for and nobody else needs to join: the house takes the other side of every bet.</p></div>
              </li>
              <li>
                <span className="guide-n num">2</span>
                <div><h3>The strike is set</h3><p>Your strike is the official price at the next 10-second mark, a few seconds after your bet lands, so nobody bets on a price they have already seen. The result is the price your chosen length later.</p></div>
              </li>
              <li>
                <span className="guide-n num">3</span>
                <div><h3>Win up to <span className="num" id="guide-fee">2.38×</span></h3><p>The odds move with the betting: the side more players back pays less, the other side more (about 1.9× when even). Your payout is fixed when your bet lands. Right call: it is credited to your in-game balance seconds after the result, less a small fee on the profit. Bet it again (<b>Use all</b> puts it in the stake, then you pick Rise or Fall), or cash out to your wallet any time. An exact tie gives your stake back.</p></div>
              </li>
              <li>
                <span className="guide-n num">4</span>
                <div><h3>Chase the jackpot</h3><p>Win bets in a row, one at a time, and your streak grows. Hit the jackpot streak and you take a share of the jackpot, which 1% of every stake feeds. A loss resets the streak.</p></div>
              </li>
            </ol>
            <p className="guide-note">The multiplier is below 2× on a coin-flip, so over time the house keeps a small edge; that is what pays for the jackpot and the vault. The chart streams live Coinbase trades; bets are decided by RedStone's signed prices, verified by the contract. Every bet, win and cash-out is a transaction on Monad, public in the Dashboard. Network fees go to Monad.</p>
            <div className="modal-actions"><button className="solid-btn" data-close="guide-modal">Start playing</button></div>
          </div>
        </div>

        {/* Wallet dialog */}
        <div className="modal hidden" id="wallet-modal" role="dialog" aria-modal="true" aria-labelledby="wallet-modal-title">
          <div className="modal-card">
            <header className="modal-head">
              <h2 className="modal-title" id="wallet-modal-title">Wallet</h2>
              <button className="icon-btn" data-close="wallet-modal" aria-label="Close">✕</button>
            </header>
            <div id="wallet-modal-body"></div>
          </div>
        </div>

        
        {/* Toast */}
        <div className="toast hidden" id="toast" role="status" aria-live="polite">
          <div className="toast-body">
            <div className="toast-title" id="toast-title">—</div>
            <div className="toast-msg" id="toast-msg">—</div>
          </div>
          <a className="toast-link hidden" id="toast-link" href="#" target="_blank" rel="noopener">View ↗</a>
        </div>


    </>
  );
}
