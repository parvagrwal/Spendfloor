# SpendFloor demo UI — architecture, operation, and honest limitations

This document describes the five-screen browser application added to the existing CLI-first SpendFloor repository. It is a **testnet demonstration control plane**. It is not a hosted service, not a wallet, and not an approval for real funds.

## 1. What was built

A single React/TypeScript/Vite application with persistent navigation and a narrow local operator adapter:

| Screen | Route | Purpose |
|---|---|---|
| Command Center | `/command-center` (and `/`) | Protection state, policy summary, three roles, network state, canonical fingerprint |
| Attack Playground | `/attack-playground` | The centerpiece: run the repository's real demo injection and inspect independent per-chain results |
| Architecture Explorer | `/architecture` | Interactive diagram of roles, vault enforcement boundary, and two chain implementations |
| Transaction Proof | `/transaction-proof` | Latest structured run and separately labelled historical evidence |
| Policy Control | `/policy-control` | Live policy/recipient reads, owner-only freeze and policy-update workflow preview |

The browser never signs, never holds a key, and never enforces policy. The vault remains the enforcement boundary.

## 2. Architecture

```
Browser (Vite UI, 5173 in dev)
   │ relative /api/* only
   ▼
Vite proxy
   │ loopback 127.0.0.1:8787
   ▼
Local operator adapter (operator/server.ts)
   ├── read-only state: sdk.readEvmPolicy / sdk.readSolPolicy
   │                    + policy/src/canonical.ts policyHash()
   ├── historical evidence: evidence/T27/*.json + evidence/T26/*.txt
   ├── policy preview: canonical hash only, applied:false, never submitted
   └── execution allowlist: spawns agent/demo-injection.ts --json-events
                              with a server-chosen instruction
                                   │
                                   ▼
                        agent → relay → on-chain vault (Base Sepolia + Solana devnet)
```

Security boundaries:

- The operator binds to loopback by default (`SPENDFLOOR_OPERATOR_HOST` to override deliberately).
- Execution is disabled unless `SPENDFLOOR_DEMO_ENABLE=1` is set **on the operator host**.
- Only two scenario IDs are accepted, and the browser-supplied instruction must match the operator's exact allowlisted string (whitespace-normalized only). No arbitrary amount, recipient, network or transaction bytes are accepted.
- The relay's internal methods are not exposed as an API. The child demo process uses the existing `createRelay` configuration and vault target allowlist.
- OWNER keys are never read by the browser, the Vite bundle, or the operator. Freeze and policy changes stay in the existing owner CLI.
- Historical evidence is read from committed evidence files and is always labelled with its source and date. There is no silent fallback to simulation.

## 3. Existing backend capabilities reused

- `agent/demo-injection.ts` — the real one-message injection demo (unchanged execution path; only optional `--json-events` structured logging was added).
- `agent/loop.ts`, `agent/pay.ts`, `agent/amount.ts` — LLM turn, exact six-decimal conversion, EIP-712 intent and partially signed Solana spend.
- `relay/submitter.ts`, `relay/envelope.ts` — submitter role, rate/float limits and sponsored-message verification.
- `sdk/evm.ts`, `sdk/sol.ts`, `sdk/errors.ts` — policy reads, signing, forced-landing broadcast, normalized labels and receipt hashes.
- `sdk/keys.ts` — role separation and external key custody checks (presence only; no key material is exposed).
- `policy/src/canonical.ts` — canonical SHA-256 fingerprint and validation. No duplicate hashing algorithm was written in the frontend or operator.
- `deployments/base-sepolia.json`, `deployments/solana-devnet.json` — public deployment records.
- `docs/EVIDENCE.md`, `evidence/T27/rehearsal-2026-10-30.json`, `evidence/T26/demo-localnet-merchant-2026-10-30-r2.txt` — historical evidence.

## 4. New code

| Path | Role |
|---|---|
| `frontend/` | Five-screen React UI, design system, API client, shared state |
| `operator/config.ts` | Public deployment/scenario config and exact instruction allowlist |
| `operator/state.ts` | Read-only chain-state adapter, canonical recomputation, expiry/status classification |
| `operator/demo.ts` | Structured-event parser, transaction lifecycle classifier, guarded demo process adapter |
| `operator/evidence.ts` | Historical evidence adapter from committed files |
| `operator/server.ts` | Narrow loopback HTTP API and optional static serving |
| `operator/types.ts` | Transport contract shared conceptually with the UI |
| `operator/test/adapter.test.ts` | Integration-boundary and state-classification tests |
| `operator/test/server.test.ts` | Real HTTP API boundary tests (ephemeral port, no transactions) |
| `frontend/test/format.test.ts`, `frontend/test/render.test.ts` | Formatter and populated-state SSR tests |
| `scripts/dev.ts` | Starts operator + UI with one command |
| `agent/demo-injection.ts` (modified) | Optional `SPENDFLOOR_EVENT` JSON lines; no execution behaviour changed when the flag is absent |
| `package.json` (modified) | UI/operator scripts, dependencies, test and typecheck gates |

No backend policy or contract logic was rewritten.

## 5. Exact setup and run commands

```bash
# Node >=22, from the repository root
npm ci --ignore-scripts
npm run typecheck
npm test

# Development: UI at http://localhost:5173, operator on 127.0.0.1:8787
npm run dev

# Built app: operator serves the UI and API from one origin on 127.0.0.1:8787
npm run build
npm start
```

The Vite dev server binds `0.0.0.0` so it works behind the Arena preview proxy; the browser only calls relative `/api/*` paths, which Vite proxies to loopback. There is no browser-to-RPC or browser-to-Ollama connection.

## 6. Environment variables

| Variable | Required for | Meaning |
|---|---|---|
| `SPENDFLOOR_DEMO_ENABLE=1` | Live demo execution | Explicit operator-side opt-in. Without it `/api/demo/execute` returns 403 and no process is spawned. |
| `SPENDFLOOR_DEMO_NET=local` | Localnet execution | Switches the demo to Anvil + Surfpool. Default is `testnet` (Base Sepolia + Solana devnet). |
| `SPENDFLOOR_OPERATOR_PORT` | Custom port | Operator port, default `8787`. Vite proxy must match if changed. |
| `SPENDFLOOR_OPERATOR_HOST` | Non-default binding | Default `127.0.0.1`; do not expose this service publicly. |
| `SPENDFLOOR_KEYS_DIR` | Live execution | Existing SDK convention: private directory outside the checkout, default `~/.spendfloor-keys`. Holds AGENT + SUBMITTER keys on the demo machine. |
| `OLLAMA_URL`, `OLLAMA_MODEL` | Demo agent | Existing convention; the demo script uses `http://localhost:11434` and `qwen2.5:3b`. Only the operator contacts Ollama. |
| `SOL_RPC2` | Independent CLI verify | Existing CLI convention; unrelated to the UI's read-only status adapter. |

No owner key, seed phrase or private RPC credential is used by the frontend or exposed through an environment variable to the browser bundle.

## 7. Testing performed

- `npm run typecheck` — pass (root SDK/agent/CLI/policy/relay/conformance, frontend, operator).
- `npm test` — **76 passed, 0 failed** (52 pre-existing + 11 operator adapter + 5 API boundary + 3 formatter + 5 populated-state render tests).
- `npm run build` — pass; Vite production bundle produced.
- Operator endpoints exercised with `curl`: health, scenarios, status (correctly reported `failed` when RPC was unreachable), evidence, policy preview, and forbidden execution when disabled.
- All five pages server-rendered without runtime errors in their empty/unavailable states.
- **Not exercised in this sandbox:** live testnet/localnet execution, Ollama inference, real key loading, and live RPC reads. The sandbox has no demo keys, Ollama, Foundry, Solana tooling or outbound RPC access. No live success is claimed.

## 8. Incomplete or unavailable capabilities

- Freeze/unfreeze and policy updates are **read-only/preview only** in the UI. They require the OWNER machine and the existing CLI; no frontend flow pretends to change the vault.
- Arbitrary natural-language instructions are intentionally rejected by the operator; only the two exact documented scenario instructions can be executed.
- There is no hosted API, authentication, database, audit log, monitoring or multi-tenant layer. This is a local single-operator demo.
- Live chain state was unavailable in this environment; the UI showed an explicit unavailable/failed state and did not substitute October values.
- The recorded demonstration policy expired on **2026-10-30 18:55:40 UTC**. A live testnet payment requires an OWNER renewal and current verification. The UI surfaces the expiry instead of claiming active spending capacity.
- Historical Solana verification was not independent-provider checked (`SOL_RPC2 == RPC1` in the T25 run). The proof screen states this caveat.
- No claim of audit, production readiness, real funds, adoption or uptime is made.

## 9. Seven-to-eight-minute presenter walkthrough

**Before the room:** start `npm run dev`; confirm the status panel. If chain reads are unavailable, say so and use the labelled recorded evidence for proof. Do not describe a historical transaction as live.

1. **0:00–0:45 — Command Center.** "SpendFloor is a security layer for AI agents that spend money. Instead of trusting the agent to follow instructions, we enforce spending rules at the vault." Point out the three role cards and the live/unavailable policy state.
2. **0:45–1:30 — Architecture Explorer.** Select AGENT, SUBMITTER and the vault. "The agent can sign and the submitter can relay, but neither controls the rules. The vault enforces them on both chains."
3. **1:30–4:00 — Attack Playground.** Attack scenario is preselected. Press **EXECUTE ATTACK**. Show the four lifecycle states, then the two independent network cards. The expected documented result is `RecipientNotAllowed` on each chain with a real hash/signature; only show `THE ATTACK FAILED.` when both returned that evidence.
4. **4:00–5:15 — Legitimate Payment.** Switch scenario, press **EXECUTE PAYMENT**. Show confirmed receipts if — and only if — both chains actually returned success.
5. **5:15–6:30 — Transaction Proof.** Show the latest run's identifiers and explorer links. Open Historical Runs to show the five recorded 2026-10-30 testnet rejections and the localnet control, each with source and date. Show the freshly computed fingerprint or the honest unavailable state.
6. **6:30–7:30 — Policy Control.** Show live limits, merchant allowlist, read-only freeze control and the owner CLI command. Close with: "Let AI make decisions. Don't let it own the consequences."

## 10. Live-demo recovery procedure

1. If **live execution is disabled** or the operator is unreachable: check `npm run dev` logs, then set `SPENDFLOOR_DEMO_ENABLE=1` and restart the operator. No transaction was submitted in the failed attempt.
2. If **Ollama is unavailable**: start `ollama serve`, confirm `qwen2.5:3b` is pulled, then retry. The agent never signed, so there is no transaction to reconcile.
3. If **keys are missing**: verify `SPENDFLOOR_KEYS_DIR` and the `MACHINE=agent` marker. The operator refuses to load owner keys and never asks the browser for keys.
4. If **an RPC fails**: the UI reports the chain as unavailable/failed. Do not present a green state. Retry a read with "Refresh state" when connectivity returns.
5. If a result is **Timeout / RpcError**: keep the identifier, look it up on the relevant explorer, and do not resubmit. A broadcast may still land; a timeout is not a rejection.
6. If **one chain succeeds and the other does not**: report them separately. Cross-chain operations are not atomic; reconcile each leg using DEPLOYMENT.md.
7. If live execution cannot be restored: open **Transaction Proof → Historical Runs**, state explicitly that these are recorded 2026-10-30 results, and walk through the recorded hashes and explorer links. Do not switch to a simulated success.

## 11. Remaining risks before any wider deployment

- The relay is a liveness dependency with process-local rate/float limits; it is not an authenticated public service. Do not expose the operator or relay to untrusted clients.
- The recorded Solana PDA has a first-initializer ownership race and must never be funded before independent bootstrap verification.
- The demo policy expiry and recorded session state are stale; a live payment requires owner renewal and a fresh verify.
- Historical verification and rejection evidence is not a current attestation; independent explorer inspection is required.
- The EVM vault is immutable; a Solana code rollback requires upgrade authority. Neither reverses a confirmed transfer.
- No audit, hosted monitoring, incident drill or production threat model covers this new UI. Treat it as presentation infrastructure for a disposable testnet demo.
