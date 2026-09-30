/**
 * PulseFeed.js
 * Data for the Pulse board, all from ChainHistory: the streak jackpot and house totals read from the
 * contract, and recent wins and jackpots (never refunds) for the feed.
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
    const account = this.web3.account ? this.web3.account.toLowerCase() : null;
    const feed = h.records.filter((r) => r.type === 'win' || r.type === 'jackpot').map((r) => {
      const bet = h.bets.get(r.betId);
      return {
        key: r.id,
        user: `${r.user.slice(0, 6)}…${r.user.slice(-4)}`,
        you: account === r.user.toLowerCase(),
        jackpot: r.type === 'jackpot',
        streak: r.streak ?? null,
        side: r.type === 'win' ? bet?.side ?? null : null,
        market: bet ? h.marketLabel(bet.marketId) : 'Streak',
        amount: r.amount,
        time: r.time ?? h.blockTimes.get(r.block) ?? null,
        mult: r.type === 'win' && bet?.stake ? r.amount / bet.stake : null
      };
    });
    const house = h.house;
    const mon = (v) => (v === undefined || v === null ? null : Number(v) / 1e18);
    this.onUpdate({
      ready: h.status === 'live' && Boolean(house),
      jackpot: mon(house?.jackpotPot),
      jackpotStreak: house ? Number(house.jackpotStreak) : null,
      paid: mon(house?.totalPaidOut),
      settled: house ? Number(house.betsSettled) : null,
      feed: feed.slice(0, MAX_FEED)
    });
  }
}
