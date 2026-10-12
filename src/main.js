/**
 * main.js
 * Horizon UI controller: wires market data, the house contract, the wallet and the canvas together.
 * Everything shown comes from the contract (via HouseState / ChainHistory) or the price feeds.
 */

import { ethers } from 'ethers';
import { HorizonEngine } from './HorizonEngine.js';
import { MarketState } from './MarketState.js';
import { Web3Manager } from './Web3Manager.js';
import { PulseFeed } from './PulseFeed.js';
import { ChainHistory } from './ChainHistory.js';
import { Dashboard } from './Dashboard.js';
import { HouseState } from './HouseState.js';
import { getConfig, SUPPORTED_MARKETS, API_CONFIG } from './config.js';

const $ = (id) => document.getElementById(id);

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtPrice = (v, d) => `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const fmtMon = (v) => Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtClock = (sec) => {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const sideName = (side) => (side === 'UP' ? 'Rise' : 'Fall');
const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const RING_LENGTH = 2 * Math.PI * 10;
// A result normally settles ~2 s after it is signed. Past this, the player can settle it themselves, so a
// late or absent keeper (run by the house) can never hold a winning bet back.
const SELF_SETTLE_AFTER_S = 20;

/** Animate a number from its last shown value to `to` */
function countTo(node, to, decimals = 2, duration = 1200) {
  const from = parseFloat(node.dataset.value || '0');
  node.dataset.value = String(to);
  const start = performance.now();
  const fmt = (v) => v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const step = (now) => {
    const p = Math.min(1, (now - start) / duration);
    node.textContent = fmt(from + (to - from) * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

let started = false;

/** Called once by src/components/AppController.jsx after the server-rendered page hydrates */
export function startApp() {
  if (started) return;
  started = true;
  const el = {
    canvas: $('horizon'),
    readout: $('readout'),
    assetName: $('asset-name'),
    assetPair: $('asset-pair'),
    assetChange: $('asset-change'),
    heroPrice: $('hero-price'),
    strikeVal: $('strike-val'),
    gapVal: $('gap-val'),
    balance: $('balance-val'),
    networkBadge: $('network-badge'),
    walletBtn: $('wallet-btn'),
    walletLabel: $('wallet-label'),
    ledgerBtn: $('ledger-btn'),
    ledgerCount: $('ledger-count'),
    ledger: $('ledger'),
    scrim: $('scrim'),
    positionChip: $('position-chip'),
    result: $('result'),
    resultTitle: $('result-title'),
    resultSub: $('result-sub'),
    resultState: $('result-state'),
    console: $('console'),
    betUp: $('bet-up'),
    betDown: $('bet-down'),
    upMult: $('up-mult'),
    downMult: $('down-mult'),
    upWin: $('up-win'),
    downWin: $('down-win'),
    stake: $('stake-input'),
    bankVal: $('bank-val'),
    rideBtn: $('ride-btn'),
    cashoutBtn: $('cashout-btn'),
    ringFill: $('phase-ring-fill'),
    phaseLabel: $('phase-label'),
    phaseTime: $('phase-time'),
    maxBet: $('round-id'),
    feedDot: $('feed-dot'),
    feedLatency: $('feed-latency'),
    positionsList: $('positions-list'),
    historyList: $('history-list'),
    toast: $('toast'),
    toastTitle: $('toast-title'),
    toastMsg: $('toast-msg'),
    toastLink: $('toast-link')
  };

  let dashboard = null; // created after the wallet, which re-renders it on connect
  let chainHistory = null; // contract event reader, shared by the Dashboard, Pulse board and results strip
  let house = null;        // house rules, the wallet's balance, streak and bets
  let pulse = null;
  let marketButtons = [...document.querySelectorAll('#market-switch .market')];

  // ---------------------------------------------------------------------------
  // Boot screen: each step is ticked by the real event; the page shows once all three are done
  // (or after 9 s, with any step still loading marked, so nobody waits on a slow source)
  // ---------------------------------------------------------------------------
  const bootDone = new Set();
  let bootFinished = false;
  function finishBoot() {
    if (bootFinished) return;
    bootFinished = true;
    setTimeout(() => {
      $('boot').classList.add('done');
      requestAnimationFrame(updateSafeArea);
      // First visit: the guide opens once the page is ready, not over the loader
      let seenGuide = true;
      try { seenGuide = localStorage.getItem('mp.seenGuide') === '1'; } catch (_) { /* storage unavailable: don't nag */ }
      if (!seenGuide) openGuide();
    }, 380);
  }
  function bootStep(name) {
    if (bootDone.has(name)) return;
    bootDone.add(name);
    document.querySelector(`[data-boot="${name}"]`)?.classList.add('ok');
    if (['network', 'prices', 'round'].every((n) => bootDone.has(n))) finishBoot();
  }
  setTimeout(() => {
    document.querySelectorAll('[data-boot]:not(.ok)').forEach((li) => li.classList.add('slow'));
    finishBoot();
  }, 9000);

  // ---------------------------------------------------------------------------
  // Toast
  // ---------------------------------------------------------------------------
  let toastTimer = null;
  function toast(title, msg, { link = null, linkLabel = 'View ↗', error = false, sticky = false } = {}) {
    clearTimeout(toastTimer);
    el.toast.classList.remove('hidden');
    el.toast.classList.toggle('error', error);
    el.toastTitle.textContent = title;
    el.toastMsg.textContent = msg.length > 160 ? `${msg.slice(0, 157)}…` : msg;
    el.toastLink.classList.toggle('hidden', !link);
    if (link) { el.toastLink.href = link; el.toastLink.textContent = linkLabel; }
    if (!sticky) toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 5000);
  }

  // ---------------------------------------------------------------------------
  // Wallet
  // ---------------------------------------------------------------------------
  let faucetHinted = false;
  const web3 = new Web3Manager({
    connected: ({ account, balance, wallet, networkError, silent }) => {
      el.walletLabel.textContent = shortAddr(account);
      el.walletBtn.classList.add('connected');
      el.walletBtn.classList.toggle('wrong-network', Boolean(networkError));
      el.balance.textContent = balance ?? '—';
      dashboard?.render();
      if (networkError) toast('Wrong network', networkError, { error: true });
      else if (!silent) toast('Wallet connected', `${wallet?.name ? `${wallet.name} · ` : ''}${shortAddr(account)} on ${getConfig().name}`);
      house?.readPlayer();
      pulse?.refresh();
      renderLedger();
    },
    balanceUpdated: (balance) => {
      el.balance.textContent = balance ?? '—';
      // An empty wallet on testnet: point at the faucet once per page load
      if (!faucetHinted && balance !== null && balance !== undefined && Number(balance) === 0 && getConfig().faucetUrl) {
        faucetHinted = true;
        toast('No test MON yet', 'This wallet is empty. Get free testnet MON from the faucet to place a bet.', { link: getConfig().faucetUrl, linkLabel: 'Faucet ↗' });
      }
      paintOdds();
    },
    txPending: ({ side, amount }) => {
      const q = quotes[side];
      toast('Confirm in your wallet', `${fmtMon(amount)} MON on ${sideName(side)} · ${duration}s · pays ${q && q.stake === amount ? fmtMon(q.payout) : '—'} MON`, { sticky: true });
    },
    txSuccess: ({ txHash, side, amount }) => {
      toast('Bet placed', `${fmtMon(amount)} MON on ${sideName(side)} · the strike is set in a few seconds`, { link: `${getConfig().explorerUrl}/tx/${txHash}` });
    },
    accountChanged: (account) => {
      el.walletLabel.textContent = shortAddr(account);
      house?.readPlayer();
      dashboard?.render();
      pulse?.refresh();
      renderLedger();
    },
    walletsChanged: () => {
      if (!$('wallet-modal').classList.contains('hidden') && !web3.account && !walletBusy) renderWalletPicker();
    },
    networkChanged: ({ isMonad }) => {
      el.walletBtn.classList.toggle('wrong-network', !isMonad);
      if (!isMonad) toast('Wrong network', `Your wallet left ${getConfig().name}. Switch back to bet (you can keep watching).`, { error: true });
      else toast('Network OK', `Back on ${getConfig().name}.`);
    },
    disconnected: () => {
      el.walletLabel.textContent = 'Connect';
      el.walletBtn.classList.remove('connected');
      el.balance.textContent = '—';
      dashboard?.render();
      house?.readPlayer();
      renderLedger();
    }
  });

  // Wallet balance on Monad; null until a wallet is connected and read
  function currentBalance() {
    const b = parseFloat(web3.balance);
    return Number.isFinite(b) ? b : null;
  }

  el.walletBtn.addEventListener('click', () => {
    if (!web3.account) openWalletPicker();
    else openWalletModal();
  });

  // Wallet chooser: our own modal listing every installed wallet (EIP-6963), so no extension opens
  // its own chooser window. The chosen wallet still shows its own approval prompt; that is the
  // wallet's security step.
  let walletBusy = false;
  const INSTALL_LINKS = [
    ['MetaMask', 'https://metamask.io/download/'],
    ['Rabby', 'https://rabby.io/'],
    ['Phantom', 'https://phantom.com/download']
  ];
  const safeIcon = (icon) => (typeof icon === 'string' && /^data:image\/(png|svg\+xml|webp|jpeg);/.test(icon) ? icon : null);

  function openWalletPicker(message = null) {
    renderWalletPicker(message);
    openModal('wallet-modal');
  }

  function renderWalletPicker(message = null, tone = 'error') {
    $('wallet-modal-title').textContent = 'Connect a wallet';
    const body = $('wallet-modal-body');
    const wallets = web3.walletList();
    const note = message ? `<p class="wallet-note ${tone}" role="alert">${escapeHtml(message)}</p>` : '';
    if (!wallets.length) {
      body.innerHTML = `${note}
        <p class="modal-text">No wallet found in this browser. Install one of these, reload the page, and connect. You can watch rounds without a wallet.</p>
        <div class="wallet-list">${INSTALL_LINKS.map(([name, url]) => `<a class="wallet-item" href="${url}" target="_blank" rel="noopener"><span class="wallet-icon">${escapeHtml(name[0])}</span><span class="wallet-name">${escapeHtml(name)}</span><span class="wallet-tag">Install ↗</span></a>`).join('')}</div>`;
      return;
    }
    body.innerHTML = `${note}
      <p class="modal-text">Choose a wallet. You'll approve the connection in the wallet, and it will be asked to use ${escapeHtml(getConfig().name)}.</p>
      <div class="wallet-list">${wallets.map((w) => {
        const icon = safeIcon(w.info.icon);
        return `<button class="wallet-item" data-wallet="${escapeHtml(w.info.uuid)}">
          ${icon ? `<img class="wallet-icon" src="${icon}" alt="" width="28" height="28" />` : `<span class="wallet-icon">${escapeHtml((w.info.name || '?')[0])}</span>`}
          <span class="wallet-name">${escapeHtml(w.info.name || 'Browser wallet')}</span>
          <span class="wallet-tag">Detected</span>
        </button>`;
      }).join('')}</div>`;
    body.querySelectorAll('[data-wallet]').forEach((btn) => btn.addEventListener('click', () => pickWallet(btn.dataset.wallet)));
  }

  async function pickWallet(uuid) {
    walletBusy = true;
    const body = $('wallet-modal-body');
    body.querySelectorAll('[data-wallet]').forEach((b) => { b.disabled = true; b.classList.toggle('pending', b.dataset.wallet === uuid); });
    body.querySelector(`[data-wallet="${CSS.escape(uuid)}"] .wallet-tag`).textContent = 'Approve in wallet…';
    const res = await web3.connect(uuid);
    walletBusy = false;
    if (!res.success) return renderWalletPicker(res.error);
    if (res.networkError) return renderNetworkProblem(res.networkError);
    closeModal('wallet-modal');
  }

  /** Connected, but the wallet is on another network: explain, offer the switch, allow watching */
  function renderNetworkProblem(message) {
    $('wallet-modal-title').textContent = 'Wrong network';
    const cfg = getConfig();
    $('wallet-modal-body').innerHTML = `
      <p class="wallet-note error" role="alert">${escapeHtml(message)}</p>
      <p class="modal-text">Bets and claims only go to ${escapeHtml(cfg.name)} (chain ${cfg.chainId}). You can keep watching meanwhile.</p>
      <div class="modal-actions">
        <button class="ghost-btn" data-close="wallet-modal">Keep watching</button>
        <button class="solid-btn" id="wallet-switch">Switch to ${escapeHtml(cfg.name)}</button>
      </div>`;
    $('wallet-switch').addEventListener('click', async () => {
      const r = await web3.switchToMonad();
      if (r.ok) {
        el.walletBtn.classList.remove('wrong-network');
        closeModal('wallet-modal');
        toast('Network OK', `Now on ${cfg.name}.`);
      } else {
        renderNetworkProblem(r.error);
      }
    });
  }

  function openWalletModal() {
    const body = $('wallet-modal-body');
    const cfg = getConfig();
    if (!web3.isLiveNetwork) {
      renderNetworkProblem(`${web3.walletInfo?.name || 'Your wallet'} is not on ${cfg.name}.`);
      openModal('wallet-modal');
      return;
    }
    $('wallet-modal-title').textContent = web3.walletInfo?.name || 'Wallet';
    body.innerHTML = `
      <div class="modal-kv"><span>Address</span><span class="num">${escapeHtml(shortAddr(web3.account))}</span></div>
      <div class="modal-kv"><span>Network</span><span>${escapeHtml(cfg.name)}</span></div>
      <div class="modal-kv"><span>Balance</span><span class="num">${escapeHtml(web3.balance ?? '—')} MON</span></div>
      <div class="modal-actions">
        ${cfg.faucetUrl ? `<a class="ghost-btn" href="${escapeHtml(cfg.faucetUrl)}" target="_blank" rel="noopener">Get test MON ↗</a>` : ''}
        <a class="ghost-btn" href="${escapeHtml(`${cfg.explorerUrl}/address/${web3.account}`)}" target="_blank" rel="noopener">Explorer ↗</a>
        <button class="solid-btn" id="wallet-disconnect">Disconnect</button>
      </div>`;
    $('wallet-disconnect').addEventListener('click', () => {
      web3.disconnect();
      closeModal('wallet-modal');
    });
    openModal('wallet-modal');
  }

  // Stake starts at the contract's minimum (rounded up to 0.1 MON) unless the user already typed one
  let stakeEdited = false;
  let stakeSeeded = false;
  let betPending = null; // 'UP' | 'DOWN' while the wallet is asked to confirm a bet
  let cashingOut = false; // while the wallet is asked to confirm a cash-out
  el.stake.addEventListener('input', (e) => { if (e.isTrusted) stakeEdited = true; });
  function seedStake() {
    const r = house?.rules;
    if (!r || stakeSeeded || stakeEdited) return;
    stakeSeeded = true;
    el.stake.value = String(Math.ceil(r.minBet * 10) / 10);
  }

  // Bet length in seconds (10, 30 or 60), remembered per browser
  let duration = 30;
  function setDuration(sec) {
    duration = [10, 30, 60].includes(sec) ? sec : 30;
    document.querySelectorAll('.dur-btn').forEach((b) => {
      const on = Number(b.dataset.dur) === duration;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    try { localStorage.setItem('mp.duration', String(duration)); } catch (_) { /* storage unavailable */ }
    tickHouse();
  }
  document.querySelectorAll('.dur-btn').forEach((b) => b.addEventListener('click', () => setDuration(Number(b.dataset.dur))));

  // ---------------------------------------------------------------------------
  // Modals & drawer
  // ---------------------------------------------------------------------------
  function openModal(id) { $(id).classList.remove('hidden'); }

  // How it works: shown once on the first visit, reopened from the ? button or the ? key
  function openGuide() {
    $('guide-fee').textContent = house?.rules ? `${house.payoutAt(0.5 - house.rules.band).toFixed(2)}×` : '—';
    openModal('guide-modal');
    try { localStorage.setItem('mp.seenGuide', '1'); } catch (_) { /* storage unavailable */ }
  }
  $('help-btn').addEventListener('click', openGuide);
  function closeModal(id) { $(id).classList.add('hidden'); }

  document.addEventListener('click', (e) => {
    const closer = e.target.closest('[data-close]');
    if (closer) closeModal(closer.dataset.close);
    if (e.target.classList.contains('modal')) closeModal(e.target.id);
  });

  function setLedger(open) {
    el.ledger.classList.toggle('open', open);
    el.ledger.setAttribute('aria-hidden', String(!open));
    el.ledgerBtn.setAttribute('aria-expanded', String(open));
    el.scrim.classList.toggle('hidden', !open);
  }
  el.ledgerBtn.addEventListener('click', () => setLedger(!el.ledger.classList.contains('open')));
  $('ledger-close').addEventListener('click', () => setLedger(false));
  el.scrim.addEventListener('click', () => setLedger(false));

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => {
        t.classList.toggle('active', t === tab);
        t.setAttribute('aria-selected', String(t === tab));
      });
      document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('active', p.id === `pane-${tab.dataset.pane}`));
    });
  });

  // ---------------------------------------------------------------------------
  // Canvas
  // ---------------------------------------------------------------------------
  const engine = new HorizonEngine(el.canvas);

  function updateSafeArea() {
    // Positions relative to the layout (the chart canvas), not the window: on short windows the
    // layout is taller than the window and the page scrolls
    const layout = $('horizon').getBoundingClientRect();
    const H = layout.height;
    const W = window.innerWidth;
    const y = (r) => r - layout.top;
    document.documentElement.style.setProperty('--topbar-h', `${Math.round(y(document.querySelector('.topbar').getBoundingClientRect().bottom))}px`);
    const consoleTop = y(el.console.getBoundingClientRect().top);
    document.documentElement.style.setProperty('--console-h', `${Math.round(H - consoleTop)}px`);

    const chipRect = el.positionChip.classList.contains('hidden') ? null : el.positionChip.getBoundingClientRect();
    const chip = chipRect ? { top: y(chipRect.top), bottom: y(chipRect.bottom) } : null;
    const chipOnTop = chip && chip.top < H / 2;
    const readoutBottom = y(el.readout.getBoundingClientRect().bottom);
    const top = Math.max(readoutBottom, chipOnTop ? chip.bottom : 0) + 14;
    const ticker = $('pulse-ticker');
    const tickerTop = ticker.classList.contains('hidden') ? Infinity : y(ticker.getBoundingClientRect().top);
    const bottom = Math.min(consoleTop, chip && !chipOnTop ? chip.top : Infinity, tickerTop) - 12;
    engine.setSafeArea(top / H, bottom / H);

    const pulseRect = $('pulse').getBoundingClientRect();
    engine.setRightInset(pulseRect.width > 0 ? W - pulseRect.left + 12 : 0);
  }
  window.addEventListener('resize', updateSafeArea);
  if (document.fonts?.ready) document.fonts.ready.then(updateSafeArea);

  // ---------------------------------------------------------------------------
  // Rendering helpers
  // ---------------------------------------------------------------------------
  const lastDelta = {};
  let lastTickerPaint = 0;
  let lastHeroPaint = 0;

  // Unknown is shown as a dash, never as 0.00%
  const fmtChange = (chg) => (chg === null ? '—' : `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`);

  function paintTickers(allMarkets) {
    const now = performance.now();
    if (now - lastTickerPaint < 250) return;
    lastTickerPaint = now;
    for (const k in allMarkets) {
      const chg = allMarkets[k].change24h ?? null;
      if (lastDelta[k] === chg) continue;
      lastDelta[k] = chg;
      const d = $(`delta-${k}`);
      if (!d) continue;
      d.textContent = fmtChange(chg);
      d.className = `market-delta ${chg === null ? '' : chg >= 0 ? 'pos' : 'neg'}`;
    }
  }

  let lastHeroPrice = null;
  let tickFlashTimer = null;
  function flashPrice(price) {
    if (lastHeroPrice !== null && price !== lastHeroPrice) {
      el.heroPrice.classList.remove('tick-up', 'tick-down');
      el.heroPrice.classList.add(price > lastHeroPrice ? 'tick-up' : 'tick-down');
      clearTimeout(tickFlashTimer);
      tickFlashTimer = setTimeout(() => el.heroPrice.classList.remove('tick-up', 'tick-down'), 260);
    }
    lastHeroPrice = price;
  }

  // The chart is an exchange price (Coinbase); a bet is decided by RedStone's signed price at its
  // result time, the median of several sources. They agree to a few hundredths of a percent, so a
  // position closer to the strike than CLOSE_CALL_PCT is shown as too close to call, not as winning.
  const CLOSE_CALL_PCT = 0.02;
  const closeCall = (price, strike) => Math.abs((price - strike) / strike) * 100 < CLOSE_CALL_PCT;

  function activeMarketId() {
    return SUPPORTED_MARKETS[amm.activeMarketKey]?.marketId || null;
  }

  /** The wallet's running bet on the active market, with its strike once recorded */
  function liveBet() {
    const id = activeMarketId();
    return id && house ? house.liveBet(id) : null;
  }

  function paintReadout(market, price) {
    const d = market.decimals;
    el.heroPrice.textContent = price === null ? '—' : fmtPrice(price, d);
    const chg = market.change24h ?? null;
    el.assetChange.textContent = `${fmtChange(chg)} 24h`;
    el.assetChange.className = `asset-change num ${chg === null ? '' : chg >= 0 ? 'pos' : 'neg'}`;

    const bet = liveBet();
    const strike = bet ? house.strikeOf(bet) : null;
    if (strike) {
      el.strikeVal.textContent = fmtPrice(strike, d);
      el.strikeVal.classList.add('locked');
      if (price === null) {
        el.gapVal.textContent = '—';
        el.gapVal.className = 'cell-val num';
      } else {
        const gap = price - strike;
        const pct = (gap / strike) * 100;
        el.gapVal.textContent = `${gap >= 0 ? '▲ +' : '▼ −'}${Math.abs(gap).toFixed(d)} (${Math.abs(pct).toFixed(3)}%)`;
        el.gapVal.className = `cell-val num ${gap > 0 ? 'above' : gap < 0 ? 'below' : ''}`;
      }
      return;
    }
    el.strikeVal.classList.remove('locked');
    el.gapVal.textContent = '—';
    el.gapVal.className = 'cell-val num';
    const now = Date.now();
    if (bet) {
      const toStrike = (bet.startTs * 1000 - now) / 1000;
      el.strikeVal.textContent = toStrike > 0 ? `Sets in ${fmtClock(toStrike)}` : 'Setting…';
    } else {
      const next = house?.nextStrikeAt(now);
      el.strikeVal.textContent = next ? `Next ${fmtClock((next - now) / 1000)}` : '—';
    }
  }

  // Network fee of the bet as set up now, from the chain: the node's gas estimate for this exact call
  // from this wallet (+10%, the limit it is sent with; Monad charges the full limit) times the gas
  // price the relay pushes from the chain. Re-estimated when the stake, length, market, balance or gas
  // price changes. Settlement is paid by the keeper and wins need no claim, so this is the only fee.
  let gasPriceWei = null;
  let feeKey = null;
  let feeTimer = null;

  function paintFee(stake) {
    const node = $('stake-fee');
    const r = house?.rules;
    const outOfRange = r && (stake < r.minBet || stake > r.maxStake);
    if (!web3.account || !r || stake <= 0 || outOfRange) {
      feeKey = null;
      node.classList.toggle('hidden', !r);
      node.classList.remove('warn');
      node.textContent = web3.account ? '' : 'Network fee: from the chain once you connect';
      node.classList.toggle('hidden', !r || (Boolean(web3.account) && (stake <= 0 || outOfRange)));
      return;
    }
    let params;
    try {
      params = betParams('UP', stake);
    } catch (_) {
      return;
    }
    const key = [stake, duration, params.marketId, params.balanceWei, gasPriceWei, web3.account].join(':');
    if (key === feeKey) return;
    feeKey = key;
    node.classList.remove('hidden', 'warn');
    node.textContent = 'Network fee: asking the chain…';
    clearTimeout(feeTimer);
    feeTimer = setTimeout(async () => {
      try {
        const { gasLimit, gasPriceWei: price, feeWei } = await web3.estimateBetFee({ ...params, minPayoutWei: 0n }, gasPriceWei);
        if (feeKey !== key) return;
        const fee = Number(ethers.formatEther(feeWei));
        const share = (fee / stake) * 100;
        node.classList.toggle('warn', share > 5);
        node.textContent = `Network fee ${fee.toFixed(4)} MON` + (share > 5 ? ` · ${share.toFixed(0)}% of stake` : '');
        node.title = `From the chain: ${gasLimit.toLocaleString('en-US')} gas × ${ethers.formatUnits(price, 'gwei')} gwei. Paid to the Monad network to place the bet; wins are credited automatically, with no claim fee.`;
      } catch (err) {
        if (feeKey !== key) return;
        node.classList.add('warn');
        node.textContent = err.message.replace(/^The contract rejected this: /, 'Would be rejected: ');
        node.title = 'The chain simulated this bet and it would not go through.';
      }
    }, 350);
  }

  /** The bet as the contract takes it: stake from the in-game balance first, the rest from the wallet */
  function betParams(side, amount) {
    const r = house.rules;
    const stakeWei = toWei(amount);
    const balanceWei = house.player?.balanceWei ?? 0n;
    const fromBalance = balanceWei < stakeWei ? balanceWei : stakeWei;
    return {
      side,
      marketId: activeMarketId(),
      duration,
      walletWei: stakeWei - fromBalance,
      balanceWei: fromBalance,
      // The quoted payout, with 2% room for other bets in the window landing first; past that the
      // contract refuses the bet instead of paying less than the player agreed to
      minPayoutWei: quotes[side] && quotes[side].stake === amount ? (quotes[side].payoutWei * 98n) / 100n : null
    };
  }

  // Live quotes from the contract for the stake, market and length on screen: odds move with the
  // betting in each window, so they are re-read when any of those, the window, or its bets change
  let quotes = { UP: null, DOWN: null };
  let quoteKey = null;
  let quoteTimer = null;
  let windowVersion = 0;
  function refreshQuotes() {
    const r = house?.rules;
    const stake = parseFloat(el.stake.value) || 0;
    const marketId = activeMarketId();
    if (!r || stake <= 0 || !marketId) {
      quotes = { UP: null, DOWN: null };
      quoteKey = null;
      return;
    }
    const key = [marketId, duration, stake, house.nextStrikeAt(), windowVersion].join(':');
    if (key === quoteKey) return;
    quoteKey = key;
    clearTimeout(quoteTimer);
    quoteTimer = setTimeout(async () => {
      try {
        const stakeWei = toWei(stake);
        const [up, down] = await Promise.all(['UP', 'DOWN'].map((side) => web3.fetchQuote(marketId, side, duration, stakeWei)));
        if (key !== quoteKey) return;
        const shape = (q) => ({
          stake,
          payoutWei: q.payout,
          payout: Number(ethers.formatEther(q.payout)),
          refused: q.refused,
          priceBps: Number(q.priceBps),
          up: Number(ethers.formatEther(q.upShares)),
          down: Number(ethers.formatEther(q.downShares))
        });
        quotes = { UP: shape(up), DOWN: shape(down) };
      } catch (err) {
        if (key !== quoteKey) return;
        quotes = { UP: null, DOWN: null };
      }
      paintOdds();
    }, 200);
  }

  // Contract reasons, in the player's words
  const REFUSED = {
    'Odds at limit on this side': 'This side is full for this round: try the other side or the next strike',
    'Bet exceeds house limit': 'Above the house limit for one bet',
    'Bet below minimum': 'Below the minimum bet',
    Paused: 'Paused by the house',
    'Market inactive': 'This market is closed'
  };
  // 6 decimals: a float's 18-digit expansion carries noise (0.1 -> 0.100000000000000006)
  const toWei = (mon) => ethers.parseEther(mon.toFixed(6));

  const inGame = () => house?.player?.balance ?? 0;

  function paintOdds() {
    const r = house?.rules;
    const stake = parseFloat(el.stake.value) || 0;
    const wallet = currentBalance();
    paintFee(stake);

    for (const side of ['UP', 'DOWN']) {
      const multEl = side === 'UP' ? el.upMult : el.downMult;
      const winEl = side === 'UP' ? el.upWin : el.downWin;
      const q = quotes[side] && quotes[side].stake === stake ? quotes[side] : null;
      multEl.textContent = q && !q.refused ? `${(q.payout / stake).toFixed(2)}×` : '—';
      (side === 'UP' ? el.betUp : el.betDown).classList.toggle('waiting', betPending === side);
      if (betPending === side) winEl.textContent = 'Confirm in your wallet…';
      else if (!r) winEl.textContent = house?.error ? 'House unavailable' : 'Opening the house…';
      else if (r.paused) winEl.textContent = 'Paused by the house';
      else if (r.minBet > r.maxStake) winEl.textContent = 'Vault too small for the minimum bet';
      else if (stake <= 0) winEl.textContent = 'Enter a stake';
      else if (stake < r.minBet) winEl.textContent = `Min bet ${fmtMon(r.minBet)} MON`;
      else if (stake > r.maxStake) winEl.textContent = `Max bet ${fmtMon(r.maxStake)} MON`;
      else if (wallet !== null && stake > wallet + inGame()) winEl.textContent = 'Above your balance';
      else if (!q) winEl.textContent = 'Reading the odds…';
      else if (q.refused) winEl.textContent = REFUSED[q.refused] || q.refused;
      else winEl.innerHTML = `Pays ${fmtMon(q.payout)} <span class="profit">+${fmtMon(q.payout - stake)}</span>`;
    }
    // Who backs what in the window this bet joins
    // The window's lean: the market maker's price of Rise (50% = even). Where players have leaned, the
    // other side pays more.
    const qu = quotes.UP;
    const lean = $('lean');
    if (qu && qu.priceBps && qu.priceBps !== 5000) {
      const upPct = qu.priceBps / 100;
      $('lean-up').style.width = `${upPct}%`;
      $('lean-down').style.width = `${100 - upPct}%`;
      const favoured = upPct > 50 ? 'Fall' : 'Rise';
      $('lean-label').textContent = `leans ${upPct > 50 ? 'Rise' : 'Fall'} ${Math.round(Math.max(upPct, 100 - upPct))}% · ${favoured} pays more`;
      lean.classList.remove('hidden');
    } else {
      lean.classList.add('hidden');
    }
    refreshQuotes();
    el.maxBet.textContent = r ? `${fmtMon(r.maxStake)} MON` : '—';

    // In-game balance: winnings wait here to ride again or cash out
    const p = house?.player;
    el.bankVal.textContent = p ? `${fmtMon(p.balance)} MON` : '—';
    $('bank').classList.toggle('has-balance', Boolean(p && p.balance > 0));
    el.rideBtn.disabled = !(p && r && p.balance >= r.minBet);
    el.cashoutBtn.disabled = !(p && p.balance > 0) || cashingOut;
    el.cashoutBtn.textContent = cashingOut ? 'Confirm in wallet…' : 'Cash out';

    // House pane
    if (r) {
      const lo = house.payoutAt(0.5 + r.band);
      const hi = house.payoutAt(0.5 - r.band);
      $('stat-pool').textContent = `${house.payoutAt(0.5).toFixed(2)}× even · ${lo.toFixed(2)}–${hi.toFixed(2)}× · ${(r.winFee * 100).toFixed(0)}% fee on wins`;
      $('stat-split').textContent = `${fmtMon(r.vault)} MON`;
      $('stat-impact').textContent = `${fmtMon(r.reserved)} MON`;
      $('stat-fee').textContent = `${fmtMon(r.minBet)} – ${fmtMon(r.maxStake)} MON`;
      $('house-note').textContent = `Every bet is against this vault. A win is paid from it, a loss goes into it. `
        + `So the vault can always pay, the full payout of every open bet is set aside ("reserved"), and one bet `
        + `may win at most ${(r.maxWin * 100).toFixed(0)}% of what is not reserved: that is the max bet. A bigger vault takes bigger bets.`;
      const shares = p?.shares ?? 0n;
      const total = r.totalShares ?? 0n;
      const share = total > 0n ? Number((shares * 1000000n) / total) / 10000 : 0;
      $('lp-share').textContent = p ? `${share.toFixed(2)}%` : '—';
      // What a withdrawal pays right now: the vault less the reserve behind open bets
      $('lp-value').textContent = p ? `${fmtMon((share / 100) * (r.vault - r.reserved))} MON` : '—';
      const locked = p && p.lpUnlockAt > Date.now();
      $('lp-remove').disabled = !(p && shares > 0n) || locked;
      $('lp-remove').title = locked ? `Locked until ${new Date(p.lpUnlockAt).toLocaleTimeString()}` : '';
    }
    paintStreak();
  }

  // Streak toward the jackpot: one dot per win in a row
  function paintStreak() {
    const r = house?.rules;
    const p = house?.player;
    const node = $('streak-val');
    $('pulse-now').textContent = p ? String(p.streak) : '—';
    if (!r || !p) {
      node.textContent = '—';
      return;
    }
    const n = r.jackpotStreak;
    const s = Math.min(p.streak, n);
    node.innerHTML = `${Array.from({ length: n }, (_, i) => `<i class="${i < s ? 'lit' : ''}"></i>`).join('')}<span>${p.streak}/${n}</span>`;
    node.title = p.streak
      ? `${p.streak} win${p.streak === 1 ? '' : 's'} in a row. ${n - s} more pays ≈ ${fmtMon(house.jackpotFor(p.streakMinStake))} MON from the jackpot.`
      : `Win ${n} one-at-a-time bets in a row to win the jackpot.`;
  }

  // The connected wallet's bets, from the contract's events
  function positionsList() {
    return house?.myBets() || [];
  }

  // Results shown in the bet rows for a few seconds after they land
  const RESULT_SHOWN_MS = 5000;
  const recentResults = new Map(); // betId -> { bet, until }

  /** One bet's row: live status by the chart price, or its result */
  function betPill(bet, market, price, now) {
    const up = bet.side === 'UP';
    const cls = ['bet-pill', up ? 'up' : 'down'];
    const glyph = up ? '▲' : '▼';
    const strikePrice = bet.startPrice ?? house.strikeOf(bet);
    const stake = `#${bet.betId} ${sideName(bet.side)} ${fmtMon(bet.stake)}${strikePrice ? ` @ ${fmtPrice(strikePrice, market.decimals)}` : ''}`;
    let text;
    if (bet.status !== 'Pending') {
      if (bet.status === 'Won') { cls.push('won'); text = `${stake} · won +${fmtMon(bet.paid)}`; }
      else if (bet.status === 'Lost') { cls.push('lost'); text = `${stake} · lost`; }
      else { cls.push('back'); text = `${stake} · ${bet.status === 'Push' ? 'tie' : 'no price'} · back`; }
    } else {
      const phase = house.phaseOf(bet, now);
      const strike = house.strikeOf(bet);
      if (phase === 'settling') {
        text = now > (bet.endTs + SELF_SETTLE_AFTER_S) * 1000 ? `${stake} · late: settle in My bets` : `${stake} · result coming`;
      } else if (phase === 'closed' || !strike) {
        const left = (bet.startTs * 1000 - now) / 1000;
        text = `${stake} · strike ${left > 0 ? `in ${fmtClock(left)}` : 'setting…'}`;
      } else {
        const left = fmtClock((bet.endTs * 1000 - now) / 1000);
        if (price === null) text = `${stake} · ${left}`;
        else if (closeCall(price, strike)) text = `${stake} · even · ${left}`;
        else if (up ? price > strike : price < strike) { cls.push('winning'); text = `${stake} · winning ${fmtMon(bet.payout)} · ${left}`; }
        else text = `${stake} · behind ${Math.abs(price - strike).toFixed(market.decimals)} · ${left}`;
      }
    }
    return `<div class="${cls.join(' ')}"><span class="position-glyph">${glyph}</span><span>${escapeHtml(text)}</span></div>`;
  }

  const MAX_PILLS = 4;
  let pillCount = 0;
  function paintPositionChip(market, chartPrice) {
    const now = Date.now();
    const id = activeMarketId()?.toLowerCase();
    for (const [k, r] of recentResults) if (r.until < now) recentResults.delete(k);
    const mine = positionsList();
    const running = mine.filter((b) => b.status === 'Pending' && b.marketId === id).sort((a, b) => a.endTs - b.endTs);
    const done = [...recentResults.values()].map((r) => r.bet).filter((b) => b.marketId === id);
    const elsewhere = mine.filter((b) => b.status === 'Pending' && b.marketId !== id).length;
    const rows = [...done, ...running];
    const shown = rows.slice(0, MAX_PILLS);
    let html = shown.map((b) => betPill(b, market, chartPrice, now)).join('');
    const hidden = rows.length - shown.length;
    if (hidden > 0 || elsewhere > 0) {
      const parts = [];
      if (hidden > 0) parts.push(`+${hidden} more`);
      if (elsewhere > 0) parts.push(`${elsewhere} on other markets`);
      html += `<div class="bet-pill more" title="All your bets are in My bets (☰)">${parts.join(' · ')}</div>`;
    }
    el.positionChip.innerHTML = html;
    const count = shown.length + (hidden > 0 || elsewhere > 0 ? 1 : 0);
    el.positionChip.classList.toggle('hidden', count === 0);
    if (count !== pillCount) {
      pillCount = count;
      requestAnimationFrame(updateSafeArea);
    }
    // Every running bet's strike on the chart
    engine.setUserBets(running.map((b) => ({ id: b.betId, side: b.side, stake: b.stake, strike: house.strikeOf(b), startAt: b.startTs * 1000, endAt: b.endTs * 1000 })));
  }

  // ---------------------------------------------------------------------------
  // Ledger lists
  // ---------------------------------------------------------------------------
  const OUTCOME = {
    Won: (b) => `<span class="row-amount won num">+${fmtMon(b.paid)}</span><span class="tag">Won</span>`,
    Lost: (b) => `<span class="row-amount lost num">${fmtMon(b.stake)}</span><span class="tag">Lost</span>`,
    Push: (b) => `<span class="row-amount num">${fmtMon(b.paid)}</span><span class="tag">Tie · back</span>`,
    Void: (b) => `<span class="row-amount num">${fmtMon(b.paid)}</span><span class="tag">No price · back</span>`
  };

  function betRow(b, { who = false } = {}) {
    const glyph = b.side === 'UP' ? '▲' : '▼';
    const market = chainHistory?.marketLabel(b.marketId) || '';
    const strike = b.startPrice ?? house?.strikeOf(b);
    const prices = strike ? ` · ${strike.toLocaleString('en-US')}${b.endPrice ? ` → ${b.endPrice.toLocaleString('en-US')}` : ''}` : '';
    let end;
    if (b.status === 'Pending') {
      const phase = house?.phaseOf(b) || 'locked';
      const late = !who && Date.now() > (b.endTs + SELF_SETTLE_AFTER_S) * 1000;
      end = late
        ? `<button class="claim-btn" data-settle="${b.betId}" title="The result is signed but not settled yet. Settle it from your wallet (you pay the network fee).">Settle it yourself</button>`
        : `<span class="row-amount num">${fmtMon(b.stake)}</span><span class="tag">${phase === 'closed' ? 'Strike soon' : phase === 'locked' ? 'Live' : 'Settling'}</span>`;
    } else {
      end = (OUTCOME[b.status] || (() => ''))(b);
    }
    return `
      <div class="row">
        <span class="row-glyph ${b.status === 'Pending' ? (b.side === 'UP' ? 'up' : 'down') : b.status === 'Won' ? 'up' : b.status === 'Lost' ? 'down' : 'neutral'}">${glyph}</span>
        <div class="row-main">
          <span class="row-title">${who ? `${escapeHtml(shortAddr(b.user))} · ` : ''}${escapeHtml(market)} · ${sideName(b.side)} ${b.duration}s</span>
          <span class="row-sub num">#${b.betId} · ${fmtMon(b.stake)} MON${prices}</span>
        </div>
        <div class="row-end">${end}</div>
      </div>`;
  }

  el.positionsList.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-settle]');
    if (!btn) return;
    const bet = positionsList().find((b) => b.betId === Number(btn.dataset.settle));
    if (!bet || bet.status !== 'Pending') return;
    const relay = API_CONFIG.priceRelayUrl;
    if (!relay) return toast('No relay configured', 'Signed prices come from the relay (NEXT_PUBLIC_PRICE_RELAY_URL).', { error: true });
    btn.disabled = true;
    btn.textContent = 'Getting signed prices…';
    try {
      const market = Object.values(SUPPORTED_MARKETS).find((m) => m.marketId.toLowerCase() === bet.marketId);
      const updates = [];
      for (const ts of [bet.startTs, bet.endTs]) {
        if (chainHistory.price(bet.marketId, ts) !== null) continue;
        const r = await fetch(`${relay}/reports?feed=${encodeURIComponent(market.feed)}&ts=${ts}`);
        const body = await r.json();
        if (!r.ok) throw new Error(body.error || `relay ${r.status}`);
        updates.push({ marketId: market.marketId, ts, reports: body });
      }
      btn.textContent = 'Confirm in wallet…';
      const res = await web3.settleBets(updates, [bet.betId]);
      if (!res.success) throw new Error(res.cancelled ? 'Cancelled in your wallet.' : res.error);
      toast('Settling your bet', 'The result lands in a few seconds.', { link: `${getConfig().explorerUrl}/tx/${res.txHash}` });
    } catch (err) {
      toast('Could not settle yet', err.message, { error: true });
      btn.disabled = false;
      btn.textContent = 'Settle it yourself';
    }
  });

  function renderPositions() {
    const bets = positionsList();
    const live = bets.filter((b) => b.status === 'Pending').length;
    el.ledgerCount.classList.toggle('hidden', !live);
    el.ledgerCount.textContent = live;
    if (!bets.length) {
      el.positionsList.innerHTML = !web3.account
        ? '<div class="empty">Connect your wallet to see your bets.</div>'
        : '<div class="empty">No bets yet.<br>Pick Rise or Fall: the house takes the other side.</div>';
      return;
    }
    el.positionsList.innerHTML = bets.slice(0, 80).map((b) => betRow(b)).join('');
  }

  // Everyone's latest results, newest first
  function renderHistory() {
    const bets = (chainHistory?.betsList() || []).filter((b) => b.status !== 'Pending').slice(0, 60);
    el.historyList.innerHTML = bets.length
      ? bets.map((b) => betRow(b, { who: true })).join('')
      : '<div class="empty">No bets have settled yet.</div>';
  }

  function renderSessionStats() {
    const settled = positionsList().filter((b) => b.status === 'Won' || b.status === 'Lost');
    $('stat-settled').textContent = settled.length;
    const p = house?.player;
    $('stat-streak').textContent = p ? `${p.streak} win${p.streak === 1 ? '' : 's'}` : '—';
    if (!settled.length) {
      $('stat-winrate').textContent = '—';
      $('stat-net').textContent = '—';
      return;
    }
    const wins = settled.filter((b) => b.status === 'Won').length;
    const net = settled.reduce((acc, b) => acc + (b.paid || 0) - b.stake, 0);
    $('stat-winrate').textContent = `${((wins / settled.length) * 100).toFixed(0)}%`;
    $('stat-net').textContent = `${net >= 0 ? '+' : '−'}${fmtMon(Math.abs(net))} MON`;
  }

  function renderLedger() {
    renderPositions();
    renderHistory();
    renderSessionStats();
  }

  // ---------------------------------------------------------------------------
  // Result moment: the wallet's bet settled on-chain
  // ---------------------------------------------------------------------------
  let resultTimer = null;
  let pendingResults = [];
  let resultBatchTimer = null;
  // Results that land together (one settlement transaction, or bets ending at the same moment) are
  // announced once, as a summary, instead of each replacing the last
  function flushResults() {
    const list = pendingResults;
    pendingResults = [];
    if (list.length === 1) return showResult(list[0]);
    if (list.length) showResults(list);
  }

  function showResults(list) {
    const won = list.filter((b) => b.status === 'Won');
    const lost = list.filter((b) => b.status === 'Lost');
    const back = list.filter((b) => b.status === 'Push' || b.status === 'Void');
    const paid = list.reduce((s, b) => s + (b.paid || 0), 0);
    const staked = list.reduce((s, b) => s + b.stake, 0);
    const net = paid - staked;
    const parts = [];
    if (won.length) parts.push(`${won.length} won`);
    if (lost.length) parts.push(`${lost.length} lost`);
    if (back.length) parts.push(`${back.length} back`);
    el.resultTitle.textContent = parts.join(' · ');
    el.resultSub.textContent = `${net >= 0 ? '+' : '−'}${fmtMon(Math.abs(net))} MON net on ${list.length} bets · ${fmtMon(paid)} MON to your balance`;
    el.resultState.textContent = 'Settled on-chain';
    el.resultState.className = 'result-state';
    el.result.className = `result ${won.length > lost.length ? 'up' : 'neutral'}`;
    void el.result.offsetWidth;
    el.result.classList.remove('hidden');
    clearTimeout(resultTimer);
    resultTimer = setTimeout(() => el.result.classList.add('hidden'), 3600);
    if (won.length) engine.celebrate(won[0].side, Math.min(2, 0.8 + won.length * 0.3));
  }

  function showResult(bet) {
    const m = amm.markets[Object.keys(SUPPORTED_MARKETS).find((k) => SUPPORTED_MARKETS[k].marketId.toLowerCase() === bet.marketId)] || amm.getActiveMarket();
    const won = bet.status === 'Won';
    const back = bet.status === 'Push' || bet.status === 'Void';
    const kind = won ? (bet.side === 'UP' ? 'up' : 'down') : 'neutral';
    el.resultTitle.textContent = won ? 'You won' : back ? (bet.status === 'Push' ? 'Tie · stake back' : 'No price · stake back') : 'Not this time';
    if (won) {
      const streak = bet.streakAfter || 0;
      el.resultSub.innerHTML = `+<span class="num" id="result-won">0.00</span> MON to your balance${streak > 1 ? ` · ${streak} in a row` : ''}`;
      countTo($('result-won'), bet.paid, 2, 1100);
    } else if (back) {
      el.resultSub.textContent = `${fmtMon(bet.paid)} MON back in your balance`;
    } else {
      el.resultSub.textContent = bet.startPrice && bet.endPrice
        ? `${sideName(bet.side)} · ${fmtPrice(bet.startPrice, m.decimals)} → ${fmtPrice(bet.endPrice, m.decimals)}`
        : `${sideName(bet.side)} lost ${fmtMon(bet.stake)} MON`;
    }
    el.resultState.textContent = 'Settled on-chain';
    if (won) {
      const text = `I just won ${fmtMon(bet.paid)} MON on a ${bet.duration || ''}${bet.duration ? 's ' : ''}${sideName(bet.side)} call on Pulse, fully on-chain on Monad. Try it:`;
      const a = document.createElement('a');
      a.className = 'result-share';
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = ' · Share ↗';
      a.href = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(location.origin)}`;
      el.resultState.appendChild(a);
    }
    el.resultState.className = 'result-state';
    el.result.className = `result ${kind}`;
    void el.result.offsetWidth;
    el.result.classList.remove('hidden');
    clearTimeout(resultTimer);
    resultTimer = setTimeout(() => el.result.classList.add('hidden'), won ? 6000 : 3200);
    if (bet.marketId === activeMarketId()?.toLowerCase()) {
      engine.flashSettlement(bet.endPrice > bet.startPrice ? 'UP' : bet.endPrice < bet.startPrice ? 'DOWN' : 'DRAW');
      engine.celebrate(won ? bet.side : 'DRAW', won ? 1.4 : 0.3);
    }
  }

  function showJackpot(rec) {
    el.resultTitle.textContent = 'JACKPOT';
    el.resultSub.innerHTML = `+<span class="num" id="result-won">0.00</span> MON · ${rec.streak} wins in a row`;
    countTo($('result-won'), rec.amount, 2, 1800);
    el.resultState.textContent = 'Paid from the streak jackpot';
    el.resultState.className = 'result-state';
    el.result.className = 'result up jackpot';
    void el.result.offsetWidth;
    el.result.classList.remove('hidden');
    clearTimeout(resultTimer);
    resultTimer = setTimeout(() => el.result.classList.add('hidden'), 5000);
    engine.celebrate('UP', 2);
  }

  // ---------------------------------------------------------------------------
  // Market data
  // ---------------------------------------------------------------------------
  const amm = new MarketState({
    tick: ({ market, isActiveMarket, price, allMarkets, vol }) => {
      if (isActiveMarket) {
        // The chart draws only once history has loaded: keep the boot screen up until then, so a
        // refresh never shows the empty canvas between the loader and the first frame
        if (!engine.store.loading) bootStep('prices');
        engine.pushTick(price, vol || 0);
        const now = performance.now();
        if (now - lastHeroPaint >= 80) {
          lastHeroPaint = now;
          flashPrice(price);
          paintReadout(market, price);
          paintPositionChip(market, price);
        }
      }
      paintTickers(allMarkets);
    },

    feedStatus: ({ status, latency, isConnected, source }) => {
      if (status === 'NOT_CONFIGURED') {
        el.feedLatency.textContent = 'No price feed';
        el.feedDot.classList.remove('live');
        toast('No price feed configured', 'Set NEXT_PUBLIC_PRICE_SOURCE or NEXT_PUBLIC_PRICE_RELAY_URL (see .env.example).', { error: true, sticky: true });
        return;
      }
      el.feedLatency.textContent = latency === null || latency === undefined ? source
        : latency >= 1000 ? `${source} · ${(latency / 1000).toFixed(1)}s` : `${source} · ${latency}ms`;
      el.feedDot.classList.toggle('live', Boolean(isConnected));
    },

    marketChanged: (market) => {
      const key = amm.activeMarketKey;
      marketButtons.forEach((b) => {
        const on = b.dataset.market === key;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', String(on));
      });
      el.assetName.textContent = SUPPORTED_MARKETS[key]?.name || key;
      el.assetPair.textContent = market.symbol.replace('/', ' / ');
      engine.reset(market.price, market.decimals);
      engine.store.load(SUPPORTED_MARKETS[key]);
      engine.setStrike(null);
      engine.setUserBets([]);
      lastHeroPrice = null;
      paintReadout(market, market.price);
      paintOdds();
      paintPositionChip(market, market.price);
      tickHouse();
    }
  });

  // ---------------------------------------------------------------------------
  // Trading
  // ---------------------------------------------------------------------------
  /**
   * One tap, one transaction: the stake comes from the in-game balance first, the rest from the
   * wallet. The payout is the contract's quote; the bet is refused if other bets moved it more than 2%.
   */
  async function executeTrade(side, stakeOverride = null) {
    if (betPending) return;
    const amount = stakeOverride ?? (parseFloat(el.stake.value) || 0);
    const r = house?.rules;
    if (amount <= 0) return toast('Enter a stake', 'Choose how much MON to bet.', { error: true });
    if (!web3.account) {
      openWalletPicker();
      return;
    }
    if (!web3.isLiveNetwork) {
      renderNetworkProblem(`${web3.walletInfo?.name || 'Your wallet'} is not on ${getConfig().name}.`);
      openModal('wallet-modal');
      return;
    }
    if (!r) return toast('House not loaded', house?.error || 'Reading the house contract on Monad…', { error: true });
    if (r.paused) return toast('Betting paused', 'The house has paused new bets. Your balance can still be cashed out.', { error: true });
    if (amount < r.minBet) return toast('Stake below the minimum', `The minimum bet is ${fmtMon(r.minBet)} MON.`, { error: true });
    if (amount > r.maxStake) return toast('Above the house limit', `The house takes bets up to ${fmtMon(r.maxStake)} MON right now.`, { error: true });
    const params = betParams(side, amount);
    const q = quotes[side];
    if (!q || q.stake !== amount || params.minPayoutWei === null) return toast('Reading the odds', 'One moment: the contract is pricing this bet.', { error: true });
    if (q.refused) return toast('Not accepted', REFUSED[q.refused] || q.refused, { error: true });
    const wallet = currentBalance();
    if (wallet !== null && Number(ethers.formatEther(params.walletWei)) > wallet) {
      return toast('Stake above balance', `You have ${fmtMon(wallet)} MON in your wallet and ${fmtMon(inGame())} MON in play.`, { error: true });
    }
    // Waiting for the wallet: say so on the button and block a second bet until it answers
    betPending = side;
    paintOdds();
    tickHouse();
    let txRes;
    try {
      txRes = await web3.placeBet(params);
    } finally {
      betPending = null;
      paintOdds();
      tickHouse();
    }
    if (!txRes.success) {
      if (txRes.cancelled) return toast('Bet cancelled', 'Nothing was sent.');
      return toast('Bet not sent', txRes.error || 'Rejected in wallet', { error: true });
    }
    const btn = side === 'UP' ? el.betUp : el.betDown;
    const rect = btn.getBoundingClientRect();
    engine.emitBet(side, rect.left + rect.width / 2, rect.top + rect.height / 3, amount);
    if (params.balanceWei > 0n) house.spent(params.balanceWei);
    setTimeout(() => web3.fetchBalance(), 2000);
  }

  el.betUp.addEventListener('click', () => executeTrade('UP'));
  el.betDown.addEventListener('click', () => executeTrade('DOWN'));

  el.stake.addEventListener('input', paintOdds);
  document.querySelectorAll('.chip[data-add]').forEach((chip) => {
    chip.addEventListener('click', () => {
      el.stake.value = String(Math.round(((parseFloat(el.stake.value) || 0) + parseFloat(chip.dataset.add)) * 100) / 100);
      stakeEdited = true;
      paintOdds();
    });
  });
  $('stake-max').addEventListener('click', () => {
    const balance = currentBalance();
    if (balance === null) return toast('Connect a wallet', 'Max uses your wallet and in-game balance.', { error: true });
    // Leave room for the network fee; never above the house limit
    const limit = house?.rules?.maxStake ?? Infinity;
    el.stake.value = Math.max(0, Math.floor(Math.min(limit, balance - 0.05 + inGame()) * 100) / 100);
    stakeEdited = true;
    paintOdds();
  });

  // Use all: put the whole in-game balance (up to the max bet) in the stake; the player then picks Rise
  // or Fall. A bet takes the in-game balance first, so nothing is sent from the wallet for it.
  el.rideBtn.addEventListener('click', () => {
    const limit = house?.rules?.maxStake ?? Infinity;
    const balWei = house?.player?.balanceWei ?? 0n;
    if (balWei <= 0n) return;
    // Exact on-chain balance, cut to 6 decimals (what toWei sends) so no dust is left behind
    const exact = Number(ethers.formatEther(balWei - (balWei % 10n ** 12n)));
    const stake = Math.min(exact, Math.floor(limit * 1e6) / 1e6);
    el.stake.value = String(stake);
    stakeEdited = true;
    paintOdds();
    el.stake.classList.remove('flash');
    void el.stake.offsetWidth;
    el.stake.classList.add('flash');
    if (inGame() > limit) toast('Capped at the max bet', `The house takes bets up to ${fmtMon(limit)} MON right now; the rest stays in play.`);
  });

  el.cashoutBtn.addEventListener('click', async () => {
    const wei = house?.player?.balanceWei ?? 0n;
    if (cashingOut || wei <= 0n) return;
    cashingOut = true;
    paintOdds();
    let res;
    try {
      res = await web3.withdrawBalance(0n);
    } finally {
      cashingOut = false;
    }
    if (!res.success) {
      paintOdds();
      if (res.cancelled) return toast('Cash out cancelled', 'Your balance stays in play.');
      if (/Nothing to withdraw/.test(res.error)) {
        house.readPlayer();
        return toast('Already cashed out', 'Your in-game balance is empty; the MON is in your wallet.');
      }
      return toast('Cash out failed', res.error, { error: true });
    }
    house.spent(wei);
    toast('Cashed out', `${fmtMon(Number(ethers.formatEther(wei)))} MON on its way to your wallet`, { link: `${getConfig().explorerUrl}/tx/${res.txHash}` });
    setTimeout(() => web3.fetchBalance(), 2000);
  });

  // Be the house: vault deposits and withdrawals
  $('lp-add').addEventListener('click', async () => {
    const amount = parseFloat($('lp-amount').value) || 0;
    if (!web3.account) return openWalletPicker();
    if (amount <= 0) return toast('Enter an amount', 'How much MON to add to the vault.', { error: true });
    const res = await web3.addLiquidity(toWei(amount));
    if (!res.success) return toast(res.cancelled ? 'Deposit cancelled' : 'Deposit failed', res.cancelled ? 'Nothing was sent.' : res.error, { error: !res.cancelled });
    toast('Added to the vault', `${fmtMon(amount)} MON`, { link: `${getConfig().explorerUrl}/tx/${res.txHash}` });
    $('lp-amount').value = '';
    house.readPlayer(); // refreshes the vault share shown in the LP panel
    setTimeout(() => web3.fetchBalance(), 2000);
  });
  $('lp-remove').addEventListener('click', async () => {
    const shares = house?.player?.shares ?? 0n;
    if (shares <= 0n) return;
    const res = await web3.removeLiquidity(shares);
    if (!res.success) return toast(res.cancelled ? 'Withdrawal cancelled' : 'Withdrawal failed', res.cancelled ? 'Your share stays in the vault.' : res.error, { error: !res.cancelled });
    toast('Withdrawn from the vault', 'Your share is on its way to your wallet', { link: `${getConfig().explorerUrl}/tx/${res.txHash}` });
    house.readPlayer(); // refreshes the vault share (back to zero) shown in the LP panel
    setTimeout(() => web3.fetchBalance(), 2000);
  });
  $('stake-clear').addEventListener('click', () => {
    el.stake.value = 0;
    paintOdds();
  });

  marketButtons.forEach((b) => b.addEventListener('click', () => amm.setActiveMarket(b.dataset.market)));

  // Chart style: remembered per browser
  function setChartMode(mode) {
    engine.setChartMode(mode);
    document.querySelectorAll('.chart-btn[data-chart]').forEach((b) => {
      const on = b.dataset.chart === mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    try { localStorage.setItem('mp.chartMode', mode); } catch (_) { /* storage unavailable */ }
  }
  document.querySelectorAll('.chart-btn[data-chart]').forEach((b) => b.addEventListener('click', () => setChartMode(b.dataset.chart)));
  try { setChartMode(localStorage.getItem('mp.chartMode') === 'candles' ? 'candles' : 'line'); } catch (_) { setChartMode('line'); }

  // Zoom applies to both views: 5s, 15s or 1m per candle / per 10px of line
  function setTimeframe(sec) {
    engine.setTimeframe(sec);
    document.querySelectorAll('.tf-btn').forEach((b) => {
      const on = Number(b.dataset.tf) === engine.tf;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    try { localStorage.setItem('mp.tf', String(engine.tf)); } catch (_) { /* storage unavailable */ }
  }
  document.querySelectorAll('.tf-btn').forEach((b) => b.addEventListener('click', () => setTimeframe(Number(b.dataset.tf))));
  try { setTimeframe(Number(localStorage.getItem('mp.tf')) || 5); } catch (_) { setTimeframe(5); }

  window.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea')) return;
    if (e.key === '?') {
      openGuide();
      return;
    }
    if (e.key === 'Escape') {
      setLedger(false);
      document.querySelectorAll('.modal').forEach((m) => m.classList.add('hidden'));
      return;
    }
    const keyMap = { 1: 'BTC', 2: 'ETH', 3: 'SOL', 4: 'MON' };
    if (keyMap[e.key]) amm.setActiveMarket(keyMap[e.key]);
    if (e.key === 'u' || e.key === 'U') el.betUp.click();
    if (e.key === 'd' || e.key === 'D') el.betDown.click();
    if (e.key === 'l' || e.key === 'L') setLedger(!el.ledger.classList.contains('open'));
  });

  // ---------------------------------------------------------------------------
  // Pulse board
  // ---------------------------------------------------------------------------
  const seenFeedKeys = new Set();
  let tickerItems = [];
  let tickerIndex = 0;

  function feedLabel(item) {
    const who = item.you ? 'You' : item.user;
    return item.jackpot ? `${who} · ${item.streak} in a row` : `${who} · ${item.market}`;
  }

  function renderPulse({ ready, jackpot, jackpotStreak, paid, settled, feed }) {
    const big = $('pulse-paid');
    if (!ready || jackpot === null) {
      big.textContent = '—';
      return;
    }
    const prev = parseFloat(big.dataset.value || '0');
    if (jackpot !== prev || big.textContent === '—') {
      countTo(big, jackpot, jackpot >= 10000 ? 0 : 2, 1400);
      if (jackpot > prev) {
        big.classList.remove('bump');
        void big.offsetWidth;
        big.classList.add('bump');
      }
    }
    $('pulse-big-label').textContent = `MON jackpot · win ${jackpotStreak} in a row`;
    $('pulse-rounds').textContent = settled.toLocaleString('en-US');
    $('pulse-top').textContent = paid === null ? '—' : fmtMon(paid);

    const list = $('pulse-feed');
    if (!feed.length) {
      list.innerHTML = '<li class="empty-feed">No wins yet. Be the first.</li>';
    } else {
      list.innerHTML = feed.slice(0, 4).map((item) => {
        const isNew = !seenFeedKeys.has(item.key);
        seenFeedKeys.add(item.key);
        const side = item.side === 'UP' ? 'up' : item.side === 'DOWN' ? 'down' : '';
        return `
          <li class="feed-item ${side}${item.you ? ' you' : ''}${item.jackpot ? ' jackpot' : ''}${isNew ? ' new' : ''}">
            <span class="feed-glyph">${item.jackpot ? '★' : item.side === 'UP' ? '▲' : item.side === 'DOWN' ? '▼' : '◆'}</span>
            <span class="feed-text">${escapeHtml(feedLabel(item))}</span>
            <span class="feed-amt num">+${fmtMon(item.amount)}${item.mult ? `<small>${item.mult.toFixed(2)}×</small>` : ''}</span>
          </li>`;
      }).join('');
    }
    tickerFeed = feed;
    paintTicker();
  }

  // Narrow screens show the Pulse feed as one line: only wins from the last few minutes, so an old win
  // is never presented as news; it rotates only when there is more than one
  const TICKER_RECENT_MS = 10 * 60e3;
  let tickerFeed = [];
  let tickerShown = null;
  function paintTicker() {
    const ticker = $('pulse-ticker');
    tickerItems = tickerFeed.filter((w) => w.time !== null && Date.now() - w.time < TICKER_RECENT_MS).slice(0, 5);
    const show = window.innerWidth <= 1100 && tickerItems.length > 0;
    const changed = ticker.classList.contains('hidden') === show;
    ticker.classList.toggle('hidden', !show);
    if (changed) requestAnimationFrame(updateSafeArea);
    if (!show) {
      tickerShown = null;
      return;
    }
    const item = tickerItems[tickerIndex % tickerItems.length];
    if (item.key === tickerShown) return; // same win: no re-render, no animation
    tickerShown = item.key;
    const side = item.side === 'UP' ? 'up' : item.side === 'DOWN' ? 'down' : '';
    const who = item.you ? 'You' : item.user;
    ticker.innerHTML = item.jackpot
      ? `<span class="up">★</span> ${escapeHtml(who)} hit the jackpot: ${fmtMon(item.amount)} MON`
      : `<span class="${side}">${item.side === 'UP' ? '▲' : item.side === 'DOWN' ? '▼' : '◆'}</span> ${escapeHtml(who)} won ${fmtMon(item.amount)} MON on ${escapeHtml(item.market)}`;
    ticker.style.animation = 'none';
    void ticker.offsetWidth;
    ticker.style.animation = '';
  }
  setInterval(() => {
    // Local timer: rotates between recent wins and drops ones that get old (no network)
    if (tickerItems.length > 1) tickerIndex = (tickerIndex + 1) % tickerItems.length;
    paintTicker();
  }, 4000);
  window.addEventListener('resize', paintTicker);

  const history = new ChainHistory(web3);
  chainHistory = history;
  history.onChange(() => renderLedgerIfChanged());

  // ---------------------------------------------------------------------------
  // Live: everything below is read from the contract
  // ---------------------------------------------------------------------------
  let ledgerSignature = '';
  function renderLedgerIfChanged() {
    const late = (b) => b.status === 'Pending' && Date.now() > (b.endTs + SELF_SETTLE_AFTER_S) * 1000;
    const sig = JSON.stringify(positionsList().map((b) => [b.betId, b.status, house?.phaseOf(b), late(b)]))
      + (chainHistory?.bets.size || 0) + (house?.player?.streak ?? '');
    if (sig === ledgerSignature) return;
    ledgerSignature = sig;
    renderLedger();
  }

  /**
   * Clock-driven view of the house (no network): the countdown to the next strike, or to the result of
   * the wallet's running bet, and the chart gates for it.
   */
  function tickHouse() {
    const m = amm.getActiveMarket();
    const r = house?.rules;
    if (!r) {
      el.phaseLabel.textContent = house?.error ? 'House unreachable' : 'Opening the house';
      el.phaseTime.textContent = house?.error || '';
      el.betUp.disabled = Boolean(house?.error);
      el.betDown.disabled = Boolean(house?.error);
      return;
    }
    const now = Date.now();
    const bet = liveBet();
    el.betUp.disabled = r.paused || Boolean(betPending);
    el.betDown.disabled = r.paused || Boolean(betPending);
    el.console.classList.toggle('locked', r.paused);
    let span;
    let left;
    if (bet) {
      const phase = house.phaseOf(bet, now);
      const strike = house.strikeOf(bet);
      if (phase === 'closed') {
        left = (bet.startTs * 1000 - now) / 1000;
        span = Math.max(1, (bet.startTs * 1000 - bet.placedAt) / 1000);
        el.phaseLabel.textContent = 'Strike in';
      } else if (phase === 'locked') {
        left = (bet.endTs * 1000 - now) / 1000;
        span = bet.duration;
        el.phaseLabel.textContent = `${sideName(bet.side)} · result in`;
      } else {
        left = null;
        el.phaseLabel.textContent = 'Result coming';
      }
      el.phaseTime.innerHTML = left === null ? '<span class="phase-verb">signed price, then paid</span>' : fmtClock(left);
      engine.setLiveRound({ lockAt: bet.startTs * 1000, closeAt: bet.endTs * 1000, phase: phase === 'settling' ? 'settling' : phase, duration: bet.duration });
      if ((strike || null) !== engine.strike) engine.setStrike(strike);
    } else {
      const strikeAt = house.nextStrikeAt(now);
      left = (strikeAt - now) / 1000;
      span = 10;
      el.phaseLabel.textContent = 'Bet now';
      // The result time is part of the label, which narrow screens hide: they show the strike countdown only
      el.phaseTime.innerHTML = `<span class="phase-verb">strike </span>${fmtClock(left)}<span class="phase-verb"> · result ${fmtClock(left + duration)}</span>`;
      engine.setLiveRound({ lockAt: strikeAt, closeAt: strikeAt + duration * 1000, phase: 'preview', duration });
      if (engine.strike !== null) engine.setStrike(null);
    }
    el.ringFill.style.strokeDashoffset = `${RING_LENGTH * (1 - (left === null ? 0 : Math.min(1, Math.max(0, left) / span)))}`;
    el.console.classList.toggle('closing', Boolean(bet) && left !== null && left <= 5);
    refreshQuotes();
    paintReadout(m, m.price);
    paintPositionChip(m, m.price);
    renderLedgerIfChanged();
  }

  // The countdown moves with the local clock between contract events (no network requests)
  setInterval(tickHouse, 250);

  history.onGas((wei) => {
    gasPriceWei = wei;
    paintOdds();
  });

  house = new HouseState({
    web3,
    history,
    onUpdate: (h) => {
      if (h.rules) {
        bootStep('network');
        bootStep('round');
        seedStake();
        $('guide-fee').textContent = `${h.payoutAt(0.5 - h.rules.band).toFixed(2)}×`;
      } else if (h.error) {
        bootStep('network');
      }
      paintOdds();
      tickHouse();
      renderLedger();
    },
    onStrike: () => tickHouse(),
    onResult: (bet) => {
      recentResults.set(bet.betId, { bet, until: Date.now() + RESULT_SHOWN_MS });
      pendingResults.push(bet);
      clearTimeout(resultBatchTimer);
      resultBatchTimer = setTimeout(flushResults, 700);
      renderLedger();
    }
  });
  const shownJackpots = new Set();
  history.onBets((batch) => {
    if (batch.initial) return;
    const active = activeMarketId()?.toLowerCase();
    if (batch.placed.some((b) => b.marketId === active)) {
      windowVersion++;
      refreshQuotes();
    }
    const me = web3.account?.toLowerCase();
    // A jackpot is announced after the winning bet's own result
    for (const rec of history.records.slice(0, 20)) {
      if (rec.type === 'jackpot' && rec.user.toLowerCase() === me && !shownJackpots.has(rec.id) && batch.settled.some((b) => b.betId === rec.betId)) {
        shownJackpots.add(rec.id);
        setTimeout(() => showJackpot(rec), 2600);
      }
    }
  });
  pulse = new PulseFeed({ web3, history, onUpdate: renderPulse });

  // ---------------------------------------------------------------------------
  // Views: Trade and the transparency Dashboard
  // ---------------------------------------------------------------------------
  dashboard = new Dashboard({ history, explorerUrl: getConfig().explorerUrl, getAccount: () => web3.account });
  function setView(view) {
    const dash = view === 'dashboard';
    document.body.classList.toggle('view-dashboard', dash);
    $('dashboard').classList.toggle('hidden', !dash);
    document.querySelectorAll('.view-btn').forEach((b) => {
      const on = b.dataset.view === view;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    if (dash) setLedger(false);
    dashboard.show(dash);
    requestAnimationFrame(updateSafeArea);
  }
  document.querySelectorAll('.view-btn').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  // A market the price source cannot cover stays visible, disabled, with the reason on hover
  marketButtons.forEach((b) => {
    const reason = amm.markets[b.dataset.market]?.unavailable;
    if (!reason) return;
    b.disabled = true;
    b.classList.add('unavailable');
    b.title = reason;
  });
  el.networkBadge.textContent = getConfig().name;
  if (!getConfig().contractAddress) {
    toast('No contract configured', 'Set NEXT_PUBLIC_CONTRACT_ADDRESS (see .env.example).', { error: true, sticky: true });
  }
  try { setDuration(Number(localStorage.getItem('mp.duration')) || 30); } catch (_) { setDuration(30); }
  house.start();
  history.start();
  // A wallet connected before reconnects without a prompt (only if it still authorises this site)
  web3.restoreSession();
  pulse.refresh();
  amm.emit('marketChanged', amm.getActiveMarket());
  renderLedger();
  updateSafeArea();
  engine.start();

  // Installable app: the service worker is registered for production builds only, so development
  // always runs fresh code
  if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}
