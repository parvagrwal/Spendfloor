# Verification record — 2026-11-18 UTC

Results below are **this checkout**, not copied pass counts from October. Local disposable Anvil, generated test keys and controlled RPC/model responses only. No user credentials, pushes, production probes or public transfers. [Captured outputs](evidence/engineering-2026-11-18/) include the environment, two TAP runs, Foundry summary, Anvil vector results and final npm audit.

|Gate / command|Observed result|What it establishes|
|---|---|---|
|`npm ci --ignore-scripts`|Pass from lockfile; Node 22.22.3/npm 10.9.8. Repeated after dependency changes.|Install without lifecycle scripts; `tsx`, TS and Web3 exercised afterwards.|
|`npm run typecheck`|Pass (strict/noEmit). Baseline: all six existing project checks also passed.|Type consistency across SDK, agent, CLI, policy, relay, conformance and new tests; not a substitute for on-chain execution.|
|`npm test`|**52 passed**, zero failures/skips (`unit.tap`). 36 existing golden/reference cases plus 16 hardening tests.|Canonical hashes and decision precedence; sponsored message integrity; key races/permissions; strict amounts, malformed action and owner inputs; loader/account data; uncertain receipt and resource limits. One pay journey uses real serialization/signatures with a transport double, not a real validator.|
|`cd evm && forge build --force && forge test`|Optimized Cancun build on pinned solc 0.8.37. **40 passed**, zero failures/skips, including 10,000-run fuzz tests (`forge-test.txt`).|Contract admin auth, expiry, replay, cap boundaries, failed-transfer invariants, golden hash parity. Foundry **1.7.1**, not the 1.8.5 release pin.|
|`npm run test:integration`|**15 passed; 3 skipped; 0 failed** (`integration.tap`).|Real local deploy/mint/pay/revert, relay off, rate limit, cross-vault signature isolation, concurrent identical intent via separate funded submitters, immutable code comparison. Skips: three Solana validator spend/read-state tests; no `.so`.|
|`SPENDFLOOR_EVIDENCE_DIR=<tempdir> npx --no-install tsx conformance/run-local-evm.ts`|**18/18** (`evm-local.json`).|Fresh Anvil P0/P1/P2 state including freeze, admin rejection, window rollover, expiry and replay. No inference that the Solana paired vectors passed this run.|
|`npm audit --json`|**0 critical, high, moderate, low or info** on final lock (`npm-audit.json`).|At baseline: 5 high, 7 moderate (includes transitive/metavulnerability counts). After initial pruning: 4 moderate. After scoped RPC-client upgrade: 0. Point-in-time npm advisory data only.|
|`detect-secrets` 1.5.0 (Python, outside project dependencies)|Scanned tracked sources/evidence and nonignored additions using explicit file list. Final implementation scan: 47 candidate files, 171 base64 entropy, 28 hex entropy, 5 IBM-key-pattern, 2 secret-keyword matches. No values logged here.|Five IBM patterns occur in public Solana token-address labels. Keyword matches occur in key schema/validation source. Entropy alerts include public addresses, hashes, signed artifacts and golden vectors. **Not a clearance of every entropy match, binary attachment, history or external key store**; human review before publication.|
|Operational static checks|`bash -n` on shell scripts, YAML parse of CI jobs, `git diff --check`. |Syntax/whitespace only; hosted runner, deploy credentials and alert destinations not exercised.|

### Failure investigations

The pinned native tools were absent. Downloading Foundry via the official release URL redirected to a disallowed asset host. Obtained Linux Forge/Anvil 1.7.1 separately via npm **outside the product tree**, and the pinned compiler via the GitHub solc-bin blob. See `environment.txt`. Did not downgrade compiler or fuzz settings. Compiler build succeeds; Foundry lint still flags three deadline/timestamp comparisons (required by time-based policy), the `uint256` → signed timestamp comparison (real block timestamps are in range; public helper is not general-purpose for arbitrary 256-bit timestamps), and two test-only narrowing casts (bounded list/synthetic caller). No critical warning suppressed.

During implementation typechecking caught incompatible wallet generics and an incorrectly typed domain chain ID; fixed and reran. The pay-through-relay RPC-double test initially supplied 20,000 lamports and correctly hit the real 10,000,000-lamport minimum. Corrected the **test fixture** to supply sufficient float; retained a separate explicit exhaustion assertion. No failing test was deleted or quota weakened. Baseline secret scan and optional Socket reports are not used as a security certification.

### Measurements (same sandbox)

|Measure|Baseline|After|Interpretation|
|---|---:|---:|---|
|Packages added by cold `npm ci --ignore-scripts --no-audit`|247|77|Fewer installed packages; includes workspace links, not unique security findings.|
|`du -sk node_modules`|332,495 KiB|146,030 KiB|~56% smaller installed footprint. Not browser bundle size or process RSS.|
|Limiter retained entries, 10,000 distinct identities spaced 60,001 ms apart|10,000 historical map keys|1 active timestamp/identity|Measured in process with controlled clock. New list bounded by configured global limit; cost proportional to that limit, not all historic identities.|
|SDK Solana success confirmation's extra `getTransaction` calls|1 (unconditional after confirmation in original SDK)|0 (asserted by RPC double)|One RPC round trip removed from SDK success path. Relay previously had separate logic. No public latency improvement claimed.|
|Foundry suite time|10.82 s|11.20 s|Single runs, randomized fuzz inputs; no throughput or speedup conclusion. No contract production bytecode optimization attempted.|

No statistically valid live p95/p99, model latency, public RPC throughput, sustained memory/load benchmark or coverage percentage measured. No Lighthouse/browser tests: no frontend. Database migrations/SQL injection/RLS tests not applicable. Ledger concurrency and authorization tests are relevant instead.

### External gates not verified

Pinned Rust/Anchor/Agave toolchain, SBF artifact reproducibility, Cargo vulnerability/yank status, LiteSVM property/precedence/native tests, three validator SDK tests, independent devnet providers, actual CLI owner operations, live verify, model inference, fee markets, chain reorganizations/finality, Socket and hosted CI are **unverified here**. `REQUIRE_SOLANA_TESTS=1` makes the missing SBF a failure for release testing. No proof of an audited mainnet setup, SLA, HSM custody, backup restore or replay-safe customer operation queue. Historical results in `evidence/T*` are useful diagnostics only.
