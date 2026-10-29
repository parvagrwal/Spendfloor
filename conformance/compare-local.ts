// compare-local (T17 local compare).
//
// Reads evidence/T17/evm-local.json + sol-local.json and checks the
// labels are identical per vector, apart from the documented V17
// evidence difference (EVM BadNonce lands with a hash; Solana duplicate
// does not land). Prints a per-vector table + writes
// evidence/T17/local-compare.json. Exits non-zero on any mismatch.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "..", "evidence", "T17");
const evm = JSON.parse(readFileSync(join(dir, "evm-local.json"), "utf8")) as {
  results: { vector: string; expected: string; actual: string; pass: boolean; hash: string | null }[];
};
const sol = JSON.parse(readFileSync(join(dir, "sol-local.json"), "utf8")) as {
  results: { vector: string; expected: string; actual: string; pass: boolean }[];
};
const solByVec = new Map(sol.results.map((r) => [r.vector, r]));
let identical = 0;
let mismatches: string[] = [];
const rows: { vector: string; evm: string; sol: string; identical: boolean; note?: string }[] = [];
for (const e of evm.results) {
  const s = solByVec.get(e.vector);
  if (!s) {
    mismatches.push(`${e.vector}: missing in SOL`);
    rows.push({ vector: e.vector, evm: e.actual, sol: "(missing)", identical: false });
    continue;
  }
  if (e.vector === "V17") {
    // Documented evidence difference: EVM lands BadNonce, SOL duplicate
    // does not land. Both reject the replay; funds do not move.
    const ok = e.actual === "BadNonce" && s.actual === "duplicate (does not land)";
    rows.push({ vector: "V17", evm: e.actual, sol: s.actual, identical: ok, note: "documented evidence difference; replay rejected on both" });
    if (ok) identical++;
    else mismatches.push("V17: unexpected labels");
    continue;
  }
  const ok = e.actual === s.actual && e.pass && s.pass;
  rows.push({ vector: e.vector, evm: e.actual, sol: s.actual, identical: ok });
  if (ok) identical++;
  else mismatches.push(`${e.vector}: EVM=${e.actual} SOL=${s.actual}`);
}
console.log("vector | EVM | SOL | identical");
for (const r of rows) {
  console.log(`${r.vector} | ${r.evm} | ${r.sol} | ${r.identical ? "yes" : "NO"}${r.note ? ` (${r.note})` : ""}`);
}
console.log(`\nLocal identical: ${identical}/${rows.length}`);
writeFileSync(join(dir, "local-compare.json"), JSON.stringify({ identical, total: rows.length, mismatches, rows }, null, 2));
if (mismatches.length > 0) {
  console.log(`MISMATCHES: ${mismatches.join("; ")}`);
  process.exit(1);
}
