# MonadPulse

30-second **Rise or Fall** rounds on BTC, ETH, SOL and MON, fully on-chain on Monad.

Pick a side before betting closes. The price at lock becomes the strike; 30 seconds later the close
price decides the round. Everyone on the winning side splits the whole pool (less a 1.5% fee) in
proportion to their stake. If nobody took the other side, or the price closes exactly at the strike,
your stake is refunded in full. Network fees for placing and claiming a bet go to Monad and are not
refundable; the app shows them before you bet.

## How it uses Monad

- **Every action is a Monad transaction.** Bets are native MON sent to `MonadUpDownAMM` on Monad
  testnet; locking, settling, claiming and refunds are contract calls. There is no off-chain order
  book or database.
- **Built for Monad's parallel execution.** Each market's rounds live in their own storage
  (`rounds[marketId][roundId]`), and the betting path never writes global counters (market volume and
  all-time winnings are updated once per settlement, not per bet). Bets on different markets therefore
  touch disjoint state and can execute in parallel. Bets into the same round share that round's pool
  totals, which is inherent to a shared pool.
- **Fast blocks and low fees make 30-second rounds practical.** Each contested round needs a lock and a
  settle transaction, plus one transaction per bet and per claim. A round settles ~5 s after it
  closes, and the app shows the verified result after ~2.5 s.
- **Push, not polling.** The relay and keeper subscribe to the contract's logs and new blocks over
  Monad's WebSocket RPC (`eth_subscribe`); browsers get events, block height and gas price pushed over
  one Server-Sent Events stream. An idle page makes no RPC requests at all.
- **Transparency from chain data only.** The Dashboard rebuilds every bet, payout, refund and fee,
  per wallet and per round, from the contract's events.
- **Permissionless markets.** Anyone can open a market for another oracle feed and earns 0.1% of its
  settled volume.

## Prices you can verify, for free

Rounds settle on signed price reports from [RedStone](https://redstone.finance)'s public data feeds,
with no API key. The contract verifies them itself (`contracts/SignedPriceOracle.sol`, our own MIT
implementation):

- A report is accepted only if at least **4 of the 5** RedStone primary-prod nodes signed it (one node
  skipping a report cannot block a round).
- Lock and close times sit on RedStone's 10-second report grid, and each price is **pinned** to the
  report signed at exactly that second, so whoever submits it has no choice of price.
- The keeper fetches that report from RedStone's free 24-hour history by timestamp ~1.5 s after it is
  signed. If it were ever unavailable, a report up to 30 s later is accepted only provisionally: for 60 s
  anyone can replace it with an earlier one, so the final price is always the earliest report anyone
  can show.
- The price is the median of the nodes' values. The browser checks the signed close report itself
  (same signers, threshold and median as the contract) to show the result before the settle
  transaction lands, marked "confirming on-chain" until it does.
- The signer set can only change after a public 2-day delay.

The chart streams Coinbase's public WebSocket (every trade, ~0.1 s); rounds are decided by RedStone's
signed prices, which agree with it to a few hundredths of a percent. A position that close to the strike
is shown as "too close to call".

Details and residual risks: [SECURITY_FIXES.md](SECURITY_FIXES.md) (SEC-01, 02, 21, 22, 23, 28, 29).

## Architecture

| Part | Path | Role |
|---|---|---|
| Contract | `contracts/MonadUpDownAMM.sol`, `contracts/SignedPriceOracle.sol` | Markets, rounds, bets, pinned settlement, fees, claims |
| App | `src/app`, `src/components`, `src/*.js` | Next.js app: canvas chart, betting console, Pulse board, Dashboard |
| Relay | `scripts/price_relay.js` | Indexes contract events (Monad WebSocket), pushes them, block height and gas price to browsers (SSE); serves signed reports by timestamp |
| Keeper | `scripts/keeper_bot.js` | Event-driven: wakes on contract events and round deadlines; locks, settles, challenges late reports, finalizes, refunds |
| Ops | `deploy/`, `scripts/retire_contract.js`, `scripts/transfer_owner.js` | Docker image and compose file for relay + keeper; retire an old deployment; hand ownership to a Safe |
| Local chain | `scripts/dev_chain.js` | Ganache with the contract deployed and simulated activity |

## Live on Monad testnet

`MonadUpDownAMM` is deployed at
[`0x31B755F6c4e319AaEAaC7f684C4c2BaB4c1AfDf2`](https://testnet.monadexplorer.com/address/0x31B755F6c4e319AaEAaC7f684C4c2BaB4c1AfDf2)
with BTC, ETH, SOL and MON markets (minimum bet 0.42 MON, so network fees stay under 5% of a bet).
Tested on testnet with real wallets and live RedStone reports: five wallets on three markets with every
payout checked to the wei (`npm run test:wallets`), a dishonest keeper's late reports replaced by the
real keeper (`npm run test:challenge`), and the whole round cycle in a browser. Older deployments are
paused with their markets deactivated; their players can still claim.

**Costs are shown, not hidden.** Monad charges the full gas limit of each transaction. The contract keeps
round starts cheap (packed storage), the app shows the network fee to bet and to claim before you bet,
warns when fees are a large share of a small stake, and claims many rounds in one transaction.
`node scripts/gas_report.js` prints the gas of every action.

Idle and one-sided markets cost nothing: such a round is replaced by the next bet, its bettors claim
their stake back directly, and the keeper only sends transactions for contested rounds.

## Run it

Requires Node 22.9+ (for `--env-file-if-exists`).

```bash
npm install
npm run compile                 # contracts -> build/ and src/contracts/AMMAbi.js
cp .env.example .env            # then fill it in (see "Deploy to Monad testnet")

npm run dev:testnet             # relay + keeper + app on http://localhost:3000; Ctrl+C stops all
```

There is one mode: every bet is a real transaction on the network in `.env` (Monad testnet today).
Without a wallet you can watch rounds, prices and the Dashboard; connect a wallet with testnet MON to bet.

For development without testnet MON, `npm run dev:chain` starts a local chain with the contract and
simulated players and prints the `NEXT_PUBLIC_*` values to use instead.

### Advanced settings (optional, not in `.env.example`)

| Variable | Default | Use |
|---|---|---|
| `NEXT_PUBLIC_CHAIN_ID` | `10143` | `143` runs the app on Monad mainnet (RPC and explorer follow) |
| `NEXT_PUBLIC_RPC_URL` | the chain's public RPC | Another RPC, e.g. a paid one without the 15 requests/s limit, or the local chain (its WebSocket URL is derived) |
| `NEXT_PUBLIC_EXPLORER_URL` | the chain's explorer | Explorer used for transaction links |
| `PORT`, `ALLOWED_ORIGIN` | `8787`, `*` | Relay port and the site allowed to read it; `ALLOWED_ORIGIN` is required when `NODE_ENV=production` |
| `KEEPER_HEALTH_PORT` | off | Keeper serves `GET /health` (stream status, balance, gas spent vs rewards) |

## Deploy

```bash
# .env: DEPLOYER_PRIVATE_KEY and KEEPER_PRIVATE_KEY (fund both; faucet on testnet)
npm run deploy -- --dry-run     # pre-flight: RPC, chain id, RedStone signers and history, minBet from gas
npm run deploy -- --network testnet
# put the printed NEXT_PUBLIC_CONTRACT_ADDRESS and NEXT_PUBLIC_CONTRACT_DEPLOY_BLOCK in .env
npm run retire -- 0xPREVIOUS_CONTRACT   # after a redeploy: pause the old one (claims stay open)
```

### Production checklist

1. **Mainnet config:** `NEXT_PUBLIC_CHAIN_ID=143` and a dedicated RPC (`NEXT_PUBLIC_RPC_URL`); the public
   one allows 15 requests/s per IP, shared by the relay and keeper.
2. **Services:** `docker compose -f deploy/docker-compose.yml --env-file .env up -d --build` runs the relay
   and keeper with restarts and health checks. Put the relay behind HTTPS and set `ALLOWED_ORIGIN` to the
   app's origin. Host the app itself (`npm run build && npm start`) on any Next.js host; it sends
   security headers (no framing, no sniffing, HSTS).
3. **Owner:** create a Safe (2 of 3 or more) and run `npm run transfer-owner -- 0xSAFE`; the Safe then
   approves `acceptOwnership()`. The owner cannot touch pool money either way (SEC-16).
4. **Keeper funds:** it pays ~0.05 MON per contested round and earns 0.1% of the pool; top it up from
   treasury fees. It warns below 1 MON and reports its net on `/health` (SEC-11).
5. **Not done by this repository:** an external audit (SEC-17) and RedStone's written confirmation that
   production use of the public gateway data is allowed (SEC-23).

## Tests

```bash
npm run test:all        # compile + app logic + EVM integration + security regressions
npm run test:mutation   # re-injects each fixed bug; every one must be caught
npm run test:fuzz       # random actions by players, keepers and owner; solvency and exact payouts after every step
npm run test:wallets    # testnet, keeper running: 8 wallets on both sides, 3 markets, payouts to the wei
npm run test:rounds     # testnet, keeper running: 7 bets in one block; 3 rounds in a row claimed in one transaction
npm run test:challenge  # testnet, keeper stopped: late reports replaced by the keeper
```

The EVM suite includes locking a round with real RedStone reports captured from the gateway
(`test/fixtures/`).
