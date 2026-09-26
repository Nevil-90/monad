/**
 * PulseFeed.js
 * Data for the Pulse board, all from ChainHistory: the contract's all-time totalWinnings counters,
 * and wins claimed on-chain (never refunds) for the feed.
 */

const MAX_FEED = 12;

export class PulseFeed {
  constructor({ web3, history, onUpdate }) {
    this.web3 = web3;
    this.history = history;
    this.onUpdate = onUpdate;
    history.onChange(() => this.refresh());
  }

  refresh() {
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
        side: round?.winningSide ?? null,
        market: h.marketLabel(r.marketId),
        amount: r.amount,
        mult: stake ? r.amount / stake : null
      };
    });
    const topMult = wins.reduce((mx, w) => Math.max(mx, w.mult || 0), 0);
    const rounds = h.roundsList().filter((r) => r.status === 'settled').length;
    this.onUpdate({
      ready: h.status === 'live',
      paid: h.totals.paidToWinners,
      rounds,
      topMult,
      feed: wins.slice(0, MAX_FEED)
    });
  }
}
