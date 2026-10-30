# T32 mutation testing results (2026-10-30)

Baseline (copy of evm/): forge test 40/40 PASS (3 suites).
Baseline (SOL): LiteSVM spend/admin/conformance suites green (T12b/T13/T17, re-verified per mutant run).

## EVM mutants (SpendFloorVault.sol spendWithSig)

- M1 cap (perTxMax+1): `amount > perTxMax` -> `amount > perTxMax + 1`.
  KILLED by test_OverPerTxCap + testFuzz_SpendOutcomes (counterexample amount 2000001 = perTx+1).
- M2 window (no reset): `spentInWindow = 0` -> `spentInWindow = spentInWindow` on rollover.
  KILLED by test_WindowRollover + test_LoweredCapNoPanic (both DailyCapExceeded: spent never reset).
- M3 precedence (DailyCap<->PerTx swapped): PerTx checked before DailyCap.
  KILLED by test_Precedence + test_U64MaxAmount + testFuzz_SpendOutcomes (all expected DailyCap, got PerTxCapExceeded).
- M4 signature (no agent check): `err != NoError || signer != agent` -> `err != NoError` only.
  KILLED by 7 tests (test_WrongSigner, test_TamperedTo/Amount/Deadline/Nonce, test_SetAgent, test_Precedence).

## SOL mutants (programs/spendfloor/src/lib.rs decide()/spend)

- S1 cap (perTxCap+1): `amount <= per_tx_cap` -> `amount <= per_tx_cap + 1`.
  KILLED by conformance_v1_to_v18 (assertion at conformance.rs:168: perTx+1 case).
- S2 window (no reset): `if stored_window != window_index { 0 } else { stored_spent }` -> always `stored_spent`.
  KILLED by spend_props window_rollover_resets_spent (FAILED, 186.94s run).
  Note: spend (1 passed) + conformance (6 passed) did NOT catch it — conformance V15 uses small amounts where the stale spent stays under the cap, so only the property test (which fills the window first) catches the missing reset. This is why the property suite matters.
- S3 precedence (DailyCap<->PerTx swapped in decide()).
  KILLED by conformance_v1_to_v18: V7 + V8 expected DailyCapExceeded, got PerTxCapExceeded (16/18 pass).
- S4 signature (agent pre-check removed from spend()).
  KILLED by conformance_v1_to_v18: V18 expected Unauthorized, got DailyCapExceeded (17/18 pass) — with auth gone the attacker spend proceeds to the cap checks instead of being rejected.

## Verdict

All 8 mutants KILLED (EVM M1-M4, SOL S1-S4). No surviving
mutant, so no new test and no gap to report. Two notes:
- S2 was caught ONLY by the property suite (spend_props
  rollover), not by the vector suites — the property tests
  are load-bearing for window logic.
- S4's V18 got DailyCapExceeded (not ACCEPT) because the
  conformance sequence's spent state at V18 already fills
  the window; the kill is still clean (expected Unauthorized).
