# Current context

Snapshot of where MonadPulseHouse actually stands, for picking this back up later (or for anyone
else reading the repo cold). Not a roadmap, not marketing copy — just the facts as of now.

## What this is

A fast, vault-backed Up/Down prediction market on Monad testnet. Players bet whether BTC, ETH, SOL or
MON moves up or down over a short window (10s report grid; 30s and 60s durations currently offered).
Odds move dynamically via a quadratic cost market maker per window, not a fixed multiplier. Settlement
is permissionless: anyone can submit RedStone's signed price reports on-chain to resolve a bet,
verified against a 4-of-5 threshold on RedStone's real production signer set (`redstone-primary-prod`)
— no mocked oracle. A shared LP vault backs payouts and earns the house edge; a win-streak jackpot pays
out after 5 consecutive wins (owner-tunable within bounds).

## Live deployment

- Contract: `0x166ad96101Ab324a648Ca7Ac5bcD9286E11CefDD` on Monad testnet (chain id 10143), deployed
  at block `66388022`.
- No proxy, no upgrade path — this is the final, immutable logic for this deployment. Confirmed no
  `delegatecall`/proxy pattern anywhere in the contract.
- Owner is currently a single EOA (see "Not done yet" below).

## What's been verified, and how

- **151 deterministic checks** (`npm run test:house`) covering settlement (win/lose/push/void), vault
  capacity, LP add/remove/lock, jackpot streak math, every owner-bound setter's every limit, two-step
  ownership transfer, oracle signer timelock, and real captured RedStone signatures.
- **37 app-logic checks** (`npm test`).
- **A real reentrancy attack** (`npm run test:security`), not just a guard that's assumed to work: a
  purpose-built attacker contract tries to reenter `removeLiquidity` mid-withdrawal. Confirmed blocked.
- **Live testnet money**, not just simulation: 130+ real bets and full LP add/remove cycles, with the
  solvency invariant (`held == vaultAssets + totalBalances + jackpotPot + treasury`) holding exactly
  after every single one. Two real bugs were found *only* by testing live (a deterministic suite could
  never have caught either):
  1. The keeper's scheduler silently dropped a bet if its settlement deadline had already passed by
     the time it was discovered (e.g. after a restart) — fixed in `scripts/house_keeper.js`.
  2. The keeper retried a persistently-failing send in an unthrottled ~50ms loop — fixed with a 5s
     backoff floor, same file.
  Both fixed with an actual repro, not just a code change on faith.
- **A real Monad-specific quirk that shaped several fixes:** Monad charges the full gas limit sent,
  not gas actually used. A defensive `MIN_GAS_LIMIT` floor (200,000) is applied everywhere a gas limit
  is computed from an estimate (`src/Web3Manager.js`, `scripts/house_keeper.js`, and the admin
  scripts) — this is a cautious buffer, not a fully-proven fix; see the code comments next to
  `MIN_GAS_LIMIT` in those files for exactly what is and isn't confirmed about why it's needed.

## Not done yet (real gaps, not being hidden)

- **Ownership is still a single EOA key**, not a multisig. `scripts/transfer_owner.js` exists
  specifically to move it to a Gnosis Safe (refuses anything under 2-of-n) and the two-step mechanism
  is proven both deterministically and live — it just hasn't been run yet. This is the one item worth
  treating as a hard blocker before any real money (mainnet) touches this contract. Irrelevant for a
  testnet/hackathon submission.
- `KEEPER_HEALTH_PORT` (a working `/health` endpoint on the keeper) exists but isn't wired to any
  monitoring or alerting.
- Nothing currently stops two keeper instances from running on the same private key at once — this
  happened once by accident during testing. Worth a documented rule or a simple lock before it matters.
- Never tested through an actual browser (no browser automation tool was available this session):
  wallet chooser, chart rendering, LP add/remove via the real UI.
- A live 5-win jackpot and a live void-status bet were never triggered naturally (both are
  probability/time-gated — proven only in the deterministic suite, not with real money).
- One test wallet's LP position (`lp1_STRANDED` in `wallet.json`) permanently holds shares because its
  private key was lost early in testing — this blocks ever again testing the `totalShares == 0` orphan
  -sweep path live on *this* deployment. Not a mainnet concern: a fresh deploy starts clean.
- Two odd, low-confidence observations from testing that were investigated but not fully root-caused:
  an intermittent "insufficient balance" rejection on a well-funded wallet (most likely explanation,
  with real supporting evidence: overlapping transactions racing the same wallet key — see the
  `MIN_GAS_LIMIT` comment in `scripts/house_keeper.js`), and one 150/151 regression result whose
  failure detail was lost before it could be inspected (never reproduced again across 7 retries).

## Where the feature ideas live

`HACKATHON_IDEAS.md` — a menu of additions, split into "bigger product ideas" (change what the thing
*is*: tradeable in-flight bets, LP-risk-as-a-market, user-defined markets, ladder bets) and smaller
usability/demo wins (session-key one-tap betting is the standout single change). Not a roadmap; pick
from it.
