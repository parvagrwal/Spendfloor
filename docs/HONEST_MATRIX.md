# SpendFloor Honest Matrix (T29)

Every pitch claim, matched to its evidence — or marked as not
proven. This document is the check that the docs match the verify
output and the test results. Current state is as of the last
verify run (T25, 2026-10-30).

## Current live state (verify, T25 final, 2026-10-30)

- Verify GREEN 15/15, twice. Policy caps perTx 2 SFUSD, window
  5 SFUSD, 86400 s, merchant-only, on both chains.
- Spent 1 SFUSD per chain (headroom 4 per chain).
- Policy hash `0xf36d290ed7e1cc23af0ea7f08ae4f3ee0b1bcfead65e4a4744c76c70a7f5b820`,
  identical on both chains (anchor/expiry were refreshed by the
  T25 restore; the earlier T21 hash `0xe078…` is superseded).
- Agent balances 0 on both chains (native 0, SFUSD 0).
- Vaults (testnet): EVM SFUSD `0xb86efe265be37a521ddb271d750e6a41cb2471e2`,
  demo vault `0x8d13a6a31518b357a480659073b9db78ab861809`;
  Solana program `CQfuniyvMY9sPDAFMPRZzbpHEwRiyy3Y4BsfuQd3iAbE`,
  policy PDA `5MUi1eZAfjaCukRDZNntAMJCr5Xz6gCRJ9s7D2iJyfuE`,
  mint `ESB1d6WUnz6e9yRmC9hv8MrHHzrQs8eFSV6aosDHNt2U`.
- Caveat: this verify run had SOL RPC2 == RPC1 (the Helius key
  lives on Parv's machine and `SOL_RPC2` was unset), so the Solana
  reads were not independently verified on that run. Same
  pre-existing note as T18/T21.

## Proven by tests

- Injection rejected on both chains: T27 rehearsal, 5/5 runs,
  all `RecipientNotAllowed` on both chains, each under 90 s
  (`docs/EVIDENCE.md` + `evidence/T27/`). Also T20 live injection
  (EVM revert, SOL error 6003) and the T26 localnet demo
  (EVM + SOL `RecipientNotAllowed`, `docs/DEMO_RUNBOOK.md`).
- Policy enforced on-chain, not in the agent: EVM vault suite
  32/32 (T10) + stateful fuzz 34/34 (T11); Solana program unit
  16/16, admin 10/10, spend 6/6 (T12b); Solana property tests
  10,000 cases, 0 failures, vault token invariants hold (T13);
  cross-chain hash conformance 86 green (T14); conformance
  runner 18/18 local + testnet V1–V18 (T17).
- Same policy on both chains: T14 hash conformance, T18 verify
  (recomputes the hash from live reads, 15/15), T21 (identical
  hash across chains), T25 round trip (apply 3/6 + restore 2/5,
  verify green).
- Agent holds nothing: T18 verify (agent native 0 + SFUSD 0 both
  chains); T02 custody enforced in code (owner machine vs agent
  machine key split).
- LLM policy drafting guarded: T09 retry loop, final drafts 10/10
  valid, 0 looser (guard blocks any looser draft before signing);
  T25 round trip draft clean in 2 tries, no human needed.
- Static analysis clean: T23 Slither 0 High/Medium/Low, clippy
  0 security lints, cargo-audit 0 vulnerabilities
  (`docs/THREAT_MODEL.md` §1).
- Dependencies triaged, NOT green: T23a finished Socket scan,
  16 pre-existing alerts, 0 new, 0 reachable, 0 production,
  0 critical, 0 fixable (`docs/THREAT_MODEL.md` §5). The scan is
  not green; the alerts are recorded, not hidden.

## Not proven / honest gaps

- PMF NOT VALIDATED. Problem validated at incident level only
  (Bankrbot, aixbt, Freysa). Zero user contact: no interviews,
  no trials, no integrations, no LOIs, no price tests
  (`pmf-validation.md`). Do not claim product-market fit.
- Vaults are unaudited custom code. This is a review (tests +
  static analysis + property tests), not a formal audit.
- C10 Zodiac MultiSend bypass: UNVERIFIED, OUT of the pitch
  (see below).
- T24 dashboard hash is stale: it shows the T21 hash `0xe078…`,
  but live state after the T25 restore is `0xf36d…`. The
  dashboard needs a refresh to match live state; its verify
  status (GREEN 15/15) and counter (10 rejections) are still
  accurate as historical records.
- Repo `deployments/localnet.json` is stale: it is the T16 Anvil
  record and still says "Solana localnet pending". The T26
  Surfpool leg is local-only by design and is not committed
  (regenerate via `docs/DEMO_RUNBOOK.md`).

## C10 — Zodiac MultiSend bypass (UNVERIFIED, OUT)

Claim (PRD, research context only): "A critical bypass in
MultiSend unwrapping was disclosed on May 18, 2026: the
permission checker could be made to check different values than
the ones MultiSend actually executes." Sole source cited: a
single x.com post
(`https://x.com/therealgregoAI/status/2056282704866422889`).

T29 search (2026-10-30): no primary source found for THAT
specific claim — no Zodiac/Gnosis advisory, audit, CVE, or repo
fix about MultiSend unwrapping value mismatch. What exists is a
related but DIFFERENT Zodiac flaw: the Gnosis Pay incident
(June 1, 2026; postmortem July 3, 2026), where the Zodiac
Delay/Roles Modifier checked only the ERC-1271 "magic value"
return data without verifying whether the staticcall succeeded,
letting failed verifications pass as valid signatures. That flaw
is real and documented, but its mechanism (magic-value check,
not MultiSend unwrapping) and its date (June, not May 18) do
not match the PRD's claim, so it does NOT verify C10.

Verdict: C10 remains UNVERIFIED and stays OUT of the pitch, per
the plan. No pitch, README, judges dossier, threat model, or
evidence doc mentions the MultiSend bypass as fact (verified
2026-10-30). SpendFloor's design does not depend on it: the
vault exposes only `transfer`, with no generic `execute`, no
`delegatecall`, and no batching, so the bypass class is removed
by design whether or not the Zodiac claim is true.

## E15 — EIP-7702 code on the agent EOA (documented, not a bypass)

The agent EOA holds no native balance, no SFUSD, and no
approvals (verified by T18). EIP-7702 lets an EOA delegate code,
but delegation does not create funds, does not change the signer
address (so `ecrecover` on spend intents still recovers the agent
address), and does not move vault funds: vault funds move only
via `spend`/`withdraw`, gated by the on-chain policy (agent
signer + recipient allowlist + caps + session) and the owner /
agent roles — not by agent EOA code. Even if code were delegated
to the agent EOA, it would have nothing to spend and no path
around the vault. EIP-7702 does not open a spend path.

## S14 — Solana clock manipulation (documented, not a bypass)

The Solana Clock sysvar is the median of validator timestamps,
bounded by the runtime's clock tolerance — no single validator
sets it arbitrarily. The policy window uses
`windowIndex = (now - anchor) / windowSeconds` with 86400 s
windows. A bounded clock skew (seconds to minutes) can only
shift a window boundary slightly; it cannot create unbounded
extra spend capacity, because spent resets only when a spend
lands in a new window index, and the per-transaction and window
caps still bind within any window. Boundary sensitivity to small
skews is inherent to any time-window policy and is bounded by
the skew, not an exploitable bypass.
