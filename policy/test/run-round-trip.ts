// T25 round-trip runner: English -> guarded LLM draft -> diff -> owner signs.
// The runner drafts + diffs only (no keys on this machine). The owner
// applies the drafted caps with the owner CLI on their machine
// (OWNER keys), then runs verify. After verify is green, the owner
// restores the demo policy (2/5) so the demo state is unchanged.
//
// English (new policy for this round trip):
//   "Allow at most 3 SFUSD per transaction, 6 SFUSD per day, merchant
//    only, for 24 hours."
// Intended (source of truth, hand-written from the English):
//   perTx 3,000,000 micro, window 6,000,000 micro, window 86,400 s,
//   recipients = merchant only (both chains).
// Anchor/expiresAt are session values set by the owner CLI at apply
// time (anchor = now, expiry = now + 86400); they are NOT part of the
// content diff (a "different" verdict on those two fields is expected
// and ignored for the clean verdict — only caps + recipients must be
// EQUAL, never looser).

import { draftWithRetry } from "../src/retry-draft.js";
import { diffPolicies } from "../src/diff.js";
import type { PolicyInput } from "../src/canonical.js";
import * as fs from "node:fs";
import * as path from "node:path";

const EVM_MERCHANT = "0x61f1c99d674bcd333578AC4f538F46AbC7bB4106";
const SOL_MERCHANT = "8e6f1AWYV4unGiaoDciMkAXvPdUZvpNCtPK6pz2kmZhS";

const ENGLISH =
  "Allow at most 3 SFUSD per transaction, 6 SFUSD per day, merchant only, for 24 hours.";

const INTENDED: PolicyInput = {
  version: 1,
  decimals: 6,
  perTxMax: 3_000_000n,
  windowMax: 6_000_000n,
  windowSeconds: 86_400n,
  windowAnchor: 0n,
  expiresAt: 0n,
  evmRecipients: [EVM_MERCHANT],
  solRecipients: [SOL_MERCHANT],
};

const CONTENT_FIELDS = ["perTxMax", "windowMax", "windowSeconds", "evmRecipients", "solRecipients"] as const;

async function main(): Promise<void> {
  console.log("T25 round trip — English:");
  console.log(`  ${ENGLISH}`);
  console.log("Current demo policy (T21): perTx 2, window 5, 86400 s, merchant only.");
  console.log("Intended new policy: perTx 3, window 6, 86400 s, merchant only.");
  console.log("Drafting with guard + retry (qwen2.5:7b, max 3 tries)…");

  const result = await draftWithRetry(ENGLISH, INTENDED);
  const final = result.finalPolicy;
  let contentDiff = null;
  let contentClean = false;
  if (final) {
    contentDiff = diffPolicies(final, INTENDED);
    contentClean =
      CONTENT_FIELDS.every((f) => contentDiff!.fields[f] === "equal") && !result.finalLooser;
  }

  console.log(`Tries used: ${result.triesUsed}, needsHuman: ${result.needsHuman}, finalLooser: ${result.finalLooser}`);
  console.log("Final policy:", final ? JSON.stringify(final, (_, v) => typeof v === "bigint" ? v.toString() : v) : null);
  console.log("Diff vs intended (content fields):", contentDiff ? JSON.stringify(contentDiff.fields) : null);
  console.log(`Content clean (caps + recipients equal, never looser): ${contentClean}`);

  if (!contentClean || !final) {
    console.log("DRAFT NOT CLEAN — do not apply. A human must review (escalation, T09 rule).");
  } else {
    console.log("DRAFT CLEAN — owner apply command (run on the OWNER machine):");
    console.log("  npx tsx cli/spendfloor.ts owner set-policy --per-tx 3000000 --window 6000000 --window-secs 86400 --expiry-secs 86400");
    console.log("Then verify (either machine): npx tsx cli/spendfloor.ts verify");
    console.log("Then restore the demo policy (owner machine):");
    console.log("  npx tsx cli/spendfloor.ts owner set-policy --per-tx 2000000 --window 5000000 --window-secs 86400 --expiry-secs 86400");
    console.log("Then verify again (must be green).");
  }

  const outDir = path.join("evidence", "T25");
  fs.mkdirSync(outDir, { recursive: true });
  const out = {
    date: "2026-10-30",
    english: ENGLISH,
    intended: JSON.stringify(INTENDED, (_, v) => typeof v === "bigint" ? v.toString() : v),
    triesUsed: result.triesUsed,
    needsHuman: result.needsHuman,
    finalLooser: result.finalLooser,
    finalPolicy: final ? JSON.stringify(final, (_, v) => typeof v === "bigint" ? v.toString() : v) : null,
    diff: contentDiff,
    contentClean,
    attempts: result.attempts.map((a) => ({
      try: a.try, valid: a.valid, validationErrors: a.validationErrors,
      looserFields: a.looserFields, draftJson: a.draftJson,
    })),
  };
  const outPath = path.join(outDir, "round-trip-draft-2026-10-30.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`Evidence written: ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
