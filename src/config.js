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
  LOG_CHUNK_BLOCKS: process.env.NEXT_PUBLIC_LOG_CHUNK_BLOCKS,
  HISTORY_WINDOW_BLOCKS: process.env.NEXT_PUBLIC_HISTORY_WINDOW_BLOCKS,
  MAINNET_CONTRACT_ADDRESS: process.env.NEXT_PUBLIC_MAINNET_CONTRACT_ADDRESS,
  MAINNET_DEPLOY_BLOCK: process.env.NEXT_PUBLIC_MAINNET_DEPLOY_BLOCK
};

const numberOrNull = (v) => (v === undefined || v === '' ? null : Number(v));

export const API_CONFIG = {
  // Price source for the UI: RedStone, the oracle the contract settles on, through the keyless relay
  // (scripts/price_relay.js at NEXT_PUBLIC_PRICE_RELAY_URL). Binance only when chosen explicitly with
  // NEXT_PUBLIC_PRICE_SOURCE=binance (smoother ticks, no MON market, not the settlement price). With
  // neither there is no source, and the UI says so. The source never switches on its own.
  priceSource: env.PRICE_SOURCE === 'binance' ? 'binance' : env.PRICE_RELAY_URL ? 'redstone' : null,
  priceRelayUrl: env.PRICE_RELAY_URL ? env.PRICE_RELAY_URL.replace(/\/$/, '') : null,
  redstoneGatewayUrl: REDSTONE_GATEWAY,
  binanceRestUrl: 'https://api.binance.com/api/v3',
  binanceWsUrl: 'wss://stream.binance.com:9443'
};

const chainId = env.CHAIN_ID ? Number(env.CHAIN_ID) : 10143;

export const NETWORK_CONFIG = {
  chainId,
  chainIdHex: `0x${chainId.toString(16)}`,
  chainName: chainId === 10143 ? 'Monad Testnet' : `Local chain ${chainId}`,
  rpcUrl: env.RPC_URL || 'https://testnet-rpc.monad.xyz',
  explorerUrl: env.EXPLORER_URL || 'https://testnet.monadexplorer.com',
  contractAddress: env.CONTRACT_ADDRESS || null,
  nativeCurrency: {
    name: 'Monad',
    symbol: 'MON',
    decimals: 18
  },
  blockTimeMs: 1000,
  // Transparency dashboard: where to start reading contract events, and RPC log limits (tuning)
  deployBlock: numberOrNull(env.CONTRACT_DEPLOY_BLOCK),
  logChunkBlocks: Number(env.LOG_CHUNK_BLOCKS || 100),
  historyWindowBlocks: Number(env.HISTORY_WINDOW_BLOCKS || 5000)
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
    explorerUrl: 'https://monadexplorer.com',
    contractAddress: env.MAINNET_CONTRACT_ADDRESS || null,
    deployBlock: numberOrNull(env.MAINNET_DEPLOY_BLOCK),
    logChunkBlocks: NETWORK_CONFIG.logChunkBlocks,
    historyWindowBlocks: NETWORK_CONFIG.historyWindowBlocks,
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

// Markets. `feed` is the RedStone data feed id the contract verifies reports for;
// marketId = keccak256(abi.encodePacked(bytes32(feed), symbol, roundDuration)).
export const SUPPORTED_MARKETS = {
  BTC: {
    marketId: '0xc432785f59f7efa251b3c5ba521def427f61a39fef626fd0f6376da33735fd9e',
    symbol: 'BTC/USD',
    name: 'Bitcoin',
    feed: 'BTC',
    binanceStream: 'btcusdt@ticker',
    binanceTradeStream: 'btcusdt@trade',
    decimals: 2,
    roundDuration: 60,
    minBet: 0.1,
    maxBet: 5000.0,
    icon: '₿',
    accentColor: '#f7931a'
  },
  ETH: {
    marketId: '0x9627768f48a0fac5f23a0a1e88ede1c008911faff20be79db7672065044b3498',
    symbol: 'ETH/USD',
    name: 'Ethereum',
    feed: 'ETH',
    binanceStream: 'ethusdt@ticker',
    binanceTradeStream: 'ethusdt@trade',
    decimals: 2,
    roundDuration: 60,
    minBet: 0.1,
    maxBet: 5000.0,
    icon: 'Ξ',
    accentColor: '#627eea'
  },
  SOL: {
    marketId: '0xdeb001efbeffa0b95446095f5c1ba806a786b8e044f9ca47bd70eac4b0b7b252',
    symbol: 'SOL/USD',
    name: 'Solana',
    feed: 'SOL',
    binanceStream: 'solusdt@ticker',
    binanceTradeStream: 'solusdt@trade',
    decimals: 2,
    roundDuration: 60,
    minBet: 0.1,
    maxBet: 5000.0,
    icon: '◎',
    accentColor: '#14f195'
  },
  MON: {
    marketId: '0xcdd64f46add8aeaf07180ed1a3dc00a1295129d708b9a63b4a40dec464feb487',
    symbol: 'MON/USD',
    name: 'Monad Native',
    feed: 'MON',
    binanceStream: null,
    binanceTradeStream: null,
    decimals: 4,
    roundDuration: 60,
    minBet: 1.0,
    maxBet: 25000.0,
    icon: 'M',
    accentColor: '#836ef9'
  }
};
