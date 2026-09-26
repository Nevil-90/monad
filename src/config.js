/**
 * config.js
 * Centralized Protocol & API Engine Configuration
 * 
 * - Single source of truth for all API endpoints, contracts, and network parameters.
 * - Dynamic environment-variable driven (Vite import.meta.env).
 * - Deployment-specific values (contract address, deploy block, price relay) have no defaults: when
 *   one is missing the feature that needs it reports it, instead of running against a guessed value.
 *   Public network facts (chain id, public RPC, Pyth's contract on testnet) are fixed constants.
 * - Endpoints and sensitive configs are encapsulated and never showcased in the UI.
 */

// Vite's import.meta.env in the browser; process.env when the scripts (keeper, deploy, relay) import this in Node
const env = import.meta.env ?? (typeof process !== 'undefined' ? process.env : {});

export const API_CONFIG = {
  // Primary Exchange Feeds
  binanceRestUrl: env.VITE_BINANCE_REST_URL || 'https://api.binance.com/api/v3',
  binanceWsUrl: env.VITE_BINANCE_WS_URL || 'wss://stream.binance.com:9443',
  
  // Pyth Network. Since the Pyth Core upgrade (2026-08-26) Hermes requires an API key, so the browser
  // never talks to Hermes directly: the keeper uses PYTH_API_KEY, and the UI streams prices through
  // scripts/price_relay.js (VITE_PRICE_RELAY_URL), which holds the key server-side.
  // Hermes is only called server-side (relay + keeper). Public Pyth endpoint; PYTH_HERMES_URL overrides it.
  pythHermesUrl: env.PYTH_HERMES_URL || 'https://pyth.dourolabs.app/hermes',
  priceRelayUrl: env.VITE_PRICE_RELAY_URL || '',
  // Price source for the UI. Pyth (through the relay) whenever a relay is configured. Binance only when
  // chosen explicitly with VITE_PRICE_SOURCE=binance (development; it has no MON market and is not the
  // settlement oracle). With neither, there is no source and the UI says so instead of guessing.
  priceSource: env.VITE_PRICE_RELAY_URL ? 'pyth' : env.VITE_PRICE_SOURCE === 'binance' ? 'binance' : null,
  // Pyth contract on Monad (verified on testnet: code present, version 1.4.6, supports parsePriceFeedUpdatesUnique)
  pythContractAddress: env.VITE_PYTH_CONTRACT || '0x2880aB155794e7179c9eE2e38200202908C17B43'
};

export const NETWORK_CONFIG = {
  chainId: Number(env.VITE_CHAIN_ID || 10143),
  chainIdHex: env.VITE_CHAIN_ID_HEX || '0x279f',
  chainName: env.VITE_CHAIN_NAME || 'Monad Testnet',
  rpcUrl: env.VITE_RPC_URL || 'https://testnet-rpc.monad.xyz',
  explorerUrl: env.VITE_EXPLORER_URL || 'https://testnet.monadexplorer.com',
  contractAddress: env.VITE_CONTRACT_ADDRESS || null,
  nativeCurrency: {
    name: 'Monad',
    symbol: 'MON',
    decimals: 18
  },
  blockTimeMs: 1000,
  targetTps: 10000,
  // Transparency dashboard: where to start reading contract events, and RPC log limits
  deployBlock: env.VITE_CONTRACT_DEPLOY_BLOCK ? Number(env.VITE_CONTRACT_DEPLOY_BLOCK) : null,
  logChunkBlocks: Number(env.VITE_LOG_CHUNK_BLOCKS || 100),
  historyWindowBlocks: Number(env.VITE_HISTORY_WINDOW_BLOCKS || 5000)
};

// Networks. Each one carries only its own addresses; nothing is borrowed from another network.
export const ENVIRONMENTS = {
  testnet: {
    ...NETWORK_CONFIG,
    name: NETWORK_CONFIG.chainName,
    pythContractAddress: API_CONFIG.pythContractAddress,
    pythHermesUrl: API_CONFIG.pythHermesUrl,
    wsFeedUrl: `${API_CONFIG.binanceWsUrl}/ws`
  },
  production: {
    chainId: 143,
    chainIdHex: '0x8f',
    name: 'Monad Mainnet',
    rpcUrl: 'https://rpc.monad.xyz',
    explorerUrl: 'https://monadexplorer.com',
    contractAddress: env.VITE_MAINNET_CONTRACT_ADDRESS || null,
    pythContractAddress: env.VITE_MAINNET_PYTH_CONTRACT || null,
    deployBlock: env.VITE_MAINNET_DEPLOY_BLOCK ? Number(env.VITE_MAINNET_DEPLOY_BLOCK) : null,
    logChunkBlocks: NETWORK_CONFIG.logChunkBlocks,
    historyWindowBlocks: NETWORK_CONFIG.historyWindowBlocks,
    pythHermesUrl: API_CONFIG.pythHermesUrl,
    nativeCurrency: NETWORK_CONFIG.nativeCurrency,
    blockTimeMs: 1000,
    targetTps: 10000,
    wsFeedUrl: `${API_CONFIG.binanceWsUrl}/ws`
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

export function getNetworkConfig() {
  return getConfig();
}

export function getApiConfig() {
  return API_CONFIG;
}

// Institutional Market Specifications & Official Pyth Feed IDs
export const SUPPORTED_MARKETS = {
  BTC: {
    marketId: '0xfdd4d0d4d8d1df0c8fceba46760c58fa65cbcb6fddda8538185f93462ec95dc9',
    symbol: 'BTC/USD',
    name: 'Bitcoin',
    pythId: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
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
    marketId: '0x5281785d17e2ac2b0e7440fdb6dc4a3a8e51208de22bc8363f8d8c2ffd93e9a7',
    symbol: 'ETH/USD',
    name: 'Ethereum',
    pythId: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
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
    marketId: '0xd1a1725151f7f74c7b6323858c383d3364d9ba9171d5f49e0fe9253061967eca',
    symbol: 'SOL/USD',
    name: 'Solana',
    pythId: '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
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
    marketId: '0x8dd94d794aa4fb7baf83ca4a46bb1cdfe2bd33423f5427669a89e5b8fbc65e5b',
    symbol: 'MON/USD',
    name: 'Monad Native',
    pythId: '0x31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1',
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
