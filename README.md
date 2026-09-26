# MonadPulse

One-minute **Rise or Fall** rounds on BTC, ETH, SOL and MON, fully on-chain on Monad.

Pick a side before betting closes. The price at lock becomes the strike; one minute later the close
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
- **Fast blocks and low fees make one-minute rounds practical.** Each market needs a lock and a settle
  transaction every minute, plus one transaction per bet and per claim.
- **Transparency from chain data only.** The Dashboard rebuilds every bet, payout, refund and fee,
  per wallet and per round, from the contract's events over Monad RPC.
- **Permissionless markets.** Anyone can open a market for another oracle feed and earns 0.1% of its
  settled volume.

## Prices you can verify, for free

Rounds settle on signed price reports from [RedStone](https://redstone.finance)'s public data feeds,
with no API key. The contract verifies them itself (`contracts/SignedPriceOracle.sol`, our own MIT
implementation):

- A report is accepted only if at least **4 of the 5** RedStone primary-prod nodes signed it (one node
  skipping a report cannot block a round).
- The lock and close prices are **pinned** to one report timestamp per round (the first 10-second mark
  at or after lock/close time), so whoever submits it has no choice of price.
- The price is the median of the nodes' values, and the chart in the app shows exactly those values.
- The signer set can only change after a public 2-day delay.

Details and residual risks: [SECURITY_FIXES.md](SECURITY_FIXES.md) (SEC-01, 02, 21, 22, 23).

## Architecture

| Part | Path | Role |
|---|---|---|
| Contract | `contracts/MonadUpDownAMM.sol`, `contracts/SignedPriceOracle.sol` | Markets, rounds, bets, pinned settlement, fees, claims |
| App | `src/app`, `src/components`, `src/*.js` | Next.js app: canvas chart, betting console, Pulse board, Dashboard |
| Price relay | `scripts/price_relay.js` | Polls RedStone once for everyone, streams verified prices, archives signed reports |
| Keeper | `scripts/keeper_bot.js` | Captures reports as they are published; locks, settles and refunds rounds |
| Local chain | `scripts/dev_chain.js` | Ganache with the contract deployed and simulated activity |

## Live on Monad testnet

`MonadUpDownAMM` is deployed at
[`0xF4Cc741A76126cEe191D25d0ccd37c859925e03E`](https://testnet.monadexplorer.com/address/0xF4Cc741A76126cEe191D25d0ccd37c859925e03E)
with BTC, ETH, SOL and MON markets. Tested end to end in a browser with a real wallet: bets, lock and
settle on live RedStone reports, winner claims, and self-service refunds of one-sided rounds. An earlier
deployment's settled round, for reference:
[settle tx](https://testnet.monadexplorer.com/tx/0x20ab4528a2224e3e6dc658e5f05f3ece41588760f974217a159d7e8d040cfce8).

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

npm run dev:testnet             # price relay + keeper + app on http://localhost:3000; Ctrl+C stops all
```

There is one mode: every bet is a real transaction on the network in `.env` (Monad testnet today).
Without a wallet you can watch rounds, prices and the Dashboard; connect a wallet with testnet MON to bet.

For development without testnet MON, `npm run dev:chain` starts a local chain with the contract and
simulated players and prints the `NEXT_PUBLIC_*` values to use instead.

### Advanced settings (optional, not in `.env.example`)

| Variable | Default | Use |
|---|---|---|
| `NEXT_PUBLIC_RPC_URL` | `https://testnet-rpc.monad.xyz` | Another Monad RPC (e.g. the local chain) |
| `NEXT_PUBLIC_CHAIN_ID` | `10143` | Chain id matching that RPC |
| `NEXT_PUBLIC_EXPLORER_URL` | `https://testnet.monadexplorer.com` | Explorer used for transaction links |
| `NEXT_PUBLIC_MAINNET_CONTRACT_ADDRESS`, `NEXT_PUBLIC_MAINNET_DEPLOY_BLOCK` | none | Mainnet deployment |
| `PORT`, `ALLOWED_ORIGIN` | `8787`, `*` | Price relay port and the site allowed to read it (set your domain in production) |

## Deploy to Monad testnet

```bash
# .env: DEPLOYER_PRIVATE_KEY and KEEPER_PRIVATE_KEY (fund both from the Monad faucet)
npm run deploy -- --dry-run     # pre-flight: RPC, chain id, RedStone signers live, gas estimate
npm run deploy -- --network testnet
# put the printed NEXT_PUBLIC_CONTRACT_ADDRESS and NEXT_PUBLIC_CONTRACT_DEPLOY_BLOCK in .env
npm run dev:testnet   # relay + keeper + app in one terminal (development)
# production: run `npm run relay` and `npm run keeper -- --mode live --network testnet` as services,
# then `npm run build && npm start`
```

The keeper and the relay must run continuously: RedStone's free gateway does not serve past reports,
so a round's report has to be captured when it is published. If a round can't be resolved, each bettor
can claim their stake back directly after 10 minutes, without waiting for anyone else.

## Tests

```bash
npm run test:all        # compile + invariants + EVM integration + security regressions
npm run test:mutation   # re-injects each fixed bug; every one must be caught
```

The EVM suite includes locking a round with real RedStone reports captured from the gateway
(`test/fixtures/`).
