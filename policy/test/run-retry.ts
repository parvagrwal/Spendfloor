// T09 retry evaluation runner: runs each English policy in
// policy/test/compile-cases.json through draftWithRetry (guard +
// retry loop), and reports the H14 gate on the FINAL drafts.
// Run: OLLAMA_URL=http://localhost:11434 OLLAMA_MODEL=qwen2.5:7b \\
//   npx tsx policy/test/run-retry.ts
// Exit 0 only when schema-valid >= 8 AND final looser == 0.
// Results JSON goes to evidence/T09/retry-results-2026-10-30.json.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { draftWithRetry, MAX_TRIES } from "../src/retry-draft.js";
import type { PolicyInput } from "../src/canonical.js";

interface CaseFile {
  name: string;
  english: string;
  intended: {
    version: number;
    decimals: number;
    perTxMax: string;
    windowMax: string;
    windowSeconds: string;
    windowAnchor: string;
    expiresAt: string;
    evmRecipients: string[];
    solRecipients: string[];
  };
}

function toInput(c: CaseFile["intended"]): PolicyInput {
  return {
    version: c.version,
    decimals: c.decimals,
    perTxMax: BigInt(c.perTxMax),
    windowMax: BigInt(c.windowMax),
    windowSeconds: BigInt(c.windowSeconds),
    windowAnchor: BigInt(c.windowAnchor),
    expiresAt: BigInt(c.expiresAt),
    evmRecipients: c.evmRecipients,
    solRecipients: c.solRecipients,
  };
}

async function main() {
  const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434";
  const model = process.env.OLLAMA_MODEL || "qwen2.5:7b";
  const cases: CaseFile[] = JSON.parse(
    readFileSync(new URL("./compile-cases.json", import.meta.url), "utf8"),
  );
  const results: Record<string, unknown>[] = [];
  let validCount = 0;
  let looserCount = 0;
  for (const c of cases) {
    const intended = toInput(c.intended);
    const res = await draftWithRetry(c.english, intended, ollamaUrl, model, MAX_TRIES);
    const valid = res.finalPolicy !== null;
    if (valid) validCount++;
    if (res.finalLooser) looserCount++;
    const firstLooser = res.attempts[0]?.looserFields ?? [];
    console.log(
      `${c.name}: tries=${res.triesUsed} first-looser=[${firstLooser.join(",")}] final-looser=${res.finalLooser} needsHuman=${res.needsHuman} valid=${valid}`,
    );
    results.push({
      name: c.name,
      triesUsed: res.triesUsed,
      firstLooser,
      finalLooser: res.finalLooser,
      needsHuman: res.needsHuman,
      valid,
      attempts: res.attempts.map((a) => ({
        try: a.try,
        valid: a.valid,
        validationErrors: a.validationErrors,
        looserFields: a.looserFields,
        overall: a.diff?.overall ?? null,
      })),
    });
  }
  console.log(`\nFINAL: valid=${validCount}/${cases.length} looser=${looserCount} (gate: valid>=8 AND looser==0)`);
  const pass = validCount >= 8 && looserCount === 0;
  console.log(pass ? "T09 RETRY PASS" : "T09 RETRY FAIL");
  mkdirSync(new URL("../../evidence/T09", import.meta.url), { recursive: true });
  writeFileSync(
    new URL("../../evidence/T09/retry-results-2026-10-30.json", import.meta.url),
    JSON.stringify({ validCount, looserCount, pass, results }, null, 2),
  );
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(`RETRY ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
