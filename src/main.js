/**
 * main.js
 * Horizon UI controller: wires market data, the contract's rounds, the wallet and the canvas together.
 * Everything shown comes from the contract (via LiveRounds / ChainHistory) or the price feeds.
 */

import { ethers } from 'ethers';
import { HorizonEngine } from './HorizonEngine.js';
import { MarketState } from './MarketState.js';
import { Web3Manager } from './Web3Manager.js';
import { PulseFeed } from './PulseFeed.js';
import { ChainHistory } from './ChainHistory.js';
import { Dashboard } from './Dashboard.js';
import { LiveRounds } from './LiveRounds.js';
import { getConfig, API_CONFIG, SUPPORTED_MARKETS, TYPICAL_GAS } from './config.js';

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
const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

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
    positionGlyph: $('position-glyph'),
    positionText: $('position-text'),
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
    tugUp: $('tug-up'),
    tugDown: $('tug-down'),
    tugUpLabel: $('tug-up-label'),
    tugDownLabel: $('tug-down-label'),
    tugTotal: $('tug-total'),
    ringFill: $('phase-ring-fill'),
    phaseLabel: $('phase-label'),
    phaseTime: $('phase-time'),
    roundId: $('round-id'),
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
  let liveRounds = null;   // the active market's on-chain round and the wallet's positions
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
  function toast(title, msg, { link = null, error = false, sticky = false } = {}) {
    clearTimeout(toastTimer);
    el.toast.classList.remove('hidden');
    el.toast.classList.toggle('error', error);
    el.toastTitle.textContent = title;
    el.toastMsg.textContent = msg.length > 160 ? `${msg.slice(0, 157)}…` : msg;
    el.toastLink.classList.toggle('hidden', !link);
    if (link) el.toastLink.href = link;
    if (!sticky) toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 5000);
  }

  // ---------------------------------------------------------------------------
  // Wallet
  // ---------------------------------------------------------------------------
  const web3 = new Web3Manager({
    connected: ({ account, balance }) => {
      el.walletLabel.textContent = shortAddr(account);
      el.walletBtn.classList.add('connected');
      el.balance.textContent = balance ?? '—';
      dashboard?.render();
      toast('Wallet connected', `${shortAddr(account)} on ${getConfig().name}`);
      liveRounds?.sync();
      pulse?.refresh();
      renderLedger();
    },
    balanceUpdated: (balance) => {
      el.balance.textContent = balance ?? '—';
      paintOdds();
    },
    txPending: ({ side, amount }) => {
      const st = liveRounds?.state;
      const left = st && st.phase === 'open' ? Math.floor((st.betCloseAt - Date.now()) / 1000) : null;
      toast('Confirm in your wallet', left !== null && left < 25
        ? `${amount} MON on ${sideName(side)} · bets close in ${left}s: a bet that arrives later fails and still pays the network fee`
        : `${amount} MON on ${sideName(side)}`, { sticky: true });
    },
    txSuccess: ({ txHash, side, amount }) => {
      toast('Bet sent', `${amount} MON on ${sideName(side)}`, { link: `${getConfig().explorerUrl}/tx/${txHash}` });
    },
    txError: (error) => {
      toast('Transaction failed', error || 'Rejected in wallet', { error: true });
    },
    accountChanged: (account) => {
      el.walletLabel.textContent = shortAddr(account);
      dashboard?.render();
      pulse?.refresh();
      renderLedger();
    },
    disconnected: () => {
      el.walletLabel.textContent = 'Connect';
      el.walletBtn.classList.remove('connected');
      el.balance.textContent = '—';
      dashboard?.render();
      renderLedger();
    }
  });


  // Wallet balance on Monad; null until a wallet is connected and read
  function currentBalance() {
    const b = parseFloat(web3.balance);
    return Number.isFinite(b) ? b : null;
  }

  el.walletBtn.addEventListener('click', async () => {
    if (!web3.account) {
      const res = await web3.connect();
      if (!res.success) openWalletModal(res.error);
      return;
    }
    openWalletModal();
  });

  function openWalletModal(error = null) {
    const body = $('wallet-modal-body');
    const cfg = getConfig();
    if (error || !web3.account) {
      body.innerHTML = `
        <p class="modal-text">${escapeHtml(error || 'No browser wallet found.')}</p>
        <p class="modal-text">Install an EVM wallet such as MetaMask or Rabby, add ${escapeHtml(cfg.name)}, then connect again. You can watch rounds without a wallet.</p>
        <div class="modal-actions"><button class="solid-btn" data-close="wallet-modal">Got it</button></div>`;
    } else {
      body.innerHTML = `
        <div class="modal-kv"><span>Address</span><span class="num">${escapeHtml(shortAddr(web3.account))}</span></div>
        <div class="modal-kv"><span>Network</span><span>${escapeHtml(cfg.name)}</span></div>
        <div class="modal-kv"><span>Balance</span><span class="num">${escapeHtml(web3.balance ?? '—')} MON</span></div>
        <div class="modal-actions">
          <a class="ghost-btn" href="${escapeHtml(`${cfg.explorerUrl}/address/${web3.account}`)}" target="_blank" rel="noopener">Explorer ↗</a>
          <button class="solid-btn" id="wallet-disconnect">Disconnect</button>
        </div>`;
      $('wallet-disconnect').addEventListener('click', () => {
        web3.disconnect();
        closeModal('wallet-modal');
      });
    }
    openModal('wallet-modal');
  }

  // Contract parameters, read once without a wallet: fee and minimum bet (null until read)
  let protocolFeeBps = null;
  let minBetMon = null;
  async function loadProtocolParameters() {
    const p = await web3.fetchLiveProtocolFees();
    if (p?.totalFeeBps !== undefined) {
      protocolFeeBps = p.totalFeeBps;
      $('guide-fee').textContent = `${(protocolFeeBps / 100).toFixed(1)}%`;
      bootStep('network');
    }
    if (p?.minBetWei !== undefined) minBetMon = Number(ethers.formatEther(p.minBetWei));
    if (p?.lockBufferSeconds !== undefined && p?.priceWindowSeconds !== undefined) {
      roundRules = { lockBuffer: p.lockBufferSeconds, priceWindow: p.priceWindowSeconds };
    }
  }

  // Timeline a bet would start right now, by the contract's rules (_startRound): the strike locks on
  // the first report-grid mark one round length ahead, betting closes lockBuffer before it, and the
  // round settles one round length after the strike. Shown while no round is running.
  let roundRules = null;
  function projectedRound(duration, nowMs) {
    if (!roundRules) return null;
    const half = Math.floor(duration / 2);
    const w = Math.min(roundRules.priceWindow, half);
    const lock = Math.ceil((Math.floor(nowMs / 1000) + duration) / w) * w;
    return { betCloseAt: (lock - Math.min(roundRules.lockBuffer, half)) * 1000, lockAt: lock * 1000, closeAt: (lock + duration) * 1000 };
  }

  // ---------------------------------------------------------------------------
  // Modals & drawer
  // ---------------------------------------------------------------------------
  function openModal(id) { $(id).classList.remove('hidden'); }

  // How it works: shown once on the first visit, reopened from the ? button or the ? key
  function openGuide() {
    $('guide-fee').textContent = protocolFeeBps === null ? '—' : `${(protocolFeeBps / 100).toFixed(1)}%`;
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
  // Create market
  // ---------------------------------------------------------------------------
  let createDuration = 300;
  $('open-create').addEventListener('click', () => {
    $('cm-error').classList.add('hidden');
    openModal('create-modal');
  });
  document.querySelectorAll('#cm-duration .seg').forEach((seg) => {
    seg.addEventListener('click', () => {
      document.querySelectorAll('#cm-duration .seg').forEach((s) => s.classList.toggle('active', s === seg));
      createDuration = parseInt(seg.dataset.sec, 10);
    });
  });

  $('create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('cm-name').value.trim();
    const symbol = $('cm-symbol').value.trim().toUpperCase();
    const feed = $('cm-feed').value.trim();
    const errorEl = $('cm-error');
    const fail = (msg) => { errorEl.textContent = msg; errorEl.classList.remove('hidden'); };

    if (!name) return fail('Enter an asset name.');
    if (!/^[A-Z0-9][A-Z0-9/ .-]{0,15}$/.test(symbol)) return fail('Enter a symbol such as SUI/USD.');
    if (!/^[A-Za-z0-9_]{1,31}$/.test(feed)) return fail('The feed ID is a RedStone feed name such as SUI (letters, digits, underscores).');
    if (!web3.account) return fail('Connect a wallet to create a market.');

    errorEl.classList.add('hidden');
    const submit = $('cm-submit');
    submit.disabled = true;
    submit.textContent = 'Confirm in wallet…';
    const res = await web3.createMarket(feed, name, symbol, createDuration);
    submit.disabled = false;
    submit.textContent = 'Create market';
    if (!res.success) return fail(res.error || 'Transaction rejected.');

    closeModal('create-modal');
    toast('Market created', `${symbol} is live on-chain. It is listed here once verified.`, {
      link: `${getConfig().explorerUrl}/tx/${res.txHash}`
    });
  });

  $('claim-royalties').addEventListener('click', async () => {
    if (!web3.account) {
      toast('Connect a wallet', 'Creator fees are paid on-chain to the wallet that created the market.');
      return;
    }
    const m = amm.getActiveMarket();
    const res = await web3.claimCreatorFees(m.marketId);
    if (!res.success) {
      toast('Nothing to claim', `No creator fees for ${m.symbol} on this wallet.`, { error: true });
      return;
    }
    toast('Creator fees claimed', m.symbol, { link: `${getConfig().explorerUrl}/tx/${res.txHash}` });
    web3.fetchBalance();
  });

  // ---------------------------------------------------------------------------
  // Canvas
  // ---------------------------------------------------------------------------
  const engine = new HorizonEngine(el.canvas);

  function updateSafeArea() {
    const H = window.innerHeight;
    const W = window.innerWidth;
    document.documentElement.style.setProperty('--topbar-h', `${Math.round(document.querySelector('.topbar').getBoundingClientRect().bottom)}px`);
    const consoleRect = el.console.getBoundingClientRect();
    document.documentElement.style.setProperty('--console-h', `${Math.round(H - consoleRect.top)}px`);

    const chip = el.positionChip.classList.contains('hidden') ? null : el.positionChip.getBoundingClientRect();
    const chipOnTop = chip && chip.top < H / 2;
    const readoutBottom = el.readout.getBoundingClientRect().bottom;
    const top = Math.max(readoutBottom, chipOnTop ? chip.bottom : 0) + 36;
    const ticker = $('pulse-ticker');
    const tickerTop = ticker.classList.contains('hidden') ? Infinity : ticker.getBoundingClientRect().top;
    const bottom = Math.min(consoleRect.top, chip && !chipOnTop ? chip.top : Infinity, tickerTop) - 30;
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

  // The chart is an exchange price (Coinbase); the round is decided by RedStone's signed price at the
  // close time, the median of several sources. They agree to a few hundredths of a percent, so a
  // position closer to the strike than CLOSE_CALL_PCT is shown as too close to call, not as winning.
  const CLOSE_CALL_PCT = 0.02;
  const closeCall = (price, strike) => Math.abs((price - strike) / strike) * 100 < CLOSE_CALL_PCT;

  function paintReadout(market, price) {
    const d = market.decimals;
    const ref = price;
    el.heroPrice.textContent = price === null ? '—' : fmtPrice(price, d);
    const chg = market.change24h ?? null;
    el.assetChange.textContent = `${fmtChange(chg)} 24h`;
    el.assetChange.className = `asset-change num ${chg === null ? '' : chg >= 0 ? 'pos' : 'neg'}`;

    if (market.lockPrice) {
      el.strikeVal.textContent = fmtPrice(market.lockPrice, d);
      el.strikeVal.classList.add('locked');
      if (ref === null) {
        el.gapVal.textContent = '—';
        el.gapVal.className = 'cell-val num';
      } else {
        const gap = ref - market.lockPrice;
        const pct = (gap / market.lockPrice) * 100;
        el.gapVal.textContent = `${gap >= 0 ? '▲ +' : '▼ −'}${Math.abs(gap).toFixed(d)} (${Math.abs(pct).toFixed(3)}%)`;
        el.gapVal.className = `cell-val num ${gap > 0 ? 'above' : gap < 0 ? 'below' : ''}`;
      }
    } else {
      const st = liveRounds?.state;
      const toLock = st ? (st.lockAt - Date.now()) / 1000 : null;
      el.strikeVal.textContent = !st || st.error ? '—'
        : st.phase === 'idle' ? 'Set after the next bet'
        : toLock > 0 ? `Sets in ${fmtClock(toLock)}` : 'Setting…';
      el.strikeVal.classList.remove('locked');
      el.gapVal.textContent = '—';
      el.gapVal.className = 'cell-val num';
    }
  }

  const postBetMultiplier = (side, stake) => amm.multiplierAfter(side, stake);

  // Whole MON for big pools; small pools (real testnet bets) keep their decimals instead of showing 0
  const fmtPool = (v) => (v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toLocaleString('en-US', { maximumFractionDigits: 2 }));

  // Live mode: what a bet and a later claim cost in network fees, from typical gas and the live gas price.
  // Shown before betting, with a warning when fees are a large share of the stake (SEC-26).
  // The gas price is pushed by the relay whenever the chain's base fee changes (no polling)
  let gasPriceWei = null;

  function paintFee(stake) {
    const node = $('stake-fee');
    const st = liveRounds?.state;
    if (!gasPriceWei || !st || st.error) {
      node.classList.add('hidden');
      return;
    }
    const mon = (gas) => (Number(gas) * 1.1 * Number(gasPriceWei)) / 1e18;
    const betFee = mon(st.phase === 'idle' ? TYPICAL_GAS.betNewRound : TYPICAL_GAS.bet);
    const claimFee = mon(TYPICAL_GAS.claim);
    const share = stake > 0 ? ((betFee + claimFee) / stake) * 100 : null;
    node.classList.remove('hidden');
    node.classList.toggle('warn', share !== null && share > 5);
    node.textContent = `Network fee ≈ ${betFee.toFixed(4)} MON to bet, ≈ ${claimFee.toFixed(4)} to claim`
      + (share !== null && share > 5 ? ` · about ${share.toFixed(0)}% of this stake, not refundable` : '');
  }

  function paintOdds() {
    const m = amm.getActiveMarket();
    const odds = amm.getLiveOdds();
    const stake = parseFloat(el.stake.value) || 0;
    const balance = currentBalance();
    paintFee(stake);

    for (const side of ['UP', 'DOWN']) {
      const multEl = side === 'UP' ? el.upMult : el.downMult;
      const winEl = side === 'UP' ? el.upWin : el.downWin;
      const mult = stake > 0 ? postBetMultiplier(side, stake) : (side === 'UP' ? odds.multUp : odds.multDown);
      const opposingPool = side === 'UP' ? m.poolDown : m.poolUp;
      multEl.textContent = mult && opposingPool > 0 ? `${mult.toFixed(2)}×` : '—';
      if (amm.feeBps === null) winEl.textContent = 'Reading the round…';
      else if (opposingPool <= 0) winEl.textContent = `Refunded unless someone takes ${side === 'UP' ? 'Fall' : 'Rise'}`;
      else if (stake <= 0) winEl.textContent = 'Enter a stake';
      else if (balance !== null && stake > balance) winEl.textContent = 'Above balance';
      else {
        // Profit can be negative: when your stake dominates the pool, the fee exceeds what you win
        const profit = stake * mult - stake;
        winEl.innerHTML = `Pays ≈ ${fmtMon(stake * mult)} <span class="profit${profit < 0 ? ' loss' : ''}">${profit < 0 ? '−' : '+'}${fmtMon(Math.abs(profit))}</span>`;
      }
    }

    const total = m.poolUp + m.poolDown;
    if (m.roundId === null) {
      // The round has not been read from the contract yet: show nothing rather than an empty pool
      el.tugTotal.textContent = '—';
      el.tugUpLabel.textContent = '—';
      el.tugDownLabel.textContent = '—';
      $('up-pool').textContent = '—';
      $('down-pool').textContent = '—';
      $('up-players').textContent = '';
      $('down-players').textContent = '';
      el.tugUp.style.width = '50%';
      el.tugDown.style.width = '50%';
      return;
    }
    const upPct = total > 0 ? (m.poolUp / total) * 100 : 50;
    el.tugUp.style.width = `${upPct}%`;
    el.tugDown.style.width = `${100 - upPct}%`;
    el.tugUpLabel.textContent = `▲ ${Math.round(upPct)}%`;
    el.tugDownLabel.textContent = `${Math.round(100 - upPct)}% ▼`;
    const upPlayers = m.upBettors || 0;
    const downPlayers = m.downBettors || 0;
    el.tugTotal.textContent = `${fmtPool(total)} MON · ${plural(upPlayers + downPlayers, 'player')}`;
    $('up-pool').textContent = `${fmtPool(m.poolUp)} MON`;
    $('down-pool').textContent = `${fmtPool(m.poolDown)} MON`;
    const playersHtml = (n) => `${n.toLocaleString('en-US')}<span class="word"> player${n === 1 ? '' : 's'}</span>`;
    $('up-players').innerHTML = playersHtml(upPlayers);
    $('down-players').innerHTML = playersHtml(downPlayers);
    $('pulse-now').textContent = (upPlayers + downPlayers).toLocaleString('en-US');
    engine.setPools(m.poolUp, m.poolDown);

    // Stats pane
    $('stat-pool').textContent = `${fmtMon(total)} MON`;
    $('stat-split').textContent = `${fmtPool(m.poolUp)} / ${fmtPool(m.poolDown)}`;
    $('stat-fee').textContent = amm.feeBps === null ? '—' : `${(amm.feeBps / 100).toFixed(2)}%`;
    if (stake > 0 && odds.multUp && odds.multDown) {
      const preUp = odds.multUp;
      const preDn = odds.multDown;
      const dilUp = Math.max(0, (preUp - postBetMultiplier('UP', stake)) / preUp) * 100;
      const dilDn = Math.max(0, (preDn - postBetMultiplier('DOWN', stake)) / preDn) * 100;
      $('stat-impact').textContent = `−${dilUp.toFixed(1)}% ▲ / −${dilDn.toFixed(1)}% ▼`;
    } else {
      $('stat-impact').textContent = '—';
    }
  }

  // Winning side of the active market's recent rounds with bets (▲ Rise, ▼ Fall, · refunded), newest last
  function paintRecent() {
    const id = SUPPORTED_MARKETS[amm.activeMarketKey]?.marketId.toLowerCase();
    const sides = (chainHistory?.roundsList() || [])
      .filter((r) => r.marketId === id && r.up + r.down > 0)
      .sort((a, b) => b.roundId - a.roundId)
      .map((r) => (r.status === 'settled' ? r.winningSide : null));
    const node = $('recent-results');
    const last = sides.slice(0, 8).reverse();
    node.innerHTML = last.length
      ? last.map((s) => (s === 'UP' ? '<i class="r-up">▲</i>' : s === 'DOWN' ? '<i class="r-down">▼</i>' : '<i class="r-void">·</i>')).join('')
      : '—';
  }


  // The connected wallet's positions, from the contract's events
  function positionsList() {
    return liveRounds?.positions(web3.account) || [];
  }

  function activePositionsForMarket() {
    const m = amm.getActiveMarket();
    return positionsList().filter((p) => p.marketKey === amm.activeMarketKey && p.roundId === m.roundId && p.status === 'Active');
  }

  function paintPositionChip(market, chartPrice) {
    const price = chartPrice;
    const mine = activePositionsForMarket();
    const wasHidden = el.positionChip.classList.contains('hidden');
    if (!mine.length) {
      el.positionChip.classList.add('hidden');
      if (!wasHidden) updateSafeArea();
      return;
    }
    if (wasHidden) requestAnimationFrame(updateSafeArea);
    const sides = new Set(mine.map((p) => p.side));
    const stake = mine.reduce((s, p) => s + p.amount, 0);
    el.positionChip.classList.remove('hidden');
    el.positionChip.classList.remove('up', 'down', 'winning');

    if (sides.size > 1) {
      el.positionGlyph.textContent = '◆';
      el.positionText.textContent = `${fmtMon(stake)} MON on both sides`;
      return;
    }
    const side = mine[0].side;
    el.positionChip.classList.add(side === 'UP' ? 'up' : 'down');
    el.positionGlyph.textContent = side === 'UP' ? '▲' : '▼';

    if (!market.lockPrice) {
      el.positionText.textContent = `${fmtMon(stake)} MON on ${sideName(side)} · strike sets at lock`;
      return;
    }
    if (price === null) {
      el.positionText.textContent = `${fmtMon(stake)} MON on ${sideName(side)} · waiting for the price feed`;
      return;
    }
    if (closeCall(price, market.lockPrice)) {
      el.positionText.textContent = `Too close to call · ${fmtMon(stake)} MON at stake`;
      return;
    }
    const winning = side === 'UP' ? price > market.lockPrice : price < market.lockPrice;
    const mult = parseFloat(side === 'UP' ? amm.getLiveOdds().multUp : amm.getLiveOdds().multDown) || 1;
    if (winning) {
      el.positionChip.classList.add('winning');
      el.positionText.textContent = `Winning · pays ≈ ${fmtMon(stake * mult)} MON`;
    } else {
      const behind = Math.abs(price - market.lockPrice);
      el.positionText.textContent = `Behind by ${behind.toFixed(market.decimals)} · ${fmtMon(stake)} MON at stake`;
    }
  }

  // ---------------------------------------------------------------------------
  // Ledger lists
  // ---------------------------------------------------------------------------
  function renderPositions() {
    const positions = positionsList();
    const active = positions.filter((p) => p.status === 'Active').length;
    const claimable = positions.filter((p) => (p.status === 'Won' || p.status === 'Refunded') && !p.claimed).length;
    el.ledgerCount.classList.toggle('hidden', !active && !claimable);
    el.ledgerCount.classList.toggle('claimable', claimable > 0);
    el.ledgerCount.textContent = claimable || active;

    if (!positions.length) {
      el.positionsList.innerHTML = !web3.account
        ? '<div class="empty">Connect your wallet to see your positions.</div>'
        : '<div class="empty">No positions yet.<br>Pick Rise or Fall to join the current round.</div>';
      return;
    }

    // Live: several claimable rounds in one market are claimed in one transaction (one network fee)
    const claimables = positions.filter((p) => (p.status === 'Won' || p.status === 'Refunded') && !p.claimed);
    const byMarket = new Map();
    for (const p of claimables) byMarket.set(p.marketId, [...(byMarket.get(p.marketId) || []), p]);
    const claimAll = [...byMarket.entries()].filter(([, list]) => list.length > 1).map(([marketId, list]) =>
      `<button class="claim-all-btn" data-claim-all="${escapeHtml(marketId)}" data-rounds="${list.map((p) => p.roundId).join(',')}">Claim all ${escapeHtml(list[0].market)} (${list.length} rounds, one fee)</button>`).join('');

    el.positionsList.innerHTML = claimAll + positions.map((p) => {
      const glyph = p.side === 'UP' ? '▲' : '▼';
      let end;
      if ((p.status === 'Won' || p.status === 'Refunded') && !p.claimed) {
        end = `<button class="claim-btn num" data-claim="${escapeHtml(p.id)}">${p.status === 'Won' ? 'Claim' : 'Refund'} ${p.payout === null ? '' : fmtMon(p.payout)}</button>`;
      } else if (p.status === 'Won') {
        end = `<span class="row-amount won num">+${fmtMon(p.payout)}</span><span class="tag">Claimed</span>`;
      } else if (p.status === 'Refunded') {
        end = `<span class="row-amount num">${fmtMon(p.payout)}</span><span class="tag">Refunded</span>`;
      } else if (p.status === 'Lost') {
        end = `<span class="row-amount lost num">${fmtMon(p.amount)}</span><span class="tag">Lost</span>`;
      } else {
        end = `<span class="row-amount num">${fmtMon(p.amount)}</span><span class="tag">Live</span>`;
      }
      return `
        <div class="row">
          <span class="row-glyph ${p.side === 'UP' ? 'up' : 'down'}">${glyph}</span>
          <div class="row-main">
            <span class="row-title">${escapeHtml(p.market)} · ${sideName(p.side)}</span>
            <span class="row-sub num">Round ${p.roundId} · ${fmtMon(p.amount)} MON${p.entryMult && p.entryMult !== '—' ? ` at ${escapeHtml(p.entryMult)}×` : ''}</span>
          </div>
          <div class="row-end">${end}</div>
        </div>`;
    }).join('');
  }

  el.positionsList.addEventListener('click', async (e) => {
    const all = e.target.closest('[data-claim-all]');
    if (all) {
      all.disabled = true;
      const rounds = all.dataset.rounds.split(',').map(Number);
      const res = await web3.claimBatch(all.dataset.claimAll, rounds);
      if (!res.success) {
        all.disabled = false;
        return toast('Claim failed', res.error || 'Rejected in wallet', { error: true });
      }
      toast('Payouts sent', `${rounds.length} rounds in one transaction`, { link: `${getConfig().explorerUrl}/tx/${res.txHash}` });
      setTimeout(() => web3.fetchBalance(), 2500);
      return;
    }
    const btn = e.target.closest('[data-claim]');
    if (!btn) return;
    const pos = positionsList().find((p) => p.id === btn.dataset.claim);
    if (!pos) return;
    if (!web3.account) return toast('Wallet not connected', 'Connect your wallet to claim.', { error: true });
    btn.disabled = true;
    const res = await web3.claimPayout(pos.marketId, pos.roundId);
    if (!res.success) {
      btn.disabled = false;
      toast('Claim failed', res.error || 'Rejected in wallet', { error: true });
      return;
    }
    toast('Payout sent', 'It appears in your ledger once the transaction is in a block.', { link: `${getConfig().explorerUrl}/tx/${res.txHash}` });
    setTimeout(() => web3.fetchBalance(), 2500);
  });

  // Rounds with bets that ended on-chain, newest first
  function renderHistory() {
    const rounds = (chainHistory?.roundsList() || []).filter((r) => r.up + r.down > 0).slice(0, 60);
    if (!rounds.length) {
      el.historyList.innerHTML = '<div class="empty">No rounds with bets have ended on-chain yet.</div>';
      return;
    }
    el.historyList.innerHTML = rounds.map((r) => {
      const winner = r.status === 'settled' ? r.winningSide : null;
      const cls = winner === 'UP' ? 'up' : winner === 'DOWN' ? 'down' : 'neutral';
      const glyph = winner === 'UP' ? '▲' : winner === 'DOWN' ? '▼' : '◆';
      const outcome = winner === 'UP' ? 'Rise won' : winner === 'DOWN' ? 'Fall won' : 'Refunded';
      const prices = r.lockPrice && r.closePrice ? ` · ${r.lockPrice.toLocaleString('en-US')} → ${r.closePrice.toLocaleString('en-US')}` : '';
      return `
        <div class="row">
          <span class="row-glyph ${cls}">${glyph}</span>
          <div class="row-main">
            <span class="row-title">${escapeHtml(chainHistory.marketLabel(r.marketId))} · ${outcome}</span>
            <span class="row-sub num">Round ${r.roundId}${prices}</span>
          </div>
          <div class="row-end"><span class="row-amount num">${fmtMon(r.up + r.down)}</span></div>
        </div>`;
    }).join('');
  }

  function renderSessionStats() {
    const settled = positionsList().filter((p) => p.status === 'Won' || p.status === 'Lost');
    $('stat-settled').textContent = settled.length;
    if (!settled.length) {
      $('stat-winrate').textContent = '—';
      $('stat-net').textContent = '—';
      $('stat-streak').textContent = '—';
      return;
    }
    const wins = settled.filter((p) => p.status === 'Won').length;
    const net = settled.reduce((acc, p) => acc + ((p.status === 'Won' ? p.payout || 0 : 0) - p.amount), 0);
    let streak = 0;
    for (const p of settled) {
      if (p.status === 'Won') streak++;
      else break;
    }
    $('stat-winrate').textContent = `${((wins / settled.length) * 100).toFixed(0)}%`;
    $('stat-net').textContent = `${net >= 0 ? '+' : '−'}${fmtMon(Math.abs(net))} MON`;
    $('stat-streak').textContent = streak ? `${streak} win${streak === 1 ? '' : 's'}` : '—';
  }

  function renderLedger() {
    renderPositions();
    renderHistory();
    renderSessionStats();
  }

  // ---------------------------------------------------------------------------
  // Settlement moment
  // ---------------------------------------------------------------------------
  let resultTimer = null;
  function showResult({ marketKey, roundId, winner, lockPrice, closePrice, confirming = false }) {
    const m = amm.markets[marketKey];
    const mine = positionsList().filter((p) => p.marketKey === marketKey && p.roundId === roundId);
    const kind = winner === 'UP' ? 'up' : winner === 'DOWN' ? 'down' : 'neutral';

    el.resultTitle.textContent = winner === 'UP' ? 'Rise wins' : winner === 'DOWN' ? 'Fall wins' : winner === 'DRAW' ? 'Tie' : winner === 'REFUND' ? 'Round refunded' : 'One-sided round';
    if (mine.length) {
      // Outcome from the round's result and the position's side (the ledger may not have caught up yet)
      const outcome = (p) => (winner === 'UP' || winner === 'DOWN' ? (p.side === winner ? 'Won' : 'Lost') : 'Refunded');
      const won = mine.filter((p) => outcome(p) === 'Won').reduce((s, p) => s + (p.status === 'Won' && p.payout ? p.payout : 0), 0);
      const lost = mine.filter((p) => outcome(p) === 'Lost').reduce((s, p) => s + p.amount, 0);
      const refunded = mine.filter((p) => outcome(p) === 'Refunded').reduce((s, p) => s + p.amount, 0);
      const wonAny = mine.some((p) => outcome(p) === 'Won');
      if (won > 0) {
        el.resultSub.innerHTML = 'You won <span class="num" id="result-won">0.00</span> MON · claim it in the Ledger';
        countTo($('result-won'), won, 2, 1100);
      }
      else if (wonAny) el.resultSub.textContent = 'You won · claim it in the Ledger';
      else if (refunded > 0) el.resultSub.textContent = `${fmtMon(refunded)} MON refundable in the Ledger`;
      else el.resultSub.textContent = `You lost ${fmtMon(lost)} MON`;
    } else if (winner === 'UP' || winner === 'DOWN') {
      el.resultSub.textContent = `Closed ${fmtPrice(closePrice, m.decimals)} vs strike ${fmtPrice(lockPrice, m.decimals)}`;
    } else {
      el.resultSub.textContent = 'All stakes refunded';
    }

    // Read from RedStone's signed close report and verified here; the settle transaction follows
    el.resultState.textContent = confirming ? 'Official price, signed by RedStone · confirming on-chain…' : 'Settled on-chain';
    el.resultState.className = `result-state${confirming ? ' pending' : ''}`;

    // Restart the CSS animation
    el.result.className = `result ${kind}`;
    void el.result.offsetWidth;
    el.result.classList.remove('hidden');
    clearTimeout(resultTimer);
    // An early result stays up until the chain confirms it (at most 20 s)
    resultTimer = setTimeout(() => el.result.classList.add('hidden'), confirming ? 20000 : 3200);
    engine.flashSettlement(winner);
    const youWon = mine.some((p) => (winner === 'UP' || winner === 'DOWN') && p.side === winner);
    engine.celebrate(winner, youWon ? 1.4 : (winner === 'UP' || winner === 'DOWN') ? 0.6 : 0.3);
  }

  // ---------------------------------------------------------------------------
  // Market data
  // ---------------------------------------------------------------------------
  const amm = new MarketState({
    tick: ({ market, isActiveMarket, price, allMarkets, vol }) => {
      if (isActiveMarket) {
        bootStep('prices');
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
      el.roundId.textContent = '—';
      // Round fields belong to the previous market until the contract read for this one arrives
      Object.assign(market, { roundId: null, poolUp: 0, poolDown: 0, upBettors: 0, downBettors: 0, lockPrice: null });
      amm.feeBps = null;
      engine.reset(market.price, market.decimals);
      engine.store.load(SUPPORTED_MARKETS[key]);
      engine.setStrike(null);
      engine.setUserPositions([]);
      lastHeroPrice = null;
      paintReadout(market, market.price);
      paintOdds();
      paintPositionChip(market, market.price);
      paintRecent();
      liveRounds?.start(key);
    }
  });

  // ---------------------------------------------------------------------------
  // Trading
  // ---------------------------------------------------------------------------
  async function executeTrade(side) {
    const amount = parseFloat(el.stake.value) || 0;
    const m = amm.getActiveMarket();
    if (amount <= 0) return toast('Enter a stake', 'Choose how much MON to put on this round.', { error: true });
    if (!web3.account) {
      const res = await web3.connect();
      if (!res.success) return toast('Wallet not connected', res.error || 'Connect a wallet to bet.', { error: true });
    }
    const balance = currentBalance();
    if (balance !== null && amount > balance) return toast('Stake above balance', `You have ${fmtMon(balance)} MON available.`, { error: true });
    if (minBetMon !== null && amount < minBetMon) return toast('Stake below the minimum', `The contract's minimum bet is ${minBetMon} MON.`, { error: true });
    {
      const st = liveRounds?.state;
      if (!st || st.error) return toast('Round not loaded', st?.error || 'Reading the round from Monad…', { error: true });
      if (st.phase !== 'open' && st.phase !== 'idle') return toast('Bets are closed', 'Wait for the next round to open.', { error: true });
      // Slippage guard: revert if, by inclusion, the payout per MON fell more than 5% below what the
      // screen shows after this stake. Only meaningful once the other side has money in it.
      const opposing = side === 'UP' ? st.poolDown : st.poolUp;
      const minMultWad = opposing > 0 && st.phase === 'open'
        ? BigInt(Math.floor(postBetMultiplier(side, amount) * 0.95 * 1e6)) * 10n ** 12n
        : 0n;
      const txRes = await web3.sendTradeTransaction(side, st.marketId, st.roundId, amount, minMultWad);
      if (!txRes.success) return toast('Bet not sent', txRes.error || 'Rejected in wallet', { error: true });
      const btn = side === 'UP' ? el.betUp : el.betDown;
      const r = btn.getBoundingClientRect();
      engine.emitBet(side, r.left + r.width / 2, r.top + r.height / 3, amount);
      setTimeout(() => { liveRounds?.sync(); web3.fetchBalance(); }, 2000);
    }
  }

  el.betUp.addEventListener('click', () => executeTrade('UP'));
  el.betDown.addEventListener('click', () => executeTrade('DOWN'));

  el.stake.addEventListener('input', paintOdds);
  document.querySelectorAll('.chip[data-add]').forEach((chip) => {
    chip.addEventListener('click', () => {
      el.stake.value = (parseFloat(el.stake.value) || 0) + parseFloat(chip.dataset.add);
      paintOdds();
    });
  });
  $('stake-max').addEventListener('click', () => {
    const balance = currentBalance();
    if (balance === null) return toast('Connect a wallet', 'Max uses your wallet balance.', { error: true });
    // Leave room for the network fee
    el.stake.value = Math.max(0, Math.floor((balance - 0.05) * 100) / 100);
    paintOdds();
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
    if (item.you) return `You · ${item.market}`;
    if (item.user) return `${item.user} · ${item.market}`;
    return `${plural(item.winners || 0, 'winner')} · ${item.market}`;
  }

  function renderPulse({ ready, paid, rounds, topMult, feed }) {
    const big = $('pulse-paid');
    if (!ready || paid === null) {
      big.textContent = '—';
      return;
    }
    const prev = parseFloat(big.dataset.value || '0');
    if (paid !== prev || big.textContent === '—') {
      countTo(big, paid, paid >= 10000 ? 0 : 2, 1400);
      if (paid > prev) {
        big.classList.remove('bump');
        void big.offsetWidth;
        big.classList.add('bump');
      }
    }
    $('pulse-rounds').textContent = rounds.toLocaleString('en-US');
    $('pulse-top').textContent = topMult > 0 ? `${topMult.toFixed(2)}×` : '—';

    const list = $('pulse-feed');
    if (!feed.length) {
      list.innerHTML = '<li class="empty-feed">No wins claimed yet.</li>';
    } else {
      list.innerHTML = feed.slice(0, 4).map((item) => {
        const isNew = !seenFeedKeys.has(item.key);
        seenFeedKeys.add(item.key);
        const side = item.side === 'UP' ? 'up' : item.side === 'DOWN' ? 'down' : '';
        return `
          <li class="feed-item ${side}${item.you ? ' you' : ''}${isNew ? ' new' : ''}">
            <span class="feed-glyph">${item.side === 'UP' ? '▲' : item.side === 'DOWN' ? '▼' : '◆'}</span>
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
    ticker.innerHTML = `<span class="${side}">${item.side === 'UP' ? '▲' : item.side === 'DOWN' ? '▼' : '◆'}</span> ${escapeHtml(who)} won ${fmtMon(item.amount)} MON on ${escapeHtml(item.market)}`;
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
  history.onChange(() => {
    paintRecent();
    renderLedgerIfChanged();
  });

  // ---------------------------------------------------------------------------
  // Live mode: everything below is read from the contract
  // ---------------------------------------------------------------------------
  let ledgerSignature = '';
  function renderLedgerIfChanged() {
    const sig = JSON.stringify(positionsList().map((p) => [p.id, p.status, p.claimed, p.amount, p.payout]))
      + (chainHistory?.roundsList().length || 0);
    if (sig === ledgerSignature) return;
    ledgerSignature = sig;
    renderLedger();
  }

  const BET_CUTOFF_GUARD_S = 8;
  const LIVE_PHASES = {
    open: { label: 'Betting open', verb: 'closes in', bets: true },
    idle: { label: 'Ready', verb: '', bets: true },
    closed: { label: 'Bets closed', verb: 'strike in', bets: false },
    locked: { label: 'Strike locked', verb: 'settles in', bets: false },
    settling: { label: 'Settling', verb: 'waiting for the keeper', bets: false },
    confirming: { label: 'Confirming price', verb: 'final in', bets: false },
    expired: { label: 'Refundable', verb: 'unresolved in time, stakes refundable', bets: false },
    ended: { label: 'Round ended', verb: '', bets: false }
  };

  function applyLive(st) {
    if (!st) return;
    const m = amm.getActiveMarket();
    if (st.error && st.roundId === undefined) {
      el.phaseLabel.textContent = 'Contract unreachable';
      el.phaseTime.textContent = st.error;
      el.betUp.disabled = true;
      el.betDown.disabled = true;
      return;
    }
    if (st.marketKey !== amm.activeMarketKey) return;
    bootStep('network');
    bootStep('round');
    const roundChanged = m.roundId !== st.roundId;
    m.roundId = st.roundId;
    m.poolUp = st.poolUp;
    m.poolDown = st.poolDown;
    m.upBettors = st.upBettors ?? 0;
    m.downBettors = st.downBettors ?? 0;
    m.lockPrice = st.lockPrice;
    if (st.feeBps) amm.feeBps = st.feeBps;
    el.roundId.textContent = st.roundId;

    const ph = LIVE_PHASES[st.phase];
    const now = Date.now();
    const until = st.phase === 'open' ? st.betCloseAt : st.phase === 'closed' ? st.lockAt : st.phase === 'locked' ? st.closeAt : st.phase === 'confirming' ? st.finalizeAt : null;
    const left = until ? Math.max(0, (until - now) / 1000) : null;
    el.console.classList.toggle('locked', !ph.bets);
    el.console.classList.toggle('closing', st.phase === 'open' && left <= 5);
    // No bets in the last 8 s: confirming in a wallet takes seconds, and a bet that lands after the
    // cutoff reverts and still pays the network fee
    const canBet = ph.bets && !(st.phase === 'open' && left !== null && left <= BET_CUTOFF_GUARD_S);
    el.betUp.disabled = !canBet;
    el.betDown.disabled = !canBet;
    el.phaseLabel.textContent = st.phase === 'open' && left <= 5 ? 'Closing' : ph.label;
    const preview = st.phase === 'idle' ? projectedRound(m.roundDuration, now) : null;
    el.phaseTime.innerHTML = st.phase === 'idle'
      ? (preview
        ? `<span class="phase-verb">bet now · strike </span>${fmtClock((preview.lockAt - now) / 1000)}<span class="phase-verb"> · result </span>${fmtClock((preview.closeAt - now) / 1000)}`
        : '<span class="phase-verb">your bet opens a new round</span>')
      : `<span class="phase-verb">${ph.verb} </span>${left === null ? '' : fmtClock(left)}`;
    const span = st.phase === 'open' ? (st.betCloseAt - (st.lockAt - m.roundDuration * 1000)) / 1000 : m.roundDuration;
    el.ringFill.style.strokeDashoffset = `${RING_LENGTH * (1 - (left === null ? 0 : Math.min(1, left / Math.max(1, span))))}`;

    engine.setLiveRound({ ...st, duration: m.roundDuration });
    if ((st.lockPrice || null) !== engine.strike) engine.setStrike(st.lockPrice);
    if (roundChanged) engine.setUserPositions([]);
    paintReadout(m, m.price);
    paintOdds();
    paintPositionChip(m, m.price);
    renderLedgerIfChanged();
  }

  // The countdown and phase move with the local clock between contract events (no network requests)
  setInterval(() => {
    liveRounds?.tick();
    if (liveRounds?.state) applyLive(liveRounds.state);
  }, 500);

  history.onGas((wei) => {
    gasPriceWei = wei;
    if (liveRounds?.state) applyLive(liveRounds.state);
  });

  liveRounds = new LiveRounds({
    web3,
    history,
    onUpdate: applyLive,
    onRoundConfirmed: ({ matches, ...data }) => {
      if (!matches) {
        // Never expected (same signed data), but the chain decides: show its result
        showResult(data);
        el.resultState.textContent = 'Settled on-chain (differs from the early reading)';
        return;
      }
      el.resultState.textContent = 'Settled on-chain ✓';
      el.resultState.className = 'result-state';
      clearTimeout(resultTimer);
      resultTimer = setTimeout(() => el.result.classList.add('hidden'), 2500);
    },
    onRoundEnd: (data) => {
      showResult(data);
      paintRecent();
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
  loadProtocolParameters();
  history.start();
  pulse.refresh();
  amm.emit('marketChanged', amm.getActiveMarket());
  renderLedger();
  updateSafeArea();
  engine.start();

  // Installable app: the service worker is registered for production builds only, so development
  // always runs fresh code
  if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('Service worker not registered:', err));
  }
}
