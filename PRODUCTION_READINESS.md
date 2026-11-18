# Release decision: NO-GO for market deployment

**2026-11-18 · Scope: current branch, single-operator testnet product.** Local EVM policy enforcement and specific off-chain safeguards have reproducible evidence. There is no equivalent current release attestation for the complete dual-chain system. In particular, a green npm scan says nothing about who can initialize the Solana PDA or what binary is deployed there.

|Dimension|Status|Decision evidence / gate|
|---|---|---|
|Functionality|Verified subset|52 offline tests; 15 passing integration cases, 3 skipped; 18/18 Anvil conformance. Model-to-real-dual-chain payment, live admin and validator execution not retested.|
|Architecture|Appropriate for a private testnet tool|Single authoritative policy per chain; relay verifies scope of its fee signature, not spend policy. Shared Solana confirmation/decoder. No speculative HTTP, SQL or microservices. **Not** a tenant-isolated SaaS or an atomic cross-chain wallet.|
|Security|Improved; blocked for real funds|Bounded signer scope, checked custody/export, fail-closed verifier and zero current npm advisories. First-initializer race remains a high-risk public deployment assumption. Independent contract review, Cargo audit, secret triage and attested native binaries required. Do not expose relay methods to untrusted clients.|
|Data integrity|Verified on Anvil; partial on Solana|Concurrent replay test: one successful debit, one `BadNonce`, no effect in another vault. 40 Foundry tests include stateful fuzz. On-chain rollback is per transaction, not per user request or cross-chain operation. No schema migration performed. Solana equivalence is not inferred.|
|Reliability|Improved, not end-to-end verified|Uncertain Sol broadcast keeps local signature; closure/float/timeout cases covered. Ambiguous EVM RPC submission, non-atomic admin/withdrawals and restart-reset rate limits require reconciliation. No durable business idempotency.|
|Performance|Measured locally only|~56% less installed JS footprint; idle limiter history bounded; one fewer RPC on successful SDK Solana confirmation. No measured customer traffic target, load SLO or reorg/failover exercise.|
|Testing|Meaningful partial coverage|Artifacts and exact limitations in [TESTING_REPORT.md](TESTING_REPORT.md). Pinned Foundry CI, native Solana pipeline and actual authorized testnet flows need a fresh successful run.|
|Accessibility|CLI only|No browser UI in this revision. Text results/exit status, JSON for completed verification. No assistive-technology acceptance test or WCAG claim.|
|Deployment & recovery|Local EVM reproducible; public release blocked|npm lock and native EVM artifact exercised. Solana program lockfile not committed; exact SBF reproduction and controlled first initialization unresolved. Rollback guide distinguishes client rollback, program upgrade and irreversible transfers.|
|Observability|Operator diagnostics only|Receipts, per-check status, failure exits and test artifacts. No production alerts, durable audit log, incident drill or monitored SLO.|
|Maintainability|Improved|Root TS/test gates, pinned package resolution, independent fixtures, documented trust boundaries. Demo-specific addresses, staged experiments and operator-managed manifests still require careful review.|

**Permitted now:** use the documented disposable Anvil workflow, offline policy tools and tests. Evaluate Solana on isolated disposable infrastructure with no assets of value. **Not approved:** custody of real funds, public sponsorship endpoint, shared customer vaults, or any claim of atomic two-chain recovery.

Before reconsideration, close R4 and R8–R9 release gates in [REMEDIATION_REPORT.md](REMEDIATION_REPORT.md); obtain operator sign-off on the exact manifest and binary hashes; pass both native suites with zero required skips, current Rust and JS audits, and an independently observed restore/partial-failure drill. See [initial inventory and risk model](ENGINEERING_AUDIT.md), [execution evidence](evidence/engineering-2026-11-18/) and [deployment guide](DEPLOYMENT.md).
