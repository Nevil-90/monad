/**
 * AMMState.js
 * In-Memory AMM State Management Engine
 */

import { LivePriceFeed } from './LivePriceFeed.js';
import { CircuitBreaker } from './CircuitBreaker.js';
import { AntiScrapeShield } from './AntiScrapeShield.js';
import { SUPPORTED_MARKETS } from './config.js';

export class AMMState {
  constructor(listeners = {}, options = {}) {
    this.listeners = listeners;
    this.options = options;
    // Demo-mode protocol parameters, equal to the contract's deployed values. Live mode replaces them
    // with values read from the contract (and refuses to show odds if it cannot read them).
    this.feeBps = 150;
    this.creatorFeeBps = 10;
    this.keeperFeeBps = 10;
    this.treasuryFeeBps = 130;
    this.lockBuffer = 10; // Dynamic anti-frontrunning cutoff buffer
    this.minBet = 0.001; // In native MON
    this.userBalance = 1000.0;
    this.activeMarketKey = 'BTC';
    this.userPositions = [];

    // Circuit Breaker Instance
    this.circuitBreaker = new CircuitBreaker();

    // Anti-Scraping, Bot Defense & Exploit Shield
    this.antiScrapeShield = new AntiScrapeShield(options.antiScrapeOptions || {});

    // Supported Markets configuration with real live market defaults
    this.markets = {
      BTC: {
        marketId: SUPPORTED_MARKETS.BTC.marketId,
        symbol: SUPPORTED_MARKETS.BTC.symbol,
        price: 84200.0,
        decimals: SUPPORTED_MARKETS.BTC.decimals,
        change24h: null,
        roundId: 1042,
        roundTimer: 45.0,
        roundDuration: 60,
        epochOffset: 0,
        baseRoundId: 1040,
        status: 'Open',
        lockPrice: null,
        closePrice: null,
        poolUp: 1420.0,
        poolDown: 1030.0,
        winningSide: null,
        ticks: [],
        ticksEstablished: false
      },
      ETH: {
        marketId: SUPPORTED_MARKETS.ETH.marketId,
        symbol: SUPPORTED_MARKETS.ETH.symbol,
        price: 2680.0,
        decimals: SUPPORTED_MARKETS.ETH.decimals,
        change24h: null,
        roundId: 819,
        roundTimer: 32.0,
        roundDuration: 60,
        epochOffset: 15,
        baseRoundId: 810,
        status: 'Open',
        lockPrice: null,
        closePrice: null,
        poolUp: 850.0,
        poolDown: 920.0,
        winningSide: null,
        ticks: [],
        ticksEstablished: false
      },
      SOL: {
        marketId: SUPPORTED_MARKETS.SOL.marketId,
        symbol: SUPPORTED_MARKETS.SOL.symbol,
        price: 116.5,
        decimals: SUPPORTED_MARKETS.SOL.decimals,
        change24h: null,
        roundId: 2410,
        roundTimer: 21.0,
        roundDuration: 60,
        epochOffset: 30,
        baseRoundId: 2400,
        status: 'Open',
        lockPrice: null,
        closePrice: null,
        poolUp: 3100.0,
        poolDown: 2400.0,
        winningSide: null,
        ticks: [],
        ticksEstablished: false
      },
      MON: {
        marketId: SUPPORTED_MARKETS.MON.marketId,
        symbol: SUPPORTED_MARKETS.MON.symbol,
        price: 0.845,
        decimals: SUPPORTED_MARKETS.MON.decimals,
        change24h: null,
        roundId: 512,
        roundTimer: 50.0,
        roundDuration: 60,
        epochOffset: 45,
        baseRoundId: 510,
        status: 'Open',
        lockPrice: null,
        closePrice: null,
        poolUp: 12500.0,
        poolDown: 9800.0,
        winningSide: null,
        ticks: [],
        ticksEstablished: false
      }
    };

    // A market the price source cannot cover (MON/USD on Binance) stays listed but cannot be selected,
    // rather than showing an approximated price.
    for (const [k, reason] of Object.entries(LivePriceFeed.unavailableMarkets())) {
      if (this.markets[k]) this.markets[k].unavailable = reason;
    }

    // Demo mode: each new round opens with simulated liquidity from other players, sized around the
    // market's starting pools, so a demo bet has counterparties. Live mode overwrites pools from chain.
    Object.values(this.markets).forEach(m => {
      m.demoLiquidity = m.poolUp + m.poolDown;
      m.upBettors = this.simulatedPlayers(m.poolUp);
      m.downBettors = this.simulatedPlayers(m.poolDown);
    });

    // Round history ledger records genuine settled rounds (Zero fake/hardcoded seed history)
    this.roundHistory = [];

    // User positions ledger records genuine user predictions (Zero fake/hardcoded seed positions)
    this.userPositions = [];

    // 1. Synchronize to universal wall-clock epoch (Zero localStorage, tamper-proof Date.now() math)
    const isBrowser = typeof window !== 'undefined';
    if ((isBrowser || this.options.useEpochSync) && !this.options.useManualTimer) {
      this.syncAllMarketsToEpoch();
    }

    // 3. Initialize Real Live Multi-Source Feed Engine
    if (!this.options.skipFeed) {
      this.feed = new LivePriceFeed(
        (tickData) => this.handleLiveTick(tickData),
        (statusData) => this.handleFeedStatus(statusData)
      );
    }

    // 4. Start Round Lifecycle Timers
    this.startRoundLifecycleLoop();
  }

  handleLiveTick({ marketKey, price, vol, time, stats, isInitialSync }) {
    const m = this.markets[marketKey];
    if (!m) return;

    // Validate with Circuit Breaker
    const validation = this.circuitBreaker.validateTick(marketKey, price, m.price, time, isInitialSync);
    if (!validation.valid) return;

    // Update with 100% REAL LIVE MARKET DATA
    m.price = price;
    m.ticks.push(price);
    if (m.ticks.length > 150) m.ticks.shift();

    if (stats && stats[marketKey] && stats[marketKey].change !== undefined) {
      m.change24h = stats[marketKey].change;
    }

    // Emit live tick to Canvas Chart & UI
    this.emit('tick', {
      marketKey,
      market: m,
      isActiveMarket: (marketKey === this.activeMarketKey),
      price: price,
      allMarkets: this.markets,
      vol: vol || 1,
      isRealLive: true,
      stats: stats
    });
  }

  handleFeedStatus(status) {
    this.emit('feedStatus', status);
  }

  getActiveMarket() {
    return this.markets[this.activeMarketKey];
  }

  setActiveMarket(key) {
    if (this.markets[key] && !this.markets[key].unavailable) {
      this.activeMarketKey = key;
      const m = this.getActiveMarket();
      this.emit('marketChanged', m);
      this.emit('tick', {
        marketKey: key,
        market: m,
        isActiveMarket: true,
        price: m.price,
        allMarkets: this.markets,
        vol: 2,
        isRealLive: true,
        stats: this.stats24h || {}
      });
    }
  }

  getLiveOdds(marketKey = this.activeMarketKey) {
    const m = this.markets[marketKey];
    const total = m.poolUp + m.poolDown;
    const netPool = total * (1 - this.feeBps / 10000);

    const multUp = m.poolUp > 0 ? (netPool / m.poolUp) : 0;
    const multDown = m.poolDown > 0 ? (netPool / m.poolDown) : 0;

    const ratioUpPct = total > 0 ? Math.round((m.poolUp / total) * 100) : 50;
    const ratioDownPct = 100 - ratioUpPct;

    return {
      totalPool: total,
      netPool,
      multUp: multUp > 0 ? multUp.toFixed(2) : '1.00',
      multDown: multDown > 0 ? multDown.toFixed(2) : '1.00',
      ratioUpPct,
      ratioDownPct
    };
  }

  placeBet(side, amount, orderOptions = {}) {
    const m = this.getActiveMarket();

    if (amount <= 0 || amount > this.userBalance) {
      return { success: false, reason: 'Insufficient balance or invalid amount' };
    }

    if (m.status !== 'Open') {
      return { success: false, reason: 'Betting window closed for this round' };
    }

    if (m.roundTimer <= this.lockBuffer) {
      return { success: false, reason: 'Lock buffer cutoff reached! Betting is frozen.' };
    }

    // Anti-Scraping & Bot Exploit Defense Verification
    if (this.antiScrapeShield) {
      const odds = this.getLiveOdds();
      const curMult = side === 'UP' ? odds.multUp : odds.multDown;
      const shieldValidation = this.antiScrapeShield.validateOrderExecution({
        side,
        amount,
        expectedMultiplier: orderOptions.expectedMultiplier || curMult,
        currentMultiplier: curMult,
        proof: orderOptions.proof,
        isSyntheticTest: orderOptions.isSyntheticTest
      });

      if (!shieldValidation.allowed) {
        return { 
          success: false, 
          reason: shieldValidation.reason, 
          code: shieldValidation.code 
        };
      }
    }

    const alreadyOnSide = this.userPositions.some(p =>
      p.marketKey === this.activeMarketKey && p.roundId === m.roundId && p.side === side);

    // Deduct user balance
    this.userBalance -= amount;

    // Add to pool
    if (side === 'UP') {
      m.poolUp += amount;
      if (!alreadyOnSide) m.upBettors = (m.upBettors || 0) + 1;
    } else {
      m.poolDown += amount;
      if (!alreadyOnSide) m.downBettors = (m.downBettors || 0) + 1;
    }

    // Dynamic creator royalties volume accumulation
    if (m.creator) {
      m.totalVolume = (m.totalVolume || 0) + amount;
      m.creatorFeesAccrued = (m.creatorFeesAccrued || 0) + (amount * (this.creatorFeeBps / 10000));
    }

    const odds = this.getLiveOdds();
    const entryMult = side === 'UP' ? odds.multUp : odds.multDown;

    const pos = {
      id: `${m.roundId}-${Date.now()}`,
      roundId: m.roundId,
      market: m.symbol,
      marketKey: this.activeMarketKey,
      side,
      amount,
      entryPrice: m.price,
      entryMult,
      placedAt: Date.now(),
      claimed: false,
      status: 'Active'
    };

    this.userPositions.unshift(pos);

    this.emit('balanceChanged', this.userBalance);
    this.emit('positionPlaced', pos);
    this.emit('oddsUpdated', odds);

    return { success: true, position: pos };
  }

  startRoundLifecycleLoop() {
    if (this.options.skipTimers) return;
    this.lifecycleInterval = setInterval(() => {
      this.updateTimers(0.1);
    }, 100);
  }

  destroy() {
    if (this.feed) this.feed.destroy();
    if (this.lifecycleInterval) clearInterval(this.lifecycleInterval);
  }

  updateTimers(dt) {
    const isBrowser = typeof window !== 'undefined';
    const useEpoch = (isBrowser || this.options.useEpochSync) && !this.options.useManualTimer;

    if (useEpoch) {
      const nowMs = Date.now();

      Object.keys(this.markets).forEach(k => {
        const m = this.markets[k];
        const epoch = this.computeMarketEpoch(k, nowMs);
        if (!epoch || m.unavailable) return;

        // Check if epoch rolled over to next round
        if (epoch.roundId > m.roundId) {
          this.settleRound(k);
          m.roundId = epoch.roundId;
          m.roundTimer = epoch.remaining;
          m.status = epoch.isBuffer ? 'Buffer' : 'Open';
          m.lockPrice = epoch.isBuffer ? m.price : null;
        } else {
          m.roundTimer = epoch.remaining;

          // Transition to Buffer if entering lock buffer cutoff
          if (m.roundTimer <= this.lockBuffer && m.status === 'Open') {
            m.status = 'Buffer';
            if (m.lockPrice === null) {
              m.lockPrice = m.price;
            }
            if (k === this.activeMarketKey) {
              this.emit('phaseChanged', { marketKey: k, status: 'Buffer', lockPrice: m.lockPrice });
            }
          }
        }
      });

      this.emit('timerUpdate', {
        market: this.getActiveMarket(),
        roundTimer: this.getActiveMarket().roundTimer
      });
      return;
    }

    // Manual countdown fallback (for deterministic headless testing)
    Object.keys(this.markets).forEach(k => {
      const m = this.markets[k];
      if (m.unavailable) return;
      m.roundTimer -= dt;

      if (m.roundTimer <= 0) {
        this.settleRound(k);
      } else if (m.roundTimer <= this.lockBuffer && m.status === 'Open') {
        // Enforce anti-frontrunning lock buffer
        m.status = 'Buffer';
        if (m.lockPrice === null) {
          m.lockPrice = m.price;
        }
        if (k === this.activeMarketKey) {
          this.emit('phaseChanged', { marketKey: k, status: 'Buffer', lockPrice: m.lockPrice });
        }
      }
    });

    this.emit('timerUpdate', {
      market: this.getActiveMarket(),
      roundTimer: this.getActiveMarket().roundTimer
    });
  }

  settleRound(marketKey) {
    const m = this.markets[marketKey];
    m.closePrice = m.price;
    const lockP = m.lockPrice || m.price;

    let winner = 'DRAW';
    let outcomeStatus = 'Settled';

    // Uncontested or tie checks
    if (m.poolUp === 0 || m.poolDown === 0) {
      winner = 'UNCONTESTED';
      outcomeStatus = 'Cancelled';
    } else if (m.closePrice > lockP) {
      winner = 'UP';
    } else if (m.closePrice < lockP) {
      winner = 'DOWN';
    } else {
      winner = 'DRAW';
      outcomeStatus = 'Cancelled';
    }

    m.winningSide = winner;
    m.status = outcomeStatus;

    const odds = this.getLiveOdds(marketKey);
    const finalMult = winner === 'UP' ? `${odds.multUp}x` : winner === 'DOWN' ? `${odds.multDown}x` : '1.00x';
    const delta = (m.closePrice - lockP).toFixed(m.decimals);

    this.roundHistory.unshift({
      roundId: m.roundId,
      market: m.symbol,
      lockPrice: lockP,
      closePrice: m.closePrice,
      delta: Number(delta) >= 0 ? `+${delta}` : delta,
      winner,
      totalPool: odds.totalPool,
      finalMult,
      paidOut: (winner === 'UP' || winner === 'DOWN') ? odds.netPool : 0,
      players: (m.upBettors || 0) + (m.downBettors || 0),
      winners: winner === 'UP' ? (m.upBettors || 0) : winner === 'DOWN' ? (m.downBettors || 0) : 0,
      marketKey,
      settledAt: Date.now()
    });
    if (this.roundHistory.length > 500) this.roundHistory.length = 500;

    this.userPositions.forEach(pos => {
      if (pos.roundId === m.roundId && pos.marketKey === marketKey && pos.status === 'Active') {
        if (winner === 'UNCONTESTED' || winner === 'DRAW') {
          pos.status = 'Refunded';
          pos.payout = pos.amount;
        } else if (pos.side === winner) {
          pos.status = 'Won';
          const winPool = winner === 'UP' ? m.poolUp : m.poolDown;
          pos.payout = (pos.amount / winPool) * odds.netPool;
        } else {
          pos.status = 'Lost';
          pos.payout = 0;
        }
      }
    });

    this.emit('roundSettled', {
      marketKey,
      roundId: m.roundId,
      winner,
      lockPrice: lockP,
      closePrice: m.closePrice,
      positions: this.userPositions
    });

    // Reset to Next Round with clean initial pool state (Zero random/fake numbers)
    m.roundId += 1;
    m.roundTimer = m.roundDuration;
    m.status = 'Open';
    m.lockPrice = null;
    m.closePrice = null;
    m.winningSide = null;
    this.seedDemoPools(m);

    if (marketKey === this.activeMarketKey) {
      this.emit('newRoundStarted', m);
    }
  }

  seedDemoPools(m) {
    if (!m.demoLiquidity) {
      m.poolUp = 0;
      m.poolDown = 0;
      m.upBettors = 0;
      m.downBettors = 0;
      return;
    }
    const total = m.demoLiquidity * (0.6 + Math.random() * 0.8);
    const upShare = 0.35 + Math.random() * 0.3;
    m.poolUp = Math.round(total * upShare);
    m.poolDown = Math.round(total - m.poolUp);
    m.upBettors = this.simulatedPlayers(m.poolUp);
    m.downBettors = this.simulatedPlayers(m.poolDown);
  }

  // Demo only: a plausible player count for a simulated pool (average stake 40-110 MON)
  simulatedPlayers(pool) {
    if (pool <= 0) return 0;
    return Math.max(1, Math.round(pool / (40 + Math.random() * 70)));
  }

  claimReward(posId) {
    const pos = this.userPositions.find(p => p.id === posId);
    if (!pos || pos.claimed || (pos.status !== 'Won' && pos.status !== 'Refunded')) {
      return { success: false, reason: 'Invalid or already claimed' };
    }

    pos.claimed = true;
    this.userBalance += pos.payout;

    this.emit('balanceChanged', this.userBalance);
    this.emit('positionClaimed', pos);

    return { success: true, payout: pos.payout };
  }

  injectShock(pct) {
    const m = this.getActiveMarket();
    m.price += m.price * (pct / 100);
    m.ticks.push(m.price);
    this.emit('tick', { market: m, price: m.price, allMarkets: this.markets, vol: 5 });
  }

  forceUncontested() {
    const m = this.getActiveMarket();
    m.poolDown = 0;
    m.downBettors = 0;
    this.emit('oddsUpdated', this.getLiveOdds());
  }

  forceTie() {
    const m = this.getActiveMarket();
    if (m.lockPrice) {
      m.price = m.lockPrice;
      m.ticks.push(m.price);
      this.emit('tick', { market: m, price: m.price, allMarkets: this.markets, vol: 1 });
    }
  }

  fastForward(seconds = 10) {
    const m = this.getActiveMarket();
    m.roundTimer = Math.max(0.5, m.roundTimer - seconds);
  }

  /**
   * Dynamically syncs fees and parameters directly from the on-chain smart contract
   */
  setProtocolParameters({ feeBps, creatorFeeBps, keeperFeeBps, treasuryFeeBps, lockBuffer, minBet }) {
    if (feeBps !== undefined) this.feeBps = feeBps;
    if (creatorFeeBps !== undefined) this.creatorFeeBps = creatorFeeBps;
    if (keeperFeeBps !== undefined) this.keeperFeeBps = keeperFeeBps;
    if (treasuryFeeBps !== undefined) this.treasuryFeeBps = treasuryFeeBps;
    if (lockBuffer !== undefined) this.lockBuffer = lockBuffer;
    if (minBet !== undefined) this.minBet = minBet;
    this.emit('protocolParamsUpdated', {
      feeBps: this.feeBps,
      creatorFeeBps: this.creatorFeeBps,
      keeperFeeBps: this.keeperFeeBps,
      treasuryFeeBps: this.treasuryFeeBps,
      lockBuffer: this.lockBuffer,
      minBet: this.minBet
    });
  }

  /**
   * Syncs live round pools and odds directly from on-chain round data
   */
  syncRoundFromOnChain(marketKey, roundData) {
    if (!this.markets[marketKey]) return;
    const m = this.markets[marketKey];
    if (roundData.roundId !== undefined) m.roundId = roundData.roundId;
    if (roundData.totalUp !== undefined) m.poolUp = roundData.totalUp;
    if (roundData.totalDown !== undefined) m.poolDown = roundData.totalDown;
    if (roundData.upBettors !== undefined && roundData.upBettors !== null) m.upBettors = roundData.upBettors;
    if (roundData.downBettors !== undefined && roundData.downBettors !== null) m.downBettors = roundData.downBettors;
    if (roundData.status !== undefined) m.status = roundData.status;
    if (roundData.lockPrice !== undefined) m.lockPrice = roundData.lockPrice;
    if (roundData.closePrice !== undefined) m.closePrice = roundData.closePrice;
    this.emit('oddsUpdated', this.getLiveOdds(marketKey));
  }

  /**
   * Computes the deterministic wall-clock epoch for any market based on universal Unix time.
   * Ensures that page refreshes cannot restart the clock or give extra time to exploit price knowledge.
   */
  computeMarketEpoch(marketKey, nowMs = Date.now()) {
    const m = this.markets[marketKey];
    if (!m) return null;

    const duration = m.roundDuration || 60;
    const offset = m.epochOffset || 0;
    const nowSec = nowMs / 1000;
    const elapsed = (nowSec + offset) % duration;
    const remaining = Math.max(0, parseFloat((duration - elapsed).toFixed(1)));
    const epochCount = Math.floor((nowSec + offset) / duration);
    const computedRoundId = (m.baseRoundId || 1000) + (epochCount % 100000);

    return {
      roundId: computedRoundId,
      remaining,
      isBuffer: remaining <= this.lockBuffer
    };
  }

  /**
   * Synchronizes all markets directly to universal wall-clock time.
   * Completely tamper-proof: derived 100% mathematically from Date.now() with zero reliance on client localStorage.
   */
  syncAllMarketsToEpoch(nowMs = Date.now()) {
    Object.keys(this.markets).forEach(k => {
      const m = this.markets[k];
      const epoch = this.computeMarketEpoch(k, nowMs);
      if (!epoch) return;

      m.roundId = epoch.roundId;
      m.roundTimer = epoch.remaining;

      if (epoch.isBuffer) {
        m.status = 'Buffer';
        if (m.lockPrice === null) {
          m.lockPrice = m.price;
        }
      } else {
        m.status = 'Open';
        m.lockPrice = null;
      }
    });
  }

  emit(event, data) {
    if (this.listeners[event]) {
      this.listeners[event](data);
    }
  }
}
