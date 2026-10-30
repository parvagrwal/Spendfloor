# T37 verifier sabotage per field (2026-10-30)

Baseline before sabotages: VERIFY GREEN 15/15 (live testnet state:
policyHash 0xf36d290e…, agent balances 0 both chains).
Each sabotage changed ONLY a local input (deployment JSON or
local build artifact). No live testnet state was changed. After
each sabotage the file was restored and its sha256 verified
against the pre-sabotage value. Final baseline after all
restores: VERIFY GREEN 15/15 again (evidence/T37/baseline-after-restore.txt).

## Sabotages (all local-only)

1. Code identity — first byte of the local build artifact
   `evm/out/SpendFloorVault.sol/SpendFloorVault.json`
   deployedBytecode flipped (60 -> 00).
   Result: VERIFY RED 14/15, failing only `evm.code`
   (on-chain hash != local build hash, "code changed, not the
   audited build"). Restored (sha256 f557f64e… matches).

2. Upgrade authority — `deployments/solana-devnet.json` owner
   replaced with the system-program dummy.
   Result: VERIFY RED 13/15, failing `sol.upgrade` (upgrade
   authority == real owner, expected dummy) and `sol.roles`.
   Restored (sha256 b5df5b80… matches).

3. AGENT balances — both chains' agent addresses replaced with
   their owners' (funded) addresses in the deployment JSONs.
   Result: VERIFY RED 11/15, failing `evm.roles`, `evm.agent`
   (native=21057763223619114 wei, SFUSD=1000000),
   `sol.roles`, `sol.agent` (native=3810592920 lamports,
   SFUSD=1000000). The balance diffs name the exact nonzero
   values. Restored (sha256s match).

4. Roles — both chains' owner addresses replaced with dummies.
   Result: VERIFY RED 12/15, failing `evm.roles` (owner
   mismatch, precise), `sol.upgrade`, `sol.roles` (owner
   mismatch, precise). Restored (sha256s match).

5. Recipient sets — both chains' merchant addresses replaced
   with the attacker addresses.
   Result: VERIFY RED 10/15, failing `evm.policy`
   (recomputed != stored, "TAMPER or recipient drift"),
   `evm.recipient` (isRecipient == false), `sol.policy`
   (recomputed != stored, "TAMPER"), `sol.recipients`
   (live [merchant] vs expected [attacker], "precise diff:
   sol.recipients"), `cross.policy` (DRIFT X1).
   Restored (sha256s match).

## Conclusion

Verify fails on every sabotaged field with a precise diff
naming that field. No sabotage went undetected, and no live
state was touched. (Live-state recipient sabotage was already
proven by the T18 mutation test; these five prove the
expected-value side.)
