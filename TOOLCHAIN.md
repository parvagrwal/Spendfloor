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
| Anchor CLI / anchor-lang / anchor-spl | 1.2.0 | program Rust crates pinned exactly to 1.2.0; no JS Anchor client required |
| Node.js | >= 22 LTS | 22.23.3 (WSL) and 24.20.0 (Muse VM) both verified |
| npm packages | `package.json` and `package-lock.json` | Exact versions. Install with `npm ci --ignore-scripts`. Web3.js 1.x is intentional. The scoped `jayson` 5 override replaces vulnerable transitives; the JSON-RPC request/batch/error compatibility test is mandatory. |
| Ollama | 0.40.6 | Model below |
| Ollama model | `qwen2.5:7b` | Fallback `llama3.1:8b`. Pull state recorded in the log below. **T08 outcome (2026-10-29): the demo AGENT runs `qwen2.5:3b`** (in the plan's latency fallback ladder) — 7B failed the ≤15 s warm-latency bar on both machines (medians 30.0 s / 70.9 s); 3B passed on both (12.5 s / 14.7 s) with 9/10 reach. The 7B stays installed for the T09 compile spike |

## Version-decision notes

- `evm_version` is pinned to `cancun` in `evm/foundry.toml`, explicitly NOT the Foundry Osaka default. T06 re-checks against Base Sepolia before the vault build starts; any change is recorded here.
- SVM tests use the Rust crate under `solana/litesvm-tests`, not the removed JS LiteSVM dependency. The policy and relay remain directly runnable TS via `tsx`; TypeScript stays on 5.9.3 and Node types track the minimum supported Node major (22).
- The table below is historical. For what was actually run on this checkout, including the alternate Foundry version, see [TESTING_REPORT.md](TESTING_REPORT.md).

## Verification log

| Date | Machine | Result |
|---|---|---|
| 2026-10-29 | Parv WSL (Ubuntu, Windows host) | rustc 1.99.1 (58cf8f9c3), forge 1.8.5, solana-cli 4.1.2 (src:182084b8), anchor-cli 1.2.0, node v22.23.3, ollama 0.40.6. Scratch `forge build` green (Solc 0.8.37). Scratch `anchor build` green. |
| 2026-10-29 | Muse VM | check-toolchain.sh exit 0, all 7 lines OK: rustc 1.99.1, forge 1.8.5, solana-cli 4.1.2, anchor-cli 1.2.0, ollama 0.40.6, node v24.20.0, qwen2.5:7b pulled. Scratch `forge build` and `anchor build` both green. Ollama installed under ~/workspace/ollama (manual tarball install; survives VM swaps). Evidence: `evidence/T01/`. |
