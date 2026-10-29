// LLM → policy draft (T09, SPIKE-COMPILE). The LLM is NEVER in the
// enforcement path: it only drafts a policy from English, and the draft
// must validate against the T05 canonical schema before it is used.
// Graphify method applied: gate thresholds do not bend (8/10 valid,
// 0 looser); a draft that fails validation is evidence, not a prompt to
// be massaged until it passes — the count is what it is.
//
// JSON form follows the golden-file convention
// (policy/test/golden-hashes.json): bigint fields are decimal STRINGS.
// A JSON number is accepted only when it is a safe integer with the
// same value, so the value, not the spelling, is what validates.

import { encodePolicy, type PolicyInput } from "./canonical.js";

export const OLLAMA_MODEL = "qwen2.5:7b";
export const OLLAMA_URL = "http://localhost:11434";

const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const WINDOW_MIN = 60n;
const WINDOW_MAX = 31536000n;

export const SCHEMA_PROMPT = `You convert an English spend policy into a JSON policy object. Output ONLY the JSON object, no prose, no markdown fences, no explanation.

The JSON object has exactly these 9 fields, no more, no fewer:
- "version": number, must be 1.
- "decimals": number, must be 6. SFUSD has 6 decimals.
- "perTxMax": string, decimal micro-units, the most that may move in one transaction. 0 to 18446744073709551615.
- "windowMax": string, decimal micro-units, the most that may move in one window. 0 to 18446744073709551615.
- "windowSeconds": string, decimal seconds, the length of one window. 60 to 31536000.
- "windowAnchor": string, decimal unix seconds (UTC), when the window cycle starts.
- "expiresAt": string, decimal unix seconds (UTC), when the policy stops applying. "0" means no expiry.
- "evmRecipients": array of 1 to 8 EVM addresses. Each is "0x" followed by exactly 40 hex characters. Copy each address EXACTLY from the English policy. Never invent an address.
- "solRecipients": array of 1 to 8 Solana pubkeys, base58 strings. Copy each pubkey EXACTLY from the English policy. Never invent a pubkey.

Money: SFUSD has 6 decimals, so dollars become micro-units by multiplying by 1000000, which means appending exactly six zeros to the dollar amount. $50 is "50000000" (50 + six zeros). $2000 is "2000000000" (2000 + six zeros). $75000 is "75000000000" (75000 + six zeros). $100000 is "100000000000" (100000 + six zeros). $0.50 is "500000". Do NOT append more or fewer than six zeros.

Check before outputting: for perTxMax and windowMax separately, divide the micro-unit value by 1000000. The result must equal the dollar amount in the English policy exactly. If it does not, fix the value before outputting. Only output the JSON after this check passes.

Time: "per minute" is 60 seconds. "per day" is 86400 seconds. "per week" is 604800 seconds. "per 30 days" is 2592000 seconds. "per year" is 31536000 seconds. A date like 2027-06-01 means midnight UTC on that date, in unix seconds.

Example (a different policy, shown only for the shape):
{"version":1,"decimals":6,"perTxMax":"10000000","windowMax":"50000000","windowSeconds":"86400","windowAnchor":"1793232000","expiresAt":"0","evmRecipients":["0x0000000000000000000000000000000000000001"],"solRecipients":["4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofN"]}`;

export interface DraftResult {
  raw: string;
  json: unknown;
  extracted: boolean;
}

function extractJson(raw: string): unknown {
  try {
    return { json: JSON.parse(raw), extracted: false };
  } catch {
    // Fall through to brace extraction.
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return { json: null, extracted: false };
  try {
    return { json: JSON.parse(raw.slice(start, end + 1)), extracted: true };
  } catch {
    return { json: null, extracted: false };
  }
}

export async function draftPolicy(
  english: string,
  ollamaUrl: string = OLLAMA_URL,
  model: string = OLLAMA_MODEL,
): Promise<DraftResult> {
  const prompt = `${SCHEMA_PROMPT}\n\nEnglish policy:\n${english}\n\nJSON:`;
  const res = await fetch(`${ollamaUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: { temperature: 0 },
    }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`Ollama request failed: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as { response?: unknown };
  if (typeof data.response !== "string") throw new Error("Ollama response had no text");
  const { json, extracted } = extractJson(data.response) as { json: unknown; extracted: boolean };
  return { raw: data.response, json, extracted };
}

function toBigIntField(
  value: unknown,
  name: string,
  signed: boolean,
  errors: string[],
): bigint | null {
  let s: string | null = null;
  if (typeof value === "string" && /^-?\d+$/.test(value)) s = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) s = String(value);
  else {
    errors.push(`${name} must be a decimal string or a safe integer, got ${JSON.stringify(value)}`);
    return null;
  }
  try {
    const v = BigInt(s);
    if (!signed && v < 0n) {
      errors.push(`${name} must not be negative, got ${v}`);
      return null;
    }
    return v;
  } catch {
    errors.push(`${name} is not a valid integer: ${JSON.stringify(value)}`);
    return null;
  }
}

export type ValidateResult =
  | { ok: true; policy: PolicyInput }
  | { ok: false; errors: string[] };

export function validateDraft(json: unknown): ValidateResult {
  const errors: string[] = [];
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { ok: false, errors: ["draft is not a JSON object"] };
  }
  const o = json as Record<string, unknown>;
  const expected = [
    "version",
    "decimals",
    "perTxMax",
    "windowMax",
    "windowSeconds",
    "windowAnchor",
    "expiresAt",
    "evmRecipients",
    "solRecipients",
  ];
  for (const f of expected) {
    if (!(f in o)) errors.push(`missing field: ${f}`);
  }
  for (const f of Object.keys(o)) {
    if (!expected.includes(f)) errors.push(`unexpected field: ${f}`);
  }
  if (o.version !== 1) errors.push(`version must be 1, got ${JSON.stringify(o.version)}`);
  if (o.decimals !== 6) errors.push(`decimals must be 6, got ${JSON.stringify(o.decimals)}`);
  const perTxMax = toBigIntField(o.perTxMax, "perTxMax", false, errors);
  const windowMax = toBigIntField(o.windowMax, "windowMax", false, errors);
  const windowSeconds = toBigIntField(o.windowSeconds, "windowSeconds", false, errors);
  const windowAnchor = toBigIntField(o.windowAnchor, "windowAnchor", true, errors);
  const expiresAt = toBigIntField(o.expiresAt, "expiresAt", true, errors);
  if (perTxMax !== null && perTxMax > U64_MAX) errors.push(`perTxMax out of u64 range: ${perTxMax}`);
  if (windowMax !== null && windowMax > U64_MAX) errors.push(`windowMax out of u64 range: ${windowMax}`);
  if (windowSeconds !== null && (windowSeconds < WINDOW_MIN || windowSeconds > WINDOW_MAX)) {
    errors.push(`windowSeconds must be 60..31536000, got ${windowSeconds}`);
  }
  if (windowAnchor !== null && (windowAnchor < I64_MIN || windowAnchor > I64_MAX)) {
    errors.push(`windowAnchor out of i64 range: ${windowAnchor}`);
  }
  if (expiresAt !== null && (expiresAt < I64_MIN || expiresAt > I64_MAX)) {
    errors.push(`expiresAt out of i64 range: ${expiresAt}`);
  }
  if (!Array.isArray(o.evmRecipients)) errors.push("evmRecipients must be an array");
  if (!Array.isArray(o.solRecipients)) errors.push("solRecipients must be an array");
  if (errors.length > 0) return { ok: false, errors };
  const policy: PolicyInput = {
    version: 1,
    decimals: 6,
    perTxMax: perTxMax as bigint,
    windowMax: windowMax as bigint,
    windowSeconds: windowSeconds as bigint,
    windowAnchor: windowAnchor as bigint,
    expiresAt: expiresAt as bigint,
    evmRecipients: o.evmRecipients as string[],
    solRecipients: o.solRecipients as string[],
  };
  try {
    encodePolicy(policy);
  } catch (e) {
    return { ok: false, errors: [(e as Error).message] };
  }
  return { ok: true, policy };
}
