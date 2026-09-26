/**
 * Web3Manager.js
 * EIP-1193 Web3 Wallet Provider & Dynamic Monad Mainnet/Testnet Integration
 * 
 * Zero-Hardcoding Architecture:
 * - Gas prices, priority fees, and base fees are queried live from the connected RPC node.
 * - Gas limits are dynamically estimated on-chain via eth_estimateGas with a 20% safety margin.
 * - Protocol fees, minimum bets, and lock buffers are queried directly from the smart contract.
 * - Supports dynamic environment switching between Monad Testnet and Monad Mainnet.
 * - Robust ABI-driven function encoding using ethers.Interface (zero manual hex bugs).
 */

import { ethers } from 'ethers';
import { getConfig, setEnvironment, ENVIRONMENTS } from './config.js';
import { AMM_ABI } from './contracts/AMMAbi.js';
import { MonadRpcProvider } from './rpc.js';

export const MONAD_NETWORKS = {
  get testnet() {
    const c = ENVIRONMENTS.testnet;
    return {
      chainId: c.chainIdHex,
      chainIdDecimal: c.chainId,
      chainName: c.name || c.chainName,
      nativeCurrency: c.nativeCurrency,
      rpcUrls: [c.rpcUrl],
      blockExplorerUrls: [c.explorerUrl]
    };
  },
  get production() {
    const c = ENVIRONMENTS.production;
    return {
      chainId: c.chainIdHex,
      chainIdDecimal: c.chainId,
      chainName: c.name || c.chainName,
      nativeCurrency: c.nativeCurrency,
      rpcUrls: [c.rpcUrl],
      blockExplorerUrls: [c.explorerUrl]
    };
  }
};

export const MONAD_TESTNET = MONAD_NETWORKS.testnet;

export class Web3Manager {
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
    this.provider = typeof window !== 'undefined' ? (window.ethereum || null) : null;
    this.account = null;
    this.chainId = null;
    this.balance = null;
    this.isLiveNetwork = false;
    
    // Contract Interface for zero-bug ABI encoding
    this.iface = new ethers.Interface(AMM_ABI);

    // Dynamically initialized from active environment configuration
    this.contractAddress = getConfig().contractAddress;
    this.currentEnvKey = 'testnet';

    try {
      this.readOnlyProvider = new MonadRpcProvider(getConfig().rpcUrl, getConfig().chainId);
    } catch (_) {
      this.readOnlyProvider = null;
    }

    // Dynamic on-chain protocol state (Zero hardcoding)
    this.protocolState = {
      totalFeeBps: null,
      creatorFeeBps: null,
      keeperFeeBps: null,
      treasuryFeeBps: null,
      lockBufferSeconds: null,
      minBetWei: null,
      priceWindowSeconds: null,
      liveGasPriceWei: null
    };

    this.initListeners();
  }

  setContractAddress(addr) {
    if (addr && addr.startsWith('0x')) {
      this.contractAddress = addr;
    }
  }

  setEnvironment(envKey) {
    this.currentEnvKey = envKey;
    const conf = ENVIRONMENTS[envKey];
    if (!conf) throw new Error(`Unknown network: ${envKey}`);
    this.contractAddress = conf.contractAddress;
    try {
      this.readOnlyProvider = new MonadRpcProvider(conf.rpcUrl, conf.chainId);
    } catch (_) {
      this.readOnlyProvider = null;
    }
    this.checkNetworkMatch();
  }

  /**
   * Contract reads always go to the configured Monad RPC, never through the wallet: a wallet can be
   * on another network (or mid-switch), and a read sent there finds no contract.
   */
  async ethCall(data, to = this.contractAddress) {
    if (!to || !this.readOnlyProvider) return null;
    try {
      return await this.readOnlyProvider.call({ to, data });
    } catch (err) {
      console.warn('Contract read failed:', err.shortMessage || err.message);
      return null;
    }
  }

  getActiveNetworkConfig() {
    return MONAD_NETWORKS[this.currentEnvKey];
  }

  isWalletInstalled() {
    return typeof window !== 'undefined' && Boolean(window.ethereum);
  }

  initListeners() {
    if (!this.provider) return;

    this.provider.on('accountsChanged', (accounts) => {
      if (accounts.length === 0) {
        this.disconnect();
      } else {
        this.account = accounts[0];
        this.fetchBalance();
        this.emit('accountChanged', this.account);
      }
    });

    this.provider.on('chainChanged', (chainId) => {
      this.chainId = chainId;
      this.checkNetworkMatch();
      this.fetchBalance();
      this.emit('networkChanged', { chainId, isMonad: this.isLiveNetwork });
    });
  }

  checkNetworkMatch() {
    if (!this.chainId) return false;
    const targetNet = this.getActiveNetworkConfig();
    this.isLiveNetwork = parseInt(this.chainId, 16) === targetNet.chainIdDecimal;
    return this.isLiveNetwork;
  }

  async connect() {
    if (!this.provider) {
      return {
        success: false,
        error: 'No browser wallet found.'
      };
    }

    try {
      // 1. Request Account Access
      const accounts = await this.provider.request({ method: 'eth_requestAccounts' });
      this.account = accounts[0];

      // 2. Verify / Switch to active Monad Network
      const currentChainId = await this.provider.request({ method: 'eth_chainId' });
      this.chainId = currentChainId;

      const targetNet = this.getActiveNetworkConfig();
      if (parseInt(currentChainId, 16) !== targetNet.chainIdDecimal) {
        await this.switchToMonad(this.currentEnvKey);
      } else {
        this.isLiveNetwork = true;
      }

      // 3. Fetch Real Monad Balance
      await this.fetchBalance();

      // 4. Fetch Live Protocol Fees & Gas Prices directly from chain
      await this.fetchLiveProtocolFees();
      await this.fetchLiveGasFee();

      this.emit('connected', {
        account: this.account,
        balance: this.balance,
        chainId: this.chainId,
        isLiveNetwork: this.isLiveNetwork,
        protocolState: this.protocolState
      });

      return {
        success: true,
        account: this.account,
        balance: this.balance,
        isLiveNetwork: this.isLiveNetwork
      };
    } catch (err) {
      console.error('Wallet connection failed:', err);
      return {
        success: false,
        error: err.message || 'User rejected wallet connection'
      };
    }
  }

  async switchToMonad(envKey = 'testnet') {
    if (!this.provider) return false;
    const targetNet = MONAD_NETWORKS[envKey];
    if (!targetNet) return false;
    try {
      await this.provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: targetNet.chainId }]
      });
      this.isLiveNetwork = true;
      return true;
    } catch (switchError) {
      if (switchError.code === 4902 || switchError.message?.includes('Unrecognized chain')) {
        try {
          await this.provider.request({
            method: 'wallet_addEthereumChain',
            params: [targetNet]
          });
          this.isLiveNetwork = true;
          return true;
        } catch (addError) {
          console.error(`Failed to add ${targetNet.chainName}:`, addError);
          return false;
        }
      }
      return false;
    }
  }

  async fetchBalance() {
    if (!this.provider || !this.account) return null;
    try {
      // Monad balance from the Monad RPC, whatever network the wallet is showing
      const balanceWei = await this.readOnlyProvider.getBalance(this.account);
      const balanceEth = Number(balanceWei) / 1e18;
      this.balance = balanceEth.toFixed(4);
      this.emit('balanceUpdated', this.balance);
      return this.balance;
    } catch (err) {
      // Unknown is shown as unknown, never as zero
      console.warn('Could not fetch on-chain balance:', err);
      this.balance = null;
      this.emit('balanceUpdated', null);
      return null;
    }
  }

  /**
   * Dynamically queries real-time gas fees from the node (Zero hardcoding)
   */
  async fetchLiveGasFee() {
    try {
      if (this.provider) {
        const gasPriceHex = await this.provider.request({ method: 'eth_gasPrice' });
        this.protocolState.liveGasPriceWei = BigInt(gasPriceHex);
      } else if (this.readOnlyProvider) {
        const feeData = await this.readOnlyProvider.getFeeData();
        this.protocolState.liveGasPriceWei = feeData.gasPrice ?? feeData.maxFeePerGas ?? null;
      }
      if (this.protocolState.liveGasPriceWei) {
        const gasPriceGwei = Number(this.protocolState.liveGasPriceWei) / 1e9;
        return {
          wei: this.protocolState.liveGasPriceWei,
          gwei: gasPriceGwei
        };
      }
      return null;
    } catch (err) {
      console.warn('Could not fetch live gas price:', err);
      return null;
    }
  }

  /**
   * Dynamically queries on-chain protocol fees from the deployed smart contract
   */
  async fetchLiveProtocolFees() {
    if (!this.contractAddress) return null;
    try {
      const calls = [
        { key: 'totalFeeBps', name: 'protocolTotalFeeBps', transform: Number },
        { key: 'creatorFeeBps', name: 'creatorFeeBps', transform: Number },
        { key: 'keeperFeeBps', name: 'keeperFeeBps', transform: Number },
        { key: 'treasuryFeeBps', name: 'treasuryFeeBps', transform: Number },
        { key: 'minBetWei', name: 'minBet', transform: BigInt },
        { key: 'lockBufferSeconds', name: 'lockBufferSeconds', transform: Number },
        { key: 'priceWindowSeconds', name: 'priceWindowSeconds', transform: Number }
      ];

      for (const item of calls) {
        try {
          const data = this.iface.encodeFunctionData(item.name, []);
          const resHex = await this.ethCall(data, this.contractAddress);
          if (resHex && resHex !== '0x') {
            const decoded = this.iface.decodeFunctionResult(item.name, resHex);
            this.protocolState[item.key] = item.transform(decoded[0]);
          }
        } catch (err) {
          console.warn(`Could not read ${item.name} from the contract:`, err);
        }
      }

      return this.protocolState;
    } catch (err) {
      return null;
    }
  }

  /**
   * Helper to dynamically estimate gas limit with a 20% safety margin
   */
  async estimateGasWithBuffer(txParams) {
    // A failed estimate means the transaction would revert: report why instead of asking the user to
    // sign a transaction that cannot succeed
    let estHex;
    try {
      estHex = await this.provider.request({
        method: 'eth_estimateGas',
        params: [txParams]
      });
    } catch (err) {
      throw new Error(this.revertReason(err));
    }
    // Monad charges the full gas limit, not gas used (SEC-25): keep the margin small
    const gasLimitWithBuffer = (BigInt(estHex) * 110n) / 100n;
    return '0x' + gasLimitWithBuffer.toString(16);
  }

  revertReason(err) {
    const data = err?.data?.data ?? err?.data ?? err?.error?.data;
    if (typeof data === 'string' && data.startsWith('0x') && data.length > 2) {
      try {
        const parsed = this.iface.parseError(data);
        if (parsed) return `The contract rejected this: ${parsed.name}`;
      } catch (_) {
        // Not a custom error of this contract; try a revert string
      }
      try {
        const [reason] = ethers.AbiCoder.defaultAbiCoder().decode(['string'], `0x${data.slice(10)}`);
        return `The contract rejected this: ${reason}`;
      } catch (_) {
        // Undecodable revert data
      }
    }
    return err?.message || 'The network could not simulate this transaction.';
  }

  /**
   * Dispatches a real transaction on Monad via MetaMask / Rabby with dynamic gas estimation
   * Supports slippage/min-odds protection (VULN-03)
   */
  async sendTradeTransaction(side, marketIdInput, roundId, amountMon, minMultiplierWad = 0n) {
    if (!this.provider || !this.account) {
      return { success: false, error: 'Wallet not connected' };
    }

    if (!this.isLiveNetwork && !(await this.switchToMonad(this.currentEnvKey))) {
      return { success: false, error: `Switch your wallet to ${this.getActiveNetworkConfig().chainName} to place a bet.` };
    }

    try {
      const valueWei = ethers.parseEther(amountMon.toString());
      const marketBytes32 = this.formatBytes32(marketIdInput);
      const isUp = side === 'UP';

      let data;
      if (minMultiplierWad && minMultiplierWad > 0n) {
        const fnName = isUp ? 'betUpWithMinOdds' : 'betDownWithMinOdds';
        data = this.iface.encodeFunctionData(fnName, [marketBytes32, roundId, minMultiplierWad]);
      } else {
        const fnName = isUp ? 'betUp' : 'betDown';
        data = this.iface.encodeFunctionData(fnName, [marketBytes32, roundId]);
      }

      const txParams = {
        from: this.account,
        to: this.contractAddress,
        value: '0x' + valueWei.toString(16),
        data: data
      };

      // Dynamically estimate gas on-chain
      txParams.gas = await this.estimateGasWithBuffer(txParams);

      this.emit('txPending', { side, amount: amountMon });

      const txHash = await this.provider.request({
        method: 'eth_sendTransaction',
        params: [txParams]
      });

      this.emit('txSuccess', { txHash, side, amount: amountMon });
      return { success: true, txHash };
    } catch (err) {
      console.error('Transaction rejected or failed:', err);
      this.emit('txError', err.message);
      return { success: false, error: err.message || 'Transaction rejected by user' };
    }
  }

  /**
   * Claim payout for a settled or cancelled round
   */
  async claimPayout(marketIdInput, roundId) {
    if (!this.provider || !this.account) return { success: false, error: 'Wallet not connected' };
    try {
      const marketBytes32 = this.formatBytes32(marketIdInput);
      const data = this.iface.encodeFunctionData('claimPayout', [marketBytes32, roundId]);

      const txParams = { from: this.account, to: this.contractAddress, data };
      txParams.gas = await this.estimateGasWithBuffer(txParams);

      const txHash = await this.provider.request({
        method: 'eth_sendTransaction',
        params: [txParams]
      });
      return { success: true, txHash };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Atomic multi-round batch claim with dynamic on-chain gas estimation
   */
  async claimBatch(marketIdInput, roundIds) {
    if (!this.provider || !this.account) return { success: false, error: 'Wallet not connected' };
    try {
      const marketBytes32 = this.formatBytes32(marketIdInput);
      const data = this.iface.encodeFunctionData('claimBatch', [marketBytes32, roundIds]);

      const txParams = { from: this.account, to: this.contractAddress, data };
      txParams.gas = await this.estimateGasWithBuffer(txParams);

      const txHash = await this.provider.request({
        method: 'eth_sendTransaction',
        params: [txParams]
      });
      return { success: true, txHash };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Emergency refund if round is unresolved past emergency timeout
   */
  async emergencyRefund(marketIdInput, roundId) {
    if (!this.provider || !this.account) return { success: false, error: 'Wallet not connected' };
    try {
      const marketBytes32 = this.formatBytes32(marketIdInput);
      const data = this.iface.encodeFunctionData('emergencyRefund', [marketBytes32, roundId]);

      const txParams = { from: this.account, to: this.contractAddress, data };
      txParams.gas = await this.estimateGasWithBuffer(txParams);

      const txHash = await this.provider.request({
        method: 'eth_sendTransaction',
        params: [txParams]
      });
      return { success: true, txHash };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Claim creator royalties
   */
  async claimCreatorFees(marketIdInput) {
    if (!this.provider || !this.account) return { success: false, error: 'Wallet not connected' };
    try {
      const marketBytes32 = this.formatBytes32(marketIdInput);
      const data = this.iface.encodeFunctionData('claimCreatorFees', [marketBytes32]);

      const txParams = { from: this.account, to: this.contractAddress, data };
      txParams.gas = await this.estimateGasWithBuffer(txParams);

      const txHash = await this.provider.request({
        method: 'eth_sendTransaction',
        params: [txParams]
      });
      return { success: true, txHash };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Permissionlessly create a market for a RedStone feed (e.g. "SUI"). New markets start unverified (SEC-08).
   */
  async createMarket(feed, name, symbol, roundDurationSec) {
    if (!this.provider || !this.account) return { success: false, error: 'Wallet not connected' };
    try {
      const data = this.iface.encodeFunctionData('createMarket', [
        ethers.encodeBytes32String(feed), name, symbol, roundDurationSec
      ]);

      const txParams = { from: this.account, to: this.contractAddress, data };
      txParams.gas = await this.estimateGasWithBuffer(txParams);

      const txHash = await this.provider.request({
        method: 'eth_sendTransaction',
        params: [txParams]
      });
      return { success: true, txHash };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Query on-chain market status directly from AMM contract
   */
  async fetchOnChainMarket(marketIdInput) {
    if (!this.contractAddress) return null;
    try {
      const marketBytes32 = this.formatBytes32(marketIdInput);
      const data = this.iface.encodeFunctionData('markets', [marketBytes32]);
      const resHex = await this.ethCall(data, this.contractAddress);
      if (!resHex || resHex === '0x') return null;
      const decoded = this.iface.decodeFunctionResult('markets', resHex);
      return {
        marketId: decoded[0],
        creator: decoded[1],
        feedId: decoded[2],
        name: decoded[3],
        symbol: decoded[4],
        roundDuration: Number(decoded[5]),
        currentRoundId: Number(decoded[6]),
        totalVolume: decoded[7],
        creatorFeesAccrued: decoded[8],
        active: decoded[9],
        verified: Boolean(decoded[10]) // SEC-08: UIs should warn on unverified markets
      };
    } catch (err) {
      return null;
    }
  }

  /**
   * Query on-chain round status directly from AMM contract
   */
  async fetchOnChainRound(marketIdInput, roundId) {
    if (!this.contractAddress) return null;
    try {
      const marketBytes32 = this.formatBytes32(marketIdInput);
      const data = this.iface.encodeFunctionData('rounds', [marketBytes32, roundId]);
      const resHex = await this.ethCall(data, this.contractAddress);
      if (!resHex || resHex === '0x') return null;
      // Read by field name: the struct is packed (SEC-25), so positions differ from the old layout
      const d = this.iface.decodeFunctionResult('rounds', resHex);
      return {
        roundId: Number(d.roundId),
        startTimestamp: Number(d.startTimestamp),
        lockTimestamp: Number(d.lockTimestamp),
        closeTimestamp: Number(d.closeTimestamp),
        betCloseTimestamp: Number(d.betCloseTimestamp),
        lockPublishTime: Number(d.lockPublishTime),
        closePublishTime: Number(d.closePublishTime),
        lockPrice: d.lockPrice,
        closePrice: d.closePrice,
        totalUp: d.totalUp,
        totalDown: d.totalDown,
        totalPool: d.totalPool,
        netPayoutPool: d.netPayoutPool,
        winningSide: Number(d.winningSide), // 0: None, 1: Up, 2: Down
        status: Number(d.status),           // 0: Inactive, 1: Open, 2: Locked, 3: Settled, 4: Cancelled
        lockKeeper: d.lockKeeper,
        feeBps: Number(d.feeBps),
        creatorFeeBps: Number(d.creatorFeeBps),
        keeperFeeBps: Number(d.keeperFeeBps),
        priceWindow: Number(d.priceWindow),
        upBettors: Number(d.upBettors),
        downBettors: Number(d.downBettors)
      };
    } catch (err) {
      return null;
    }
  }

  /**
   * Query on-chain user bet for a given round
   */
  async fetchUserBet(marketIdInput, roundId, userAddress = this.account) {
    if (!this.contractAddress || !userAddress) return null;
    try {
      const marketBytes32 = this.formatBytes32(marketIdInput);
      const data = this.iface.encodeFunctionData('userBets', [marketBytes32, roundId, userAddress]);
      const resHex = await this.ethCall(data, this.contractAddress);
      if (!resHex || resHex === '0x') return null;
      const decoded = this.iface.decodeFunctionResult('userBets', resHex);
      return {
        amount: decoded[0],
        side: Number(decoded[1]),
        claimed: decoded[2]
      };
    } catch (err) {
      return null;
    }
  }

  formatBytes32(input) {
    if (typeof input === 'string') {
      if (input.startsWith('0x')) {
        const clean = input.slice(2);
        return '0x' + clean.padEnd(64, '0').slice(0, 64);
      }
      return ethers.encodeBytes32String(input.slice(0, 31));
    }
    return ethers.ZeroHash;
  }

  disconnect() {
    this.account = null;
    this.balance = '0.00';
    this.emit('disconnected');
  }

  emit(event, data) {
    if (this.callbacks[event]) {
      this.callbacks[event](data);
    }
  }
}
