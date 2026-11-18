#!/usr/bin/env bash
# T36 clean-room rerun: fresh clone + pinned toolchain + one command.
# Usage: bash scripts/cleanroom-run.sh [--skip-anvil]
# Runs the pinned toolchains, lockfile install, native suites and TS gates.
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
echo "=== npm ci ==="
npm ci --ignore-scripts
npm run typecheck
npm test
echo "=== forge test (evm) ==="
(cd evm && forge test)
echo "=== cargo build-sbf (solana) ==="
(cd solana && cargo build-sbf)
echo "=== cargo test --release (litesvm-tests) ==="
(cd solana/litesvm-tests && cargo test --release --locked)
(cd solana && cargo test --release)
if [ "$SKIP_ANVIL" = "1" ]; then
  echo "=== Anvil conformance SKIPPED (--skip-anvil; port 8545 busy) ==="
else
  echo "=== Anvil conformance (conformance/run-local-evm.ts) ==="
  npx tsx conformance/run-local-evm.ts
fi
echo "=== CLEANROOM DONE ==="
