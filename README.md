# MonadPulse

One-minute **Rise or Fall** rounds on BTC, ETH, SOL and MON, fully on-chain on Monad.

Pick a side before betting closes. The price at lock becomes the strike; one minute later the close
price decides the round. Everyone on the winning side splits the whole pool (less a 1.5% fee) in
proportion to their stake. If nobody took the other side, or the price closes exactly at the strike,
every stake is refunded.

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

- A report is accepted only if **all 5** of RedStone's primary-prod nodes signed it.
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

## Run it locally

Requires Node 22.9+ (for `--env-file-if-exists`).

```bash
npm install
npm run compile                 # contracts -> build/ and src/contracts/AMMAbi.js
cp .env.example .env

npm run dev                     # price relay (:8787) + app on http://localhost:3000, Ctrl+C stops both
```

Live mode against a local chain with simulated players:

```bash
npm run dev:chain               # prints the NEXT_PUBLIC_* values to put in .env
npm run dev
```

## Deploy to Monad testnet

```bash
# .env: DEPLOYER_PRIVATE_KEY and KEEPER_PRIVATE_KEY (fund both from the Monad faucet)
npm run deploy -- --dry-run     # pre-flight: RPC, chain id, all 5 RedStone signers live, gas estimate
npm run deploy -- --network testnet
# put the printed NEXT_PUBLIC_CONTRACT_ADDRESS and NEXT_PUBLIC_CONTRACT_DEPLOY_BLOCK in .env
npm run keeper -- --mode live --network testnet   # keep it running
npm run relay                                     # keep it running
npm run build && npm start
```

The keeper and the relay must run continuously: RedStone's free gateway does not serve past reports,
so a round's report has to be captured when it is published. A round nobody could resolve is refunded
in full after 10 minutes.

## Tests

```bash
npm run test:all        # compile + invariants + EVM integration + security regressions
npm run test:mutation   # re-injects each fixed bug; every one must be caught
```

The EVM suite includes locking a round with real RedStone reports captured from the gateway
(`test/fixtures/`).
