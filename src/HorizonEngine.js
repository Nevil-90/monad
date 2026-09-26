/**
 * HorizonEngine.js
 * Full-screen canvas renderer for the Horizon interface.
 *
 * The strike price is a horizon line. Above it is the Rise side (sun), below it the Fall side (tide).
 * The live price is a comet whose trail is the recent price path. Two gates ahead of the comet show
 * when betting closes and when the round settles. Pool sizes set how much light each side emits:
 * an aurora in the sky for Rise, caustics in the sea for Fall. Bets fly into the comet as light,
 * new money ripples along the horizon, and settlement releases embers (Rise) or bubbles (Fall).
 *
 * Line and candle views share one frame: the same horizon scale, % levels, price axis, time axis,
 * volume strip, gates, crosshair and zoom (5s / 15s / 1m). Only the price series differs.
 */

import { PriceStore } from './PriceStore.js';

const FONT = '"JetBrains Mono", ui-monospace, monospace';
const TIME_STEPS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];

const COLORS = {
  night: '#06050b',
  ink: [238, 234, 246],
  sun: [255, 178, 63],
  sunHi: [255, 224, 163],
  tide: [63, 208, 230],
  tideHi: [179, 243, 251],
  horizon: [246, 243, 255]
};

const rgba = ([r, g, b], a) => `rgba(${r},${g},${b},${a})`;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;

export class HorizonEngine {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = 1;
    this.width = 0;
    this.height = 0;

    this.ticks = [];            // { t, p }
    this.decimals = 2;
    this.strike = null;         // locked strike price, or null while betting is open
    this.anchor = null;         // smoothed live price used as a floating horizon before lock
    this.displayPrice = null;   // smoothed comet price
    this.scale = null;          // px per price unit (smoothed)

    this.round = { remaining: 60, duration: 60, lockBuffer: 10, phase: 'open', syncedAt: performance.now() };
    this.pools = { up: 0, down: 0 };
    this.positions = [];
    this.flash = null;          // { winner, start }
    this.safeArea = { top: 0.22, bottom: 0.78 };

    this.reducedMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.particles = [];
    this.sparks = [];           // comet sparks and settlement showers
    this.bursts = [];           // bet light travelling from the console into the comet
    this.ripples = [];          // money entering a pool
    this.head = null;           // last comet head position { x, y }
    this.pointer = { x: 0.5, y: 0.5 };
    this.chartMode = 'line';    // 'line' | 'candles'
    this.tf = 5;                // zoom: seconds per candle / per 10px
    this.store = new PriceStore();
    this.pointerPx = null;
    this.parallax = { x: 0, y: 0 };
    this.running = false;
    window.addEventListener('pointermove', (e) => {
      this.pointer = { x: e.clientX / Math.max(1, this.width), y: e.clientY / Math.max(1, this.height) };
      this.pointerPx = { x: e.clientX, y: e.clientY };
    });
    document.addEventListener('pointerleave', () => { this.pointerPx = null; });
    window.addEventListener('blur', () => { this.pointerPx = null; });
    this.lastFrame = performance.now();

    this.resize = this.resize.bind(this);
    window.addEventListener('resize', this.resize);
    this.resize();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Switch to a market. `price` is its last real price, or null if none has arrived yet. Nothing is
   * drawn until there is a real price and the price history has finished loading (see render), so a
   * refresh never shows a guessed price or an animated rescale.
   */
  reset(price, decimals = 2) {
    this.decimals = decimals;
    this.ticks = Number.isFinite(price) && price > 0 ? [{ t: Date.now(), p: price }] : [];
    this.displayPrice = this.ticks.length ? price : null;
    this.anchor = this.displayPrice;
    this.scale = null;
    this.flash = null;
    this.ready = false;
  }

  pushTick(price, vol = 0) {
    if (!Number.isFinite(price) || price <= 0) return;
    const now = Date.now();
    this.store.push(price, vol, now);
    const last = this.ticks[this.ticks.length - 1];
    // Collapse bursts of ticks within 120ms into one point to keep the path light
    if (last && now - last.t < 120) last.p = price;
    else this.ticks.push({ t: now, p: price });
    const cutoff = now - 240000;
    while (this.ticks.length && this.ticks[0].t < cutoff) this.ticks.shift();
    if (this.displayPrice === null) this.displayPrice = price;
  }

  setStrike(price) {
    this.strike = price || null;
  }

  setRound({ remaining, duration, lockBuffer, phase }) {
    this.round = { remaining, duration, lockBuffer, phase, syncedAt: performance.now() };
    this.liveGates = null;
  }

  /**
   * Live mode: the contract's own moments (ms since epoch). Gates are drawn at these exact times
   * as they are on the contract.
   */
  setLiveRound({ betCloseAt, lockAt, closeAt, phase, duration }) {
    const now = Date.now();
    this.liveGates = { betCloseAt, lockAt, closeAt, phase };
    const remaining = Math.max(0, (closeAt - now) / 1000);
    this.round = { remaining, duration, lockBuffer: 0, phase: phase === 'locked' || phase === 'settling' || phase === 'confirming' ? 'locked' : 'open', syncedAt: performance.now() };
  }

  setPools(up, down) {
    const prev = this.pools;
    const next = { up: Math.max(0, up), down: Math.max(0, down) };
    const total = next.up + next.down;
    // Ripple for new money; large jumps are round resets, not bets
    for (const [side, key] of [['UP', 'up'], ['DOWN', 'down']]) {
      const added = next[key] - prev[key];
      if (added > 0 && prev[key] + prev[key === 'up' ? 'down' : 'up'] > 0 && added < total * 0.3) {
        this.addRipple(side, clamp((added / Math.max(1, total)) * 25, 0.35, 1));
      }
    }
    this.pools = next;
  }

  addRipple(side, strength = 1) {
    if (this.reducedMotion) return;
    this.ripples.push({ side, strength, start: performance.now(), x: this.head ? this.head.x : this.width * 0.6 });
    if (this.ripples.length > 12) this.ripples.shift();
  }

  /** A bet leaves the console at (fromX, fromY) and flies into the comet as light */
  emitBet(side, fromX, fromY, amount = 10) {
    if (this.reducedMotion) {
      this.addRipple(side, 1);
      return;
    }
    const n = Math.round(clamp(14 + amount / 8, 14, 60));
    const now = performance.now();
    const group = { side, remaining: n };
    for (let i = 0; i < n; i++) {
      this.bursts.push({
        side, group,
        x0: fromX + (Math.random() - 0.5) * 80,
        y0: fromY + (Math.random() - 0.5) * 30,
        start: now + i * 16,
        dur: 650 + Math.random() * 550,
        bend: (Math.random() - 0.5) * 320,
        size: 1.4 + Math.random() * 1.6,
        prev: null
      });
    }
  }

  /** Settlement shower from the comet: embers rise for Rise, bubbles sink for Fall */
  celebrate(side, strength = 1) {
    if (this.reducedMotion || !this.head) return;
    const n = Math.round(160 * strength);
    const neutral = side !== 'UP' && side !== 'DOWN';
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI;
      const speed = 60 + Math.random() * 320 * strength;
      const dir = side === 'DOWN' ? 1 : -1;
      this.sparks.push({
        x: this.head.x, y: this.head.y,
        vx: Math.cos(a) * speed * (neutral ? 1.2 : 1),
        vy: dir * Math.sin(a) * speed * (neutral ? 0.25 : 1),
        drag: 1.6,
        lift: neutral ? 0 : dir * 18,
        age: 0,
        life: 1.2 + Math.random() * 1.6,
        size: 0.8 + Math.random() * 2.2,
        color: side === 'UP' ? COLORS.sunHi : side === 'DOWN' ? COLORS.tideHi : COLORS.horizon
      });
    }
  }

  setUserPositions(positions) {
    this.positions = (positions || []).filter(p => p.status === 'Active' && p.placedAt);
  }

  /** Top/bottom of the free band between the hero readout and the console, as fractions of height */
  setSafeArea(topFrac, bottomFrac) {
    this.safeArea = { top: clamp(topFrac, 0.05, 0.6), bottom: clamp(bottomFrac, 0.4, 0.95) };
  }

  setChartMode(mode) {
    this.chartMode = mode === 'candles' ? 'candles' : 'line';
  }

  setTimeframe(sec) {
    this.tf = [5, 15, 60].includes(sec) ? sec : 5;
    this.scale = null;
  }

  /** Width reserved on the right (e.g. for the Pulse board); the comet and gates stay left of it */
  setRightInset(px) {
    this.rightInset = Math.max(0, px || 0);
  }

  flashSettlement(winner) {
    this.flash = { winner, start: performance.now() };
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = (ts) => {
      if (!this.running) return;
      if (!document.hidden) this.render(ts);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
  }

  // ---------------------------------------------------------------------------
  // Layout
  // ---------------------------------------------------------------------------

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.seedParticles();
  }

  seedParticles() {
    const area = this.width * this.height;
    const count = this.reducedMotion ? 0 : Math.round(clamp(area / 9000, 40, 160));
    this.particles = Array.from({ length: count }, () => this.makeParticle(true));
  }

  makeParticle(randomY) {
    const above = Math.random() < 0.5;
    return {
      above,
      x: Math.random() * this.width,
      // Distance from the horizon as a fraction of the half-band (0 = on the line, 1 = far)
      d: randomY ? Math.random() : (above ? 0.02 : 0.02),
      speed: 0.004 + Math.random() * 0.012,
      z: 0.2 + Math.random() * 0.8,
      drift: (Math.random() - 0.5) * 6,
      size: 0.5 + Math.random() * 1.4,
      phase: Math.random() * Math.PI * 2
    };
  }

  // ---------------------------------------------------------------------------
  // Frame
  // ---------------------------------------------------------------------------

  render(ts = performance.now()) {
    const ctx = this.ctx;
    const W = this.width;
    const H = this.height;
    if (!W || !H || !this.ticks.length || this.store.loading) return;
    // First frame with real data: start exactly at the latest price and scale, no glide from elsewhere
    if (!this.ready) {
      this.ready = true;
      const last = this.ticks[this.ticks.length - 1].p;
      this.displayPrice = last;
      this.anchor = last;
      this.scale = null;
    }

    const dt = Math.min(0.1, (ts - this.lastFrame) / 1000);
    this.lastFrame = ts;
    const now = Date.now();

    // --- Smoothed state -------------------------------------------------------
    const latest = this.ticks[this.ticks.length - 1].p;
    this.displayPrice = lerp(this.displayPrice ?? latest, latest, 1 - Math.pow(0.0005, dt));
    this.anchor = lerp(this.anchor ?? latest, latest, 1 - Math.pow(0.35, dt));
    const ref = this.strike ?? this.anchor;

    // --- Shared frame -----------------------------------------------------------
    const isNarrow = W < 720;
    const usable = W - (this.rightInset || 0);
    const bandTop = H * this.safeArea.top;
    const bandBottom = H * this.safeArea.bottom;
    const F = {
      x0: isNarrow ? 12 : 28,
      x1: usable - (isNarrow ? 84 : 92),
      plotTop: bandTop + 24,
      plotBottom: bandBottom - 58,
      volTop: bandBottom - 50,
      volBottom: bandBottom - 22,
      timeY: bandBottom - 8,
      narrow: isNarrow
    };
    const horizonY = (F.plotTop + F.plotBottom) / 2;
    const amplitude = (F.plotBottom - F.plotTop) / 2;
    // A window too short or narrow for a chart (e.g. with DevTools open): draw nothing this frame rather
    // than shapes with negative sizes, which the canvas rejects
    if (amplitude < 12 || F.x1 - F.x0 < 60) return;

    // Time scale: zoom sets px per second; "now" leaves room for the round ahead
    const elapsedSinceSync = (performance.now() - this.round.syncedAt) / 1000;
    const remaining = Math.max(0, this.round.remaining - elapsedSinceSync);
    const duration = Math.max(1, this.round.duration);
    const spacing = isNarrow ? 8 : 10;
    const pps = spacing / this.tf;
    const plotW = F.x1 - F.x0;
    // Room to the right of "now" for the round ahead: up to its result time, so the STRIKE and RESULT
    // markers are on screen
    const ahead = this.liveGates && ['preview', 'open', 'closed', 'locked'].includes(this.liveGates.phase)
      ? Math.max(0, (this.liveGates.closeAt - now) / 1000) : duration;
    const nowX = F.x1 - clamp(ahead * pps + 48, spacing * 6, plotW * 0.45);
    const xAt = (t) => nowX - ((now - t) / 1000) * pps;
    const tAt = (x) => now + ((x - nowX) / pps) * 1000;
    const visibleFrom = tAt(F.x0 - spacing);

    // Series data in view
    const tfMs = this.tf * 1000;
    const candles = this.store.candles(this.tf).filter((c) => c.t + tfMs >= visibleFrom);
    if (candles.length) {
      const live = candles[candles.length - 1] = { ...candles[candles.length - 1] };
      if (now - live.t < tfMs * 2) {
        live.c = this.displayPrice;
        live.h = Math.max(live.h, live.c);
        live.l = Math.min(live.l, live.c);
      }
    }
    const points = this.store.points(this.tf).filter((p) => p.t >= visibleFrom && p.t <= now);

    // Vertical scale centred on the strike: fit the visible deviation into ~85% of the half-plot
    let maxDev = ref * 0.00012;
    if (this.chartMode === 'candles') {
      for (const c of candles) maxDev = Math.max(maxDev, Math.abs(c.h - ref), Math.abs(c.l - ref));
    } else {
      for (const p of points) maxDev = Math.max(maxDev, Math.abs(p.p - ref));
    }
    maxDev = Math.max(maxDev, Math.abs(this.displayPrice - ref));
    const targetScale = (amplitude * 0.85) / maxDev;
    this.scale = this.scale ? lerp(this.scale, targetScale, 1 - Math.pow(0.08, dt)) : targetScale;
    const yAt = (p) => clamp(horizonY - (p - ref) * this.scale, F.plotTop - 6, F.plotBottom + 6);
    const pAt = (y) => ref + (horizonY - y) / this.scale;

    const total = this.pools.up + this.pools.down;
    const upShare = total > 0 ? this.pools.up / total : 0.5;

    // Settlement flash envelope (0..1, eases out over 1.8s)
    let flashAmt = 0;
    if (this.flash) {
      const age = (performance.now() - this.flash.start) / 1800;
      if (age >= 1) this.flash = null;
      else flashAmt = Math.pow(1 - age, 2);
    }
    const flashUp = this.flash?.winner === 'UP' ? flashAmt : 0;
    const flashDown = this.flash?.winner === 'DOWN' ? flashAmt : 0;
    const flashNeutral = this.flash && this.flash.winner !== 'UP' && this.flash.winner !== 'DOWN' ? flashAmt : 0;

    // --- 1. Night, sky and sea -----------------------------------------------------
    ctx.fillStyle = COLORS.night;
    ctx.fillRect(0, 0, W, H);

    const skyA = 0.06 + 0.22 * upShare + 0.45 * flashUp;
    const sky = ctx.createLinearGradient(0, horizonY, 0, 0);
    sky.addColorStop(0, rgba(COLORS.sun, skyA));
    sky.addColorStop(0.35, rgba(COLORS.sun, skyA * 0.28));
    sky.addColorStop(1, rgba(COLORS.sun, 0));
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, horizonY);

    const seaA = 0.06 + 0.22 * (1 - upShare) + 0.45 * flashDown;
    const sea = ctx.createLinearGradient(0, horizonY, 0, H);
    sea.addColorStop(0, rgba(COLORS.tide, seaA));
    sea.addColorStop(0.35, rgba(COLORS.tide, seaA * 0.28));
    sea.addColorStop(1, rgba(COLORS.tide, 0));
    ctx.fillStyle = sea;
    ctx.fillRect(0, horizonY, W, H - horizonY);

    this.drawBloom(ctx, nowX, horizonY, W * 0.55, amplitude * 0.9, COLORS.sun, 0.1 + 0.18 * upShare + 0.3 * flashUp, true);
    this.drawBloom(ctx, nowX, horizonY, W * 0.55, amplitude * 0.9, COLORS.tide, 0.1 + 0.18 * (1 - upShare) + 0.3 * flashDown, false);

    this.parallax.x = lerp(this.parallax.x, (this.pointer.x - 0.5) * 2, 1 - Math.pow(0.05, dt));
    this.parallax.y = lerp(this.parallax.y, (this.pointer.y - 0.5) * 2, 1 - Math.pow(0.05, dt));

    // Aurora (Rise) and caustics (Fall): each side's light grows with its share of the pool
    if (!this.reducedMotion) {
      this.drawAurora(ctx, W, horizonY, amplitude, ts, 0.3 + 0.8 * upShare + 1.6 * flashUp);
      this.drawCaustics(ctx, W, H, horizonY, amplitude, ts, 0.3 + 0.8 * (1 - upShare) + 1.6 * flashDown);
    }

    // Particles: warm dust rising, cold motes sinking
    for (const pt of this.particles) {
      pt.d += pt.speed * dt * 6;
      pt.x += pt.drift * dt;
      if (pt.d > 1.15 || pt.x < -10 || pt.x > W + 10) Object.assign(pt, this.makeParticle(false), { x: Math.random() * W });
      const y = pt.above ? horizonY - pt.d * horizonY : horizonY + pt.d * (H - horizonY);
      const twinkle = 0.55 + 0.45 * Math.sin(ts / 700 + pt.phase);
      const fade = clamp(1 - pt.d, 0, 1) * twinkle;
      ctx.fillStyle = rgba(pt.above ? COLORS.sunHi : COLORS.tideHi, 0.5 * fade);
      ctx.beginPath();
      ctx.arc(pt.x + this.parallax.x * pt.z * 24, y + this.parallax.y * pt.z * 14, pt.size * (0.6 + pt.z * 0.6), 0, Math.PI * 2);
      ctx.fill();
    }

    // --- 2. Levels, time axis, volume -------------------------------------------
    this.drawLevels(ctx, F, horizonY, amplitude, ref, [yAt(this.displayPrice), horizonY]);
    this.drawTimeAxis(ctx, F, xAt, now, pps);
    this.drawVolume(ctx, F, candles, xAt, tfMs, spacing, ref);

    // --- 3. Gates ------------------------------------------------------------------
    this.drawGates(ctx, F, xAt, now);

    // --- 4. Horizon (strike) line; beats once per second in the final 5s ----------
    let beat = 0;
    if (this.round.phase === 'locked' && remaining > 0 && remaining < 5 && !this.reducedMotion) {
      beat = Math.pow(remaining % 1, 4);
    }
    if (beat > 0.01) {
      const band = ctx.createLinearGradient(0, horizonY - 40, 0, horizonY + 40);
      band.addColorStop(0, rgba(COLORS.horizon, 0));
      band.addColorStop(0.5, rgba(COLORS.horizon, 0.16 * beat));
      band.addColorStop(1, rgba(COLORS.horizon, 0));
      ctx.fillStyle = band;
      ctx.fillRect(0, horizonY - 40, W, 80);
    }
    ctx.save();
    ctx.strokeStyle = rgba(COLORS.horizon, (this.strike ? 0.95 : 0.4) * (0.75 + 0.25 * flashNeutral) + 0.25 * flashAmt);
    ctx.lineWidth = this.strike ? 1.5 : 1;
    if (!this.strike) ctx.setLineDash([2, 7]);
    ctx.shadowColor = rgba(COLORS.horizon, this.strike ? 0.8 : 0.25);
    ctx.shadowBlur = this.strike ? 14 + 20 * flashAmt + 26 * beat : 6;
    ctx.beginPath();
    ctx.moveTo(0, horizonY);
    ctx.lineTo(W, horizonY);
    ctx.stroke();
    ctx.restore();
    // The STRIKE marker on the time axis says when the strike sets; this label is only for when no round
    // timeline is known yet
    const timeline = this.liveGates && ['preview', 'open', 'closed'].includes(this.liveGates.phase);
    if (!this.strike && !timeline) {
      ctx.font = `600 10px ${FONT}`;
      ctx.textAlign = 'right';
      ctx.fillStyle = rgba(COLORS.horizon, 0.5);
      ctx.fillText('STRIKE SETS AT LOCK', F.x1 - 6, horizonY - 8);
    }
    this.drawRipples(ctx, W, horizonY);

    // --- 5. Price series -----------------------------------------------------------
    const headY = yAt(this.displayPrice);
    if (this.chartMode === 'candles') {
      this.drawCandleSeries(ctx, candles, xAt, yAt, tfMs, spacing, F);
    } else {
      const pts = points.map((p) => [xAt(p.t), yAt(p.p)]);
      pts.push([nowX, headY]);
      this.drawLineSeries(ctx, pts, nowX, horizonY, W, H);
    }

    // --- 6. Your entries ---------------------------------------------------------
    for (const pos of this.positions) {
      const x = xAt(pos.placedAt);
      if (x < F.x0 || x > nowX) continue;
      this.drawEntry(ctx, x, yAt(pos.entryPrice), pos);
    }

    // --- 7. Comet head at "now" ----------------------------------------------------
    const headColor = this.displayPrice > ref ? COLORS.sun : this.displayPrice < ref ? COLORS.tide : COLORS.horizon;
    const glow = ctx.createRadialGradient(nowX, headY, 0, nowX, headY, 30);
    glow.addColorStop(0, rgba(headColor, 0.5));
    glow.addColorStop(1, rgba(headColor, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(nowX, headY, 30, 0, Math.PI * 2);
    ctx.fill();
    if (!this.reducedMotion) {
      const pulse = (ts % 1600) / 1600;
      ctx.strokeStyle = rgba(headColor, 0.5 * (1 - pulse));
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(nowX, headY, 5 + pulse * 22, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (flashAmt > 0) {
      ctx.strokeStyle = rgba(this.flash.winner === 'UP' ? COLORS.sun : this.flash.winner === 'DOWN' ? COLORS.tide : COLORS.horizon, 0.7 * flashAmt);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(nowX, headY, 10 + (1 - flashAmt) * Math.max(W, H) * 0.35, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(nowX, headY, 3.5, 0, Math.PI * 2);
    ctx.fill();

    this.head = { x: nowX, y: headY };
    this.updateSparks(ctx, dt, nowX, headY, headColor, this.chartMode === 'line');
    this.drawBursts(ctx);

    // --- 8. Price axis tags: last price and strike ------------------------------
    ctx.strokeStyle = rgba(headColor, 0.5);
    ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(nowX + 6, headY); ctx.lineTo(F.x1, headY); ctx.stroke();
    ctx.setLineDash([]);
    if (this.strike) this.axisTag(ctx, F, horizonY, this.fmt(this.strike), COLORS.horizon, 'STRIKE');
    this.axisTag(ctx, F, headY, this.fmt(this.displayPrice), headColor);

    // --- 9. Crosshair: the price at any moment, same in both views -------------
    this.drawCrosshair(ctx, F, { now, nowX, xAt, tAt, yAt, pAt, candles, tfMs, ref, horizonY });
  }

  fmt(p) {
    return p.toLocaleString('en-US', { minimumFractionDigits: this.decimals, maximumFractionDigits: this.decimals });
  }

  drawLineSeries(ctx, pts, nowX, horizonY, W, H) {
    if (pts.length < 2) return;
    const tracePath = () => {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i][0] + pts[i + 1][0]) / 2;
        const my = (pts[i][1] + pts[i + 1][1]) / 2;
        ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
      }
      ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    };
    for (const side of ['above', 'below']) {
      const color = side === 'above' ? COLORS.sun : COLORS.tide;
      const colorHi = side === 'above' ? COLORS.sunHi : COLORS.tideHi;
      ctx.save();
      ctx.beginPath();
      if (side === 'above') ctx.rect(0, 0, W, horizonY);
      else ctx.rect(0, horizonY, W, H - horizonY);
      ctx.clip();

      // Area between the line and the horizon: distance from the strike
      tracePath();
      ctx.lineTo(nowX, horizonY);
      ctx.lineTo(pts[0][0], horizonY);
      ctx.closePath();
      const area = ctx.createLinearGradient(pts[0][0], 0, nowX, 0);
      area.addColorStop(0, rgba(color, 0.02));
      area.addColorStop(1, rgba(color, this.strike ? 0.16 : 0.08));
      ctx.fillStyle = area;
      ctx.fill();

      tracePath();
      const stroke = ctx.createLinearGradient(pts[0][0], 0, nowX, 0);
      stroke.addColorStop(0, rgba(color, 0.35));
      stroke.addColorStop(0.7, rgba(color, 0.8));
      stroke.addColorStop(1, rgba(colorHi, 1));
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.shadowColor = rgba(color, 0.6);
      ctx.shadowBlur = 10;
      ctx.stroke();
      ctx.restore();
    }
  }

  drawCandleSeries(ctx, candles, xAt, yAt, tfMs, spacing, F) {
    const body = Math.max(3, Math.round(spacing * 0.66));
    ctx.save();
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const x = Math.round(xAt(c.t + tfMs / 2)) + 0.5;
      if (x < F.x0 - body || x > F.x1) continue;
      const color = c.c > c.o ? COLORS.sun : c.c < c.o ? COLORS.tide : COLORS.horizon;
      if (c.h === c.l && i !== candles.length - 1) {
        // No trade in this interval: a thin level line across the whole slot, so quiet stretches read
        // as one continuous flat price instead of a row of dashes
        ctx.strokeStyle = rgba(color, 0.5);
        ctx.lineWidth = 1;
        const y = Math.round(yAt(c.c)) + 0.5;
        ctx.beginPath(); ctx.moveTo(x - spacing / 2, y); ctx.lineTo(x + spacing / 2, y); ctx.stroke();
        continue;
      }
      ctx.strokeStyle = rgba(color, 0.95);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, yAt(c.h)); ctx.lineTo(x, yAt(c.l)); ctx.stroke();
      const top = yAt(Math.max(c.o, c.c));
      const h = Math.max(1.5, yAt(Math.min(c.o, c.c)) - top);
      ctx.fillStyle = rgba(color, 1);
      if (i === candles.length - 1) {
        ctx.shadowColor = rgba(color, 0.9);
        ctx.shadowBlur = 12;
      }
      ctx.fillRect(x - body / 2, top, body, h);
      ctx.shadowBlur = 0;
    }
    ctx.restore();
  }

  drawVolume(ctx, F, candles, xAt, tfMs, spacing) {
    if (!candles.length) return;
    const body = Math.max(3, Math.round(spacing * 0.66));
    const maxVol = Math.max(1e-9, ...candles.map((c) => c.v));
    ctx.save();
    for (const c of candles) {
      if (!c.v) continue;
      const x = xAt(c.t + tfMs / 2);
      if (x < F.x0 || x > F.x1) continue;
      const h = (c.v / maxVol) * (F.volBottom - F.volTop);
      ctx.fillStyle = rgba(c.c >= c.o ? COLORS.sun : COLORS.tide, 0.3);
      ctx.fillRect(x - body / 2, F.volBottom - h, body, h);
    }
    ctx.restore();
  }

  drawTimeAxis(ctx, F, xAt, now, pps) {
    const stepSec = TIME_STEPS.find((s) => s * pps >= (F.narrow ? 72 : 96)) || 7200;
    const stepMs = stepSec * 1000;
    ctx.save();
    ctx.font = `500 ${F.narrow ? 10 : 11}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let t = Math.floor(now / stepMs) * stepMs; ; t -= stepMs) {
      const x = xAt(t);
      if (x < F.x0) break;
      if (x > F.x1) continue;
      ctx.strokeStyle = rgba(COLORS.ink, 0.04);
      ctx.beginPath(); ctx.moveTo(x, F.plotTop); ctx.lineTo(x, F.volBottom); ctx.stroke();
      const label = new Date(t).toLocaleTimeString([], stepSec >= 60
        ? { hour: '2-digit', minute: '2-digit' }
        : { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const half = ctx.measureText(label).width / 2;
      if (x - half < F.x0 || x + half > F.x1) continue;
      ctx.fillStyle = rgba(COLORS.ink, 0.45);
      ctx.fillText(label, x, F.timeY);
    }
    ctx.restore();
  }

  /** Round marker, from the contract's round only; nothing until it has been read */
  drawGates(ctx, F, xAt, now) {
    if (this.liveGates) this.drawLiveGates(ctx, F, xAt, now);
  }

  /**
   * The round on the time axis: a STRIKE marker (when the price is locked), a RESULT marker (when the
   * round is decided) and the shaded window between them, whose price movement decides the round.
   * 'preview' (no round running) shows the round a bet placed now would start, dimmer. The result
   * label drops a line when it would touch the strike label, so they never overlap.
   */
  drawLiveGates(ctx, F, xAt, now) {
    const { lockAt, closeAt, phase } = this.liveGates;
    if (!['preview', 'open', 'closed', 'locked', 'settling', 'confirming'].includes(phase)) return;
    const clock = (t) => {
      const s = Math.max(0, Math.ceil((t - now) / 1000));
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    const dim = phase === 'preview' ? 0.6 : 1;
    const running = phase === 'locked';
    const ending = phase === 'settling' || phase === 'confirming';
    const strike = { t: lockAt, label: lockAt > now ? `STRIKE ${clock(lockAt)}` : 'STRIKE', alpha: (lockAt > now ? 0.45 : 0.3) * dim };
    const result = {
      t: closeAt,
      label: phase === 'confirming' ? 'CONFIRMING PRICE' : ending ? 'RESULT COMING' : `RESULT ${clock(closeAt)}`,
      alpha: (running || ending ? 0.7 : 0.45) * dim
    };
    const xs = xAt(strike.t);
    const xr = xAt(result.t);
    ctx.save();
    // The deciding window
    const left = Math.max(F.x0, xs);
    const right = Math.min(F.x1, xr);
    if (right > left) {
      ctx.fillStyle = rgba(COLORS.ink, (running ? 0.05 : 0.03) * dim);
      ctx.fillRect(left, F.plotTop, right - left, F.volBottom - F.plotTop);
    }
    ctx.font = `700 10px ${FONT}`;
    ctx.textAlign = 'center';
    const line = (x, alpha) => {
      ctx.strokeStyle = rgba(COLORS.ink, alpha);
      ctx.setLineDash([3, 5]);
      ctx.beginPath(); ctx.moveTo(x, F.plotTop); ctx.lineTo(x, F.volBottom); ctx.stroke();
      ctx.setLineDash([]);
    };
    const place = (x, text) => {
      const w = ctx.measureText(text).width;
      return { x: Math.min(F.x1 - w / 2, Math.max(F.x0 + w / 2, x)), w };
    };
    let strikeLabel = null;
    if (xs >= F.x0 && xs <= F.x1) {
      line(xs, strike.alpha);
      strikeLabel = place(xs, strike.label);
      ctx.fillStyle = rgba(COLORS.horizon, Math.min(1, strike.alpha + 0.5));
      ctx.fillText(strike.label, strikeLabel.x, F.plotTop - 6);
    }
    if (xr >= F.x0 && xr <= F.x1) {
      line(xr, result.alpha);
      const r = place(xr, result.label);
      const clash = strikeLabel && Math.abs(r.x - strikeLabel.x) < (r.w + strikeLabel.w) / 2 + 8;
      ctx.fillStyle = rgba(COLORS.ink, Math.min(1, result.alpha + 0.5));
      ctx.fillText(result.label, r.x, F.plotTop - 6 + (clash ? 13 : 0));
    }
    ctx.restore();
  }

  drawEntry(ctx, x, y, pos) {
    const color = pos.side === 'UP' ? COLORS.sun : COLORS.tide;
    ctx.save();
    ctx.strokeStyle = rgba(color, 0.95);
    ctx.fillStyle = COLORS.night;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = rgba(color, 1);
    ctx.beginPath();
    if (pos.side === 'UP') { ctx.moveTo(x, y - 3); ctx.lineTo(x + 2.8, y + 2); ctx.lineTo(x - 2.8, y + 2); }
    else { ctx.moveTo(x, y + 3); ctx.lineTo(x + 2.8, y - 2); ctx.lineTo(x - 2.8, y - 2); }
    ctx.closePath();
    ctx.fill();
    ctx.font = `600 10px ${FONT}`;
    ctx.fillStyle = rgba(COLORS.ink, 0.8);
    ctx.textAlign = 'center';
    ctx.fillText(`YOU ${pos.amount}`, x, pos.side === 'UP' ? y - 12 : y + 20);
    ctx.restore();
  }

  axisTag(ctx, F, y, text, color, label = null) {
    ctx.save();
    ctx.font = `600 ${F.narrow ? 10 : 11}px ${FONT}`;
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width + 12;
    ctx.fillStyle = rgba(color, 1);
    ctx.beginPath();
    ctx.roundRect(F.x1 + 4, y - 10, w, 20, 4);
    ctx.fill();
    ctx.fillStyle = COLORS.night;
    ctx.textAlign = 'left';
    ctx.fillText(text, F.x1 + 10, y + 0.5);
    if (label) {
      ctx.font = `700 9px ${FONT}`;
      ctx.fillStyle = rgba(color, 0.9);
      ctx.textAlign = 'right';
      ctx.fillText(label, F.x1 - 4, y - 9);
    }
    ctx.restore();
  }

  /** Hover anywhere on the chart to read the price at that moment */
  drawCrosshair(ctx, F, { now, nowX, xAt, tAt, yAt, pAt, candles, tfMs, ref, horizonY }) {
    const ptr = this.pointerPx;
    const inside = ptr && ptr.x >= F.x0 && ptr.x <= F.x1 && ptr.y >= F.plotTop - 10 && ptr.y <= F.volBottom;
    let header;

    if (inside && ptr.x <= nowX + 4) {
      const t = Math.min(now, tAt(ptr.x));
      let x;
      let y;
      let price;
      let candle = null;
      if (this.chartMode === 'candles') {
        const key = Math.floor(t / tfMs) * tfMs;
        candle = candles.find((c) => c.t === key) || null;
        x = xAt(key + tfMs / 2);
        y = clamp(ptr.y, F.plotTop, F.plotBottom);
        price = pAt(y);
      } else {
        const bar = this.store.priceAt(t);
        price = t >= now - 1000 ? this.displayPrice : bar ? bar.c : null;
        x = ptr.x;
        y = price !== null ? yAt(price) : null;
      }

      ctx.save();
      ctx.strokeStyle = rgba(COLORS.ink, 0.4);
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(x, F.plotTop); ctx.lineTo(x, F.volBottom); ctx.stroke();
      if (y !== null) {
        ctx.beginPath(); ctx.moveTo(F.x0, y); ctx.lineTo(F.x1, y); ctx.stroke();
      }
      ctx.setLineDash([]);
      if (this.chartMode === 'line' && y !== null) {
        const c = price > ref ? COLORS.sun : price < ref ? COLORS.tide : COLORS.horizon;
        ctx.fillStyle = rgba(c, 1);
        ctx.strokeStyle = COLORS.night;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      ctx.restore();

      if (price !== null && y !== null) this.axisTag(ctx, F, y, this.fmt(price), COLORS.ink);
      const timeText = new Date(candle ? candle.t : t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      this.timeTag(ctx, F, x, timeText);

      if (candle) header = this.ohlcParts(candle);
      else if (price !== null) header = this.priceParts(timeText, price, ref);
    } else if (this.chartMode === 'candles' && candles.length) {
      header = this.ohlcParts(candles[candles.length - 1]);
    } else {
      header = this.priceParts('Now', this.displayPrice, ref);
    }
    if (header) this.drawHeader(ctx, F, header);
  }

  timeTag(ctx, F, x, text) {
    ctx.save();
    ctx.font = `600 10px ${FONT}`;
    const w = ctx.measureText(text).width + 12;
    ctx.fillStyle = 'rgba(238,234,246,0.95)';
    ctx.beginPath();
    ctx.roundRect(x - w / 2, F.timeY - 9, w, 18, 4);
    ctx.fill();
    ctx.fillStyle = COLORS.night;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, F.timeY + 0.5);
    ctx.restore();
  }

  ohlcParts(c) {
    const color = c.c > c.o ? COLORS.sun : c.c < c.o ? COLORS.tide : COLORS.horizon;
    const chg = c.o ? ((c.c - c.o) / c.o) * 100 : 0;
    return [
      ['O', this.fmt(c.o), color], ['H', this.fmt(c.h), color], ['L', this.fmt(c.l), color], ['C', this.fmt(c.c), color],
      [null, `${chg >= 0 ? '+' : ''}${chg.toFixed(3)}%`, color]
    ];
  }

  priceParts(label, price, ref) {
    const color = price > ref ? COLORS.sun : price < ref ? COLORS.tide : COLORS.horizon;
    const diff = price - ref;
    const pct = (diff / ref) * 100;
    const vs = this.strike ? 'vs strike' : 'vs now';
    return [
      [label, this.fmt(price), COLORS.ink],
      [null, `${diff >= 0 ? '+' : '−'}${this.fmt(Math.abs(diff))} (${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(3)}%) ${vs}`, color]
    ];
  }

  drawHeader(ctx, F, parts) {
    ctx.save();
    ctx.font = `600 11px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    let x = F.x0;
    const y = F.plotTop - 20;
    const zoom = this.tf === 60 ? '1m' : `${this.tf}s`;
    ctx.fillStyle = rgba(COLORS.ink, 0.5);
    ctx.fillText(zoom, x, y);
    x += ctx.measureText(zoom).width + 12;
    const shown = F.narrow && parts.length > 2 ? parts.slice(3) : parts;
    for (const [k, v, color] of shown) {
      if (k) {
        ctx.fillStyle = rgba(COLORS.ink, 0.45);
        ctx.fillText(k, x, y);
        x += ctx.measureText(k).width + 5;
      }
      ctx.fillStyle = rgba(color, 1);
      ctx.fillText(v, x, y);
      x += ctx.measureText(v).width + 10;
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Pieces
  // ---------------------------------------------------------------------------

  drawAurora(ctx, W, horizonY, amplitude, ts, intensity) {
    const t = ts / 1000;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, horizonY);
    ctx.clip();
    ctx.globalCompositeOperation = 'lighter';
    const shift = this.parallax.x * 14;
    for (let i = 0; i < 3; i++) {
      const base = horizonY - amplitude * (0.42 + i * 0.36);
      const thick = amplitude * (0.24 - i * 0.05);
      const top = [];
      for (let x = -40; x <= W + 40; x += 24) {
        const y = base
          + Math.sin(x * 0.0032 + t * (0.22 + 0.08 * i) + i * 2.1) * amplitude * 0.15
          + Math.sin(x * 0.0087 - t * 0.37 + i) * amplitude * 0.05;
        top.push([x + shift * (i + 1) * 0.5, y, thick * (0.55 + 0.45 * Math.sin(x * 0.006 + t * 0.31 + i))]);
      }
      ctx.beginPath();
      ctx.moveTo(top[0][0], top[0][1]);
      for (const [x, y] of top) ctx.lineTo(x, y);
      for (let k = top.length - 1; k >= 0; k--) ctx.lineTo(top[k][0], top[k][1] + top[k][2]);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, base - amplitude * 0.25, 0, base + thick + amplitude * 0.2);
      const a = clamp(intensity * (0.12 - i * 0.025), 0, 0.5);
      g.addColorStop(0, rgba(COLORS.sun, 0));
      g.addColorStop(0.45, rgba(i === 1 ? COLORS.sunHi : COLORS.sun, a));
      g.addColorStop(1, rgba(COLORS.sun, 0));
      ctx.fillStyle = g;
      ctx.fill();
    }
    ctx.restore();
  }

  drawCaustics(ctx, W, H, horizonY, amplitude, ts, intensity) {
    const t = ts / 1000;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, horizonY, W, H - horizonY);
    ctx.clip();
    ctx.globalCompositeOperation = 'lighter';
    const shift = this.parallax.x * 10;
    for (let i = 0; i < 4; i++) {
      const y0 = horizonY + amplitude * (0.22 + i * 0.24);
      ctx.beginPath();
      for (let x = -20; x <= W + 20; x += 18) {
        const y = y0 + Math.sin(x * 0.012 + t * 0.9 + i * 1.7) * 5 + Math.sin(x * 0.0041 - t * 0.5 + i) * amplitude * 0.07;
        if (x === -20) ctx.moveTo(x + shift, y);
        else ctx.lineTo(x + shift, y);
      }
      const a = clamp(intensity * (0.09 - i * 0.017), 0, 0.4);
      ctx.strokeStyle = rgba(COLORS.tide, a);
      ctx.lineWidth = 1.2;
      ctx.stroke();
      // Glints travelling along each caustic line
      ctx.setLineDash([2, 22 + i * 6]);
      ctx.lineDashOffset = -t * (30 + i * 12);
      ctx.strokeStyle = rgba(COLORS.tideHi, a * 2.2);
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  drawRipples(ctx, W, horizonY) {
    const now = performance.now();
    this.ripples = this.ripples.filter(r => now - r.start < 1600);
    for (const r of this.ripples) {
      const age = (now - r.start) / 1600;
      const ease = 1 - Math.pow(1 - age, 3);
      const rx = 20 + ease * W * 0.4;
      const ry = 3 + ease * 26;
      const above = r.side === 'UP';
      ctx.save();
      ctx.strokeStyle = rgba(above ? COLORS.sunHi : COLORS.tideHi, (1 - age) * 0.55 * r.strength);
      ctx.lineWidth = 1.5;
      ctx.shadowColor = rgba(above ? COLORS.sun : COLORS.tide, 0.8);
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.ellipse(r.x, horizonY, rx, ry, 0, above ? Math.PI : 0, above ? Math.PI * 2 : Math.PI);
      ctx.stroke();
      ctx.restore();
    }
  }

  updateSparks(ctx, dt, cometX, headY, headColor, emit = true) {
    // Comet sheds sparks continuously; they drift back along the trail
    if (emit && !this.reducedMotion) {
      const rise = headColor === COLORS.sun ? -1 : headColor === COLORS.tide ? 1 : 0;
      this.sparkDebt = (this.sparkDebt || 0) + dt * 55;
      while (this.sparkDebt >= 1) {
        this.sparkDebt -= 1;
        this.sparks.push({
          x: cometX, y: headY,
          vx: -(50 + Math.random() * 130), vy: (Math.random() - 0.5) * 50,
          drag: 0.6, lift: rise * 14,
          age: 0, life: 0.5 + Math.random() * 0.9,
          size: 0.5 + Math.random() * 1.3,
          color: headColor === COLORS.sun ? COLORS.sunHi : headColor === COLORS.tide ? COLORS.tideHi : COLORS.horizon
        });
      }
    }
    if (this.sparks.length > 700) this.sparks.splice(0, this.sparks.length - 700);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const alive = [];
    for (const sp of this.sparks) {
      sp.age += dt;
      if (sp.age >= sp.life) continue;
      const k = Math.exp(-sp.drag * dt);
      sp.vx *= k;
      sp.vy = sp.vy * k + sp.lift * dt * 4;
      sp.x += sp.vx * dt;
      sp.y += sp.vy * dt;
      const fade = 1 - sp.age / sp.life;
      ctx.fillStyle = rgba(sp.color, 0.85 * fade);
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, sp.size * (0.5 + 0.5 * fade), 0, Math.PI * 2);
      ctx.fill();
      alive.push(sp);
    }
    this.sparks = alive;
    ctx.restore();
  }

  drawBursts(ctx) {
    if (!this.bursts.length || !this.head) return;
    const now = performance.now();
    const { x: tx, y: ty } = this.head;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    const alive = [];
    for (const b of this.bursts) {
      const p = (now - b.start) / b.dur;
      if (p < 0) { alive.push(b); continue; }
      const color = b.side === 'UP' ? COLORS.sun : COLORS.tide;
      const colorHi = b.side === 'UP' ? COLORS.sunHi : COLORS.tideHi;
      if (p >= 1) {
        b.group.remaining -= 1;
        if (b.group.remaining === 0) {
          this.addRipple(b.side, 1);
          this.celebrate(b.side, 0.18);
        }
        continue;
      }
      const e = 1 - Math.pow(1 - p, 3);
      const cx = (b.x0 + tx) / 2 + b.bend;
      const cy = Math.min(b.y0, ty) - 140;
      const x = (1 - e) * (1 - e) * b.x0 + 2 * (1 - e) * e * cx + e * e * tx;
      const y = (1 - e) * (1 - e) * b.y0 + 2 * (1 - e) * e * cy + e * e * ty;
      if (b.prev) {
        ctx.strokeStyle = rgba(color, 0.55);
        ctx.lineWidth = b.size;
        ctx.beginPath();
        ctx.moveTo(b.prev[0], b.prev[1]);
        ctx.lineTo(x, y);
        ctx.stroke();
      }
      ctx.fillStyle = rgba(colorHi, 0.95);
      ctx.beginPath();
      ctx.arc(x, y, b.size, 0, Math.PI * 2);
      ctx.fill();
      b.prev = [x, y];
      alive.push(b);
    }
    this.bursts = alive;
    ctx.restore();
  }

  drawBloom(ctx, cx, cy, rx, ry, color, alpha, above) {
    if (!(rx > 1 && ry > 1)) return;
    ctx.save();
    ctx.beginPath();
    if (above) ctx.rect(0, cy - ry * 2, this.width, ry * 2);
    else ctx.rect(0, cy, this.width, ry * 2);
    ctx.clip();
    ctx.translate(cx, cy);
    ctx.scale(rx / ry, 1);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, ry);
    g.addColorStop(0, rgba(color, alpha));
    g.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, ry, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  drawLevels(ctx, F, horizonY, amplitude, ref, reserved = []) {
    // "Nice" percent steps about 60px apart: % from the strike on the left, the price on the right
    const pctPerPx = (1 / this.scale) / ref * 100;
    const raw = pctPerPx * 60;
    const steps = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5];
    const step = steps.find(v => v >= raw) || 5;
    const pctDecimals = step < 0.01 ? 3 : 2;
    ctx.save();
    ctx.font = `600 ${F.narrow ? 10 : 11}px ${FONT}`;
    ctx.textBaseline = 'middle';
    for (let i = 1; i <= 8; i++) {
      for (const dir of [1, -1]) {
        const y = horizonY - dir * (i * step / 100) * ref * this.scale;
        if (Math.abs(y - horizonY) > amplitude + 4) continue;
        ctx.strokeStyle = rgba(COLORS.ink, 0.06);
        ctx.lineWidth = 1;
        ctx.setLineDash([1, 5]);
        ctx.beginPath(); ctx.moveTo(F.x0, y); ctx.lineTo(F.x1, y); ctx.stroke();
        ctx.setLineDash([]);

        const pct = `${dir > 0 ? '+' : '−'}${(i * step).toFixed(pctDecimals)}%`;
        const w = ctx.measureText(pct).width + 14;
        ctx.fillStyle = 'rgba(6,5,11,0.72)';
        ctx.strokeStyle = rgba(dir > 0 ? COLORS.sun : COLORS.tide, 0.4);
        ctx.beginPath();
        ctx.roundRect(F.x0, y - 9, w, 18, 9);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = rgba(dir > 0 ? COLORS.sunHi : COLORS.tideHi, 0.95);
        ctx.textAlign = 'left';
        ctx.fillText(pct, F.x0 + 7, y + 0.5);

        // Skip axis labels that would sit under the live-price or strike tags
        if (reserved.every((r) => Math.abs(r - y) > 16)) {
          ctx.fillStyle = rgba(COLORS.ink, 0.5);
          ctx.fillText(this.fmt(ref * (1 + dir * (i * step) / 100)), F.x1 + 10, y + 0.5);
        }
      }
    }
    ctx.restore();
  }

}
