/**
 * scripts/sync_markets.js
 * Makes the deployed contract match src/config.js:
 *   - round timing (ROUND_RULES: betting window, cutoff before the strike); applies to new rounds only
 *   - creates any configured market that does not exist yet, and marks it verified
 *   - deactivates every other active market (e.g. after changing a round length, which gives a market
 *     a new id). A deactivated market's current round still locks, settles and pays out; it just
 *     starts no new rounds.
 *
 * Usage: npm run markets [-- --dry-run]   (owner key in DEPLOYER_PRIVATE_KEY or KEEPER_PRIVATE_KEY)
 */

import { ethers } from 'ethers';
import { getConfig, SUPPORTED_MARKETS, ROUND_RULES } from '../src/config.js';
import { AMM_ABI } from '../src/contracts/AMMAbi.js';
import { MonadRpcProvider } from '../src/rpc.js';
import { feedIdBytes32 } from '../src/oracle.js';

const dryRun = process.argv.includes('--dry-run');
const cfg = getConfig();
const key = process.env.DEPLOYER_PRIVATE_KEY || process.env.KEEPER_PRIVATE_KEY;
if (!cfg.contractAddress || !key) {
  console.error('Needs NEXT_PUBLIC_CONTRACT_ADDRESS and the owner key in .env');
  process.exit(1);
}
const provider = new MonadRpcProvider(cfg.rpcUrl, cfg.chainId);
const owner = new ethers.Wallet(key, provider);
const amm = new ethers.Contract(cfg.contractAddress, AMM_ABI, owner);
if ((await amm.owner()).toLowerCase() !== owner.address.toLowerCase()) throw new Error(`${owner.address} is not the contract owner`);

const send = async (label, method, ...args) => {
  if (dryRun) return console.log(`  [dry-run] ${label}`);
  const est = await amm[method].estimateGas(...args);
  const rc = await (await amm[method](...args, { gasLimit: (est * 110n) / 100n })).wait();
  console.log(`  [OK] ${label} (tx ${rc.hash})`);
};

// Round timing
if ((await amm.bettingWindowSeconds()) !== BigInt(ROUND_RULES.bettingWindow)) {
  await send(`Betting window ${ROUND_RULES.bettingWindow} s`, 'setBettingWindow', ROUND_RULES.bettingWindow);
}
const [lockBuffer, priceWindow, timeout, minBet] = await Promise.all([amm.lockBufferSeconds(), amm.priceWindowSeconds(), amm.emergencyTimeout(), amm.minBet()]);
if (lockBuffer !== BigInt(ROUND_RULES.lockBuffer)) {
  await send(`Betting closes ${ROUND_RULES.lockBuffer} s before the strike`, 'setProtocolParameters', ROUND_RULES.lockBuffer, priceWindow, timeout, minBet);
}

const wanted = new Set();
for (const m of Object.values(SUPPORTED_MARKETS)) {
  const id = ethers.solidityPackedKeccak256(['bytes32', 'string', 'uint256'], [feedIdBytes32(m.feed), m.symbol, m.roundDuration]);
  if (id !== m.marketId) throw new Error(`${m.symbol}: marketId in src/config.js should be ${id}`);
  wanted.add(id);
  const onChain = await amm.markets(id);
  if (onChain.creator === ethers.ZeroAddress) {
    await send(`${m.symbol} ${m.roundDuration}s market created`, 'createMarket', feedIdBytes32(m.feed), m.name, m.symbol, m.roundDuration);
  } else if (!onChain.active) {
    await send(`${m.symbol} ${m.roundDuration}s market reactivated`, 'setMarketActive', id, true);
  }
  if (dryRun || !(await amm.markets(id)).verified) await send(`${m.symbol} ${m.roundDuration}s market verified`, 'setMarketVerified', id, true);
}

const count = Number(await amm.getMarketCount());
for (let i = 0; i < count; i++) {
  const id = await amm.allMarketIds(i);
  if (wanted.has(id)) continue;
  const m = await amm.markets(id);
  if (m.active) await send(`${m.symbol} ${m.roundDuration}s market deactivated (not in src/config.js)`, 'setMarketActive', id, false);
}
console.log('Contract matches src/config.js.');
