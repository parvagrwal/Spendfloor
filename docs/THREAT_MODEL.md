# SpendFloor Threat Model (T23)

Static analysis + review for the SpendFloor vaults (Base Sepolia EVM +
Solana devnet). This document is the T23 deliverable: it records what
was checked, what the tools found, and which bypasses are closed.

## 1. Static analysis results (2026-10-30)

### Slither 0.11.6 (EVM: SpendFloorVault.sol + SFUSD.sol)

14 contracts analyzed, 97 detectors, 19 results. **0 High, 0 Medium,
0 Low.** All 7 detectors fired at INFO level only:

| Detector | Where | Triage |
|---|---|---|
| unused-return | SpendFloorVault.spendWithSig (line 343) | Intentional: tryRecover returns (signer, err, signature); the vault uses signer + err and ignores the third value (the input signature itself, not needed). Not a finding. |
| timestamp | SpendFloorVault.windowIndexAt (line 279) | By design: windows are time-based. A miner can shift block.timestamp by ~12s on Base; the window is 86400s and the deadline is 300s, so a 12s shift cannot break any cap or create funds. Not a vulnerability. |
| assembly | OpenZeppelin SafeERC20 (lib, not our code) | Library code (audited OZ). Not our vault. Not a finding for SpendFloor. |
| pragma | OpenZeppelin uses ^0.8.20, vault pins 0.8.37 | Expected: libraries use a range, the vault pins an exact version (T01). Not an issue. |
| cyclomatic-complexity | _setPolicy (13), spendWithSig (12) | By design: both functions must check many conditions (precedence + validation). Complexity is not a vulnerability; both are covered by 32/32 (T10) + 34/34 (T11) tests + 10,000-run fuzz. |
| solc-version | solc 0.8.37 pinned | Deliberate (T01 pin, Base Sepolia Cancun). Not an issue. |
| naming-convention | DOMAIN_SEPARATOR (line 85) | False positive: it is a constant, and UPPER_SNAKE is the correct convention for constants. Slither expects mixedCase for state variables. Not a finding. |

**Verdict: no unresolved High findings (there are no High findings at
all). Slither acceptance met.**

### Clippy (Rust: solana/programs/spendfloor, lib.rs)

15 warnings, 0 errors. Breakdown:

- 10 warnings are Anchor macro noise (unexpected cfg: custom-heap,
  solana, custom-panic, anchor-debug) from the #[program] and
  #[derive(Accounts)] expansions. These are in generated code, not
  hand-written logic, and cannot be fixed without changing Anchor.
- 5 warnings are hand-written style lints, none security or
  correctness:
  - too_many_arguments (8/7) at lib.rs:285 (a helper with 8 params).
  - manual RangeInclusive::contains at lib.rs:298 (a manual range
    check instead of .contains()).
  - loop variable only used to index at lib.rs:311 (index loop
    instead of iterators).
  - useless vec! x3 at lib.rs:652-654 (vec! where a slice would do).
- No correctness, panic, or security lints in hand-written code.

**Verdict: no security findings from clippy. Acceptance met.**

### Cargo-audit 0.22.2 (Rust dependencies, solana/Cargo.lock)

1386 advisories loaded, 234 crate dependencies scanned. **0
vulnerabilities.** 1 allowed warning:

- bincode 1.3.3, unmaintained (RUSTSEC-2025-0141, 2025-12-16).
  Triage: bincode 1.x is a transitive dependency (via Anchor/Solana
  serialization), not a direct dependency of the SpendFloor program,
  and "unmaintained" is a maintenance warning, not a vulnerability
  (no CVE, no exploit). Upgrading it would mean upgrading
  Anchor/Solana, which is out of scope for T23. Documented here, not
  a High finding, and cargo-audit exits 0 with warnings allowed.

Note: the yanked-status checks for some crates timed out (slow
network to crates.io) — that only means yanked status could not be
verified for those crates, not that any were found yanked or
vulnerable. The advisory scan itself completed.

**Verdict: no unresolved High findings. Cargo-audit acceptance met.**

## 2. Bypass checklist (T23 acceptance: E3, E4, E11, S3, S4 ticked)

Verified by code inspection (grep, 2026-10-30) + tests:

- [x] **E3 — transferFrom using a vault allowance (EVM).** The vault
  and token contain no `approve` call anywhere, so the vault never
  grants an allowance and allowance(vault, .) = 0 always. T11's
  invariant suite covers this. CLOSED.
- [x] **E4 — permit / EIP-1271 signature from the vault (EVM).** The
  vault contains no `permit`, no `isValidSignature`, and no signing
  key. It only VERIFIES agent signatures (ECDSA.tryRecover on
  intents); it never creates a signature. A permit or EIP-1271 call
  from the vault is impossible. CLOSED.
- [x] **E11 — proxy / delegatecall / selfdestruct (EVM).** The vault
  and token contain no `delegatecall`, no `selfdestruct`, and no
  proxy pattern. The vault is non-upgradeable by construction.
  CLOSED.
- [x] **S3 — delegate on the vault token account (Solana).** The
  program contains no `approve` / delegate instruction, so the vault
  token account's delegate stays None. Proven across 10,000 random
  cases by T13 (spend_props.rs: after every spend attempt, delegate
  tag == 0). CLOSED.
- [x] **S4 — set-authority / close on the vault token account
  (Solana).** The program contains no set-authority or close
  instruction, so the vault token account's authority stays the
  policy PDA and close authority stays None. Proven across 10,000
  random cases by T13 (owner bytes == PDA, close tag == 0). CLOSED.

## 3. Full bypass matrix (status + evidence)

EVM: E1 agent native send (T02/T18/T22) · E2 agent token transfer
(T18/T22) · E3 vault allowance (T11/T23, closed above) · E4
permit/EIP-1271 (T23, closed above) · E5 spend to attacker (T10,
V2/V3) · E6 many small spends (T11, V7-V10) · E7 window-boundary
burst — inherent, documented (T17 local) · E8 intent replay incl.
cross-chain (T10, V17) · E8b replay of rejected intent after
rollover (T10) · E9 signature malleability/tamper (T10) · E10 agent
calls owner functions (V12) · E11 proxy/delegatecall/selfdestruct
(T23, closed above) · E12 reentrancy (T10/T23) · E13 different token
(T10) · E14 ETH sent to vault — no receive/fallback (T10) · E15
EIP-7702 on agent EOA (T29 doc).

Solana: S1 agent sends SOL (T07/T22) · S2 agent transfers SPL (T22) ·
S3 delegate (T13, closed above) · S4 set-authority/close (T13, closed
above) · S5 spend to non-allowlisted wallet (V2/V3) · S6 wrong mint /
Token-2022 (T12b) · S7 fake token program (T12b) · S8 fake
vault/policy account (T12a) · S9 missing agent signer (V18) · S10
agent calls owner instructions (V12) · S11 program upgraded by
non-owner (T07/T18) · S12 re-initialization (T12a) · S13 duplicate
mutable accounts (T12b) · S14 clock manipulation — bounded median,
documented (T29) · S15 submitter alters payload — agent signature
covers it (T10/T12b).

Cross-chain: G1 relay griefing (T19, bounded by rate limit + float) ·
X1 one chain updated, other not (T18 verify DRIFT) · X2 freeze skew
(T21, caps bound it) · X3 owner key compromised (out of scope, T02).

## 4. Honest limits

- Slither + clippy + cargo-audit are static tools: they catch known
  patterns, not logic errors. The logic is covered by tests (T10
  32/32, T11 34/34, T12b, T13 10,000 cases, T14, T17 conformance).
- The vaults are unaudited custom code (not a formal audit). This
  document is a review, not an audit report.
- Socket dependency scanning (T23a) is covered in section 5 below.

## 5. Socket dependency scanning (T23a)

Socket here is Socket.dev (supply-chain security), NOT the Socket
bridge protocol that appears in the old multichain research file.

What it scans: the npm manifests (root package.json: viem 2.57.7,
@solana/web3.js 1.99.0, @solana/spl-token 0.4.15,
@anchor-lang/core 1.2.0, tsx, typescript, @types/node, litesvm; plus
the sub-package manifests, which carry no dependencies) and the Cargo
manifests (solana/Cargo.toml workspace, programs/spendfloor
anchor-lang/anchor-spl 1.2.0, litesvm-tests litesvm 0.10 + proptest 1
+ solana 3.x + sha2). Foundry libraries are vendored as plain files
in evm/lib/ (not manifest dependencies), so Socket does not scan
them; they are covered by Slither (section 1) instead.

How CI runs it: `.github/workflows/ci.yml` has two jobs. `forge-tests`
runs the EVM vault suite. `socket-scan` runs `socket ci` (Node CLI,
alias for `socket scan create --report`), which exits non-zero when
the scan does not pass the security policy, so unhealthy dependencies
fail CI. The scan step skips gracefully (job stays green) when no
Socket API key is configured; it fails CI only on a real unhealthy
scan. (GitHub Actions does not allow `secrets` in a job-level `if`,
so the missing-key case is handled inside the step, not by a job
condition — that was the cause of the first CI run failing with no
jobs.)

Setup (either path, Parv's choice):
1. (Recommended) Install the Socket GitHub App (free) on this repo.
   It scans on every push and posts a check. No secret needed.
2. Create a free Socket API key (socket.dev dashboard) and add it as
   a repo secret named SOCKET_SECURITY_API_KEY. The socket-scan job
   then runs on every push and pull request.

Scan report: pending the first CI run with Socket enabled. The link
goes here once the first scan is green.

Pre-check (not a substitute for the Socket scan): the manifests were
reviewed by hand — all direct dependencies are mainstream, pinned
packages (viem, @solana/web3.js, Anchor, LiteSVM, proptest); no
typosquats or obviously malicious packages were found. The Socket
scan is still required for the T23a acceptance.
