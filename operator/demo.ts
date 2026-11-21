// Narrow structured adapter around the repository's real demo script.
// It spawns agent/demo-injection.ts with an allowlisted, server-chosen
// instruction and parses its machine-readable lifecycle events. No policy
// logic is reimplemented here; only the repository's SDK produces results.

import { execFile } from "node:child_process";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DEMO_INSTRUCTIONS, REPO_ROOT, txUrl, type ScenarioId } from "./config.js";
import { classifyExecution } from "./state.js";
import type { ChainExecution, ChainKey, DemoRun, FlowStep } from "./types.js";

export interface DemoEvent {
  type: string;
  at: string;
  [key: string]: unknown;
}

export function parseEventLines(stdout: string): DemoEvent[] {
  const out: DemoEvent[] = [];
  for (const line of stdout.split("\n")) {
    const idx = line.indexOf("SPENDFLOOR_EVENT ");
    if (idx < 0) continue;
    try {
      const parsed = JSON.parse(line.slice(idx + "SPENDFLOOR_EVENT ".length).trim());
      if (parsed && typeof parsed.type === "string" && typeof parsed.at === "string") out.push(parsed);
    } catch {
      // Ignore a malformed line rather than trusting it as evidence.
    }
  }
  return out;
}

function firstEvent(events: DemoEvent[], type: string): DemoEvent | undefined {
  return events.find((e) => e.type === type);
}

function chainExecution(events: DemoEvent[], chain: ChainKey): ChainExecution {
  const result = events.find((e) => e.type === "chain_result" && e.chain === chain);
  const relay = events.find((e) => e.type === "submitter_relaying" && e.chain === chain);
  const skipped = events.find((e) => e.type === "chain_skipped" && e.chain === chain);
  const base: ChainExecution = {
    state: skipped ? "failed" : relay ? "unknown" : "not_started",
    label: null,
    hash: null,
    digest: null,
    signedAmountMicro: null,
    observedAt: null,
    explorerUrl: null,
    raw: null,
    note: skipped ? "Leg skipped before broadcast; no transaction exists." : null,
  };
  if (!result) return base;
  const ok = result.ok === true;
  const label = typeof result.label === "string" ? result.label : null;
  const hash = typeof result.hash === "string" ? result.hash : null;
  const state = classifyExecution({ ok, label, hash });
  const note = state === "rejected"
    ? `Landed on-chain; vault returned ${label}. Reverted state was rolled back.`
    : state === "confirmed"
      ? "Landed on-chain with a successful receipt."
      : state === "timed_out"
        ? "Broadcast identifier retained; confirmation unknown. Reconcile on an explorer before concluding."
        : state === "failed"
          ? "Submission failed before a confirmed on-chain result."
          : "Outcome could not be established; do not assume rejection or success.";
  return {
    state,
    label,
    hash,
    digest: typeof result.digest === "string" ? result.digest : null,
    signedAmountMicro: typeof result.signedAmountMicro === "string" ? result.signedAmountMicro : null,
    observedAt: typeof result.at === "string" ? result.at : null,
    explorerUrl: hash ? txUrl(chain, hash) : null,
    raw: typeof result.raw === "string" ? result.raw : null,
    note,
  };
}

export function buildFlowSteps(events: DemoEvent[], chains: Record<ChainKey, ChainExecution>): FlowStep[] {
  const started = firstEvent(events, "run_started");
  const processing = firstEvent(events, "agent_processing");
  const signed = firstEvent(events, "agent_signed");
  const noPay = firstEvent(events, "agent_no_pay");
  const relayed = events.find((e) => e.type === "submitter_relaying");
  const failed = firstEvent(events, "run_failed");
  const evm = chains.evm.state;
  const sol = chains.sol.state;
  const resultState: DemoRun["steps"][number]["state"] =
    failed ? "failed"
    : evm === "rejected" && sol === "rejected" ? "rejected"
    : evm === "confirmed" && sol === "confirmed" ? "confirmed"
    : evm === "timed_out" || sol === "timed_out" ? "timed_out"
    : evm === "confirmed" || sol === "confirmed" || evm === "rejected" || sol === "rejected" ? "unknown"
    : noPay ? "failed"
    : relayed ? "submitted" : "not_started";
  return [
    {
      key: "agent",
      state: failed ? "failed" : noPay ? "failed" : processing ? "signed" : started ? "processing" : "not_started",
      at: processing?.at ?? started?.at ?? null,
      detail: failed ? "Run failed before completion" : noPay ? "Agent declined to sign a payment action" : processing ? "Agent received the instruction" : "Waiting for run",
    },
    {
      key: "sign",
      state: failed ? "failed" : signed ? "signed" : noPay ? "failed" : "not_started",
      at: signed?.at ?? null,
      detail: signed ? `Signed intent for ${String(signed.amountSfusd ?? "?")} SFUSD` : noPay ? "No signed intent was produced" : "Waiting for signed intent",
    },
    {
      key: "relay",
      state: failed ? "failed" : relayed ? "submitted" : "not_started",
      at: relayed?.at ?? null,
      detail: relayed ? "Submitter relayed to the vault" : "Waiting for submitter",
    },
    {
      key: "result",
      state: resultState,
      at: chains.evm.observedAt ?? chains.sol.observedAt ?? failed?.at ?? null,
      detail: resultState === "rejected" ? "Both chains returned on-chain policy rejections"
        : resultState === "confirmed" ? "Both chains returned successful receipts"
        : resultState === "unknown" ? "Only one leg or an incomplete outcome is available"
        : resultState === "timed_out" ? "Confirmation timed out; reconcile by identifier"
        : "Waiting for on-chain results",
    },
  ];
}

export function buildRunFromEvents(input: {
  id?: string;
  scenario: ScenarioId;
  mode: "testnet" | "local";
  instruction: string;
  events: DemoEvent[];
  error?: string | null;
  startedAt: string;
  finishedAt: string | null;
}): DemoRun {
  const chains: Record<ChainKey, ChainExecution> = {
    evm: chainExecution(input.events, "evm"),
    sol: chainExecution(input.events, "sol"),
  };
  const noPay = firstEvent(input.events, "agent_no_pay");
  const failed = firstEvent(input.events, "run_failed") ?? input.error;
  const states = [chains.evm.state, chains.sol.state];
  let outcome: DemoRun["outcome"];
  if (noPay && !failed) outcome = "no_action";
  else if (failed) outcome = "failed";
  else if (states.every((s) => s === "failed")) outcome = "failed";
  else if (states.includes("timed_out")) outcome = "timed_out";
  else if (states.every((s) => s === "rejected") &&
    chains.evm.label === "RecipientNotAllowed" && chains.sol.label === "RecipientNotAllowed" &&
    chains.evm.hash && chains.sol.hash) outcome = "rejected";
  else if (states.every((s) => s === "confirmed") && chains.evm.hash && chains.sol.hash) outcome = "accepted";
  else outcome = "unknown";

  const blocked = input.scenario === "attack-recipient" && outcome === "rejected";
  return {
    id: input.id ?? randomUUID(),
    scenario: input.scenario,
    mode: input.mode,
    instruction: input.instruction,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    outcome,
    freshness: input.mode === "local" ? "Local" : "Live",
    steps: buildFlowSteps(input.events, chains),
    chains,
    securityOutcome: input.scenario === "legit-payment" ? "not_applicable" : blocked ? "attack_blocked" : "inconclusive",
    agentRaw: typeof firstEvent(input.events, "agent_no_pay")?.raw === "string"
      ? String(firstEvent(input.events, "agent_no_pay")?.raw)
      : null,
    events: input.events,
    error: typeof failed === "string" ? failed : failed && typeof failed.reason === "string" ? childError(failed.reason) : null,
  };
}

let running: Promise<DemoRun> | null = null;
let lastRun: DemoRun | null = null;

export function getLastRun(): DemoRun | null {
  return lastRun;
}

export function setLastRun(run: DemoRun | null): void {
  lastRun = run;
}

export function isDemoRunning(): boolean {
  return running !== null;
}

function childError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  if (/ETIMEDOUT|timed out/i.test(text)) return "Demo timed out. Any broadcast identifier must be reconciled on-chain before drawing a conclusion.";
  if (/spendfloor-keys|key absent|machine marker|ENOENT/i.test(text))
    return "Demo keys are missing or inaccessible on the operator host. Configure the agent/submitter keys and machine marker outside the checkout, then retry.";
  if (/ollama|ECONNREFUSED/i.test(text))
    return "Ollama is unavailable on the operator host. Start ollama serve and confirm the demo model is pulled; no payment was signed.";
  if (/RPC|fetch failed|network/i.test(text))
    return "A required RPC endpoint was unreachable. No on-chain outcome was established; reconcile before retrying.";
  return text.slice(0, 300);
}

export function executeScenario(scenario: ScenarioId, mode: "testnet" | "local"): Promise<DemoRun> {
  if (running) return Promise.reject(new Error("A demo run is already in progress"));
  const instruction = DEMO_INSTRUCTIONS[scenario];
  const startedAt = new Date().toISOString();
  const task = new Promise<DemoRun>((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", join(REPO_ROOT, "agent", "demo-injection.ts"),
        "--message", instruction, "--net", mode, "--json-events"],
      { cwd: REPO_ROOT, timeout: 180_000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const events = parseEventLines(stdout);
        const errText = error ? childError(error) : null;
        const run = buildRunFromEvents({
          scenario, mode, instruction, events,
          error: errText,
          startedAt,
          finishedAt: new Date().toISOString(),
        });
        if (stderr.trim() && !events.length && !errText) {
          run.error = `Demo produced no structured events. ${stderr.trim().slice(0, 180)}`;
          run.outcome = "unknown";
        }
        resolve(run);
      },
    );
  }).then((run) => {
    lastRun = run;
    return run;
  }).finally(() => {
    running = null;
  });
  running = task;
  return task;
}
