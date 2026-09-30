/**
 * scripts/house_admin.js
 * Owner tools for the deployed MonadPulseHouse (the contract in .env). With no options it only prints
 * the current rules and the bet range they allow.
 *
 * Usage:
 *   npm run house                              show rules, vault and the bet range
 *   npm run house -- --min-bet 0.1             smallest bet, in MON
 *   npm run house -- --max-win 10              largest net win of one bet, as % of the free vault (max 10)
 *   npm run house -- --add-liquidity 20        deposit MON into the vault (from the owner wallet)
 *   npm run house -- --pause                   stop new bets and deposits (settling, cash-outs and
 *                                              vault withdrawals keep working); --unpause reverses it
 *   npm run house -- --withdraw-liquidity      take the owner's whole vault share out (what is not
 *                                              reserved for open bets; run again once they settle)
 *   npm run house -- --withdraw-treasury       send the collected win fees to the owner
 *   --address 0x…                              act on another house deployment than the one in .env
 * Options combine. Env: DEPLOYER_PRIVATE_KEY (the owner). Every change applies to new bets only.
 */

import { ethers } from 'ethers';
import { getConfig } from '../src/config.js';
import { HOUSE_ABI } from '../src/contracts/HouseAbi.js';
import { MonadRpcProvider } from '../src/rpc.js';

const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const net = getConfig();
const address = arg('--address') || net.contractAddress;
if (!address) throw new Error('NEXT_PUBLIC_CONTRACT_ADDRESS is not set in .env (or pass --address).');
const provider = new MonadRpcProvider(net.rpcUrl, net.chainId);
const key = process.env.DEPLOYER_PRIVATE_KEY;
const house = new ethers.Contract(address, HOUSE_ABI, key ? new ethers.Wallet(key, provider) : provider);
const mon = (v) => `${ethers.formatEther(v)} MON`;

// Deployments before moving odds have another houseInfo() layout and no marginBps(); pause, liquidity
// and shares work the same on both, so those actions are allowed on either version
const legacy = await house.marginBps().then(() => false, () => true);

async function show(title) {
  if (legacy) {
    const [vault, locked, minBetNow, max, pot, isPaused] = await Promise.all([house.vaultAssets(), house.lockedPayouts(), house.minBet(), house.maxStake(), house.jackpotPot(), house.paused()]);
    console.log(`\n${title} (${address} on ${net.name}) — older house version (fixed odds)`);
    console.log(`  Vault             ${mon(vault)} (reserved for pending bets ${mon(locked)})`);
    console.log(`  Bet range         ${mon(minBetNow)} to ${mon(max)}`);
    console.log(`  Jackpot           ${mon(pot)}`);
    if (isPaused) console.log('  PAUSED: no new bets or deposits');
    if (key) {
      const me = await house.runner.getAddress();
      const [sh, total] = await Promise.all([house.shares(me), house.totalShares()]);
      if (sh > 0n) console.log(`  Owner vault share ${(Number((sh * 10000n) / total) / 100).toFixed(2)}% = ${mon((sh * (vault - locked)) / total)} withdrawable now`);
    }
    return;
  }
  const h = await house.houseInfo();
  const maxWinBps = await house.maxWinBps();
  console.log(`\n${title} (${address} on ${net.name})`);
  const m = Number(h.marginBps) / 10000;
  const f = Number(h.winFeeBps) / 10000;
  const band = Number(h.maxSkewBps) / 10000;
  const pays = (p) => (1 + (1 / (p * (1 + m)) - 1) * (1 - f)).toFixed(2);
  console.log(`  Odds              ${pays(0.5)}x when even, ${pays(0.5 + band)}x to ${pays(0.5 - band)}x as the betting leans`);
  console.log(`  House takes       ${(m * 100).toFixed(1)}% margin on stakes (vault) + ${(f * 100).toFixed(1)}% of each win's profit (treasury)`);
  console.log(`  Treasury          ${mon(h.treasury)} (win fees; --withdraw-treasury sends them to the owner)`);
  console.log(`  Vault             ${mon(h.vaultAssets)} (reserved for pending bets ${mon(h.lockedPayouts)})`);
  console.log(`  Max win per bet   ${Number(maxWinBps) / 100}% of the free vault`);
  console.log(`  Bet range         ${mon(h.minBet)} to ${mon(h.maxStake)}`);
  console.log(`  Jackpot           ${mon(h.jackpotPot)} (win ${h.jackpotStreak} in a row)`);
  if (h.paused) console.log('  PAUSED: no new bets or deposits');
  if (key) {
    const me = await house.runner.getAddress();
    const [sh, total] = await Promise.all([house.shares(me), house.totalShares()]);
    if (sh > 0n) console.log(`  Owner vault share ${(Number((sh * 10000n) / total) / 100).toFixed(2)}% = ${mon((sh * (h.vaultAssets - h.lockedPayouts)) / total)} withdrawable now`);
  }
  if (h.minBet > h.maxStake) console.log('  !! The minimum is above the maximum: no bet fits. Lower --min-bet or raise --max-win / --add-liquidity.');
}

await show('Now');
const minBet = arg('--min-bet');
const maxWin = arg('--max-win');
const addLiquidity = arg('--add-liquidity');
const pause = args.includes('--pause');
const unpause = args.includes('--unpause');
const withdraw = args.includes('--withdraw-liquidity');
const withdrawTreasury = args.includes('--withdraw-treasury');
if (!minBet && !maxWin && !addLiquidity && !pause && !unpause && !withdraw && !withdrawTreasury) process.exit(0);
if (!key) throw new Error('DEPLOYER_PRIVATE_KEY (the owner) is needed to change anything.');
const me = await house.runner.getAddress();
if ((await house.owner()).toLowerCase() !== me.toLowerCase()) throw new Error(`${me} is not the owner.`);

// A handful of sends were seen rejected as "insufficient balance" on well-funded wallets on Monad
// testnet, not really about the gasLimit value (see house_keeper.js for the closest thing to a root
// cause: overlapping transactions racing the same wallet key). Kept as a cheap defensive buffer.
const MIN_GAS_LIMIT = 200_000n;
const send = async (label, fn, ...a) => {
  const est = await house[fn].estimateGas(...a);
  const buffered = (est * 110n) / 100n;
  const gasLimit = buffered > MIN_GAS_LIMIT ? buffered : MIN_GAS_LIMIT;
  const rc = await (await house[fn](...a, { gasLimit })).wait();
  console.log(`  [OK] ${label} (tx ${rc.hash})`);
};

if (legacy && (minBet || maxWin || withdrawTreasury)) {
  throw new Error('This is an older house version (fixed odds): only --pause, --unpause, --withdraw-liquidity and --add-liquidity work on it.');
}
if (minBet || maxWin) {
  const [margin, fee, cut, curMaxWin, curMin, lead] = await Promise.all([house.marginBps(), house.winFeeBps(), house.jackpotCutBps(), house.maxWinBps(), house.minBet(), house.minLead()]);
  const newMin = minBet ? ethers.parseEther(minBet) : curMin;
  const newMaxWin = maxWin ? BigInt(Math.round(Number(maxWin) * 100)) : curMaxWin;
  await send(`min bet ${ethers.formatEther(newMin)} MON, max win ${Number(newMaxWin) / 100}% of the free vault`, 'setParams', margin, fee, cut, newMaxWin, newMin, lead);
}
if (pause) await send('paused: no new bets or deposits', 'setPaused', true);
if (unpause) await send('unpaused', 'setPaused', false);
if (withdraw) {
  const sh = await house.shares(me);
  if (sh === 0n) console.log('  [--] The owner holds no vault shares');
  else await send('owner vault share withdrawn', 'removeLiquidity', sh);
}
if (withdrawTreasury) {
  if ((await house.treasury()) === 0n) console.log('  [--] The treasury is empty');
  else await send('treasury (win fees) sent to the owner', 'withdrawTreasury', me);
}
if (addLiquidity) await send(`added ${addLiquidity} MON to the vault`, 'addLiquidity', { value: ethers.parseEther(addLiquidity) });
await show('After');
