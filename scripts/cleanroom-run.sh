#!/usr/bin/env bash
# T36 clean-room rerun: fresh clone + pinned toolchain + one command.
# Usage: bash scripts/cleanroom-run.sh [--skip-anvil]
# Runs: check-toolchain, npm ci (falls back to npm install if the
# lockfile install trips on the missing rebalance-bot workspace),
# forge test, cargo build-sbf, cargo test --release (litesvm-tests),
# policy TS tests (golden + reference).
# Anvil conformance (conformance/run-local-evm.ts) is skipped with
# --skip-anvil (used when port 8545 is busy) and run as a second
# phase when Anvil is free.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$HOME/workspace/ollama/bin:$PATH"
SKIP_ANVIL=0
if [ "${1:-}" = "--skip-anvil" ]; then SKIP_ANVIL=1; fi
echo "=== check-toolchain ==="
bash scripts/check-toolchain.sh
echo "=== npm ci (fallback: npm install) ==="
npm ci || { echo "npm ci failed; falling back to npm install"; npm install; }
echo "=== forge test (evm) ==="
(cd evm && forge test)
echo "=== cargo build-sbf (solana) ==="
(cd solana && cargo build-sbf)
echo "=== cargo test --release (litesvm-tests) ==="
(cd solana/litesvm-tests && cargo test --release)
echo "=== policy TS tests ==="
npx tsx --test policy/test/golden.test.ts policy/test/reference.test.ts
if [ "$SKIP_ANVIL" = "1" ]; then
  echo "=== Anvil conformance SKIPPED (--skip-anvil; port 8545 busy) ==="
else
  echo "=== Anvil conformance (conformance/run-local-evm.ts) ==="
  npx tsx conformance/run-local-evm.ts
fi
echo "=== CLEANROOM DONE ==="
