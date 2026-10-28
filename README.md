# SpendFloor

One spend policy for AI agents, enforced on-chain on Base and Solana. The agent's key holds nothing, so a prompt-injected drain gets rejected by the vault.

## The problem

AI agents that move money can be prompt-injected into draining the wallets they control. Existing defences are off-chain policies, allowlists, or human approvals — all bypassable once the agent's key is compromised.

## How it works

- One canonical policy, hashed identically on both chains (`policyHash`).
- A vault contract on each chain (Solidity on Base Sepolia, Anchor on Solana devnet) enforces the policy on every spend: daily cap, per-transaction cap, allowlist, freeze, expiry.
- Three keys, three roles: OWNER (sets policy, off the agent machine), AGENT (signs spend intents, holds zero native, zero tokens, zero approvals), SUBMITTER (pays gas, has no authority).
- Only `spend` and `withdraw` move vault funds. A server-off test proves nothing moves without the chain.

## Status

Built at HH Goa 2026. Testnets only — Base Sepolia and Solana devnet. Work in progress.

Done so far: toolchain pinned (T01), key custody enforced (T02), canonical policy encoding with golden hashes (T05), agent spike proving an injected instruction reaches the signer (T08).

## Repo layout

- `evm/` — Solidity vault (Foundry)
- `solana/` — Anchor program
- `sdk/` — key generation, role custody checks, funding checks
- `policy/` — canonical policy encoding and golden test vectors
- `agent/` — demo agent spike
- `scripts/` — toolchain version check

## Run the toolchain check

```bash
bash scripts/check-toolchain.sh

