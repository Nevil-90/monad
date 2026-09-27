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
    // The wallet the user picked (EIP-1193 provider); null until one is chosen
    this.provider = null;
    this.walletInfo = null;
    // The network the app runs on (.env: NEXT_PUBLIC_CHAIN_ID); every wallet is checked against it
    this.currentEnvKey = 'testnet';
    // Installed wallets, discovered with EIP-6963 so each one is addressed directly (no fight over
    // window.ethereum between extensions, and no extension's own chooser window)
    this.wallets = new Map(); // uuid -> { info: { uuid, name, icon, rdns }, provider }
    this.discoverWallets();
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

  }

  discoverWallets() {
    if (typeof window === 'undefined') return;
    window.addEventListener('eip6963:announceProvider', (e) => {
      const { info, provider } = e.detail || {};
      if (!info?.uuid || !provider?.request) return;
      this.wallets.set(info.uuid, { info, provider });
      this.emit('walletsChanged', this.walletList());
    });
    window.dispatchEvent(new Event('eip6963:requestProvider'));
  }

  /**
   * Wallets to offer: every EIP-6963 wallet, or, for an older extension that only sets
   * window.ethereum, that one as "Browser wallet"
   */
  walletList() {
    const list = [...this.wallets.values()];
    if (!list.length && typeof window !== 'undefined' && window.ethereum?.request) {
      list.push({ info: { uuid: 'injected', name: 'Browser wallet', icon: null, rdns: 'injected' }, provider: window.ethereum });
    }
    return list;
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
    return this.walletList().length > 0;
  }

  /** Follows account and network changes of the chosen wallet only */
  initListeners() {
    if (!this.provider?.on) return;
    if (this.listening && this.listening !== this.provider) this.listening.removeListener?.('accountsChanged', this.onAccounts);
    if (this.listening && this.listening !== this.provider) this.listening.removeListener?.('chainChanged', this.onChain);
    if (this.listening === this.provider) return;
    this.listening = this.provider;
    this.onAccounts = (accounts) => {
      if (accounts.length === 0) {
        this.disconnect();
      } else {
        this.account = accounts[0];
        this.fetchBalance();
        this.emit('accountChanged', this.account);
      }
    };
    this.onChain = (chainId) => {
      this.chainId = chainId;
      this.checkNetworkMatch();
      this.fetchBalance();
      this.emit('networkChanged', { chainId, isMonad: this.isLiveNetwork });
    };
    this.provider.on('accountsChanged', this.onAccounts);
    this.provider.on('chainChanged', this.onChain);
  }

  checkNetworkMatch() {
    const targetNet = this.getActiveNetworkConfig();
    if (!this.chainId || !targetNet) {
      this.isLiveNetwork = false;
      return false;
    }
    this.isLiveNetwork = parseInt(this.chainId, 16) === targetNet.chainIdDecimal;
    return this.isLiveNetwork;
  }

  /** Plain-language reason for a wallet error (EIP-1193 / JSON-RPC codes) */
  static walletError(err, walletName = 'your wallet', networkName = 'the network') {
    const code = err?.code ?? err?.info?.error?.code ?? err?.error?.code;
    if (code === 4001 || code === 'ACTION_REJECTED') return `Cancelled in ${walletName}.`;
    if (code === -32002) return `${walletName} already has a request waiting: open the extension to approve or reject it.`;
    if (code === 4200 || code === -32601) return `${walletName} does not support this request. Add ${networkName} to it manually, or use MetaMask, Rabby or Phantom.`;
    if (code === 4100) return `${walletName} has not authorised this site. Unlock it and try again.`;
    if (code === 4900 || code === 4901) return `${walletName} is disconnected from ${networkName}. Check its network settings.`;
    return err?.shortMessage || err?.message || `${walletName} returned an error.`;
  }

  /** Reconnects a wallet chosen before, without a prompt (eth_accounts only lists authorised accounts) */
  async restoreSession() {
    let saved = null;
    try { saved = localStorage.getItem('mp.wallet'); } catch (_) { /* storage unavailable */ }
    if (!saved) return false;
    // Give wallets a moment to announce themselves
    for (let i = 0; i < 10 && !this.walletList().some((w) => w.info.rdns === saved); i++) await new Promise((r) => setTimeout(r, 100));
    const wallet = this.walletList().find((w) => w.info.rdns === saved);
    if (!wallet) return false;
    try {
      const accounts = await wallet.provider.request({ method: 'eth_accounts' });
      if (!accounts?.length) return false;
      await this.connect(wallet.info.uuid, { silent: true });
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Connects the wallet with this uuid (from walletList()). Validates what the app needs: an EVM
   * account, and the app's Monad network (switching or adding it). A wallet that stays on another
   * network is connected for viewing but cannot bet (wrongNetwork: true, with the reason).
   */
  async connect(walletId, { silent = false } = {}) {
    const wallet = this.walletList().find((w) => w.info.uuid === walletId) || (walletId ? null : this.walletList()[0]);
    if (!wallet) {
      return { success: false, error: 'No wallet found in this browser. Install MetaMask, Rabby or Phantom, then reload.' };
    }
    const name = wallet.info.name || 'your wallet';
    const targetNet = this.getActiveNetworkConfig();
    try {
      const accounts = await wallet.provider.request({ method: silent ? 'eth_accounts' : 'eth_requestAccounts' });
      if (!Array.isArray(accounts) || !accounts.length || !/^0x[0-9a-fA-F]{40}$/.test(accounts[0] || '')) {
        return { success: false, error: `${name} did not share an EVM account. Unlock it, choose an Ethereum-style (0x…) account, and try again.` };
      }
      this.provider = wallet.provider;
      this.walletInfo = wallet.info;
      this.initListeners();
      this.account = accounts[0];
      try { localStorage.setItem('mp.wallet', wallet.info.rdns); } catch (_) { /* storage unavailable */ }

      // The app's Monad network: switch to it, or add it to the wallet first
      this.chainId = await wallet.provider.request({ method: 'eth_chainId' });
      let networkError = null;
      if (parseInt(this.chainId, 16) !== targetNet.chainIdDecimal) {
        const switched = silent ? { ok: false, error: null } : await this.switchToMonad(this.currentEnvKey);
        if (switched.ok) this.chainId = targetNet.chainId;
        else networkError = switched.error || `${name} is on another network. Switch it to ${targetNet.chainName} to bet.`;
      }
      this.checkNetworkMatch();

      // 3. Fetch Real Monad Balance
      await this.fetchBalance();

      // 4. Fetch Live Protocol Fees & Gas Prices directly from chain
      await this.fetchLiveProtocolFees();
      await this.fetchLiveGasFee();

      this.emit('connected', {
        account: this.account,
        balance: this.balance,
        chainId: this.chainId,
        wallet: this.walletInfo,
        isLiveNetwork: this.isLiveNetwork,
        networkError,
        silent,
        protocolState: this.protocolState
      });

      return { success: true, account: this.account, balance: this.balance, isLiveNetwork: this.isLiveNetwork, networkError };
    } catch (err) {
      return { success: false, error: Web3Manager.walletError(err, name, targetNet.chainName) };
    }
  }

  /** SEC-19: never send a transaction to another chain. Re-reads the wallet's chain first. */
  async ensureNetwork() {
    try {
      this.chainId = await this.provider.request({ method: 'eth_chainId' });
    } catch (err) {
      return { ok: false, error: Web3Manager.walletError(err, this.walletInfo?.name) };
    }
    if (this.checkNetworkMatch()) return { ok: true };
    const switched = await this.switchToMonad(this.currentEnvKey);
    return switched.ok ? switched : { ok: false, error: `${switched.error} Transactions need ${this.getActiveNetworkConfig().chainName}.` };
  }

  /** Switches the wallet to the app's network, adding it first if the wallet does not know it */
  async switchToMonad(envKey = this.currentEnvKey) {
    const targetNet = MONAD_NETWORKS[envKey];
    const name = this.walletInfo?.name || 'your wallet';
    if (!this.provider || !targetNet) return { ok: false, error: 'No wallet connected.' };
    try {
      await this.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: targetNet.chainId }] });
    } catch (switchError) {
      const unknownChain = switchError.code === 4902 || switchError?.data?.originalError?.code === 4902 || /unrecognized|not added|unknown chain/i.test(switchError.message || '');
      if (!unknownChain) return { ok: false, error: Web3Manager.walletError(switchError, name, targetNet.chainName) };
      try {
        await this.provider.request({ method: 'wallet_addEthereumChain', params: [targetNet] });
      } catch (addError) {
        return { ok: false, error: Web3Manager.walletError(addError, name, targetNet.chainName) };
      }
    }
    // Confirm the wallet really is on it now (some wallets resolve before switching)
    this.chainId = await this.provider.request({ method: 'eth_chainId' });
    const ok = this.checkNetworkMatch();
    return ok ? { ok: true } : { ok: false, error: `${name} did not switch to ${targetNet.chainName}.` };
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
        { key: 'priceWindowSeconds', name: 'priceWindowSeconds', transform: Number },
        { key: 'bettingWindowSeconds', name: 'bettingWindowSeconds', transform: Number }
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

  isUserRejection(err) {
    const code = err?.code ?? err?.info?.error?.code ?? err?.error?.code;
    return code === 4001 || code === 'ACTION_REJECTED';
  }

  /** Readable reason for a failed send: wallet cancel/codes, or the revert reason from estimateGas */
  txError(err) {
    const name = this.walletInfo?.name || 'your wallet';
    if (err?.code === undefined && err?.message) return err.message; // our own Error from estimateGasWithBuffer
    // Some wallets reject with an empty object: no code, no message
    if (err?.code === undefined && !err?.shortMessage) return `Not sent: cancelled or rejected in ${name}.`;
    return Web3Manager.walletError(err, name);
  }

  revertReason(err) {
    const data = err?.data?.data ?? err?.data ?? err?.error?.data;
    if (typeof data === 'string' && data.startsWith('0x') && data.length > 2) {
      try {
        const parsed = this.iface.parseError(data);
        // require("...") reverts decode as the built-in Error(string): show the message, not "Error"
        if (parsed?.name === 'Error') return `The contract rejected this: ${parsed.args[0]}`;
        if (parsed?.name === 'Panic') return `The contract rejected this: internal check failed (panic 0x${parsed.args[0].toString(16)})`;
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

    const net = await this.ensureNetwork();
    if (!net.ok) return { success: false, error: net.error };

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
      // A cancel in the wallet is a normal choice, not a failure: no console error for it
      const error = this.txError(err);
      if (!this.isUserRejection(err)) console.warn('Bet not sent:', error);
      this.emit('txError', error);
      return { success: false, error };
    }
  }

  /**
   * Claim payout for a settled or cancelled round
   */
  async claimPayout(marketIdInput, roundId) {
    if (!this.provider || !this.account) return { success: false, error: 'Wallet not connected' };
    const net = await this.ensureNetwork();
    if (!net.ok) return { success: false, error: net.error };
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
      return { success: false, error: this.txError(err) };
    }
  }

  /**
   * Atomic multi-round batch claim with dynamic on-chain gas estimation
   */
  async claimBatch(marketIdInput, roundIds) {
    if (!this.provider || !this.account) return { success: false, error: 'Wallet not connected' };
    const net = await this.ensureNetwork();
    if (!net.ok) return { success: false, error: net.error };
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
      return { success: false, error: this.txError(err) };
    }
  }

  /**
   * Emergency refund if round is unresolved past emergency timeout
   */
  async emergencyRefund(marketIdInput, roundId) {
    if (!this.provider || !this.account) return { success: false, error: 'Wallet not connected' };
    const net = await this.ensureNetwork();
    if (!net.ok) return { success: false, error: net.error };
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
      return { success: false, error: this.txError(err) };
    }
  }

  /**
   * Claim creator royalties
   */
  async claimCreatorFees(marketIdInput) {
    if (!this.provider || !this.account) return { success: false, error: 'Wallet not connected' };
    const net = await this.ensureNetwork();
    if (!net.ok) return { success: false, error: net.error };
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
      return { success: false, error: this.txError(err) };
    }
  }

  /**
   * Permissionlessly create a market for a RedStone feed (e.g. "SUI"). New markets start unverified (SEC-08).
   */
  async createMarket(feed, name, symbol, roundDurationSec) {
    if (!this.provider || !this.account) return { success: false, error: 'Wallet not connected' };
    const net = await this.ensureNetwork();
    if (!net.ok) return { success: false, error: net.error };
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
      return { success: false, error: this.txError(err) };
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
        closePublishTime: Number(d.closePublishTime), // 0 until a close price is proposed
        expiryTimestamp: Number(d.expiryTimestamp),   // unresolved after this: refundable (SEC-29)
        finalizeAfter: Number(d.finalizeAfter),       // end of the challenge period for a late report (SEC-28)
        maxReportDelay: Number(d.maxReportDelay),
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

  /** Forgets the wallet in this app (the wallet itself keeps its own site permission) */
  disconnect() {
    this.account = null;
    this.balance = null;
    this.provider = null;
    this.walletInfo = null;
    try { localStorage.removeItem('mp.wallet'); } catch (_) { /* storage unavailable */ }
    this.emit('disconnected');
  }

  emit(event, data) {
    if (this.callbacks[event]) {
      this.callbacks[event](data);
    }
  }
}
