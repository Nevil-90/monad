/**
 * config.js
 * Networks, price sources and markets, shared by the Next.js app and the Node scripts (keeper, deploy,
 * local chain).
 *
 * - Deployment-specific values (contract address, deploy block) have no defaults: when one is missing
 *   the feature that needs it reports it, instead of running against a guessed value.
 * - Public network facts (chain id, public RPC, explorer) and the RedStone gateway are constants.
 * - Next.js inlines NEXT_PUBLIC_* values only where they are written out literally, so each one is
 *   read by name below. In Node, the same names come from process.env (npm scripts load .env).
 */

import { REDSTONE_GATEWAY } from './oracle.js';

const env = {
  PRICE_SOURCE: process.env.NEXT_PUBLIC_PRICE_SOURCE,
  PRICE_RELAY_URL: process.env.NEXT_PUBLIC_PRICE_RELAY_URL,
  CHAIN_ID: process.env.NEXT_PUBLIC_CHAIN_ID,
  RPC_URL: process.env.NEXT_PUBLIC_RPC_URL,
  EXPLORER_URL: process.env.NEXT_PUBLIC_EXPLORER_URL,
  CONTRACT_ADDRESS: process.env.NEXT_PUBLIC_CONTRACT_ADDRESS,
  CONTRACT_DEPLOY_BLOCK: process.env.NEXT_PUBLIC_CONTRACT_DEPLOY_BLOCK,
  MAINNET_CONTRACT_ADDRESS: process.env.NEXT_PUBLIC_MAINNET_CONTRACT_ADDRESS,
  MAINNET_DEPLOY_BLOCK: process.env.NEXT_PUBLIC_MAINNET_DEPLOY_BLOCK
};

const numberOrNull = (v) => (v === undefined || v === '' ? null : Number(v));

export const API_CONFIG = {
  // Chart price source, chosen with NEXT_PUBLIC_PRICE_SOURCE: 'coinbase' (public WebSocket, every trade,
  // ~0.1 s, all four markets in USD) or 'binance' (no MON market). Unset means no source, and the UI
  // says so. The source never switches on its own. Strike and settlement are always RedStone's signed
  // prices, which arrive as contract events through the relay (NEXT_PUBLIC_PRICE_RELAY_URL).
  priceSource: env.PRICE_SOURCE === 'coinbase' ? 'coinbase'
    : env.PRICE_SOURCE === 'binance' ? 'binance' : null,
  priceRelayUrl: env.PRICE_RELAY_URL ? env.PRICE_RELAY_URL.replace(/\/$/, '') : null,
  redstoneGatewayUrl: REDSTONE_GATEWAY,
  coinbaseWsUrl: 'wss://ws-feed.exchange.coinbase.com',
  coinbaseRestUrl: 'https://api.exchange.coinbase.com',
  binanceRestUrl: 'https://api.binance.com/api/v3',
  binanceWsUrl: 'wss://stream.binance.com:9443'
};

// Public facts of the Monad chains. The app runs on the one NEXT_PUBLIC_CHAIN_ID names (testnet by
// default); any other id is a local chain and needs NEXT_PUBLIC_RPC_URL.
const KNOWN_CHAINS = {
  10143: { name: 'Monad Testnet', rpcUrl: 'https://testnet-rpc.monad.xyz', explorerUrl: 'https://testnet.monadexplorer.com' },
  143: { name: 'Monad Mainnet', rpcUrl: 'https://rpc.monad.xyz', explorerUrl: 'https://monadexplorer.com' }
};
const chainId = env.CHAIN_ID ? Number(env.CHAIN_ID) : 10143;
const known = KNOWN_CHAINS[chainId] || null;
const rpcUrl = env.RPC_URL || known?.rpcUrl || null;

export const NETWORK_CONFIG = {
  chainId,
  chainIdHex: `0x${chainId.toString(16)}`,
  chainName: known ? known.name : `Local chain ${chainId}`,
  isMainnet: chainId === 143,
  rpcUrl,
  // Push subscriptions (new blocks, contract logs) use the same endpoint over WebSocket
  wsUrl: rpcUrl ? rpcUrl.replace(/^http/, 'ws') : null,
  explorerUrl: env.EXPLORER_URL || known?.explorerUrl || null,
  contractAddress: env.CONTRACT_ADDRESS || null,
  nativeCurrency: {
    name: 'Monad',
    symbol: 'MON',
    decimals: 18
  },
  blockTimeMs: 1000,
  // Where the relay starts indexing the contract's events for the Dashboard
  deployBlock: numberOrNull(env.CONTRACT_DEPLOY_BLOCK)
};

// Networks. Each one carries only its own addresses; nothing is borrowed from another network.
export const ENVIRONMENTS = {
  testnet: {
    ...NETWORK_CONFIG,
    name: NETWORK_CONFIG.chainName
  },
  production: {
    chainId: 143,
    chainIdHex: '0x8f',
    name: 'Monad Mainnet',
    rpcUrl: 'https://rpc.monad.xyz',
    wsUrl: 'wss://rpc.monad.xyz',
    explorerUrl: 'https://monadexplorer.com',
    isMainnet: true,
    contractAddress: env.MAINNET_CONTRACT_ADDRESS || null,
    deployBlock: numberOrNull(env.MAINNET_DEPLOY_BLOCK),
    nativeCurrency: NETWORK_CONFIG.nativeCurrency,
    blockTimeMs: 1000
  }
};

export let CURRENT_ENV = 'testnet';

export function setEnvironment(envKey) {
  if (!ENVIRONMENTS[envKey]) throw new Error(`Unknown network: ${envKey}`);
  CURRENT_ENV = envKey;
  return ENVIRONMENTS[envKey];
}

export function getConfig() {
  return ENVIRONMENTS[CURRENT_ENV];
}

export function getApiConfig() {
  return API_CONFIG;
}

// Typical gas per action, measured with scripts/gas_report.js on the deployed contract. Monad charges
// the gas limit, so the app shows fee estimates from these and the live gas price (+10% margin).
export const TYPICAL_GAS = {
  bet: 135000,          // first bet on a side (joining or adding costs less)
  betNewRound: 230000,  // bet that replaces an expired one-sided round
  claim: 50000
};

// Markets. `feed` is the RedStone data feed id the contract verifies reports for;
// marketId = keccak256(abi.encodePacked(bytes32(feed), symbol, roundDuration)).
export const SUPPORTED_MARKETS = {
  BTC: {
    marketId: '0x59294bc06269f63b60b63ee06667680628d5671d515196bc7074fe72e621fc1a',
    symbol: 'BTC/USD',
    name: 'Bitcoin',
    feed: 'BTC',
    coinbase: 'BTC-USD',
    binanceStream: 'btcusdt@ticker',
    binanceTradeStream: 'btcusdt@trade',
    decimals: 2,
    roundDuration: 30,
    minBet: 0.1,
    maxBet: 5000.0,
    icon: '₿',
    accentColor: '#f7931a'
  },
  ETH: {
    marketId: '0x136f06ff19094248bad10faa0a5a77934229a8919cb38ea96a2553208a185ed5',
    symbol: 'ETH/USD',
    name: 'Ethereum',
    feed: 'ETH',
    coinbase: 'ETH-USD',
    binanceStream: 'ethusdt@ticker',
    binanceTradeStream: 'ethusdt@trade',
    decimals: 2,
    roundDuration: 30,
    minBet: 0.1,
    maxBet: 5000.0,
    icon: 'Ξ',
    accentColor: '#627eea'
  },
  SOL: {
    marketId: '0x4b635dc0844531fe1e553dc9fc420ba762844708cb36820ae0eff7fbf0df7b08',
    symbol: 'SOL/USD',
    name: 'Solana',
    feed: 'SOL',
    coinbase: 'SOL-USD',
    binanceStream: 'solusdt@ticker',
    binanceTradeStream: 'solusdt@trade',
    decimals: 2,
    roundDuration: 30,
    minBet: 0.1,
    maxBet: 5000.0,
    icon: '◎',
    accentColor: '#14f195'
  },
  MON: {
    marketId: '0x113c7cb008694d03e98bd99015925fa7918673291f92169097a9a8eac1c5e3f1',
    symbol: 'MON/USD',
    name: 'Monad Native',
    feed: 'MON',
    coinbase: 'MON-USD',
    binanceStream: null,
    binanceTradeStream: null,
    decimals: 4,
    roundDuration: 30,
    minBet: 1.0,
    maxBet: 25000.0,
    icon: 'M',
    accentColor: '#836ef9'
  }
};
