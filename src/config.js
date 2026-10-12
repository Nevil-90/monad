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
  10143: { name: 'Monad Testnet', rpcUrl: 'https://testnet-rpc.monad.xyz', explorerUrl: 'https://testnet.monadexplorer.com', faucetUrl: 'https://faucet.monad.xyz' },
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
  faucetUrl: known?.faucetUrl || null,
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

// Markets. `feed` is the RedStone data feed id the contract verifies reports for. marketId is the
// id the house contract registers the market under (setMarket, owner only). Bet rules (multiplier,
// minimum, house limit, lengths) and network fees are read from the chain, never set here.
export const SUPPORTED_MARKETS = {
  BTC: {
    marketId: '0x3f2c6b072f0d9130d909f43afc36353b37725d468aa5ba558e74e348d02a6476',
    symbol: 'BTC/USD',
    name: 'Bitcoin',
    feed: 'BTC',
    coinbase: 'BTC-USD',
    binanceStream: 'btcusdt@ticker',
    binanceTradeStream: 'btcusdt@trade',
    decimals: 2,
    icon: '₿',
    accentColor: '#f7931a'
  },
  ETH: {
    marketId: '0x673949a04694203f6ab1c2f92b6e818d17797544bf0d4b5f53241b46ac8af479',
    symbol: 'ETH/USD',
    name: 'Ethereum',
    feed: 'ETH',
    coinbase: 'ETH-USD',
    binanceStream: 'ethusdt@ticker',
    binanceTradeStream: 'ethusdt@trade',
    decimals: 2,
    icon: 'Ξ',
    accentColor: '#627eea'
  },
  SOL: {
    marketId: '0x1b8f7cb08526b69e6101b3861e8964b87f383476f8c3a79598a4be5b72370f16',
    symbol: 'SOL/USD',
    name: 'Solana',
    feed: 'SOL',
    coinbase: 'SOL-USD',
    binanceStream: 'solusdt@ticker',
    binanceTradeStream: 'solusdt@trade',
    decimals: 2,
    icon: '◎',
    accentColor: '#14f195'
  },
  MON: {
    marketId: '0x359a04e86f6643cb63069b9583e50feef723bc85296daeefbe576ef91a10e206',
    symbol: 'MON/USD',
    name: 'Monad Native',
    feed: 'MON',
    coinbase: 'MON-USD',
    binanceStream: null,
    binanceTradeStream: null,
    decimals: 4,
    icon: 'M',
    accentColor: '#836ef9'
  }
};
