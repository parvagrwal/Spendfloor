# SpendFloor

![CI](https://github.com/parvagrwal/SpendFloor/actions/workflows/ci.yml/badge.svg)

One spend policy for AI agents, enforced on-chain on Base and Solana. The agent's key holds nothing, so a prompt-injected drain gets rejected by the vault.

## The problem

AI agents that move money can be prompt-injected into draining the wallets they control. Existing defences are off-chain policies, allowlists, or human approvals, all bypassable once the agent's key is compromised. SpendFloor moves the policy on-chain, so the vault itself rejects a bad spend, no matter what the agent was told to do.

## How it works

- **One canonical policy, hashed identically on both chains** (`policyHash`). Same caps, same recipients, same window, on Base Sepolia and Solana devnet.
- **A vault contract on each chain** (Solidity on Base Sepolia, Anchor on Solana devnet) enforces the policy on every spend: per-transaction cap, window cap, recipient allowlist, freeze, expiry.
- **Three keys, three roles.** OWNER sets the policy and stays off the agent machine. AGENT signs spend intents and holds zero native, zero tokens, zero approvals. SUBMITTER pays gas and has no authority.
- **Only `spend` and `withdraw` move vault funds.** The relay submits spends but enforces no policy, so it cannot steal and cannot bypass the vault. A server-off test proves nothing moves without the chain: with all app processes stopped, raw spends still fail.
- **Precedence is fixed.** Unauthorized, then Frozen, then SessionExpired, then ZeroAmount, then RecipientNotAllowed, then DailyCapExceeded, then PerTxCapExceeded. The EVM adds transport errors (BadNonce, IntentExpired, DeadlineTooFar) between Unauthorized and Frozen. Solana transport failures (expired blockhash, duplicate) never land and are reported as NotLanded, a documented difference.

## Live demo

Live: https://parvagrwal.github.io/Spendfloor/ui/

No terminal needed. Open the live link above, or open `ui/index.html` directly in a browser, or serve the `ui/` folder.

The page has two parts:

- **Demo:** a guided walkthrough of one injection. Press Play and narrate, or step through it yourself. Setup, injection, draft, vault checks, a real on-chain rejection hash, and a valid spend that still works.
- **Playground:** try it yourself. Pick an amount, a recipient, and a signer, and see what the vault would do. It runs entirely in the browser, sends no transaction, and touches no keys.

### Live deployments (testnet)

| | Base Sepolia | Solana devnet |
| --- | --- | --- |
| Vault / program | `0x8d13a6a31518b357a480659073b9db78ab861809` | `CQfuniyvMY9sPDAFMPRZzbpHEwRiyy3Y4BsfuQd3iAbE` |
| Token | SFUSD `0xb86efe265be37a521ddb271d750e6a41cb2471e2` | Mint `ESB1d6WUnz6e9yRmC9hv8MrHHzrQs8eFSV6aosDHNt2U` |
| Policy PDA / merchant | Merchant `0x61f1c99d674bcd333578AC4f538F46AbC7bB4106` | Policy PDA `5MUi1eZAfjaCukRDZNntAMJCr5Xz6gCRJ9s7D2iJyfuE` |

Policy (same on both chains): per-transaction cap 2 SFUSD, window cap 5 SFUSD, window 86,400 s (24 h), recipients merchant only. Policy hash `0xf36d290ed7e1cc23af0ea7f08ae4f3ee0b1bcfead65e4a4744c76c70a7f5b820` on both chains. Live state: spent 1 SFUSD per chain, headroom 4 SFUSD. Verify: GREEN 15/15.

### Proof

10 on-chain-confirmed rejections: 5 rehearsal runs x 2 chains, all RecipientNotAllowed, all under 90 s, amount fidelity true. Full hashes and explorer links are in [docs/EVIDENCE.md](docs/EVIDENCE.md) and on the demo page.

## How to use

### Prerequisites

Node.js 22 or later, Foundry (for the EVM vault), Solana CLI plus Anchor (for the Solana program), and Ollama (for the agent loop, which uses qwen2.5:3b). Exact pinned versions are in [TOOLCHAIN.md](TOOLCHAIN.md).

### 1. Clone and install

```bash
git clone https://github.com/parvagrwal/SpendFloor.git
cd SpendFloor
npm ci
bash scripts/check-toolchain.sh
```

### 2. Set up keys

Keys live outside the repo, never in it, and are never printed. Generate one role keypair per chain, on the machine that owns that role. The owner machine can never generate agent or submitter keys, and an agent machine can never generate an owner key. Custody is enforced in code, not by convention.

```bash
npx tsx sdk/gen-key.ts --chain evm|sol --role owner|agent|submitter [--machine owner|agent]
```

The first run on a machine must pass `--machine`, which writes the machine marker. After that the marker rules. Owner keys stay off the agent machine. Agent keys hold zero native, zero tokens, and zero approvals, checked by the funding check before any spend.

### 3. Deploy (owner machine only)

Build the EVM vault, then deploy one SFUSD token plus three vaults (demo/P0, P1, P2) and mint 100 SFUSD to each vault, all from the owner key. The vault owner is the deployer and there is no ownership transfer, so this must run with the owner key.

```bash
cd evm && forge build
cd .. && npx tsx sdk/deploy-t16.ts
```

For localnet (Anvil, throwaway accounts, no custody check):

```bash
SPENDFLOOR_LOCALNET=1 npx tsx sdk/deploy-t16.ts
```

Deploy the Solana program, then create the mint, the vault token account, and the policy PDA, and mint 100 SFUSD to the vault, all from the owner key:

```bash
solana program deploy --url https://api.devnet.solana.com \
  --keypair ~/.spendfloor-keys/sol-owner.json \
  --program-id solana/target/deploy/spendfloor-keypair.json \
  solana/target/deploy/spendfloor.so
SPENDFLOOR_SOL_PROGRAM_ID=<program-id> npx tsx sdk/solana-deploy-t16.ts
```

Demo policy (both chains, SFUSD 6 decimals): per-transaction 2, window 5, window 86,400 s, anchor now, expiry now plus 86,400, recipients merchant only. The demo merchant is receive-only and its keys are stored nowhere.

### 4. Verify the live state

```bash
npx tsx cli/spendfloor.ts verify [--net testnet] [--json]
```

15 checks, exit code 0 if all pass. It reads the enforced state from both chains, recomputes everything from what it reads (trusting neither stored hash), and reports PASS/FAIL per check with a precise diff on failure. If the Solana second RPC is unset, it reuses the first and flags the output as not independent, rather than claiming independence it does not have.

### 5. Run the agent and the relay

The agent loop takes one message, sends it to the model, and if the model clearly asks to pay, signs that spend with the agent key. It enforces nothing and checks no policy. The relay holds only the submitter key, pays gas, and broadcasts the agent's signed spends through the vault. It enforces no policy and forwards only through the vault, never a direct token transfer.

To run the demo injection (one pasted message, executed on both chains through the relay):

```bash
npx tsx agent/demo-injection.ts --message "<pasted message>" [--net testnet|local]
```

For an injection (pay to a non-recipient), both chains must return RecipientNotAllowed with a hash or signature, and the vault state must be unchanged. For a local run, Anvil is used and a fresh vault is deployed for legit-pay proof. The full localnet fallback, including Surfpool for Solana, is in [docs/DEMO_RUNBOOK.md](docs/DEMO_RUNBOOK.md).

### 6. Manage as owner

All owner commands run on the owner machine only. Freeze and unfreeze run on both chains in parallel and record the skew, which is not atomic.

```bash
npx tsx cli/spendfloor.ts owner freeze
npx tsx cli/spendfloor.ts owner unfreeze
npx tsx cli/spendfloor.ts owner set-policy --per-tx 2000000 --window 5000000 --window-secs 86400 --expiry-secs 86400
npx tsx cli/spendfloor.ts owner withdraw --amount 1000000
npx tsx cli/spendfloor.ts owner set-agent --evm-agent <hex> --sol-agent <base58>
```

Note: `setPolicy` never resets spent. To force a reset, move to a new window index.

## Sponsor integrations

### Socket.dev — code integration (CI)

Socket scans the repo's dependencies on every push, via `.github/workflows/ci.yml`, for malicious packages and known CVEs. This is the one real sponsor code integration, not a narrative claim: the scan actually runs in CI.

Latest finished scan: 623 dependencies scanned, 16 alerts found (3 malicious, 6 high CVE, 5 medium CVE, 1 low CVE, 1 deprecated). Triage: 0 new, 0 reachable, 0 fixable, 0 in production, and none are direct dependencies (all transitive in lockfiles). Status is triaged, accepted risk, not a clean bill. Full triage is in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) section 5.

### Cake Wallet — narrative fit, no code

Cake Wallet is a wallet sponsor, and SpendFloor is about agent spending safety, so it is a narrative fit for Cake's judging table. There is no Cake SDK, no code integration, and no claim otherwise. The distinction matters: Socket is the code integration, Cake is the story fit.

## Repo layout

- `evm/` — Solidity vault and SFUSD token (Foundry)
- `solana/` — Anchor program, LiteSVM tests, property tests
- `sdk/` — keys, funding checks, RPC probe, deploy scripts, EVM and Solana clients
- `policy/` — canonical policy encoding, golden hashes, reference model, draft guard and retry
- `agent/` — agent loop, pay tool, demo injection, rehearsal
- `relay/` — submitter relay (gas only, no policy logic)
- `cli/` — verify CLI and owner CLI
- `conformance/` — local and testnet conformance runners, differential and precedence runners
- `docs/` — evidence, honest matrix, threat model, demo runbook
- `evidence/` — per-task evidence (hashes, logs, runs)
- `deployments/` — testnet and localnet deployment records
- `ui/` — demo page (demo mode plus playground simulator, single file, no build)
- `scripts/` — toolchain check, clean-room runner, raw server-off scripts
- `rebalance-bot/` — stub, no code yet

## Docs

- [docs/EVIDENCE.md](docs/EVIDENCE.md) — rehearsal runs, hashes, explorer links
- [docs/HONEST_MATRIX.md](docs/HONEST_MATRIX.md) — live state and honest gaps
- [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) — threats, Socket scan triage, residual risks
- [docs/DEMO_RUNBOOK.md](docs/DEMO_RUNBOOK.md) — how to run the demo, testnet and localnet
- [TOOLCHAIN.md](TOOLCHAIN.md) — pinned toolchain versions

## Limitations (honest)

- Testnets only (Base Sepolia, Solana devnet) with a test token. No real funds, no mainnet deployment.
- Vaults are unaudited. Static analysis is done (Slither, Clippy, cargo-audit, Socket scan in CI), but that is not an audit.
- Product-market fit is not validated. The problem is validated at incident level only, with zero user contact so far: no interviews, no trials, no integrations.
- No production users yet. The deployments above are the hackathon demo.
- CI runs Foundry tests and a Socket scan on every push. See `.github/workflows/ci.yml`.

## Status

Built at HH Goa 2026. Work in progress, testnets only.
