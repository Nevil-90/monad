# Ideas for Monad Metropolis

Pulse already covers the core loop well: instant vault-backed bets, moving odds, a streak
jackpot, and a fully verifiable dashboard. These are additions that would make the submission stand
out further for judges, grouped by what they mainly help with. Not a roadmap — a menu to pick from.

**If picking just one: session-key / one-tap betting**, below. It's the single highest-leverage change
for how the project actually feels in a 90-second judge demo, and every other idea on this list is
additive on top of it rather than a substitute for it.

## Bigger product ideas, not just polish

These change what the product *is*, not how smooth it feels. Higher effort and higher risk than
anything else on this page, but this is where "novel" actually lives rather than "well executed."

- **Tradeable in-flight bets.** Right now a placed bet is locked until settlement. Make the bet
  position itself a transferable token (ERC-721 or a simple internal transfer registry) so someone can
  sell their exposure to another player *before* the result is known — a genuine secondary market for
  risk that only exists because this is on-chain. A player who regrets a bet isn't stuck; a player who
  wants exposure to an already-favorable-looking window can buy in from someone who wants out. This is
  the one idea on this whole page that isn't possible in a normal centralized betting app.
- **LP risk as its own market.** The vault currently absorbs 100% of one-sided demand risk itself. Let
  a third party sell "stop-loss" cover to LPs for a premium — if the vault's realized P&L over a period
  drops below a threshold, the cover pays out from the premium pool. Turns the existing (already
  tested) vault mechanics into a base layer for a second product instead of the only product.
- **User-defined markets, not just Up/Down.** The AMM and settlement pipeline don't actually care what
  the question is, only that RedStone can sign a number for it at a fixed time. Letting anyone propose
  a market ("will BTC move >0.5% in the next 30 s," a threshold bet, not a direction bet) turns this
  from "one game" into "infrastructure for fast binary markets on any RedStone-priced asset" — a much
  bigger story for judges than another Up/Down app.
- **A ladder bet.** One stake that carries forward through consecutive windows (5 s → 30 s → 60 s),
  paying out progressively more the longer the direction holds and losing the whole stake on the first
  miss — a structured product built entirely from primitives that already exist (the same AMM pricing,
  called three times instead of once), not a new pricing model.

## Make the demo itself more compelling

- **Session key / one-tap betting.** Today every bet is a wallet confirmation. A short-lived session
  key (sign once, bet many times for N minutes or until a spend cap) removes the single biggest
  friction point in a live demo and in real play — "click Rise, see the result" with no popup in
  between. This is the highest-leverage addition for a hackathon demo specifically: judges try a lot
  of projects quickly, and removing a MetaMask popup per action makes the difference between "played
  three rounds" and "played thirty."
- **A guided first-time flow that ends in a bet, not a wallet connect screen.** Auto-detect no wallet
  → offer a one-click burner session key funded from a faucet tap, so a judge with no MetaMask
  extension installed can still place a real on-chain bet in under 30 seconds.
- **A sponsored first bet.** Pair the burner-key idea with covering that one first bet's gas from the
  treasury (a few cents, bounded to once per new address). The single biggest silent drop-off point in
  any on-chain demo is "wait, I need testnet MON first" - removing it for exactly the first action
  costs almost nothing and keeps a judge moving instead of tabbing away to find a faucet.
- **Replay the last few minutes on load.** The chart and dashboard already reconstruct full history;
  surfacing a short "here's what just happened" animation on first paint (last jackpot, last big win)
  sells the "real money, real time" feeling immediately instead of a blank chart.
- **A live crowd-sentiment gauge, for free.** The contract already tracks each open window's Up/Down
  skew (`net` against `maxSkewBps`) to price the AMM — that's the exact same number a "78% of this
  round is betting Rise" gauge needs. No new state, no oracle, nothing invented: just surfacing a value
  that's already on-chain and already trusted for settlement, which fits the "everything here is
  provable" story better than a separately-computed stat would.
- **A browser/OS notification when your bet settles.** Rounds are short (5–30 s) but a player won't
  always be staring at the tab. A single `Notification` API call on the existing `BetSettled` event
  ("You won 1.2 MON on BTC Rise") turns a game that currently demands attention into one that respects
  it — small effort, no contract change, and a real UX difference for anyone who plays for more than a
  couple of rounds.

## Onchain Finance & Trading track

- **Parlay / combo bets.** Bet Rise on BTC *and* Rise on ETH in the same slip for a multiplied payout
  if both land, priced off the same quadratic cost function per leg. A genuinely novel primitive on
  top of the existing AMM, not just a UI combination — differentiates from "another up/down game."
- **Streak insurance.** Spend a small fee (or jackpot points) to protect a streak through one loss.
  Turns the jackpot mechanic into a second, smaller strategic decision each round instead of a passive
  counter, and is fully fundable from the existing margin/fee split.
- **Copy a strategy, not a person.** Rather than social copy-trading (which needs on-chain identity
  work), let a player save a "rule" (e.g. "bet 1 MON Rise every 30 s window while BTC is trending up
  over the last five candles") that one-click re-arms after each settlement. Pure client-side
  convenience on top of the existing quote/placeBet flow — no contract change needed.
- **A live, honest APY for LPs.** `addLiquidity`/`removeLiquidity` already price a deposit and a
  withdrawal off real vault state (SEC-verified this session, including a live round-trip that lost
  ~11% over an hour because the house was actually down against a profitable bettor). Computing and
  showing LPs a trailing real yield number - not a marketing projection, the actual realized number
  from on-chain history - is a genuinely rare thing to show in a hackathon demo and fits "Onchain
  Finance" better than most novelty features would.

## Social, Attention & Culture track

- **On-chain trophies for streak jackpots.** Mint a cheap ERC-721 (or a soulbound token) the moment a
  jackpot pays out, with the streak length and payout baked into its metadata. Gives players something
  to hold and show off beyond a number in a balance, and it's a natural fit for "Social, Attention &
  Culture" since it's inherently shareable.
- **A public, provably-fair leaderboard page.** The Dashboard already proves every number from
  transaction history; packaging a "top streaks this week" / "biggest single win" leaderboard as its
  own shareable page (with an OG image per entry) turns the existing transparency work into something
  that spreads on its own.
- **A spectator ticker as its own embeddable widget.** The narrow-screen win ticker already exists in
  the app; publishing it as a standalone `<iframe>`-able widget lets it be dropped into a Farcaster
  frame or a stream overlay, which is low effort (it's already built) but extends reach well past the
  app's own URL.
- **A shareable "beat my streak" challenge link.** A deep link that opens straight into the same
  market/duration a friend just won a streak on, with their streak length shown as the target. Costs
  nothing to build against the existing streak/jackpot data, and turns the jackpot mechanic - currently
  a private counter only the bettor sees - into something that spreads person to person.
- **Scheduled tournament rounds.** A recurring window (say, the top of every hour) where stakes are
  pooled into a separate small prize on top of the normal payout - same settlement mechanics, just a
  second, time-boxed pot on the side. Gives people a reason to be online at the same moment, which is
  exactly what a demo booth or a stream benefits from.

## Trust, Identity & AI Infrastructure track

- **A plain-language "why did I win/lose" readout.** Every bet already has a strike price, a result
  price, an oracle signer set and a transaction hash. Surfacing that as one auto-generated sentence per
  settled bet ("Settled by the median of 4 RedStone reports at 14:02:30; BTC $84,161.40 → $84,172.10,
  Rise wins") turns the existing verifiability into something a non-technical judge can read in one
  glance, without them having to open the explorer themselves.
- **An optional AI market-context strip — informational only, never custodial.** A small read-only
  panel that narrates recent price action in one sentence (e.g. "BTC is up 0.3% over the last minute,
  volatility picking up") sourced from the same Coinbase feed already streamed to the chart. Kept
  strictly advisory and clearly labelled as such, it plays well for the "AI Infrastructure" track
  without touching the parts that must stay simple and auditable (pricing, settlement, payouts).
- **A "prove it yourself" mode for the settlement math.** Every settlement is just a median of signed
  RedStone reports checked against a threshold - genuinely simple enough that a judge could verify one
  by hand. A small panel that walks through one real settled bet's actual numbers (the reports, the
  median, the signer addresses, the threshold check) step by step turns "trust the contract" into
  "watch the contract be correct," which is a stronger trust story than any amount of README text.
- **A one-click "verify this is the deployed code" badge.** Fetch the deployed bytecode, recompile the
  published source client-side (or via a small serverless function) and show a green check when they
  match. This project already has no proxy and no upgrade path (confirmed this session) - that
  immutability is a selling point, and a live verification badge is the most direct way to make a
  judge feel it instead of just being told it.

## Lower effort, still worth doing

- **Explorer-style bet receipt page.** A shareable `/bet/{id}` page that shows one bet's full lifecycle
  (placed → strike → result → settled) with links to each transaction — good for judges who want to
  verify one specific result without hunting through the Dashboard.
- **A "how the odds move" explainer with a live worked example.** The quadratic cost market maker is a
  genuine differentiator versus a fixed-multiplier game; a short interactive explainer (slide a stake
  slider, watch the quoted payout move) makes that legible to a judge in the 90 seconds they'll spend
  on the project, instead of relying on them reading the README.
- **A risk meter before every confirm.** One line under the bet button - "max you can lose: 0.7 MON,
  max you can win: 1.35 MON" - computed from the same quote the transaction will use. Nearly free to
  add (the number is already fetched for the payout preview) and it's the single clearest signal to a
  judge that this is a real, bounded-risk financial product and not a black box.
