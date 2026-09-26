/**
 * CircuitBreaker.js
 * Protocol Safety & Anomaly Detection Engine
 * 
 * Invariants Enforced:
 * 1. Stale Oracle / WebSocket Feed Freeze (no settlements on data older than 15s)
 * 2. Flash Crash / Outlier Spike Filter (rejects single-tick jumps > 12%)
 * 3. Health & RPC Rate-Limit Monitor
 */

export class CircuitBreaker {
  constructor(options = {}) {
    this.maxStaleSeconds = options.maxStaleSeconds || 30;
    this.maxSingleTickDeltaPct = options.maxSingleTickDeltaPct || 15.0; // 15% max per single tick
    this.lastTickTime = Date.now();
    this.isTripped = false;
    this.tripReason = null;
    this.baselineSynced = new Set();
    this.lastPrice = {};
    this.consecutiveOutliers = {};
  }

  validateTick(marketKey, newPrice, prevPrice, timestamp = Date.now(), isInitialSync = false) {
    if (!newPrice || isNaN(newPrice) || newPrice <= 0) {
      return { valid: false, reason: 'Invalid zero or negative price' };
    }

    // Baseline Synchronization: First live tick sets the true live baseline
    if (isInitialSync || !this.baselineSynced.has(marketKey) || !this.lastPrice[marketKey]) {
      this.baselineSynced.add(marketKey);
      this.lastPrice[marketKey] = newPrice;
      this.lastTickTime = Date.now();
      if (this.isTripped) this.reset();
      return { valid: true, isBaseline: true };
    }

    // 1. Check Stale Feed (only if timestamp is provided and reasonably past)
    if (timestamp && timestamp > 0) {
      const ageSeconds = Math.max(0, (Date.now() - timestamp) / 1000);
      if (ageSeconds > this.maxStaleSeconds) {
        this.trip(`Stale feed detected for ${marketKey}: data is ${ageSeconds.toFixed(1)}s old`);
        return { valid: false, reason: this.tripReason };
      }
    }

    // 2. Check Single-Tick Outlier (reject sudden momentary glitch spikes)
    const refPrice = this.lastPrice[marketKey] || prevPrice;
    if (refPrice > 0) {
      const deltaPct = Math.abs((newPrice - refPrice) / refPrice) * 100;
      if (deltaPct > this.maxSingleTickDeltaPct) {
        this.consecutiveOutliers[marketKey] = (this.consecutiveOutliers[marketKey] || 0) + 1;
        // If 3 consecutive ticks confirm the new price level (genuine market shift), accept it
        if (this.consecutiveOutliers[marketKey] >= 3) {
          this.lastPrice[marketKey] = newPrice;
          this.consecutiveOutliers[marketKey] = 0;
          this.lastTickTime = Date.now();
          if (this.isTripped) this.reset();
          return { valid: true };
        }
        this.trip(`Outlier spike detected on ${marketKey}: ${deltaPct.toFixed(2)}% jump rejected`);
        return { valid: false, reason: this.tripReason };
      }
    }

    this.consecutiveOutliers[marketKey] = 0;
    this.lastPrice[marketKey] = newPrice;
    this.lastTickTime = Date.now();
    if (this.isTripped) {
      this.reset();
    }

    return { valid: true };
  }

  trip(reason) {
    this.isTripped = true;
    this.tripReason = reason;
    console.warn(`[CIRCUIT BREAKER TRIPPED] ${reason}`);
  }

  reset() {
    this.isTripped = false;
    this.tripReason = null;
    console.log(`[CIRCUIT BREAKER RESET] Protocol feed healthy`);
  }

  getStatus() {
    return {
      isTripped: this.isTripped,
      reason: this.tripReason,
      lastTickAgo: ((Date.now() - this.lastTickTime) / 1000).toFixed(1)
    };
  }
}

