# Operator guide: disposable local networks and authorized testnets only

There is no web server to run, database to migrate, or production image to publish. TypeScript programs run on Node using `tsx`. Deployable binaries are the EVM bytecode and Solana SBF program. A frontend, public relay endpoint and mainnet configuration are **not** included. A working CLI is not a release approval.

## Reproduce the release candidate

Use a clean Linux checkout, Node >=22 and the native pins in `TOOLCHAIN.md`. On a CI runner, `.github/workflows/ci.yml` contains the Agave tarball version and SHA-256. Install native tools from verified releases, not unversioned installers. A networked Rust build host is needed for the program dependencies and platform tools. Exact JS install, no wallet required:

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
(cd evm && forge build && forge test)
# Run on an isolated host with disposable ports 8545 and 8899.
npm run test:integration
SPENDFLOOR_EVIDENCE_DIR="$(mktemp -d)" npx --no-install tsx conformance/run-local-evm.ts
npm audit --audit-level=high
```

Integration tests start ephemeral chains or reuse a running local node. **Do not point them at a shared ledger.** Without `solana/target/deploy/spendfloor.so`, three validator tests skip. For the **required** Solana gate on the native host:

```sh
(cd solana && cargo build-sbf --tools-version v1.58 && cargo test --release)
(cd solana/litesvm-tests && cargo test --locked --release)
(cd solana && cargo audit && cargo audit --file litesvm-tests/Cargo.lock)
REQUIRE_SOLANA_TESTS=1 npm run test:integration
```

The integration harness preloads the artifact at its declared ID on a fresh validator. If supplying your own validator, preload that same program with an uninitialized policy PDA. Never reset an existing user's validator. The Rust test crate has a lockfile; **the program workspace does not yet**. Capture and review its resolved `solana/Cargo.lock` on the native host before promoting a release; repeat a clean locked build and compare artifacts. Do not generate a fictitious lock from the unrelated test crate. Historical LiteSVM conformance writes under `evidence/`; use a disposable checkout. Record tool versions, revision, lockfiles, checksums, test and advisory reports together. Check `scripts/check-toolchain.sh` on the full demo host (including Ollama and model).

## Config and trust

|Setting|Purpose/default|
|---|---|
|`SPENDFLOOR_KEYS_DIR`|Private POSIX directory outside checkout, default `~/.spendfloor-keys`; directory 0700, key files 0600. `MACHINE` records role split.|
|`SPENDFLOOR_LOCALNET`|Set exactly `1` for the Anvil path in `sdk/deploy-t16.ts` and `conformance/owner.ts`. **Not** a global network switch. Demo network is `--net local` or `--net testnet`; verify/owner target testnets.|
|`SPENDFLOOR_EVM_RPC`, `SPENDFLOOR_SOL_RPC`|Override providers in setup, funding and spike scripts that read them. Demo/CLI otherwise use explicit Base Sepolia / Solana devnet URLs. Local Solana setup requires loopback. Do not publish credential-bearing URLs or raw RPC logs.|
|`SOL_RPC2`|Operator-provided independent devnet endpoint for `verify`. Different hostname required, different underlying provider must be checked by operator.|
|`SPENDFLOOR_SOL_PROGRAM_ID`, `SPENDFLOOR_LOCAL_OWNER_KEYPAIR`|Deployed program ID for setup; latter is a disposable bare-key file for local setup only. Program address must equal the artifact's `declare_id!`.|
|`SPENDFLOOR_EVIDENCE_DIR`, `REQUIRE_SOLANA_TESTS`|Optional T17 local EVM result directory; set `REQUIRE_SOLANA_TESTS=1` to forbid skipping the missing SBF build.|
|`OLLAMA_URL`, `OLLAMA_MODEL`; `OLLAMA_HOST`, `SF_MODEL`|Policy compiler experiment settings; latter pair are for the agent spike. Main demo loop defaults to local `http://localhost:11434` and `qwen2.5:3b`; draft default is 7b. Do not expose Ollama or feed secrets as prompts.|
|`SPENDFLOOR_HELIUS_API_KEY`, `SPENDFLOOR_EVM_SEQUENCER_RPC`|Optional credential/provider for RPC probes. Do not run probes as production load tests.|
|`SPENDFLOOR_VAULT_ADDRESS`, `SPENDFLOOR_SPEND_RESUME`|Legacy spend spike overrides; not the current dual-chain release procedure.|
|`EVM_VAULT`, `EVM_P1_VAULT`, `EVM_P2_VAULT`, `SOL_PROGRAM`, `SOL_POLICY`, `SOL_VAULT_TOKEN`, `SOL_MERCHANT_TOKEN`, `SOL_ATTACKER_TOKEN`|Explicit targets for stateful public conformance. `SKIP_EVM`, `SKIP_SOL`, `RESUME` select staged runs; skipped/pending steps are not release proof.|
|`SOCKET_SECURITY_API_KEY`|CI secret only, optional Socket scan. Without it use the independent npm/Rust checks; don't mark Socket verified.|

Public trusted inputs: `sdk/addresses.json` (roles), `deployments/{base-sepolia,solana-devnet}.json` (testnet targets). Pin and review these **out of band**, not from model output or an incoming request. For a new local or custom relay, pass `createRelay(..., {targets: {evmVaults, solVault: {program, vaultToken, agent}}})`. Omitted local targets deny sponsorship. Update the relay configuration on agent rotation. Restrict to a single trusted operator; no external HTTP admission control exists.

## Provision and initialize

1. On physically/logically separate owner and agent hosts, with private storage, generate only the roles needed, e.g. `npx --no-install tsx sdk/gen-key.ts --chain sol --role owner --machine owner`. Repeat for EVM. On the agent host use `--machine agent` and generate agent and submitter keys. Record only public addresses in the registry. Do not fund agent keys or reuse demo keys on another network. Back up keys/upgrade authority encrypted and test restoration on an isolated host. The code cannot protect against a compromised OS.
2. For disposable EVM, start `anvil` on loopback and run `SPENDFLOOR_LOCALNET=1 npx --no-install tsx sdk/deploy-t16.ts`. For **authorized Base Sepolia only**, review RPC/chain ID (84532), owner, agent, merchant, gas and mint amounts, then run the same script without localnet mode on the owner host. Save every transaction hash. Deploying is **not** idempotent.
3. On Solana, review program ID, loader, artifact digest, deploy authority, mint authority and intended cluster before signing. Initialize only a freshly approved program; never overwrite an existing deployment to complete a checklist. The canonical ID is embedded in the binary. Deploying to another ID requires updating `declare_id!`, Anchor config, fixtures and clients, rebuilding and re-verifying. A wrapped role-key JSON is **not** a Solana CLI keypair: `npx --no-install tsx sdk/sol-key-to-bare.ts owner` produces an exclusive private temporary file. Supply its path explicitly to the CLI, remove that file immediately after use, and never save it in logs/backups of the checkout. See `sdk/solana-deploy-t16.ts` for the devnet deploy arguments.
4. Public bootstrap is a release blocker: **the first initializer of `["policy"]` becomes owner**. Never send assets to a predicted PDA before confirming the correct initialization. On disposable devnet only, after deploying the reviewed `.so`, `SPENDFLOOR_SOL_PROGRAM_ID=<approved-id> npx --no-install tsx sdk/solana-deploy-t16.ts` creates mint/accounts, initializes policy and checks owner, agent and mint before minting demo tokens. If the PDA already exists, stop. Do not retry a partial setup without accounting for already-created accounts. For local Surfpool follow `docs/DEMO_RUNBOOK.md` with throwaway local keys/addresses. Old T07 lamport scripts are not compatible with this SPL policy.
5. Independently record and review manifest values (including recipients and approved caps). Compare against both chains; run `npx --no-install tsx cli/spendfloor.ts verify --json` with second provider and verified local artifacts available. A red result after an intended policy change requires review against the approved manifest, **not** editing it to match whatever the network returned. Expiry and current remaining headroom must be checked separately before a live payment. Historical October timestamps are not live sessions.

## Release, monitoring and recovery

There is no SQL migration. Schema is contract storage and the Anchor Borsh layout. This change set requires no existing state rewrite. Never deploy incompatible layout under an existing program ID without a tested conversion and recovery plan. Retain exact previous binary, IDL/schema, build inputs, authorities and manifest; keep private keys separate from build artifacts.

Observe local exit codes, structured `verify --json` reports, transaction hashes/signatures, timestamps, nonce/spent/window, frozen state, payer balances and provider agreement. Record the requested operation and both receipts **before declaring success**. Treat logs from legacy experiments and raw model text as sensitive. No production alert backend, SLO or durable journal is bundled. Alert on unknown outcomes, role/hash drift, anomalous fee spend, RPC disagreement and any one-sided admin change.

If a payment times out, stop new work and look up the original ID on independent providers. A `SubmitFailed` or `RpcError` is not proof that the provider never accepted a send. Compare nonce, recent finalized transactions, token balances and spent counters. Do **not** sign a new blockhash/nonce or repeat a withdrawal as a retry. Window rollover can make comparisons of `spent` alone misleading. Cross-chain freeze, withdraw, rotate and set-policy are two transactions, not a distributed commit. Reconcile each leg separately; leave both frozen until ownership and policy are confirmed. Emergency operator commands need owner keys, not the relay. Stop the agent/relay as containment, but only on-chain freeze stops other submitters.

For a client regression, stop submissions and restore the reviewed previous client/config **only if it preserves custody safeguards**; verify before re-enabling. An immutable EVM vault cannot be patched or rolled back: any move to a replacement is an explicitly authorized owner operation. A Solana code rollback requires upgrade authority and compatibility with existing state. Never equate a binary rollback with reversing a confirmed transfer. Loss of an immutable owner key may be unrecoverable. No public-network release, restore drill or asset transfer was performed in this audit.
