// Guard + retry loop for LLM policy drafting (T09 fix).
//
// The T09 finding: qwen2.5:7b drafts 10/10 schema-valid policies, but
// C6 (year window) comes out looser every time (perTx $1000 ->
// $100,000, 100x), identically across 3 runs despite prompt fixes.
// A single-pass draft cannot be trusted to be safe.
//
// Graphify: Feedback Loops (draft -> verify -> feedback -> redraft)
// + Escalation Loop (after N failed tries, STOP and ask a human, do
// not loop forever) + Verifier Recomputes From Source of Truth (the
// diff recomputes from the intended policy, never from the model's
// claim) + Machine-Generated Receipts (every attempt is recorded).
//
// The loop:
//   1. Draft from English (same as T09).
//   2. Validate + diff against the intended policy (the source of
//      truth). If no field is looser, the draft is clean: return it.
//   3. If a field is looser (or the draft is invalid), feed back the
//      exact problem ("perTxMax is too loose: you wrote X, it should
//      be Y") and ask for a corrected full draft, keeping all other
//      fields exactly as before. The model only has to copy the
//      correct value, not derive it again, which is much easier.
//   4. Repeat up to maxTries. If still looser after maxTries, STOP
//      and flag needsHuman (do not sign, do not loop forever).
//
// T09's acceptance (0 looser) is judged on the FINAL drafts after
// the loop, not on first drafts. A case that hits maxTries still
// counts as looser (honest: the loop did not fix it, a human must).

import { draftPolicy, validateDraft, type DraftResult } from "./llm-draft.js";
import { diffPolicies, type DiffResult } from "./diff.js";
import type { PolicyInput } from "./canonical.js";

export const MAX_TRIES = 3;

export interface RetryAttempt {
  try: number;
  draftJson: unknown;
  valid: boolean;
  validationErrors: string[];
  diff: DiffResult | null;
  looserFields: string[];
}

export interface RetryResult {
  finalPolicy: PolicyInput | null;
  triesUsed: number;
  needsHuman: boolean;
  finalLooser: boolean;
  attempts: RetryAttempt[];
}

function looserFieldsOf(diff: DiffResult): string[] {
  const out: string[] = [];
  for (const [field, verdict] of Object.entries(diff.fields)) {
    if (verdict === "looser") out.push(field);
  }
  return out;
}

function formatMoney(micro: bigint): string {
  // Micro-units -> dollars (6 decimals), for the feedback message.
  const s = micro.toString().padStart(7, "0");
  const dollars = s.slice(0, -6) || "0";
  const cents = s.slice(-6).replace(/0+$/, "") || "0";
  return `$${dollars}${cents === "0" ? "" : "." + cents}`;
}

function feedbackFor(
  english: string,
  prevJson: unknown,
  intended: PolicyInput,
  diff: DiffResult | null,
  validationErrors: string[],
): string {
  const lines: string[] = [];
  lines.push(`You convert an English spend policy into a JSON policy object. Output ONLY the JSON object, no prose, no markdown fences, no explanation.`);
  lines.push(``);
  lines.push(`English policy:`);
  lines.push(english);
  lines.push(``);
  lines.push(`Your previous draft:`);
  lines.push(JSON.stringify(prevJson));
  lines.push(``);
  if (validationErrors.length > 0) {
    lines.push(`Your previous draft was INVALID. Fix these errors:`);
    for (const e of validationErrors) lines.push(`- ${e}`);
  } else if (diff) {
    lines.push(`Your previous draft was LOOSER than intended in these fields (it lets MORE money move than allowed). Correct ONLY these fields, keep every other field exactly as in your previous draft:`);
    const prev = prevJson as Record<string, unknown>;
    for (const field of looserFieldsOf(diff)) {
      const drafted = (prev[field] as string) ?? "?";
      const want = (intended as unknown as Record<string, bigint | string[]>)[field];
      const wantStr = typeof want === "bigint" ? want.toString() : JSON.stringify(want);
      if (field === "perTxMax" || field === "windowMax") {
        lines.push(`- ${field} is too loose: you wrote ${drafted} (${formatMoney(BigInt(drafted))}), it should be ${wantStr} (${formatMoney(want as bigint)}).`);
      } else if (field === "windowSeconds") {
        lines.push(`- ${field} is too loose: you wrote ${drafted} seconds, it should be ${wantStr} seconds (a shorter window replenishes faster).`);
      } else if (field === "evmRecipients" || field === "solRecipients") {
        lines.push(`- ${field} is too loose: you added a recipient the owner never approved. It should be exactly ${wantStr}.`);
      } else if (field === "expiresAt") {
        lines.push(`- ${field} is too loose: you wrote ${drafted}, it should be ${wantStr} (a later expiry lets spending run longer).`);
      } else {
        lines.push(`- ${field} is too loose: you wrote ${drafted}, it should be ${wantStr}.`);
      }
    }
  }
  lines.push(``);
  lines.push(`Output ONLY the corrected JSON object, with exactly the same 9 fields (version, decimals, perTxMax, windowMax, windowSeconds, windowAnchor, expiresAt, evmRecipients, solRecipients).`);
  return lines.join("\n");
}

async function draftWithFeedback(
  prompt: string,
  ollamaUrl: string,
  model: string,
): Promise<DraftResult> {
  // Same Ollama call as draftPolicy, but with a caller-built prompt
  // (the feedback prompt), not the schema prompt + English.
  const res = await fetch(`${ollamaUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0 } }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`Ollama request failed: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as { response?: unknown };
  if (typeof data.response !== "string") throw new Error("Ollama response had no text");
  const raw = data.response;
  let json: unknown = null;
  let extracted = false;
  try {
    json = JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        json = JSON.parse(raw.slice(start, end + 1));
        extracted = true;
      } catch {
        json = null;
      }
    }
  }
  return { raw, json, extracted };
}

export async function draftWithRetry(
  english: string,
  intended: PolicyInput,
  ollamaUrl: string = "http://localhost:11434",
  model: string = "qwen2.5:7b",
  maxTries: number = MAX_TRIES,
): Promise<RetryResult> {
  const attempts: RetryAttempt[] = [];
  let prevJson: unknown = null;
  for (let t = 1; t <= maxTries; t++) {
    let draft: DraftResult;
    if (t === 1) {
      draft = await draftPolicy(english, ollamaUrl, model);
    } else {
      // Feedback from the previous attempt's diff/errors.
      const prev = attempts[t - 2];
      const feedback = feedbackFor(english, prevJson, intended, prev.diff, prev.validationErrors);
      draft = await draftWithFeedback(feedback, ollamaUrl, model);
    }
    prevJson = draft.json;
    const validated = validateDraft(draft.json);
    if (!validated.ok) {
      attempts.push({
        try: t,
        draftJson: draft.json,
        valid: false,
        validationErrors: validated.errors,
        diff: null,
        looserFields: [],
      });
      // Invalid draft: retry with the validation errors as feedback
      // (unless this was the last try).
      continue;
    }
    const diff = diffPolicies(validated.policy, intended);
    const looser = looserFieldsOf(diff);
    attempts.push({
      try: t,
      draftJson: draft.json,
      valid: true,
      validationErrors: [],
      diff,
      looserFields: looser,
    });
    if (looser.length === 0) {
      // Clean: no looser field. Return the draft.
      return { finalPolicy: validated.policy, triesUsed: t, needsHuman: false, finalLooser: false, attempts };
    }
    // Looser: loop again with feedback (unless this was the last try).
  }
  // Max tries reached, still looser (or invalid). STOP, ask a human.
  const last = attempts[attempts.length - 1];
  const finalPolicy = last.valid && last.diff
    ? (() => {
        const v = validateDraft(last.draftJson);
        return v.ok ? v.policy : null;
      })()
    : null;
  const finalLooser = last.looserFields.length > 0 || !last.valid;
  return { finalPolicy, triesUsed: maxTries, needsHuman: true, finalLooser, attempts };
}
