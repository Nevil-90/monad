# Security Fixes Checklist

> **Scope note (2026-09-27):** the findings below were for the retired pari-mutuel rounds contract
> `MonadUpDownAMM`, which has been removed from this repository in favour of `MonadPulseHouse`. The
> oracle findings (SEC-01/02, 21, 22, 23, 27, 28) still apply because `SignedPriceOracle.sol` is shared;
> the others are kept as history. The test commands listed below refer to suites that were removed with
> that contract. `MonadPulseHouse` is covered by `npm run test:house`; SEC-30 is its first finding.

## MonadPulseHouse

| ID | Severity | Finding | Status | Regression test |
|---|---|---|---|---|
| SEC-30 | High | Void/push refunded the full stake from `vaultAssets`, which had only ever received `stake - jackpotCut` for that bet; the jackpot cut leaked from the LP vault into the jackpot pot on every void/push | ✅ Fixed | `test:house` solvency checks |

### SEC-30: Jackpot cut leaked from the vault on void/push (High) ✅
**Bug.** `placeBet` splits every stake into `toVault = stake - cut` (credited to `vaultAssets`) and `cut` (credited to `jackpotPot`). But `_settle` refunded the *full* `stake` from `vaultAssets` on `Push` and `Void` ("a bet whose price never appears is void ... and its stake is returned"). Since `vaultAssets` for that bet only ever grew by `toVault`, every void or push quietly transferred `cut` from the LP vault to the jackpot pot, on top of the cut already taken. This broke the documented solvency invariant ("the vault can always pay every winner") over time: `vaultAssets` decayed independently of `lockedPayouts`, and enough voids/pushes could eventually make `vaultAssets -= paid` underflow and revert, permanently stalling settlement (and the stake) of whatever bet triggered it. Confirmed with `test:house`: the jackpot pot grew across the void test even though the voided bet's full stake was refunded and no jackpot was won.
**Fix.** Each `Bet` now stores the `cut` taken at placement. On `Push`/`Void`, that cut is returned from `jackpotPot` to `vaultAssets` (capped at the pot's current balance, in case earlier jackpot payouts already spent it) before the stake is debited, so the vault only ever nets `-(stake - cut)` for a bet that never played, matching what it actually received.
**Files.** `contracts/MonadPulseHouse.sol` (`Bet.cut`, `placeBet`, `_settle`)
**Test.** `test:house`'s per-step solvency invariant (`held == vault + balances + pot + treasury`) still holds; the void/push cases now show the pot's growth net of the returned cut instead of retaining it.

Tracks every security finding for `MonadUpDownAMM`: what was wrong, what changed, and which test proves it is still fixed. Update this file whenever a finding is fixed, reopened, or regresses.

## How to verify

```bash
npm run test:all        # compile + app logic + EVM integration + security regressions
npm run test:mutation   # re-injects each fixed bug and confirms the regression suite catches it
npm run test:fuzz       # randomized stateful test: solvency, exact payouts, no refund-then-settle (SEC-17)
npm run test:wallets    # testnet: 5 real wallets play 3 markets, payouts checked to the wei (needs the keeper)
npm run test:challenge  # testnet: a dishonest late report is replaced by the keeper (SEC-28; keeper must be stopped)
```

- `test/security_regressions.test.js` prints one `[PASS]/[FAIL] [SEC-xx]` line per check. **Any `[FAIL] [SEC-xx]` means that bug has come back.** Set its status to `Regressed` below and add a history entry.
- `scripts/mutation_check.js` re-introduces the original bug for each covered finding. If it prints `[MISSED]`, the regression test for that finding has become too weak and must be strengthened.

## Status legend

| Status | Meaning |
|---|---|
| ✅ Fixed | Code fixed, regression test in place, caught by the mutation check |
| 🟡 Partial | Contract side fixed; off-chain / operational follow-up still needed |
| ⬜ Open | Not fixed yet |
| ➖ Won't fix | Accepted risk, reason documented |
| 🔴 Regressed | Was fixed, a test now fails. Fix before any deploy |

## Summary

| ID | Severity | Finding | Status | Regression test | Mutation-checked |
|---|---|---|---|---|---|
| SEC-01 | Critical | Settle could reuse the stale stored lock price, so losers could force a "tie" refund | ✅ Fixed | `[SEC-01]` | ✅ |
| SEC-02 | Critical | Keeper could cherry-pick lock/close prices from a ~60s staleness window | ✅ Fixed | `[SEC-02]` | ✅ |
| SEC-03 | High | Hostile locker contract could burn gas on the bounty push and block settlement | ✅ Fixed | `[SEC-03]` | ✅ |
| SEC-04 | Medium | Late lock/settle auto-cancelled the round, giving losers a refund option | ✅ Fixed | `[SEC-04]` | via SEC-01/02 |
| SEC-05 | Medium | Owner parameter changes hit in-flight rounds; `lockBuffer ≥ duration` bricked betting | ✅ Fixed | `[SEC-05]` | ✅ |
| SEC-06 | Medium | No emergency pause or market deactivation | ✅ Fixed | `[SEC-06]` | ✅ |
| SEC-07 | Low | Single-step ownership transfer (a typo loses admin forever) | ✅ Fixed | `[SEC-07]` | ✅ |
| SEC-08 | Medium | Market spoofing: any feed can be listed under any name/symbol | 🟡 Partial | `[SEC-08]` | — |
| SEC-09 | Critical (latent) | Re-creating a deactivated market would reset its round counter over live storage | ✅ Fixed | `[SEC-09]` | ✅ |
| SEC-10 | Medium | Private keys accepted as CLI args (leak to shell history / `ps`) | ✅ Fixed | `[SEC-10]` | — (static check) |
| SEC-11 | Medium | Keeper economics: bounty often below gas on small pools; minBet far below network fees | 🟡 Partial | deploy pre-flight | — |
| SEC-12 | Info | Rounding dust (< 1 wei per winning claim) stays in the contract | ➖ Won't fix | — | — |
| SEC-13 | Info | "AntiScrapeShield" / "CircuitBreaker" are browser-only, not security controls | ➖ Won't fix | — | — |
| SEC-14 | Medium | JS simulation scripts model the old contract, not the fixed one | ✅ Fixed | — (scripts removed) | — |
| SEC-15 | Medium | Market-hours feeds (equities/FX) have no price outside hours, so rounds stall until emergency timeout | ⬜ Open | — | — |
| SEC-16 | High (ops) | Owner is a single EOA; no timelock | 🟡 Partial | `[SEC-16]` | — |
| SEC-17 | High (process) | No external audit; no fuzz/invariant tests | 🟡 Partial | `test:fuzz` | — |
| SEC-18 | Low | Settle costs ~505k gas (next-round storage writes); keeper used a fixed 350k limit | ✅ Fixed | `[SEC-25]` | — |
| SEC-19 | Medium | Bet sent even when switching the wallet to Monad failed (tx went to whatever chain the wallet was on) | ✅ Fixed | — (manual, browser) | — |
| SEC-20 | Medium | Silent fallbacks replaced real data with invented or wrong values (see details) | ✅ Fixed | — (manual + script runs) | — |
| SEC-21 | Medium | Free oracle gateway keeps no past reports: an uncaptured round could only refund after 2 h | ✅ Fixed | `[SEC-21]` | ✅ |
| SEC-22 | High | Oracle signer set is owner-controlled: an instant swap would let the owner forge prices | ✅ Fixed | `[SEC-22]` | ✅ |
| SEC-24 | Medium (ops) | Idle markets needed a keeper transaction every minute (~6 MON/hour for 4 markets) | ✅ Fixed | `[SEC-24]` | ✅ |
| SEC-25 | Medium (cost) | Monad charges the full gas LIMIT: +20%/+30% margins and a 10-slot Round struct overcharged every user and the keeper | ✅ Fixed | `[SEC-25]` (gas budgets) | — |
| SEC-26 | Medium | "100% refund" ignored network fees, and refunds depended on someone else's transaction | ✅ Fixed | `[SEC-26]` | ✅ |
| SEC-27 | Medium (liveness) | Requiring all 5 oracle signatures left contested rounds unsettleable when one node skipped a report | ✅ Fixed | EVM `4-of-5` checks | via SEC-02 |
| SEC-28 | High (liveness) | Free gateway serves only the latest report through a rate-limited CDN: ~12% of 10 s timestamps are never observable, so their rounds can only be refunded | ✅ Fixed | `[SEC-28]`, `test:challenge` | ✅ |
| SEC-29 | Critical | A timed-out round was refundable and still settleable: refunded stakes were paid again to winners, out of other rounds' money; the owner could also move the timeout of in-flight rounds | ✅ Fixed | `[SEC-29]`, `test:fuzz` | ✅ |
| SEC-23 | High (legal) | RedStone's own contract library is BUSL-1.1; free production use of its data is unconfirmed | 🟡 Partial | — | — |

---

## Details

### SEC-01: Stale-price forced tie (Critical) ✅
**Bug.** `settleRound()` read Pyth's *stored* price via `getPriceNoOlderThan(id, 60)`. With 30–60s rounds, if nobody pushed a new update after lock, the stored price was still the lock price. A losing bettor called `settleRound()` right at close, `closePrice == lockPrice` counted as a tie, and every bettor got a 100% refund. Losers could void any round they were losing.
**Fix.** Removed `lockRound()` / `settleRound()` (the no-update versions). Lock and settle now *require* signed reports for the round's pinned timestamp. They never read stored state. Settle also requires `closePublishTime > lockPublishTime`. (Since 2026-09-26 the reports are RedStone's, verified in `SignedPriceOracle.sol`; see SEC-22.)
**Files.** `contracts/MonadUpDownAMM.sol` (`settleRoundWithUpdate`, `_pinnedPrice`), `contracts/SignedPriceOracle.sol`
**Test.** `[SEC-01]`: no stored-price settle function exists in the ABI; empty update reverts; replaying the lock update as the close reverts; a pre-close price reverts.

### SEC-02: Keeper price selection (Critical) ✅
**Bug.** Lock was allowed anywhere in `[lockTs, lockTs+30s]` and settle in `[closeTs, closeTs+120s]`, each with any price ≤ 60s old. A bettor running a keeper chose favourable prices from a window larger than the round, including lock prices already known before betting closed.
**Fix.** Each price is pinned to one report timestamp: the first multiple of `priceWindow` (10 s, RedStone's publishing interval) at or after the round's `lockTimestamp` / `closeTimestamp`. Every submitted report must carry exactly that timestamp, and **all** authorised signers must sign (5 of 5 by default), so the keeper can choose neither the time nor which nodes' values form the median. Who calls and when no longer matters. (Originally built on Pyth's `parsePriceFeedUpdatesUnique`; moved to RedStone on 2026-09-26.) `closeTimestamp` is now the fixed `lockTimestamp + roundDuration`; it is no longer reset at lock time. Publish times are stored in `round.lockPublishTime` / `round.closePublishTime` for auditability.
**Files.** `MonadUpDownAMM.sol` (`_pinnedPrice`, `lockReportTimestamp`, `closeReportTimestamp`), `SignedPriceOracle.sol` (`_verifiedMedian`), `scripts/keeper_bot.js`
**Test.** `[SEC-02]`: pre-lock reports, next-mark reports, a set mixing timestamps, other-feed reports and a chosen 3-of-5 subset are all rejected. A late lock still gets the exact pinned price. The settler can't substitute a later, favourable price. `test/contract_evm.test.js` also locks a round with real reports captured from RedStone's gateway.
- [ ] Confirm Hermes `GET /v2/updates/price/{publish_time}` returns the first update at/after that time. The keeper pre-checks and the contract enforces it, so a wrong update only reverts and loses no funds.

### SEC-03: Gas-griefing locker (High) ✅
**Bug.** At settle, the keeper bounty was pushed to `lockKeeper` with an unbounded `.call`. An attacker locked from a contract whose `receive()` burns all gas it gets (63/64 of the tx). Every honest settle ran out of gas; Monad charges for the gas *limit*. The round then auto-cancelled after 120s: a free refund option for the attacker.
**Fix.** Bounties are credited to `keeperRewards[addr]` and withdrawn with `claimKeeperRewards()`. Settlement makes no external call to the locker.
**Files.** `MonadUpDownAMM.sol` (`_distributeFees`, `claimKeeperRewards`), `contracts/test/HostileKeeper.sol` (test-only attacker), `scripts/keeper_bot.js` (claims bounties each cycle)
**Test.** `[SEC-03]`: with a gas-burning `HostileKeeper` as the locker, an honest settle succeeds with an 800k gas limit and both shares are credited.

### SEC-04: Deadline-lapse refunds (Medium) ✅
**Bug.** Locking after `lockTs + maxLockDelay` or settling after `closeTs + maxSettleDelay` cancelled the round. Losing parties benefited from delays (see SEC-03).
**Fix.** Because prices are pinned (SEC-02), lateness gives nobody an option, so the late-cancel rule was removed. Removed parameters: `maxLockDelay`, `maxSettleDelay`, `oracleMaxStaleness` (replaced by `priceWindowSeconds`). Truly stuck rounds still fall back to `emergencyRefund` after `emergencyTimeout`.
**Test.** `[SEC-04]`: a lock 200s late and a settle 600s late both resolve at the pinned prices with the correct winner.

### SEC-05: Owner params affect live rounds (Medium) ✅
**Bug.** `lockBufferSeconds` and the oracle tolerances were read live, so owner changes applied to rounds already accepting bets. `lockBuffer = 60` on a 30s market left no betting window.
**Fix.** Each round snapshots `betCloseTimestamp` and `priceWindow` at start. Both are clamped to `roundDuration / 2`, so betting always has a window and the lock/close price windows can't overlap. `setProtocolParameters` is now `(lockBuffer, priceWindow, emergencyTimeout, minBet)`, and changes apply to future rounds only.
**Test.** `[SEC-05]`: an in-flight round is unchanged by parameter updates; a 30s market clamps to 15s and still accepts bets; non-owners are rejected.

### SEC-06: No pause (Medium) ✅
**Fix.** `setPaused(bool)` blocks new bets and new markets only. Lock, settle, refunds and claims always work, so the owner can never freeze funds. `setMarketActive(id, bool)` retires a market: its in-flight round can still resolve, but no new round is chained. After reactivation anyone can call `startRound()`.
**Test.** `[SEC-06]`

### SEC-07: Two-step ownership (Low) ✅
**Fix.** `transferOwnership()` sets `pendingOwner`; the new owner must call `acceptOwnership()`.
**Test.** `[SEC-07]`

### SEC-08: Market spoofing (Medium) 🟡
**Bug.** `createMarket` is permissionless, so a scammer can list "BTC/USD" backed by an illiquid, manipulable feed.
**Done.** Added a `Market.verified` flag (default `false`, owner-only `setMarketVerified`). `Web3Manager.fetchOnChainMarket` now returns `verified`.
**Remaining.**
- [ ] UI: show only verified markets by default, with a clear warning on unverified ones.
- [ ] Deploy script: call `setMarketVerified` for the canonical markets in `src/config.js`.

### SEC-09: Market re-creation overwrite (Critical, latent) ✅
**Bug.** Found while adding SEC-06. `createMarket` checked existence with `!markets[id].active`. Once markets could be deactivated, anyone could re-create one; that reset `currentRoundId` to 0 and restarted round 1 on top of existing round storage and bets.
**Fix.** Existence is now keyed on `creator != address(0)`.
**Test.** `[SEC-09]`

### SEC-10: Private keys on the command line (Medium) ✅
**Fix.** `keeper_bot.js` and `deploy.js` read keys only from `KEEPER_PRIVATE_KEY` / `DEPLOYER_PRIVATE_KEY`. Passing `--private-key` now exits with an error.
**Test.** `[SEC-10]`: static source check.

### SEC-11: Keeper economics (Medium) 🟡
Measured 2026-09-26 at 102 gwei: a contested round costs the keeper ~0.05 MON (lock 0.019 + settle 0.031–0.042); its reward is 0.1% of the pool, so it breaks even only at ~50 MON per round. The whole 1.5% fee covers keeping at pools of ~3.5 MON and up. One-sided and empty rounds cost the keeper nothing (SEC-24/26).
- [x] `minBet` is set at deploy from the live gas price so network fees to bet and claim are at most 5% of the smallest bet (0.42 MON at 102 gwei). The deploy pre-flight prints it; the owner re-tunes it with `setProtocolParameters` as gas moves.
- [x] Decision: the operator runs the keeper and funds it from treasury fees. The keeper reports gas spent, rewards claimed and net result in its log and on `/health`, and warns below 1 MON.
- [ ] Business decision left to the operator: a higher keeper share, or a treasury subsidy schedule, once real volumes are known.

### SEC-12: Rounding dust (Info) ➖
Payouts round down, leaving < 1 wei per winning claim in the contract. Tracking it would need a global liabilities counter written on every bet, which serializes bets under Monad's parallel execution. The amount is economically irrelevant.

### SEC-13: Client-side "security" modules (Info) ➖
`src/AntiScrapeShield.js` and `src/CircuitBreaker.js` run in the browser, and anyone can call the contract directly. Treat them as UX only; never rely on them for protection. The UI redesign removed the claims that overstated them ("80/80 SECURE", "DEFENSE ARMED") and the honeypot element with its fake "admin key" text.

### SEC-14: Stale simulation models (Medium) ✅
Retired: the JS models of the old contract are gone; `test/invariant_fuzz.test.js` (SEC-17) and the EVM suites test the real compiled contract.


### SEC-15: Market-hours feeds (Medium) ⬜
For equity/FX feeds there is no Pyth price outside trading hours, so rounds can't lock or settle and wait for `emergencyTimeout` (≥ 30 min).
- [ ] Restrict `createMarket` to 24/7 feeds (allowlist), or add a market schedule.

### SEC-16: Admin key (High, ops) 🟡
**What the owner can do:** change fees (≤ 10%) and timing parameters, pause new bets and markets, deactivate or verify markets, withdraw treasury fees, and propose an oracle signer change (applies after 2 days, SEC-22).
**What it cannot do:** touch pool money. Fees, timing and expiry are snapshotted per round, pause never blocks lock, settle, refunds or claims, and withdrawals only take accrued fees. `[SEC-16]` uses every owner power at once mid-round and checks the winner is still paid in full at the round's own 1.5%.
- [x] `npm run transfer-owner -- 0xSAFE` hands ownership to a Safe: refuses a plain wallet or a 1-of-n Safe, starts the two-step transfer and prints the `acceptOwnership()` transaction for the Safe's signers.
- [ ] Operator: create the Safe (2 of 3 or more, keys on separate devices) and run the handover right after the mainnet deploy.

### SEC-17: Audit & fuzzing (High, process) 🟡
- [x] `test/invariant_fuzz.test.js` (`npm run test:fuzz`): random players, keepers and owner actions against the compiled contract (bets, whole rounds, pinned / late / too-late reports with random 4- or 5-signer sets, ties, challenges, finalize, emergency refunds, claims, batch claims, fee and parameter changes, pause, withdrawals). After every step: balance ≥ everything owed; balance − owed ≤ 1 wei per winning bet; every payout equals the formula; a round anyone was refunded from never settles. Seeds 1, 2, 3, 7, 11 and 20260926 all hold (6–16 settled rounds per run); at the end every account withdraws and at most a few wei of rounding dust remain.
- [ ] External audit before mainnet (needs a budget and an auditor: the operator's call).

### SEC-18: Settle gas cost (Low) 🟡
Settle is ~505k gas because it also writes the next round's storage. The keeper previously used a fixed 350k limit, which would have failed; it now uses `estimateGas × 1.3`.
- [ ] Optional: pack `Round` (uint64 timestamps, uint16 bps) to cut settle gas roughly in half.

### SEC-19: Bet sent after a failed network switch (Medium) ✅
`sendTradeTransaction` ignored the result of `switchToMonad`, so a user whose wallet refused the switch still signed a bet on the wrong chain. It now stops with "Switch your wallet to Monad Testnet to place a bet." A failed gas estimate now shows the contract's revert reason instead of asking the user to sign a transaction that cannot succeed.

### SEC-20: Silent fallbacks (Medium) ✅
Failures used to be hidden behind substitute values. Each one now fails visibly instead:
- [x] Keeper: when the contract was unreachable it simulated a made-up round (#1042, 2,500 MON pool) and added fake bounties to its totals, then printed "100% OPERATIONAL". It now refuses to start without a deployed contract, logs per-market errors, and reports only confirmed transactions (reward = measured `keeperRewards` delta). No invented 1-wei Pyth fee, no default fee/gas values.
- [x] Deploy: without `DEPLOYER_PRIVATE_KEY` it silently switched to a dry run and printed unchecked fee "[OK]"s. It now errors unless `--dry-run` is given, and the dry run's checks (chain id, Pyth code, deploy gas estimate) must pass.
- [x] Config: the default contract address pointed at an address with no AMM deployed; mainnet reused the testnet contract and Pyth addresses; unknown networks became testnet. None of these have defaults now (see `.env.example`).
- [x] UI: hardcoded 24h changes, fee values invented when the contract read failed, a `0.00` balance when the balance was unknown, and a price feed that switched to Binance on its own. Unknown values now show "—", and the price source is explicit.

### SEC-21: No past oracle reports (Medium) ✅
**Issue.** Settlement moved to RedStone's free gateway (no API key), which serves only the latest report set, every 10 s, published about 12 s after its timestamp. A report that nobody captured can never be fetched later, so the round cannot be locked or settled. With the old 2-hour `emergencyTimeout`, its bettors' funds sat idle and the market stopped for 2 hours.
**Fix.** `emergencyTimeout` defaults to 10 minutes (range 5 min–24 h). The keeper runs continuously and archives every report (`scripts/lib/report_archive.js`); the relay keeps its own archive and serves it at `/reports`, so anyone can lock or settle. The keeper also calls `emergencyRefund` on rounds past the timeout so markets keep moving.
**Residual.** If a round's report is captured by nobody at all, the round is refunded in full. A losing bettor who is the *only* party holding the report could withhold it to force that refund; running the keeper and the relay (two independent archives) makes this impractical.
**Test.** `[SEC-21]`: default is 10 min; refund is refused before, allowed after; the market chains a new round.

### SEC-22: Owner-controlled oracle signers (High) ✅
**Issue.** Our own verifier (`SignedPriceOracle.sol`) checks signatures against a signer list stored in the contract. An owner able to replace that list instantly could add their own key and settle any round at a forged price.
**Fix.** Signers change only through `proposeOracleSigners` → a public `OracleSignersProposed` event → `applyOracleSigners` after `ORACLE_CHANGE_DELAY` (2 days), cancellable. The threshold must be a strict majority. Users have two days to stop betting before any change applies. Default set: RedStone's 5 primary-prod nodes, 4 required (SEC-27).
**Test.** `[SEC-22]`: non-owner can't propose; a minority threshold is rejected; an immediate apply reverts; reports from the proposed key are rejected while pending; a cancelled proposal can't be applied; a legitimate rotation applies after 2 days.
**Before mainnet.**
- [ ] Put the owner behind a multisig as well (SEC-16).

### SEC-25: Gas is charged on the limit (Medium, cost) ✅
**Issue.** Monad charges `gasLimit × price`, not gas used (verified on testnet receipts: fee = limit × price on every transaction). The app added +20% and the keeper +30% to every estimate, so every transaction paid that margin for nothing. Starting a round wrote 10 fresh storage slots (~221k gas), paid by the settling keeper or by the first bettor.
**Fix.** `Round` packed into 3 fixed slots plus amounts (uint64 timestamps, uint16 bps, uint32 bettor counts). Margins cut to +10%. Measured (`node scripts/gas_report.js`): settle 524k → 331k, bet opening a round 400k → 227k, one-sided cancel 284k → 130k, first bet 153k → 134k, market creation 493k → 339k. Unused duplicate getters and the unbounded `getAllMarkets` removed (size 23.6 KB).
**Test.** `[SEC-25]` fails if bet, lock, settle, new-round bet or claim exceed their gas budgets.

### SEC-26: Refunds and network fees (Medium) ✅
**Issue.** The contract and UI promised "100% refunds". The stake is refunded, but the bettor pays network fees to bet and to claim, and those are never refunded: a 0.05 MON bet refunded on testnet cost 0.051 MON in fees. Refunds of one-sided rounds also waited for a keeper's cancel transaction (which the keeper paid for with no fee income), and stuck rounds waited for someone to call `emergencyRefund`.
**Fix.**
- A round that can no longer be contested (one side empty after betting closed) or resolved (past close + `emergencyTimeout`) is refundable directly by `claimPayout` / `claimBatch` (`_isRefundable`). No one else's transaction is needed.
- The next bet on such a one-sided round cancels it and opens a new round (same path as SEC-24); the keeper sends nothing for one-sided rounds.
- The app shows the network fee to bet and to claim before betting, warns when fees exceed 5% of the stake, offers "Claim all" per market (one fee for many rounds), and blocks bets in the last 3 s (they would likely revert after the cutoff and still cost the fee). Wording now says the stake is refunded and network fees are not.
**Test.** `[SEC-26]`: no refund while the other side can still bet; full stake refunded directly after betting closes; no double refund, including after the round is later cancelled; contested rounds refundable directly only after the timeout.
**Residual.** Fees are real money on small stakes. With ~0.02 MON to bet and claim at 102 gwei, the 0.001 MON contract minimum is far below cost; raise `minBet` with `setProtocolParameters` before mainnet (see SEC-11).

### SEC-27: One missing oracle node blocked settlement (Medium, liveness) ✅
**Found** by the multi-wallet test on Monad testnet (2026-09-26): ETH round 3 could not settle because the report set at 1790430060 had fewer than 5 signatures. Two independent archives (keeper and relay) both captured complete sets 10 s before and after, so one RedStone node really skipped that report. With 5-of-5, the round could only be refunded after the timeout.
**Fix.** Deploy with 4 of 5 (still a strict majority). One missing node no longer blocks a round.
**Trade-off.** With all 5 reports available, the submitter can choose which 4 to send. The median of 4 is the mean of the middle two, so the choice moves the price at most within the spread between the 2nd and 4th node values; in captured data the nodes' values are identical or differ by cents. A round decided by less than that spread is effectively a tie.
**Test.** `test/contract_evm.test.js`: with real captured packages, a 4-of-5 contract rejects 3 signatures and settles with 4 at their median. `[SEC-02]` still proves a chosen 3-of-5 subset is rejected.

### SEC-28: Unobservable oracle reports (High, liveness) ✅
**Found** by the multi-wallet test on testnet (2026-09-26): BTC round 3 could not settle; neither archive (keeper, relay) ever saw the report for its close time (1790431040). Gateway 1 serves only the latest report set, and some sets are replaced before a 2 s poll sees them (~12% of timestamps), so ~1 in 5 contested rounds would have been refunded.
**Root cause:** the data was never missing. RedStone's gateway 2 serves any 10 s report of the last 24 h by exact timestamp (`/v2/data-packages/historical/redstone-primary-prod/{ms}`, free, no key); the "missing" BTC report and the ETH set that looked short of a signer (SEC-27) are both there, complete with all 5 signatures. Measured: a report set is complete ~1.5–2 s after its timestamp.
**Fix (three layers):**
1. The keeper and relay fetch the report for a round's exact time from that history (`fetchReportsAt`), at the moment it is published, instead of trying to catch it live. Nothing polls the gateway.
2. Lock and close times are aligned to the 10 s report grid, so the settling report is the one signed at the close second.
3. Backstop for a gateway outage: if the pinned report cannot be found, a report up to `maxReportDelay` (30 s, half the round at most) later is accepted **provisionally**; for `CHALLENGE_PERIOD` (60 s) anyone can replace it with an earlier valid report (and takes the bounty); `finalizeRound` settles after that. The final price is the earliest report anyone can show. The pinned report settles at once.
**Measured on testnet after the fix:** lock and settle confirmed 4.7–5.3 s after the lock/close time; the browser verifies the signed close report itself and shows the result 2.6 s after close ("confirming on-chain"), then "Settled on-chain" at ~4.5 s.
**Test.** `[SEC-28]` (late lock/close accepted only provisionally, earlier replaces later, no later replacement, no settle before the challenge period ends, finalize pays the bounty, lock and close on the grid); `[SEC-02]` (too late / off-grid reports rejected; a later favourable close is replaced by the pinned one). `npm run test:challenge` plays a dishonest keeper on testnet with real RedStone reports: the keeper replaced both late reports with the pinned ones (4/4). Mutations: settle without the challenge period, replace with a later report, widen the window: all caught.
**Residual.** If no one can produce the pinned report (gateway history down for the whole window), a party that privately captured it can choose to reveal it or not within the challenge period; the price then comes from the earliest report shown. With the history endpoint this needs the gateway to be down, and the round still refunds after expiry if no report at all is available.

### SEC-29: Refund, then settle (Critical) ✅
**Bug (found 2026-09-26 while reviewing SEC-28).** `_isRefundable` made a Locked round refundable after `closeTimestamp + emergencyTimeout`, but `settleRoundWithUpdate` still accepted it afterwards (the relay keeps reports, so the close report stayed available). A losing bettor refunded their stake, then anyone settled the round: `netPayoutPool` was computed from the full pool, so winners were paid the refunded stake a second time, out of other rounds' money. `emergencyTimeout` was also read live, so the owner could make in-flight rounds refundable (or not) at will.
**Fix.** Each round stores `expiryTimestamp = close + emergencyTimeout` at start. Lock, settle and finalize revert after it; refunds are possible only after it. A round resolves exactly one way.
**Test.** `[SEC-29]`: after expiry and a refund, settle and lock revert, everyone still refunds; lowering the timeout does not make an in-flight round refundable early. `test:fuzz` checks after every step that a round anyone was refunded from never settles. Mutations: settle after expiry, live timeout: caught.
**Old deployments** keep this bug: they are paused with their markets deactivated (`npm run retire`), which blocks new rounds; claims stay open.

### SEC-23: Oracle licence and terms (High, legal) 🟡
RedStone's EVM connector package ships its Solidity under **BUSL-1.1** (its package.json says MIT; the licence grant text is not included). We do not use that code: `SignedPriceOracle.sol` is an independent MIT implementation of the public data-package format. Whether RedStone's free gateway data may be used in production without an agreement is **not confirmed**.
- [x] No RedStone library code in the contracts.
- [x] Licence checked 2026-09-26: `redstone-finance/redstone-oracles-monorepo` is BUSL-1.1 (licensor Distributed Data Labs), granting only non-production use of the *code*, with no Additional Use Grant. It does not address use of the *data* served by the public gateway. (Note: `github.com/microsoft/RedStone` is an unrelated Microsoft LLM-dataset project under MIT.)
- [ ] Get written confirmation from RedStone that production use of `redstone-primary-prod` via the public gateway is allowed, or agree terms.
- [ ] Re-check the signer set before deploy (`src/oracle.js`; `npm run deploy -- --dry-run` verifies all 5 sign right now).

### SEC-24: Idle markets drain the keeper (Medium, ops) ✅
**Issue.** A round nobody bet in still had to be closed and a new one started every minute. Measured on Monad testnet: ~249k gas ≈ 0.025 MON per market per minute, about 6 MON/hour for 4 idle markets, with nobody playing.
**Fix.** The first bet on an expired round that has **no** bets replaces it with a fresh round in the same transaction (`_placeBet`). The keeper sends nothing for empty rounds. A round that holds any bet is never replaced, so a late bettor cannot void it.
**Test.** `[SEC-24]`: idle round replaced on the next bet and the bet lands in the new round; a stale round id is not redirected; a late bet on a round with bets is rejected and the round stays open. Verified on testnet 2026-09-26 (BTC round #1 → #2).

---

## Breaking changes introduced by these fixes

- 2026-09-26 (SEC-28/29): `Round` re-packed (`uint32 roundId`, `uint40` timestamps) with new fields `expiryTimestamp`, `finalizeAfter`, `maxReportDelay`; decode it by field name. Added `finalizeRound`, `MAX_REPORT_DELAY`, `CHALLENGE_PERIOD`, event `ClosePriceProposed`; `RoundLocked` may be emitted again when a late lock report is replaced. `lockRoundWithUpdate` also accepts an earlier report on a Locked round. Lock and close times are multiples of `priceWindow`. `minBet` may be up to 1000 MON.

The contract is not upgradeable. **These fixes require a fresh deployment**, then `NEXT_PUBLIC_CONTRACT_ADDRESS` and `NEXT_PUBLIC_CONTRACT_DEPLOY_BLOCK` set to the values `npm run deploy` prints.

- Removed: `lockRound(bytes32,uint256)`, `settleRound(bytes32,uint256)`, `maxLockDelay`, `maxSettleDelay`, `oracleMaxStaleness`, `MAX_LOCK_DELAY()`, `MAX_SETTLE_DELAY()`, `ORACLE_MAX_STALENESS()`, the 5- and 6-arg `setProtocolParameters`.
- Changed (2026-09-26, RedStone): the constructor takes `(address[] signers, uint256 threshold)`; `lockRoundWithUpdate` / `settleRoundWithUpdate` take `SignedPrice[]` reports and are no longer payable (no oracle fee); `Market.pythFeedId` is now `feedId` (e.g. `bytes32("BTC")`), which changes every market ID. Added `lockReportTimestamp`, `closeReportTimestamp`, `oracleSigners`, `signerThreshold`, `proposeOracleSigners`, `applyOracleSigners`, `cancelOracleSignersProposal`, `pendingOracleSigners`.
- Changed: `lockRoundWithUpdate` / `settleRoundWithUpdate` now require a pinned update for a contested round. `setProtocolParameters(lockBuffer, priceWindow, emergencyTimeout, minBet)`. `transferOwnership` is now two-step. Keeper bounties are pulled, not pushed.
- Added: `claimKeeperRewards`, `keeperRewards`, `priceWindowSeconds`, `setPaused` / `paused`, `setMarketActive`, `setMarketVerified`, `pendingOwner`, `acceptOwnership`.
- `Round` gained `betCloseTimestamp, priceWindow, lockPublishTime, closePublishTime, upBettors, downBettors`, and `Market` gained `verified`, all **appended** so existing index-based decoders keep working.
- Added `totalWinnings(marketId)`: the all-time sum of settled rounds' `netPayoutPool`, written once per settlement. It feeds the UI's Pulse board.
- `upBettors` / `downBettors` count distinct wallets per side per round. Only a wallet's first bet in a round writes them. Tested in `test/contract_evm.test.js`.

## History

| Date | ID(s) | Change |
|---|---|---|
| 2026-09-26 | SEC-28, SEC-29, SEC-11, SEC-14, SEC-16, SEC-17, SEC-18 | Production pass. Found and fixed SEC-29 (refund then settle). SEC-28 fixed: reports fetched by timestamp from RedStone's free 24 h history, rounds on the report grid, challengeable late-report backstop. Everything push-based (Monad WebSocket logs/heads, SSE to browsers); no polling. minBet from live gas; owner handover script; randomized invariant test. Deployed `0x31B755F6c4e319AaEAaC7f684C4c2BaB4c1AfDf2`; retired 5 older deployments. Security 92/92, EVM 45/45, app 51/51, mutations 16/16, fuzz 6 seeds, testnet: multi-wallet 27/27, challenge 4/4. |
| 2026-09-26 | SEC-25, SEC-26, SEC-11 | Raised by the user: refunds are not free once network fees count. Measured real costs on testnet, packed `Round` (−35% to −54% gas on round starts), self-service refunds, fee display and warnings, keeper skips one-sided rounds. Security 70/70, mutations 11/11. |
| 2026-09-26 | SEC-24 | Idle rounds replaced on the next bet; keeper skips empty rounds. Deployed to Monad testnet at `0x2d983986A906006Fa15479314E6F36cE30550b80` and ran a full round with live RedStone reports (lock, settle, claim). Security 58/58, mutations 10/10. |
| 2026-09-26 | SEC-01, 02, 21, 22, 23 | Settlement moved from Pyth (API key required since 2026-08-26) to RedStone's free signed reports, verified by our own `SignedPriceOracle.sol`. SEC-01/02 re-proven on the new oracle; added SEC-21/22 with tests and mutations. Suites: invariants 75/75, EVM 42/42 (incl. real RedStone packages on-chain), security 52/52, mutations 9/9 caught. |
| 2026-09-26 | SEC-19, SEC-20 | Removed silent fallbacks across keeper, deploy, config and UI; bets blocked when the network switch fails. All suites pass (80/80, 33/33, 39/39; 6/6 mutations caught). |
| 2026-09-26 | — | UI redesign (Horizon). Contract additions for the UI: `totalWinnings`, per-round `upBettors` / `downBettors`. All suites pass (EVM 33/33, security 39/39). |
| 2026-09-26 | SEC-01 … SEC-18 | Initial review. Fixed SEC-01–07, 09, 10; partial SEC-08, 18; opened SEC-11, 14–17; won't-fix SEC-12, 13. Added `test/security_regressions.test.js` (39 checks) and `scripts/mutation_check.js` (6 mutations, all caught). |