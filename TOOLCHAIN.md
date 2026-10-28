# SpendFloor — TOOLCHAIN.md

Pinned 2026-10-29(T01). Both machines must match this file.
`scripts/check-toolchain.sh` prints every installed version and exits 0 only when all match.
Change a pin only by editing this file and re-running the check on both machines.

## Pins

| Tool | Pin | Rule |
|---|---|---|
| Rust (rustc / cargo) | 1.99.1 | `solana/rust-toolchain.toml` carries the same channel |
| Foundry (forge / cast / anvil) | 1.8.5 | Stable only, never nightly. Solc pinned in `evm/foundry.toml` |
| Solc (via forge) | 0.8.37 | Pinned in `evm/foundry.toml`, not left to auto-pick |
| Solana CLI | 4.1.2 | Pairs with platform-tools below. 3.1.10 is the documented fallback only |
| Solana platform-tools (cargo build-sbf) | v1.58 | As reported by `avm install 1.2.0` on this CLI line |
| Anchor CLI / anchor-lang / anchor-spl | 1.2.0 | Rust crates and `@anchor-lang/core` all on 1.2.0 |
| Node.js | >= 22 LTS | 22.23.3 (WSL) and 24.20.0 (Muse VM) both verified |
| npm packages | see `package.json` | Exact versions, no ranges: `@anchor-lang/core` 1.2.0, `@solana/web3.js` 1.99.0 (1.x line on purpose; 3.x exists and is NOT used), `@solana/spl-token` 0.4.15, `viem` 2.57.7, `litesvm` 1.6.1, `typescript` 5.9.3, `tsx` 4.23.15 |
| Ollama | 0.40.6 | Model below |
| Ollama model | `qwen2.5:7b` | Fallback `llama3.1:8b`. Pull state recorded in the log below. **T08 outcome (2026-10-29): the demo AGENT runs `qwen2.5:3b`** (in the plan's latency fallback ladder) — 7B failed the ≤15 s warm-latency bar on both machines (medians 30.0 s / 70.9 s); 3B passed on both (12.5 s / 14.7 s) with 9/10 reach. The 7B stays installed for the T09 compile spike |

## Version-decision notes

- `evm_version` is pinned to `cancun` in `evm/foundry.toml`, explicitly NOT the Foundry Osaka default. T06 re-checks against Base Sepolia before the vault build starts; any change is recorded here.
- LiteSVM 1.6.1 is the current release at pin time. If T12 shows a solana-crate mismatch, re-pin here first, then in `package.json`.
- TypeScript stays on the 5.x line (5.9.3). 7.0.2 exists; the Anchor/TS tooling is verified against 5.x.
- `@types/node` 26.6.5 added 2026-10-29 during T02: types-only dev dependency, required for `tsc` to resolve `node:*` modules in the SDK. No runtime effect. Pinned exact, like every other package.

## Verification log

| Date | Machine | Result |
|---|---|---|
| 2026-10-29 | Parv WSL (Ubuntu, Windows host) | rustc 1.99.1 (58cf8f9c3), forge 1.8.5, solana-cli 4.1.2 (src:182084b8), anchor-cli 1.2.0, node v22.23.3, ollama 0.40.6. Scratch `forge build` green (Solc 0.8.37). Scratch `anchor build` green. |
| 2026-10-29 | Muse VM | check-toolchain.sh exit 0, all 7 lines OK: rustc 1.99.1, forge 1.8.5, solana-cli 4.1.2, anchor-cli 1.2.0, ollama 0.40.6, node v24.20.0, qwen2.5:7b pulled. Scratch `forge build` and `anchor build` both green. Ollama installed under ~/workspace/ollama (manual tarball install; survives VM swaps). Evidence: `evidence/T01/`. |
