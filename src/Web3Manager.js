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
import { HOUSE_ABI } from './contracts/HouseAbi.js';
import { MonadRpcProvider } from './rpc.js';

// A handful of sends were seen rejected as "Signer had insufficient balance" on well-funded wallets on
// Monad testnet; retesting the identical call later succeeded, so it wasn't really about the gasLimit
// value. Best evidence (from a separately reproduced, related case - see house_keeper.js): overlapping
// transactions from the same wallet key (another script or process active on it at the same time) can
// leave the node's balance/nonce view briefly inconsistent. Not proven beyond that, but MIN_GAS_LIMIT
// is kept as a cheap defensive buffer regardless, applied everywhere a gas limit is computed here.
const MIN_GAS_LIMIT = 200_000n;

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
    this.iface = new ethers.Interface(HOUSE_ABI);

    // Dynamically initialized from active environment configuration
    this.contractAddress = getConfig().contractAddress;
    this.currentEnvKey = 'testnet';

    try {
      this.readOnlyProvider = new MonadRpcProvider(getConfig().rpcUrl, getConfig().chainId);
    } catch (_) {
      this.readOnlyProvider = null;
    }

    // Live gas price, read on demand
    this.protocolState = { liveGasPriceWei: null };
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

      // 4. Live gas price from the chain
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

  /** Reads view functions of the house contract in parallel: { name: value } (a failed read throws) */
  async readViews(names, args = {}) {
    if (!this.contractAddress) throw new Error('No contract address configured (NEXT_PUBLIC_CONTRACT_ADDRESS).');
    const entries = await Promise.all(names.map(async (name) => {
      const data = this.iface.encodeFunctionData(name, args[name] || []);
      const hex = await this.ethCall(data, this.contractAddress);
      const out = this.iface.decodeFunctionResult(name, hex);
      return [name, out.length === 1 ? out[0] : out];
    }));
    return Object.fromEntries(entries);
  }

  /** House rules and vault state, one call (houseInfo; fields by name, bigints as returned) */
  async fetchHouse() {
    const { houseInfo, maxWinBps } = await this.readViews(['houseInfo', 'maxWinBps']);
    return { ...houseInfo.toObject(), maxWinBps };
  }

  /**
   * What a bet placed now would get, from the contract (odds move with the betting in each window):
   * { payout, grossPayout, startTs, priceBps, upShares, downShares, refused }
   */
  async fetchQuote(marketId, side, duration, stakeWei) {
    const { quote } = await this.readViews(['quote'], { quote: [marketId, side === 'UP' ? 1 : 2, duration, stakeWei] });
    return quote.toObject();
  }

  /** The connected wallet's in-game balance, streak and vault position, one call (playerInfo) */
  async fetchPlayer(account = this.account) {
    return (await this.readViews(['playerInfo'], { playerInfo: [account] })).playerInfo;
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
    // Monad charges the full gas limit, not gas used (SEC-25): keep the margin small. See MIN_GAS_LIMIT
    // above for the (unconfirmed) defensive floor applied on top of that margin.
    const buffered = (BigInt(estHex) * 110n) / 100n;
    const gasLimitWithBuffer = buffered > MIN_GAS_LIMIT ? buffered : MIN_GAS_LIMIT;
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
   * Sends a call to the house contract: network check, gas estimate (a revert is reported with its
   * reason before the wallet opens), then the wallet's confirmation. A cancel is not an error log.
   */
  async sendContractTx(fn, args, valueWei = 0n, { onPending } = {}) {
    if (!this.provider || !this.account) return { success: false, error: 'Wallet not connected' };
    const net = await this.ensureNetwork();
    if (!net.ok) return { success: false, error: net.error };
    try {
      const txParams = {
        from: this.account,
        to: this.contractAddress,
        value: '0x' + BigInt(valueWei).toString(16),
        data: this.iface.encodeFunctionData(fn, args)
      };
      txParams.gas = await this.estimateGasWithBuffer(txParams);
      onPending?.();
      const txHash = await this.provider.request({ method: 'eth_sendTransaction', params: [txParams] });
      return { success: true, txHash };
    } catch (err) {
      const error = this.txError(err);
      if (!this.isUserRejection(err)) console.warn(`${fn} not sent:`, error);
      return { success: false, error, cancelled: this.isUserRejection(err) };
    }
  }

  /**
   * Places a bet: `walletWei` sent from the wallet plus `balanceWei` from the in-game balance.
   * minPayoutWei guards against the odds moving (other bets in the window) between the quote and inclusion.
   */
  async placeBet({ side, marketId, duration, walletWei, balanceWei, minPayoutWei }) {
    const res = await this.sendContractTx(
      'placeBet',
      [marketId, side === 'UP' ? 1 : 2, duration, balanceWei, minPayoutWei],
      walletWei,
      { onPending: () => this.emit('txPending', { side, amount: Number(ethers.formatEther(walletWei + balanceWei)) }) }
    );
    if (res.success) this.emit('txSuccess', { txHash: res.txHash, side, amount: Number(ethers.formatEther(walletWei + balanceWei)) });
    return res;
  }

  /**
   * Network fee of a bet, from the chain: eth_estimateGas for this exact call from this wallet, with
   * the same +10% margin the transaction is sent with (Monad charges the full gas limit), times the
   * chain's gas price. Returns { gasLimit, gasPriceWei, feeWei }; throws with the revert reason if the
   * bet would fail.
   */
  async estimateBetFee({ side, marketId, duration, walletWei, balanceWei, minPayoutWei }, gasPriceWei = null) {
    if (!this.account || !this.readOnlyProvider) throw new Error('Connect a wallet to estimate the network fee.');
    const tx = {
      from: this.account,
      to: this.contractAddress,
      value: walletWei,
      data: this.iface.encodeFunctionData('placeBet', [marketId, side === 'UP' ? 1 : 2, duration, balanceWei, minPayoutWei])
    };
    let est;
    try {
      est = await this.readOnlyProvider.estimateGas(tx);
    } catch (err) {
      // ethers puts the revert data on err.data; keep its short message otherwise
      throw new Error(this.revertReason({ data: err?.data, message: err?.shortMessage || err?.message }));
    }
    const buffered = (est * 110n) / 100n;
    const gasLimit = buffered > MIN_GAS_LIMIT ? buffered : MIN_GAS_LIMIT;
    const price = gasPriceWei ?? (await this.readOnlyProvider.getFeeData()).gasPrice;
    if (!price) throw new Error('The network did not return a gas price.');
    return { gasLimit, gasPriceWei: price, feeWei: gasLimit * price };
  }

  /**
   * Settle bets from this wallet (settlement is permissionless): records the signed prices it needs,
   * then settles. For when the keeper is late or absent; costs this wallet the network fee.
   */
  settleBets(updates, betIds) {
    return this.sendContractTx('recordAndSettle', [updates, betIds]);
  }

  /** Cash out: the in-game balance to the wallet (0 = all of it) */
  withdrawBalance(amountWei = 0n) {
    return this.sendContractTx('withdrawBalance', [amountWei]);
  }

  addLiquidity(amountWei) {
    return this.sendContractTx('addLiquidity', [], amountWei);
  }

  removeLiquidity(shares) {
    return this.sendContractTx('removeLiquidity', [shares]);
  }

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
