# SpendFloor Product Demonstration

This guide describes the client-facing, dependency-free demonstration in `ui/index.html`.

## Run it

The demo needs no wallet, API key, chain endpoint, or build step.

```sh
# From the repository root
python3 -m http.server 8080 --directory ui
```

Open `http://localhost:8080`, or open `ui/index.html` directly in a modern browser. The page is deliberately self-contained so it can be used reliably in a live presentation. It makes **no RPC writes**, does not request a wallet, and never handles a private key.

### Suggested presentation path

1. Click **Run the injection scenario**. The prepared intent is a 50 SFUSD payment to a non-allowlisted attacker.
2. Read the dual-chain trace. Both represented vault paths stop at `RecipientNotAllowed`; the trace also exposes the EVM-only nonce/deadline transport stage.
3. Choose **Merchant payout** and run it. A 1 SFUSD payment to the allowlisted merchant is accepted by the local model and moves only the **sandbox** window meter.
4. Try **Emergency freeze**, **Window exhausted**, a bad signer, or a replayed EVM nonce to show the first-failure rule.
5. Open **The boundary is deliberately narrow** and click each architecture component to explain separation of authority.
6. Use the **Policy authoring guard** to show that adding a recipient is classified as `LOOSER` and blocked before owner signing.
7. Finish with **Recorded rejections**. These explorer links are historical T27 evidence, deliberately separate from page interactions.
8. Use **Reset full demonstration** before repeating the flow.

## Product understanding from the repository

SpendFloor is an on-chain spend-policy system for AI agents on Base Sepolia and Solana devnet. The agent signs payment intents, but it is not the custodian of the funds. The vault/program holds the policy and only transfers the test token when the intent satisfies that policy.

The implementation uses three roles:

- **Owner**: sets policy, rotates the agent, freezes/unfreezes, and withdraws.
- **Agent**: signs payment intent(s), intended to hold no native funds, SFUSD, or approvals.
- **Submitter**: pays gas / forwards the intent; it has no policy authority.

The core problem demonstrated is prompt injection: an LLM can be instructed to draft a drain, so an off-chain instruction check is not an adequate funds boundary. SpendFloor moves the final authorization decision into the vault contract/program.

## Capability-to-demonstration map

| Implemented capability | Underlying implementation | Demonstration representation | Interaction and expected output | Validation source |
|---|---|---|---|---|
| EVM policy enforcement | `evm/src/SpendFloorVault.sol`, `spendWithSig` | Dual-chain decision trace | Run a configured intent. The EVM trace follows `Unauthorized → BadNonce → IntentExpired → DeadlineTooFar → Frozen → SessionExpired → ZeroAmount → RecipientNotAllowed → DailyCapExceeded → PerTxCapExceeded`. First failure is shown. | EVM vault tests and invariants referenced in `docs/HONEST_MATRIX.md` |
| Solana policy enforcement | `solana/programs/spendfloor/src/lib.rs`, `spend` / `decide` | Dual-chain decision trace | The Solana side follows its documented policy path. It intentionally marks EVM nonce/deadline transport as `N/A`. | Solana unit, property, and conformance results referenced in `docs/HONEST_MATRIX.md` |
| Recipient allowlist and caps | Both vault implementations; policy micro-units use 6 decimals | Prepared attack, merchant, and exhausted-window scenarios | 50 SFUSD to attacker returns `RecipientNotAllowed`; 1 SFUSD to merchant returns `ACCEPT`; 2 SFUSD after 4 spent returns `DailyCapExceeded`. | `docs/EVIDENCE.md`, contract/program tests |
| Canonical cross-chain policy | `policy/src/canonical.ts`; on-chain hash computation | Policy artifact and observed policy card | Shows policy shape: 2 SFUSD per transaction, 5 SFUSD per 24h, merchant-only, and the cited hash snapshot. | `policy/test/golden-hashes.json`, T14/T18/T25 evidence described in honest matrix |
| Separation of authority | Vault/program roles, relay, and key custody logic | Clickable trust-boundary architecture | Select Owner, Agent, Submitter, or Vaults to see what it can and cannot do. | `README.md`, source comments, `docs/THREAT_MODEL.md` |
| Guarded policy drafting | `policy/src/diff.ts`, retry/drafting modules | Policy authoring guard | Select a policy proposal. Added recipient is `LOOSER` and represented as blocked; aligned/tighter drafts are distinguished, not automatically applied. | `policy/src/diff.ts`, T09 summary in honest matrix |
| On-chain injection evidence | `evidence/T27/rehearsal-2026-10-30.json` | Recorded-rejection table | Opens five Base and five Solana explorer records. These do not change when page controls are used. | `docs/EVIDENCE.md` and T27 JSON |
| Resettable presentation state | Browser-only UI state | Reset buttons and activity log | Reset returns to the 50-SFUSD injection, 1/5 SFUSD sandbox window state, blank trace, and empty local activity. | Manual browser rehearsal |

## Simulation boundary

The interactive policy lab is a **deterministic browser model**, not an execution client. It exists because a predictable client presentation should not require a funded key, a running relay, public RPC availability, or a live testnet state.

It models the documented first-failure precedence and uses representative policy values from the recorded testnet snapshot. It does not:

- compile or call the Solidity or Rust programs;
- construct a real EIP-712 signature or Solana transaction;
- use a private key, wallet, or browser extension;
- send an RPC request or mutate any chain state;
- claim that a local `ACCEPT` result landed on-chain.

An accepted sandbox run advances only the meter and local activity log in the current browser session. Historical explorer records are labeled separately so they cannot be mistaken for newly produced evidence.

## Assumptions and known limitations

- The UI uses the 30 October 2026 evidence/snapshot values in this repository: per-transfer cap 2 SFUSD, window cap 5 SFUSD, 24-hour window, merchant-only recipient set, and one SFUSD spent. It is not a live-state monitor.
- The EVM and Solana programs are similar but not byte-identical interfaces. EVM has nonce/deadline transport errors; Solana transaction transport failures do not land. The UI makes that difference explicit rather than pretending the paths are identical.
- Deployments are testnet-only and SFUSD is a test token. There is no mainnet, production funds, fiat rail, production customer integration, or validated product-market fit.
- The custom vaults are unaudited. Test, fuzz/property-test, static-analysis, and conformance claims are documented evidence—not an audit guarantee.
- The architecture explorer and policy-draft guard are explanatory simulations of real roles and diff semantics. Owner actions are not exposed as live controls because the owner key must remain off the presentation machine.

## Test summary

The product demo was checked as a standalone static artifact:

- Installed the repository's pinned Node dependencies with `npm ci` and ran `npm run typecheck --workspace=@spendfloor/policy` successfully.
- Extracted JavaScript from `ui/index.html` and ran `node --check` successfully.
- Ran structural assertions for a single HTML/style/script document and the required presentation states.
- Ran a temporary jsdom interaction smoke test against the rendered page. It exercised: empty state; injection rejection; merchant acceptance and local-meter advance; frozen rejection; exhausted-window rejection; invalid precision error; looser-draft block; architecture selection; full reset; and absence of jsdom runtime errors.
- Ran `git diff --check` to verify no whitespace errors.

Repository-level contract and policy test evidence predates this UI work and is intentionally cited rather than rerun or recharacterized by the page. See `docs/HONEST_MATRIX.md`, `docs/EVIDENCE.md`, and the source test suites for the underlying verification record.
