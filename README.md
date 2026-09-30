# MonadPulse

**Rise or Fall** on BTC, ETH, SOL and MON, fully on-chain on Monad. Bet any time; the house takes the
other side of every bet, so nothing waits for another player and nothing is refunded for lack of one.

1. **Call it.** Pick Rise or Fall and a length: 10, 30 or 60 seconds.
2. **The strike is set.** Your strike is RedStone's signed price at the next 10-second mark at least
   5 s after your bet lands, so nobody bets on a price they have already seen. The result is the price
   your chosen length later.
3. **Odds that move with the crowd.** Each round (market, strike time, length) has its own odds. When
   they're even a right call pays about 1.91×; the side more players back pays less and the other side
   more, from 1.60× to 2.38×. Your payout is fixed when your bet lands and shown before you confirm.
   Winnings reach your in-game balance about 2 s after the result is signed. Bet them again (**Use all**
   puts them in the stake; you pick the side) or cash out to your wallet any time. A tie returns your stake.
4. **Chase the jackpot.** Win 5 one-at-a-time bets in a row to take 25% of the streak jackpot (capped
   at 20× the smallest stake in the streak). 1% of every stake feeds the jackpot.

**How the house earns (and players are not emptied):** a 3% margin on every stake (to the vault and its
liquidity providers), 3% of each winner's profit (to the treasury, withdrawn by the owner) and 1% of every
stake to the jackpot, which goes back to players. All three are capped by the contract (margin 1–10%, win
fee at most 10% of the profit), and the odds band can never go below ~1.4×.

**Why the odds cannot be gamed:** each round's odds come from a quadratic cost market maker (a share pays
1 MON if its side wins). A bet's price depends only on where the round starts and ends, so no sequence of
bets, on either side, can lock in a profit (checked by simulation over 1.2 M random sequences and on-chain
in the tests). A bet that would move the odds past the band is refused rather than given worse odds, and
the payout you confirmed is protected: if other bets moved it by more than 2% before yours lands, the
contract refuses yours instead of paying less.

## How it works on-chain (`contracts/MonadPulseHouse.sol`)

- **Every payout is reserved.** When a bet is placed, its full payout is locked in the vault, so the
  vault can always pay every winner. One bet may win at most 2% of the free vault (the "max bet").
- **Future strike.** The contract picks the strike time itself; the bettor has no choice of price.
- **Settlement is permissionless, so the house cannot hold a winner back.** Anyone can record signed
  prices and settle bets (`recordAndSettle`); the keeper does it ~2 s after each result is signed. The
  house runs that keeper and is also the counterparty, so the app shows **Settle it yourself** on any bet
  whose result is 20 s late: it fetches the signed prices and settles from the player's wallet. A price
  missing from the oracle is replaced by the earliest recorded report up to 30 s later only after 5
  minutes (time for anyone to post the exact report), and a bet voids (stake returned) only after
  20 hours, inside the oracle's 24 h history, so a winner can always be settled as a win.
- **Streaks cannot be farmed by hedging.** Only a bet placed while you have no other bet pending counts
  toward your streak, so betting both sides at once cannot build one.
- **Liquidity providers** deposit MON for vault shares (`addLiquidity` / `removeLiquidity`). A deposit is
  priced as if every open bet loses and a withdrawal as if every open bet wins, so seeing a signed result
  before it settles gains an LP nothing (with no open bets the two prices are the same). Deposits are
  locked for an hour, and the reserve behind open bets never leaves the vault.
- **Owner powers are bounded.** Multiplier (house edge at least 1%), jackpot rules, limits, markets and
  pause. The owner cannot touch player balances, reserved payouts or pending bets; oracle signer changes
  take effect only after a public 2-day delay.

## Everything shown comes from the chain

- Multiplier, minimum bet, max bet, jackpot, vault and totals: `houseInfo()`, one contract call.
- Your in-game balance, streak and vault share: `playerInfo(address)`, one call.
- The network fee: the node's gas estimate for your exact bet (+10%, the limit it is sent with; Monad
  charges the full limit) times the chain's gas price. A bet that would fail shows the contract's reason
  before your wallet opens.
- Bets, strikes, results, jackpots and cash-outs: contract events, indexed by the relay and pushed to
  the browser (no polling).

## Prices you can verify, for free

Bets settle on signed price reports from [RedStone](https://redstone.finance)'s public data feeds, with
no API key. The contract verifies them itself (`contracts/SignedPriceOracle.sol`, our own MIT
implementation): at least **4 of the 5** RedStone primary-prod nodes must sign the report for the exact
second, and the price is the median of their values. The chart streams Coinbase's public WebSocket
(every trade, ~0.1 s); a position within 0.02% of its strike is shown as "too close to call".

## Architecture

| Part | Path | Role |
|---|---|---|
| Contract | `contracts/MonadPulseHouse.sol`, `contracts/SignedPriceOracle.sol` | Bets, vault, prices, settlement, streak jackpot |
| App | `src/app`, `src/components`, `src/*.js` | Next.js app: canvas chart, bet panel, jackpot board, Dashboard |
| Relay | `scripts/price_relay.js` | Indexes contract events (Monad WebSocket), pushes them with block height and gas price to browsers (SSE); serves signed reports by timestamp |
| Keeper | `scripts/house_keeper.js` | Event-driven: records the strike and result prices of pending bets and settles them |
| Ops | `deploy/`, `scripts/retire_contract.js`, `scripts/transfer_owner.js` | Docker image and compose file for relay + keeper; pause an old deployment; hand ownership to a Safe |
| Local chain | `scripts/dev_house_chain.js` | Ganache with the house deployed, simulated players and a local settler |

## Run it

Requires Node 22.9+ (for `--env-file-if-exists`).

```bash
npm install
npm run compile                 # contracts -> build/ and src/contracts/HouseAbi.js
cp .env.example .env            # then fill it in (see "Deploy")

npm run dev:testnet             # relay + keeper + app on http://localhost:3000; Ctrl+C stops all
```

Every bet is a real transaction on the network in `.env` (Monad testnet today). Without a wallet you can
watch prices, the jackpot and the Dashboard; connect a wallet with testnet MON to bet.

For development without testnet MON, `npm run dev:house-chain` starts a local chain with the house,
simulated players and a settler, and prints the `NEXT_PUBLIC_*` values to run the relay and app against.

### Advanced settings (optional, not in `.env.example`)

| Variable | Default | Use |
|---|---|---|
| `NEXT_PUBLIC_CHAIN_ID` | `10143` | `143` runs the app on Monad mainnet (RPC and explorer follow) |
| `NEXT_PUBLIC_RPC_URL` | the chain's public RPC | Another RPC, e.g. a paid one without the 15 requests/s limit, or the local chain |
| `NEXT_PUBLIC_EXPLORER_URL` | the chain's explorer | Explorer used for transaction links |
| `PORT`, `ALLOWED_ORIGIN` | `8787`, `*` | Relay port and the site allowed to read it; `ALLOWED_ORIGIN` is required when `NODE_ENV=production` |
| `KEEPER_HEALTH_PORT` | off | Keeper serves `GET /health` (stream status, pending bets, gas spent) |

## Deploy

```bash
# .env: DEPLOYER_PRIVATE_KEY and KEEPER_PRIVATE_KEY (fund both; faucet on testnet)
npm run deploy -- --dry-run                       # pre-flight: RPC, chain id, RedStone signers, simulated deploy
npm run deploy -- --network testnet --seed 25     # deploy, register markets, seed the vault with 25 MON
# put the printed NEXT_PUBLIC_CONTRACT_ADDRESS and NEXT_PUBLIC_CONTRACT_DEPLOY_BLOCK in .env
npm run retire -- 0xPREVIOUS_CONTRACT             # after a redeploy: pause the old one (claims stay open)

npm run house                                     # show the live rules, vault and bet range
npm run house -- --min-bet 0.1 --max-win 10       # owner: smallest bet; largest win as % of the free vault (max 10)
npm run house -- --add-liquidity 20               # owner: put more MON in the vault
npm run house -- --withdraw-treasury              # owner: collect the win fees
```

The seed sets the table limit: the largest win is 2% of the free vault, so 25 MON takes stakes up to
~0.55 MON at even odds. The minimum bet is set at deploy from the chain's gas estimate of a real bet, so the
network fee stays under 5% of the smallest bet.

### Production checklist

1. **Mainnet config:** `NEXT_PUBLIC_CHAIN_ID=143` and a dedicated RPC (`NEXT_PUBLIC_RPC_URL`); the public
   one allows 15 requests/s per IP, shared by the relay and keeper.
2. **Services:** `docker compose -f deploy/docker-compose.yml --env-file .env up -d --build` runs the relay
   and keeper with restarts and health checks. Put the relay behind HTTPS and set `ALLOWED_ORIGIN`.
3. **Owner:** create a Safe (2 of 3 or more) and run `npm run transfer-owner -- 0xSAFE`; the Safe then
   approves `acceptOwnership()`.
4. **Vault:** size it for the bets you want to take; the max bet scales with it. The keeper pays the gas
   of every settlement and warns below 1 MON.
5. **Not done by this repository:** an external audit of `MonadPulseHouse`, and RedStone's written
   confirmation that production use of the public gateway data is allowed.

### Hosting the web app on Vercel (testnet demo)

Vercel serves only the Next.js frontend. The relay and the keeper are long-running processes (an open
WebSocket, an in-memory event index, settlement timers), so they cannot run as Vercel functions: host
them on a machine that stays up (Railway, Fly, a VPS; `deploy/` has the Dockerfile) and run exactly one
keeper. Then, in Vercel, set only the public variables (`NEXT_PUBLIC_CONTRACT_ADDRESS`,
`NEXT_PUBLIC_CONTRACT_DEPLOY_BLOCK`, `NEXT_PUBLIC_PRICE_RELAY_URL` = the relay's HTTPS URL,
`NEXT_PUBLIC_PRICE_SOURCE`). `NEXT_PUBLIC_*` values are baked in at build time, so a changed relay URL needs
a redeploy: give the relay a fixed URL. Never put `DEPLOYER_PRIVATE_KEY` or `KEEPER_PRIVATE_KEY` in Vercel.

## Tests

```bash
npm run test:all        # compile + app logic + house contract on an in-memory EVM
```

The house suite checks payouts, ties, voids, the substitute price rule, streaks and the jackpot
(including hedged bets), the vault's share value, lock and reserve, owner bounds, real RedStone reports
captured from the gateway (`test/fixtures/`), and after every step that the contract holds exactly the
vault plus player balances plus the jackpot.
