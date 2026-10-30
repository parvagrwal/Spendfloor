// Precedence matrix generator (T33, decide() side).
// Enumerates every feasible simultaneous-violation combination
// (subsets of the 7 policy labels) and checks decide()'s winning
// label equals the first label in precedence order present.
// Feasibility (normal states: spent <= windowMax): the only
// infeasible pairs are ZeroAmount with DailyCap/PerTx (amount 0
// cannot exceed a cap when spent <= windowMax). So a subset is
// feasible iff it does NOT contain Z together with D or P.
// Total: 128 subsets - 48 infeasible = 80 feasible (including the
// empty subset = ACCEPT). Writes evidence/T33/precedence-matrix.json.
// Chain runs (EVM + SOL) replay the same 80 requests later, after
// T31/T32 free Anvil and restore the original program.
// Run: npx tsx conformance/precedence-matrix-gen.ts
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decide, type ReferencePolicy, type ReferenceState } from "../policy/src/reference.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "evidence", "T33");
mkdirSync(outDir, { recursive: true });

// Precedence order (first failing check wins).
const ORDER = ["Unauthorized", "Frozen", "SessionExpired", "ZeroAmount", "RecipientNotAllowed", "DailyCapExceeded", "PerTxCapExceeded"] as const;
type Label = (typeof ORDER)[number];
const U = 1_000_000n; // 1 SFUSD
const W = 5n * U; // windowMax
const T = 2n * U; // perTxMax
const ANCHOR = 1_000n;
const WINDOW_SECS = 86_400n;

interface Combo {
  subset: Label[];
  request: { signer: string; frozen: boolean; now: bigint; expiry: bigint; amount: bigint; spent: bigint; recipient: string };
  expectedWinner: string;
  decideLabel: string;
  match: boolean;
}

const combos: Combo[] = [];
const labels: Label[] = [...ORDER];
for (let mask = 0; mask < 128; mask++) {
  const subset = labels.filter((_, i) => (mask >> i) & 1);
  const has = (l: Label) => subset.includes(l);
  // Feasibility: Z with D or P is infeasible (normal states).
  if (has("ZeroAmount") && (has("DailyCapExceeded") || has("PerTxCapExceeded"))) continue;
  // Build a request exhibiting EXACTLY this subset.
  const signer = has("Unauthorized") ? "attacker" : "agent";
  const frozen = has("Frozen");
  // Expiry: if SessionExpired in subset, now == expiry; else expiry far future.
  const expiry = 100_000n;
  const now = has("SessionExpired") ? expiry : 50_000n;
  const recipient = has("RecipientNotAllowed") ? "attacker" : "merchant";
  let amount: bigint;
  let spent: bigint;
  if (has("ZeroAmount")) {
    amount = 0n;
    spent = 0n; // D and P are false (subset excludes them by feasibility)
  } else if (has("DailyCapExceeded") && has("PerTxCapExceeded")) {
    amount = 6n * U;
    spent = 0n; // 0+6 > 5, 6 > 2
  } else if (has("DailyCapExceeded")) {
    amount = 2n * U;
    spent = 4n * U; // 4+2 > 5, 2 <= 2
  } else if (has("PerTxCapExceeded")) {
    amount = 3n * U;
    spent = 0n; // 0+3 <= 5, 3 > 2
  } else {
    amount = 1n * U;
    spent = 0n; // 0+1 <= 5, 1 <= 2
  }
  const policy: ReferencePolicy = {
    perTxMax: T,
    windowMax: W,
    windowSeconds: WINDOW_SECS,
    anchor: ANCHOR,
    expiresAt: expiry,
    recipients: new Set(["merchant"]),
    frozen,
    agent: "agent",
  };
  const st: ReferenceState = { currentWindow: 0n, spentInWindow: spent, nonce: 0n };
  // currentWindow is set to the window containing now, so spent
  // is in the current window (no rollover in these cases).
  const windowIndex = now < ANCHOR ? 0n : (now - ANCHOR) / WINDOW_SECS;
  st.currentWindow = windowIndex;
  const out = decide(
    policy,
    st,
    {
      chain: "evm",
      signerIsAgent: signer === "agent",
      recipient,
      amount,
      nonce: 0n,
      deadline: now + 100n,
    },
    now,
  );
  const decideLabel = out.ok ? "ACCEPT" : out.label;
  const expectedWinner = subset.length === 0 ? "ACCEPT" : ORDER.find((l) => subset.includes(l))!;
  combos.push({
    subset,
    request: { signer, frozen, now, expiry, amount, spent, recipient },
    expectedWinner,
    decideLabel,
    match: decideLabel === expectedWinner,
  });
}

const mismatches = combos.filter((c) => !c.match);
const out = {
  totalSubsets: 128,
  feasible: combos.length,
  infeasible: 128 - combos.length,
  mismatches: mismatches.length,
  combos: combos.map((c) => ({
    subset: c.subset,
    request: {
      signer: c.request.signer,
      frozen: c.request.frozen,
      now: c.request.now.toString(),
      expiry: c.request.expiry.toString(),
      amount: c.request.amount.toString(),
      spent: c.request.spent.toString(),
      recipient: c.request.recipient,
    },
    expectedWinner: c.expectedWinner,
    decideLabel: c.decideLabel,
    match: c.match,
  })),
};
writeFileSync(join(outDir, "precedence-matrix.json"), JSON.stringify(out, null, 2) + "\n");
// Line-based TXT for the Rust runner (no serde_json in litesvm-tests).
// CASE,<idx>,<subset+-joined or EMPTY>,<signer G|X>,<frozen 0|1>,<now>,<expiry>,<amount>,<spent>,<recipient M|A>,<expectedWinner>
const txtLines = combos.map((c, i) => {
  const subset = c.subset.length === 0 ? "EMPTY" : c.subset.join("+");
  const signer = c.request.signer === "agent" ? "G" : "X";
  const frozen = c.request.frozen ? "1" : "0";
  const recip = c.request.recipient === "merchant" ? "M" : "A";
  return `CASE,${i},${subset},${signer},${frozen},${c.request.now},${c.request.expiry},${c.request.amount},${c.request.spent},${recip},${c.expectedWinner}`;
});
writeFileSync(join(outDir, "precedence-matrix.txt"), txtLines.join("\n") + "\n");
console.log(`feasible ${combos.length} / 128, mismatches ${mismatches.length}`);
for (const m of mismatches) {
  console.log(`MISMATCH subset [${m.subset.join(",")}] expected ${m.expectedWinner} got ${m.decideLabel}`);
}
if (mismatches.length === 0) console.log("decide() matches the precedence matrix on all feasible combinations");
