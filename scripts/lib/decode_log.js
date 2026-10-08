/**
 * scripts/lib/decode_log.js
 * Turns one raw house-contract log into the rows the Supabase-backed Dashboard needs: an `activity`
 * row for anything that moves money or state (one per log), and, for BetPlaced/BetSettled, the bet
 * fields to upsert into `bets`. Mirrors src/ChainHistory.js's ingest() so the Dashboard (read from
 * Supabase) and the live Trade view (read from the relay's in-memory event stream) always agree on
 * what each event means.
 */
import { ethers } from 'ethers';
import { HOUSE_ABI } from '../../src/contracts/HouseAbi.js';

const PRICE_DECIMALS = 8;
const STATUS = ['None', 'Pending', 'Won', 'Lost', 'Push', 'Void'];
const toMon = (v) => Number(ethers.formatEther(v));
const iface = new ethers.Interface(HOUSE_ABI);

/**
 * @param {{blockNumber:number, transactionHash:string, index:number, topics:string[], data:string, timestamp:number}} entry
 * @returns {{ activity: object|null, placed: object|null, settled: object|null }}
 *   activity: an `activity` table row, or null for logs with no Dashboard meaning (e.g. PriceRecorded).
 *   placed/settled: fields to upsert into `bets` for BetPlaced / BetSettled, or null otherwise.
 */
export function decodeLog(entry) {
  let ev;
  try { ev = iface.parseLog({ topics: entry.topics, data: entry.data }); } catch (_) { return { activity: null, placed: null, settled: null }; }
  if (!ev) return { activity: null, placed: null, settled: null };

  const base = { txHash: entry.transactionHash, logIndex: entry.index, blockNumber: entry.blockNumber, blockTime: entry.timestamp };
  const a = ev.args;
  const marketId = a.marketId ? String(a.marketId).toLowerCase() : null;

  switch (ev.name) {
    case 'BetPlaced': {
      const betId = Number(a.betId);
      const side = Number(a.side) === 1 ? 'UP' : 'DOWN';
      const stake = toMon(a.stake);
      const placed = {
        betId, userAddress: a.player, marketId, side, stake, payout: toMon(a.payout),
        startTs: Number(a.startTs), duration: Number(a.duration), endTs: Number(a.startTs) + Number(a.duration),
        streakBet: Boolean(a.streakBet), txHash: base.txHash, blockNumber: base.blockNumber, placedAt: base.blockTime
      };
      const activity = { ...base, type: 'bet', userAddress: a.player, marketId, betId, side, amount: stake };
      return { activity, placed, settled: null };
    }
    case 'BetSettled': {
      const betId = Number(a.betId);
      const status = STATUS[Number(a.status)] || 'None';
      const paid = toMon(a.paid);
      const settled = {
        betId, userAddress: a.player, marketId, status, paid,
        startPrice: a.startPrice > 0n ? Number(ethers.formatUnits(a.startPrice, PRICE_DECIMALS)) : null,
        endPrice: a.endPrice > 0n ? Number(ethers.formatUnits(a.endPrice, PRICE_DECIMALS)) : null,
        streakAfter: Number(a.streak), settleTx: base.txHash, settleBlock: base.blockNumber, settledAt: base.blockTime
      };
      let activity = null;
      if (status === 'Won') activity = { ...base, type: 'win', userAddress: a.player, marketId, betId, amount: paid };
      else if (status === 'Push' || status === 'Void') activity = { ...base, type: 'refund', userAddress: a.player, marketId, betId, amount: paid };
      return { activity, placed: null, settled };
    }
    case 'JackpotWon':
      return { activity: { ...base, type: 'jackpot', userAddress: a.player, betId: Number(a.betId), amount: toMon(a.amount) }, placed: null, settled: null };
    case 'BalanceWithdrawn':
      return { activity: { ...base, type: 'cashout', userAddress: a.player, amount: toMon(a.amount) }, placed: null, settled: null };
    case 'LiquidityAdded':
      return { activity: { ...base, type: 'lpIn', userAddress: a.provider, amount: toMon(a.amount) }, placed: null, settled: null };
    case 'LiquidityRemoved':
      return { activity: { ...base, type: 'lpOut', userAddress: a.provider, amount: toMon(a.amount) }, placed: null, settled: null };
    default:
      return { activity: null, placed: null, settled: null };
  }
}
