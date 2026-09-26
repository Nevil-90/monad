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
            <div className="boot-tag">Rise or fall · every minute · on Monad</div>
            <ul className="boot-steps">
              <li data-boot="network"><span className="boot-check" aria-hidden="true"></span>Connecting to Monad</li>
              <li data-boot="prices"><span className="boot-check" aria-hidden="true"></span>Streaming live prices</li>
              <li data-boot="round"><span className="boot-check" aria-hidden="true"></span>Reading the current round</li>
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
                <span className="cell-val num" id="strike-val" title="RedStone's signed price at the lock time, verified by the contract">Sets at lock</span>
              </div>
              <div className="strike-cell">
                <span className="cell-label">Distance</span>
                <span className="cell-val num" id="gap-val">—</span>
              </div>
              <div className="strike-cell">
                <span className="cell-label">Last rounds</span>
                <span className="cell-val recent num" id="recent-results" title="Winning side of recent rounds, newest on the right">—</span>
              </div>
            </div>
          </section>

          {/* Pulse board: what winners have been paid */}
          <section className="pulse" id="pulse" aria-label="Pulse: payouts to winners">
            <header className="pulse-head">
              <span className="pulse-title"><span className="pulse-beat" aria-hidden="true"></span>Pulse</span>
              <span className="pulse-badge live" id="pulse-badge">On-chain</span>
            </header>
            <div className="pulse-big num" id="pulse-paid">—</div>
            <div className="pulse-big-label">MON paid to winners</div>
            <div className="pulse-stats">
              <div><span className="pulse-stat num" id="pulse-now">—</span><span className="pulse-stat-label">playing now</span></div>
              <div><span className="pulse-stat num" id="pulse-rounds">—</span><span className="pulse-stat-label">rounds settled</span></div>
              <div><span className="pulse-stat num" id="pulse-top">—</span><span className="pulse-stat-label">top payout</span></div>
            </div>
            <ul className="pulse-feed" id="pulse-feed"></ul>
            <p className="pulse-note" id="pulse-note">All-time totals read from the contract. The feed shows wins claimed on-chain.</p>
          </section>

          {/* Mobile: rotating latest win */}
          <div className="pulse-ticker hidden" id="pulse-ticker" aria-live="off"></div>

          {/* Live position status */}
          <div className="position-chip hidden" id="position-chip" role="status">
            <span className="position-glyph" id="position-glyph">▲</span>
            <span id="position-text">—</span>
          </div>

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
                <span className="side-pool num"><span id="up-pool">—</span><span className="side-players" id="up-players">—</span></span>
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
                <div className="tug" aria-label="Pool split">
                  <div className="tug-bar"><span className="tug-up" id="tug-up"></span><span className="tug-down" id="tug-down"></span></div>
                  <div className="tug-labels num">
                    <span id="tug-up-label">—</span>
                    <span id="tug-total">—</span>
                    <span id="tug-down-label">—</span>
                  </div>
                </div>
              </div>

              <button className="side-btn fall" id="bet-down" aria-label="Predict fall">
                <span className="side-head"><span className="side-glyph">▼</span><span className="side-name">Fall</span></span>
                <span className="side-mult num" id="down-mult">—</span>
                <span className="side-win num" id="down-win">—</span>
                <span className="side-pool num"><span id="down-pool">—</span><span className="side-players" id="down-players">—</span></span>
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
              <span className="round-id num">Round <span id="round-id">—</span></span>
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
                <p className="dash-sub">Every row is an event emitted by the contract on Monad, indexed by the MonadPulse relay. Each one links to its transaction on the Monad explorer, so anyone can check it, and the totals are read from the contract itself.</p>
              </div>
              <div className="dash-source">
                <div className="dash-sync"><span className="sync-dot" id="dash-sync-dot"></span><span id="dash-sync">Connecting…</span></div>
                <a className="dash-contract num" id="dash-contract" target="_blank" rel="noopener">—</a>
              </div>
            </header>

            <section className="dash-stats">
              <div className="dash-stat"><span className="dash-stat-label">Paid to winners</span><span className="dash-stat-val num" id="ds-paid">—</span><span className="dash-stat-note">All time · contract counter</span></div>
              <div className="dash-stat"><span className="dash-stat-label">Settled volume</span><span className="dash-stat-val num" id="ds-volume">—</span><span className="dash-stat-note">All time · contract counter</span></div>
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
                <span className="flow-label">Taken out</span>
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
                  <button className="tab dash-tab" role="tab" data-dtab="rounds" aria-selected="false">Rounds</button>
                </div>
                <div className="dash-filters">
                  <button className="dash-input dash-mine" id="dash-mine" aria-pressed="false" disabled title="Connect a wallet to see your activity">My activity</button>
                  <input type="search" id="dash-search" className="dash-input num" placeholder="Search wallet or tx (0x…)" autoComplete="off" spellCheck="false" aria-label="Search wallet or transaction" />
                  <select id="dash-market" className="dash-input" aria-label="Market"></select>
                  <select id="dash-type" className="dash-input" aria-label="Activity type">
                    <option value="all">All activity</option>
                    <option value="bet">Bets</option>
                    <option value="win">Wins</option>
                    <option value="refund">Refunds</option>
                    <option value="fee">Fees paid out</option>
                    <option value="market">New markets</option>
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
              <button className="tab active" role="tab" data-pane="positions" aria-selected="true">Positions</button>
              <button className="tab" role="tab" data-pane="history" aria-selected="false">Rounds</button>
              <button className="tab" role="tab" data-pane="stats" aria-selected="false">Stats</button>
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
              <h3 className="stat-title">This round</h3>
              <dl className="stat-grid">
                <div><dt>Pool</dt><dd className="num" id="stat-pool">—</dd></div>
                <div><dt>Rise / Fall</dt><dd className="num" id="stat-split">—</dd></div>
                <div><dt>Your stake impact</dt><dd className="num" id="stat-impact">—</dd></div>
                <div><dt>Protocol fee</dt><dd className="num" id="stat-fee">—</dd></div>
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
              <h3 className="stat-title">Create a market</h3>
              <p className="stat-note">Anyone can open a market for a RedStone price feed and earns 0.1% of its settled volume. New markets start unverified.</p>
              <div className="stat-actions">
                <button className="solid-btn" id="open-create">New market</button>
                <button className="ghost-btn" id="claim-royalties">Claim creator fees</button>
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
                <div><h3>Pick a side</h3><p>Rounds are quick: the strike locks 10–20 s after the round's first bet and the result comes 20 s later. The next round opens as soon as betting closes, so there is always a round to play. Stake on <b className="rise">Rise</b> if you think the price ends above the strike, or <b className="fall">Fall</b> if below.</p></div>
              </li>
              <li>
                <span className="guide-n num">2</span>
                <div><h3>The strike locks</h3><p>Just after betting closes, the official price is locked as the strike: the bright line across the chart. From here, watch it move.</p></div>
              </li>
              <li>
                <span className="guide-n num">3</span>
                <div><h3>Winners split the pool</h3><p>Everyone on the winning side shares the whole pool, less a <span className="num" id="guide-fee">1.5%</span> fee, in proportion to their stake. The multiplier on each side is your payout per 1 MON right now, and it moves as others bet.</p></div>
              </li>
              <li>
                <span className="guide-n num">4</span>
                <div><h3>No contest, stake back</h3><p>If nobody took the other side, or the price closes exactly at the strike, your stake is refunded in full. Network fees for placing and claiming a bet are paid to Monad and are not refundable.</p></div>
              </li>
            </ol>
            <p className="guide-note">The chart streams live Coinbase trades. Rounds are decided by the official price: RedStone's signed report at the lock time (the strike) and at the close time, verified by the contract. The two sources agree to a few hundredths of a percent, so a round that close is shown as too close to call. Every bet and payout is a transaction on Monad, public in the Dashboard. Connect a wallet with MON to play.</p>
            <div className="modal-actions"><button className="solid-btn" data-close="guide-modal">Start trading</button></div>
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

        {/* Create market dialog */}
        <div className="modal hidden" id="create-modal" role="dialog" aria-modal="true" aria-labelledby="create-modal-title">
          <div className="modal-card">
            <header className="modal-head">
              <h2 className="modal-title" id="create-modal-title">New market</h2>
              <button className="icon-btn" data-close="create-modal" aria-label="Close">✕</button>
            </header>
            <form className="form" id="create-form" noValidate>
              <label className="field">
                <span className="field-label">Asset name</span>
                <input type="text" id="cm-name" placeholder="Sui" maxLength="32" autoComplete="off" />
              </label>
              <label className="field">
                <span className="field-label">Symbol</span>
                <input type="text" id="cm-symbol" placeholder="SUI/USD" maxLength="16" autoComplete="off" />
              </label>
              <label className="field">
                <span className="field-label">RedStone feed ID</span>
                <input type="text" id="cm-feed" className="num" placeholder="SUI" maxLength="31" autoComplete="off" spellCheck="false" />
              </label>
              <div className="field">
                <span className="field-label">Round length</span>
                <div className="segmented" id="cm-duration">
                  <button type="button" className="seg" data-sec="60">1 min</button>
                  <button type="button" className="seg active" data-sec="300">5 min</button>
                  <button type="button" className="seg" data-sec="900">15 min</button>
                </div>
              </div>
              <p className="form-note">Sent from your connected wallet in Live mode. Use a 24/7 feed; market-hours feeds pause outside trading hours.</p>
              <p className="form-error hidden" id="cm-error"></p>
              <button type="submit" className="solid-btn wide" id="cm-submit">Create market</button>
            </form>
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
