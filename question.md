# Open doubts

Honest remainder from this session — not resolved, not hidden. Worth checking before trusting the
project unattended, and worth re-reading before mainnet.

1. **The 200,000 gas floor (`MIN_GAS_LIMIT`) is a defensive guess, not a proven fix.** The original
   theory behind it (a gasLimit under ~180k gets rejected as "insufficient balance" regardless of real
   balance) was directly disproven on retest during this same session. The floor is kept because it's
   cheap and harmless, not because it's known to solve anything. If the real "insufficient balance"
   pattern recurs on mainnet, this floor might not help — genuinely unknown.

2. **~~Nothing stops two keeper instances from running on the same private key.~~ Addressed in code,
   not yet exercised.** `scripts/house_keeper.js` now takes a per-wallet lock file (in the OS temp dir,
   holding the PID) in live mode and exits with a clear message if a live process already owns it;
   a lock left by a dead process is taken over. Only syntax-checked so far. Limits: it guards one
   machine only, not two hosts sharing a key.

3. **There is no way to verify from inside this session that the app keeps running after the terminal
   closes.** The keeper/relay/app stack was launched from this session's shell; whether it survives the
   terminal closing depends on the OS/process setup, not on anything confirmed here. Check
   `http://localhost:3000` and the keeper's `/health` endpoint independently rather than trusting the
   last check made here as permanent.

4. **Ownership is still a single EOA key**, not a multisig. `scripts/transfer_owner.js` exists and the
   two-step mechanism is proven (deterministically and live), but it has not been run. This is the one
   item that matters if real money (mainnet) gets near this contract — irrelevant for testnet/hackathon
   use.

## Also worth knowing (found while checking on these)

`node_modules` was found silently missing most of its packages (including `ethers`) partway through
this session, for reasons never identified — not a disk-space eviction (37G free at the time), not
something this session's own commands did. Reinstalled and reverified (151/151, app restarted cleanly)
before ending the session, but the root cause of why it emptied out is unknown. If dependencies go
missing again, that's a recurrence of something unexplained, not a new problem.
