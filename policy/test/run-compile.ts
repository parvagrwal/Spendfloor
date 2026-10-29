// T09 evaluation runner: drafts each English policy in
// policy/test/compile-cases.json with the local Ollama model, validates
// the draft against the T05 canonical schema, diffs it against the
// intended policy, and reports the H14 gate counts.
// Run: OLLAMA_URL=http://localhost:11434 OLLAMA_MODEL=qwen2.5:7b \
//   npx tsx policy/test/run-compile.ts
// Exit 0 only when schema-valid >= 8 AND looser == 0.
// Results JSON goes to evidence/T09/compile-results-2026-10-29.json.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  draftPolicy,
  validateDraft,
  OLLAMA_MODEL,
  OLLAMA_URL,
  type DraftResult,
} from "../src/llm-draft.js";
import { diffPolicies, type DiffResult } from "../src/diff.js";
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

function stringifyPolicy(p: PolicyInput): Record<string, unknown> {
  return {
    version: p.version,
    decimals: p.decimals,
    perTxMax: p.perTxMax.toString(),
    windowMax: p.windowMax.toString(),
    windowSeconds: p.windowSeconds.toString(),
    windowAnchor: p.windowAnchor.toString(),
    expiresAt: p.expiresAt.toString(),
    evmRecipients: p.evmRecipients,
    solRecipients: p.solRecipients,
  };
}

const ollamaUrl = process.env.OLLAMA_URL ?? OLLAMA_URL;
const model = process.env.OLLAMA_MODEL ?? OLLAMA_MODEL;
const cases: CaseFile[] = JSON.parse(
  readFileSync(new URL("./compile-cases.json", import.meta.url), "utf8"),
);

interface CaseResult {
  name: string;
  raw: string;
  extracted: boolean;
  valid: boolean;
  errors: string[];
  drafted: Record<string, unknown> | null;
  diff: DiffResult | null;
}

const results: CaseResult[] = [];
let validCount = 0;
let looserCount = 0;
let cleanCount = 0;

for (const c of cases) {
  console.log(`\n=== ${c.name} ===`);
  console.log(`English: ${c.english}`);
  let draft: DraftResult;
  try {
    draft = await draftPolicy(c.english, ollamaUrl, model);
  } catch (e) {
    console.log(`DRAFT ERROR: ${(e as Error).message}`);
    results.push({ name: c.name, raw: "", extracted: false, valid: false, errors: [(e as Error).message], drafted: null, diff: null });
    continue;
  }
  if (!draft.extracted && draft.json !== null) cleanCount++;
  const v = validateDraft(draft.json);
  if (!v.ok) {
    console.log(`schema-valid: NO`);
    for (const err of v.errors) console.log(`  - ${err}`);
    results.push({ name: c.name, raw: draft.raw, extracted: draft.extracted, valid: false, errors: v.errors, drafted: null, diff: null });
    continue;
  }
  validCount++;
  const diff = diffPolicies(v.policy, toInput(c.intended));
  if (diff.overall === "LOOSER") looserCount++;
  console.log(`schema-valid: YES (extracted JSON: ${draft.extracted ? "yes" : "no"})`);
  console.log(`diff overall: ${diff.overall}`);
  for (const [field, verdict] of Object.entries(diff.fields)) {
    console.log(`  ${field}: ${verdict}`);
  }
  results.push({
    name: c.name,
    raw: draft.raw,
    extracted: draft.extracted,
    valid: true,
    errors: [],
    drafted: stringifyPolicy(v.policy),
    diff,
  });
}

console.log(`\n=== H14 gate ===`);
console.log(`model: ${model}`);
console.log(`schema-valid: ${validCount}/10 (need >= 8)`);
console.log(`clean JSON (no extraction): ${cleanCount}/10`);
console.log(`looser diffs: ${looserCount} (need 0)`);
const pass = validCount >= 8 && looserCount === 0;
console.log(pass ? "run-compile: PASS" : "run-compile: FAIL");

const outDir = new URL("../../evidence/T09/", import.meta.url);
mkdirSync(outDir, { recursive: true });
writeFileSync(
  new URL("compile-results-2026-10-29.json", outDir),
  JSON.stringify({ model, validCount, looserCount, cleanCount, pass, results }, null, 2),
);
console.log(`results written to evidence/T09/compile-results-2026-10-29.json`);
process.exit(pass ? 0 : 1);
