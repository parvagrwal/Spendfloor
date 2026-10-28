#!/usr/bin/env bash
# SpendFloor toolchain check (T01).
# Prints every installed version next to its pin from TOOLCHAIN.md.
# Exit 0 only when everything matches. Run from anywhere.
set -u

RUST_PIN="1.99.1"
FORGE_PIN="1.8.5"
SOLANA_PIN="4.1.2"
ANCHOR_PIN="1.2.0"
OLLAMA_PIN="0.40.6"
MODEL_PIN="qwen2.5:7b"

fail=0
check() { # name, pin, actual
  if [ "$2" = "$3" ]; then
    printf "OK    %-10s pin %-8s got %s\n" "$1" "$2" "$3"
  else
    printf "FAIL  %-10s pin %-8s got %s\n" "$1" "$2" "${3:-NOT FOUND}"
    fail=1
  fi
}

ver() { command -v "$1" >/dev/null 2>&1 && "$@" 2>/dev/null; }

check "rustc"  "$RUST_PIN"   "$(ver rustc --version  | awk '{print $2}')"
check "forge"  "$FORGE_PIN"  "$(ver forge --version  | head -1 | awk '{print $3}')"
check "solana" "$SOLANA_PIN" "$(ver solana --version | awk '{print $2}')"
check "anchor" "$ANCHOR_PIN" "$(ver anchor --version | awk '{print $2}')"
check "ollama" "$OLLAMA_PIN" "$(ver ollama --version | awk '{print $4}')"

node_major="$(ver node --version | sed 's/v\([0-9]*\).*/\1/')"
if [ "${node_major:-0}" -ge 22 ] 2>/dev/null; then
  echo "OK    node       pin >=22     got $(node --version)"
else
  echo "FAIL  node       pin >=22     got $(node --version 2>/dev/null || echo 'NOT FOUND')"
  fail=1
fi

if command -v ollama >/dev/null 2>&1 && ollama list 2>/dev/null | grep -q "^${MODEL_PIN}"; then
  echo "OK    model      pin $MODEL_PIN pulled"
else
  echo "FAIL  model      pin $MODEL_PIN not pulled (run: ollama pull $MODEL_PIN)"
  fail=1
fi

exit $fail
