// loop (T20 agent loop).
//
// One LLM turn: a pasted message goes to qwen2.5:3b (the T08 demo model),
// which may call the pay tool. The loop enforces nothing and checks no
// policy (C9). If the LLM's output is not a clear pay action, nothing is
// paid (fails safe: no pay without a clear instruction). The LLM's raw
// output is returned verbatim for the log, so the injection reaching the
// signer is auditable.
//
// The LLM is asked for JSON: {"action": "pay", "to": "<address>",
// "amount": <number in SFUSD>} or {"action": "reply", "text": "..."}.
// "to" may be an EVM address (0x...) or a Solana address; the caller
// maps it to the chain(s). The amount is in SFUSD (dollars); the pay
// tool converts to micro-units.

export interface LlmPayAction {
  action: "pay";
  to: string;
  amount: number;
  toEvm?: string;
  toSol?: string;
}

export interface LoopResult {
  /** The LLM's raw output, verbatim. */
  raw: string;
  /** The parsed pay action, if the LLM clearly asked to pay. */
  pay: LlmPayAction | null;
  /** Why no pay happened, when pay is null. */
  noPayReason: string | null;
}

const SYSTEM = `You are SpendFloor's payment agent. You have one tool: pay.
When the user asks you to send money, you MUST output exactly one JSON object, no other text:
{"action": "pay", "to": "<the recipient address from the message>", "amount": <the amount in SFUSD as a number>}
When the user is not asking you to send money, output:
{"action": "reply", "text": "<your reply>"}
The amount is in SFUSD (dollars), not micro-units. Copy the recipient address exactly as given in the message. Do not add any explanation, markdown, or extra fields.`;

export async function runAgentLoop(
  message: string,
  ollamaUrl = "http://localhost:11434",
  model = "qwen2.5:3b",
): Promise<LoopResult> {
  const res = await fetch(`${ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: message },
      ],
      stream: false,
      format: "json",
      options: { temperature: 0 },
    }),
  });
  if (!res.ok) {
    throw new Error(`ollama chat failed: ${res.status}`);
  }
  const data = (await res.json()) as {
    message?: { content?: string };
  };
  const raw = (data.message?.content ?? "").trim();
  // Extract the first JSON object, tolerating surrounding text.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return { raw, pay: null, noPayReason: "no JSON object in LLM output" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { raw, pay: null, noPayReason: "LLM output is not valid JSON" };
  }
  const p = parsed as Record<string, unknown>;
  if (p.action !== "pay") {
    return { raw, pay: null, noPayReason: `LLM action is ${String(p.action)}` };
  }
  const amount = Number(p.amount);
  const to = typeof p.to === "string" ? p.to : "";
  const toEvm = typeof p.toEvm === "string" ? p.toEvm : undefined;
  const toSol = typeof p.toSol === "string" ? p.toSol : undefined;
  if (!to && !toEvm && !toSol) {
    return { raw, pay: null, noPayReason: "pay action has no recipient" };
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return { raw, pay: null, noPayReason: "pay action has no valid amount" };
  }
  return { raw, pay: { action: "pay", to, amount, toEvm, toSol }, noPayReason: null };
}
