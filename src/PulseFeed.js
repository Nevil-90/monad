/**
 * PulseFeed.js
 * Data for the Pulse board: how much has been paid to winners, and who won recently.
 *
 * Live mode reads ChainHistory: the contract's totalWinnings counters for the all-time total and
 * claimed wins (never refunds) for the feed. Demo mode summarises
 * settled demo rounds, which include simulated players, and is always labelled as demo.
 */

const MAX_FEED = 12;

export class PulseFeed {
  constructor({ web3, amm, history, onUpdate }) {
    this.web3 = web3;
    this.amm = amm;
    this.history = history;
    this.onUpdate = onUpdate;
    this.mode = 'demo';
    history.onChange(() => this.refreshLive());
  }

  setMode(mode) {
    this.mode = mode;
    if (mode === 'live') {
      this.history.start();
      this.refreshLive();
    } else {
      this.refreshDemo();
    }
  }

  /** Call after any demo round settles */
  refreshDemo() {
    if (this.mode !== 'demo') return;
    const history = this.amm.roundHistory;
    const settled = history.filter(h => h.winner === 'UP' || h.winner === 'DOWN');
    const paid = settled.reduce((s, h) => s + (h.paidOut || 0), 0);
    const topMult = settled.reduce((mx, h) => Math.max(mx, parseFloat(h.finalMult) || 0), 0);
    const players = history.reduce((s, h) => s + (h.players || 0), 0);

    const feed = [];
    for (const h of history) {
      if (h.winner !== 'UP' && h.winner !== 'DOWN') continue;
      const mine = this.amm.userPositions.find(p =>
        p.marketKey === h.marketKey && p.roundId === h.roundId && p.status === 'Won');
      if (mine) {
        feed.push({ key: `${h.marketKey}-${h.roundId}`, you: true, side: h.winner, market: h.market, amount: mine.payout, mult: parseFloat(h.finalMult) });
      } else {
        feed.push({ key: `${h.marketKey}-${h.roundId}`, side: h.winner, market: h.market, amount: h.paidOut, mult: parseFloat(h.finalMult), winners: h.winners });
      }
      if (feed.length >= MAX_FEED) break;
    }

    this.onUpdate({ mode: 'demo', paid, rounds: history.length, players, topMult, feed });
  }

  /** Live figures come from ChainHistory: contract counters plus claimed wins in loaded history */
  refreshLive() {
    if (this.mode !== 'live') return;
    const h = this.history;
    const stakeOf = new Map();
    for (const r of h.records) {
      if (r.type !== 'bet') continue;
      const k = `${r.marketId}:${r.roundId}:${r.user.toLowerCase()}`;
      stakeOf.set(k, (stakeOf.get(k) || 0) + r.amount);
    }
    const account = this.web3.account ? this.web3.account.toLowerCase() : null;
    const wins = h.records.filter((r) => r.type === 'win').map((r) => {
      const stake = stakeOf.get(`${r.marketId}:${r.roundId}:${r.user.toLowerCase()}`);
      const round = h.rounds.get(`${r.marketId}:${r.roundId}`);
      return {
        key: r.id,
        user: `${r.user.slice(0, 6)}…${r.user.slice(-4)}`,
        you: account === r.user.toLowerCase(),
        side: round?.winningSide || 'UP',
        market: h.marketLabel(r.marketId),
        amount: r.amount,
        mult: stake ? r.amount / stake : null
      };
    });
    const topMult = wins.reduce((mx, w) => Math.max(mx, w.mult || 0), 0);
    const rounds = h.roundsList().length;
    this.onUpdate({ mode: 'live', paid: h.totals.paidToWinners || 0, rounds, players: null, topMult, feed: wins.slice(0, MAX_FEED) });
  }
}
