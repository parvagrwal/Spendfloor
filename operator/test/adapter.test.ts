import assert from "node:assert/strict";
import test from "node:test";
import { DEMO_INSTRUCTIONS, NETWORKS, normalizeInstruction } from "../config.js";
import { buildRunFromEvents, parseEventLines } from "../demo.js";
import { getHistoricalRecords } from "../evidence.js";
import { classifyExecution, deriveProtection, expiryState, sumFingerprintPreview } from "../state.js";
import { policyHash } from "../../policy/src/canonical.js";
import type { DemoEvent } from "../demo.js";

const at = "2026-10-30T12:00:00.000Z";
function ev(type: string, extra: Record<string, unknown> = {}): DemoEvent {
  return { type, at, ...extra };
}
function eventSet(overrides: Partial<Record<"evm" | "sol", Record<string, unknown>>> = {}): DemoEvent[] {
  return [
    ev("run_started", { network: "testnet" }),
    ev("agent_processing"),
    ev("agent_signed", { amountSfusd: 50 }),
    ev("submitter_relaying", { chain: "evm" }),
    ev("chain_result", { chain: "evm", ok: false, label: "RecipientNotAllowed", hash: "0xaaa", digest: "0x1", signedAmountMicro: "50000000", ...overrides.evm }),
    ev("submitter_relaying", { chain: "sol" }),
    ev("chain_result", { chain: "sol", ok: false, label: "RecipientNotAllowed", hash: "sigA", digest: "sigA", signedAmountMicro: "50000000", ...overrides.sol }),
    ev("run_complete"),
  ];
}

test("event parser accepts only prefixed JSON lines", () => {
  const parsed = parseEventLines([
    "EVM pay: ok=false label=RecipientNotAllowed",
    `SPENDFLOOR_EVENT ${JSON.stringify({ type: "chain_result", at, chain: "evm" })}`,
    "SPENDFLOOR_EVENT {not json}",
  ].join("\n"));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].type, "chain_result");
});

test("confirmed attack rejection is based on returned labels and hashes", () => {
  const run = buildRunFromEvents({
    scenario: "attack-recipient", mode: "testnet", instruction: DEMO_INSTRUCTIONS["attack-recipient"],
    events: eventSet(), startedAt: at, finishedAt: at,
  });
  assert.equal(run.outcome, "rejected");
  assert.equal(run.securityOutcome, "attack_blocked");
  assert.equal(run.chains.evm.state, "rejected");
  assert.equal(run.chains.sol.state, "rejected");
  assert.equal(run.chains.evm.label, "RecipientNotAllowed");
  assert.equal(run.chains.sol.label, "RecipientNotAllowed");
  assert.ok(run.chains.evm.explorerUrl?.startsWith("https://sepolia.basescan.org/tx/0xaaa"));
  assert.ok(run.chains.sol.explorerUrl?.includes("cluster=devnet"));
  assert.equal(run.steps[3].state, "rejected");
});

test("no second rejection reason is inferred from the same execution", () => {
  const run = buildRunFromEvents({
    scenario: "attack-recipient", mode: "testnet", instruction: "x", events: eventSet(), startedAt: at, finishedAt: at,
  });
  const labels = [run.chains.evm.label, run.chains.sol.label];
  assert.deepEqual(labels, ["RecipientNotAllowed", "RecipientNotAllowed"]);
});

test("timeout is not converted to a rejection or success", () => {
  const run = buildRunFromEvents({
    scenario: "attack-recipient", mode: "testnet", instruction: "x",
    events: eventSet({
      evm: { ok: false, label: "Timeout", hash: "0xpending" },
      sol: { ok: false, label: "Timeout", hash: "sigpending" },
    }),
    startedAt: at, finishedAt: at,
  });
  assert.equal(run.outcome, "timed_out");
  assert.equal(run.securityOutcome, "inconclusive");
  assert.equal(run.chains.evm.state, "timed_out");
  assert.match(run.chains.evm.note ?? "", /reconcile/i);
});

test("transport failure without a hash is failed, not a landed revert", () => {
  const run = buildRunFromEvents({
    scenario: "attack-recipient", mode: "testnet", instruction: "x",
    events: eventSet({
      evm: { ok: false, label: "SubmitFailed", hash: null },
      sol: { ok: false, label: "RpcError", hash: null },
    }),
    startedAt: at, finishedAt: at,
  });
  assert.equal(run.outcome, "failed");
  assert.equal(run.chains.evm.state, "failed");
  assert.equal(run.chains.sol.state, "failed");
});

test("accepted outcome requires both chains to confirm", () => {
  const accepted = buildRunFromEvents({
    scenario: "legit-payment", mode: "testnet", instruction: "x",
    events: eventSet({
      evm: { ok: true, label: null, hash: "0xok" },
      sol: { ok: true, label: null, hash: "sigok" },
    }),
    startedAt: at, finishedAt: at,
  });
  assert.equal(accepted.outcome, "accepted");
  assert.equal(accepted.securityOutcome, "not_applicable");

  const oneLeg = buildRunFromEvents({
    scenario: "legit-payment", mode: "testnet", instruction: "x",
    events: eventSet({ evm: { ok: true, label: null, hash: "0xok" } }),
    startedAt: at, finishedAt: at,
  });
  assert.equal(oneLeg.outcome, "unknown");
});

test("lifecycle and expiry helpers keep states distinct", () => {
  assert.equal(classifyExecution({ ok: false, label: "RecipientNotAllowed", hash: "0x1" }), "rejected");
  assert.equal(classifyExecution({ ok: false, label: "RecipientNotAllowed", hash: null }), "unknown");
  assert.equal(classifyExecution({ ok: true }), "confirmed");
  assert.equal(deriveProtection("verified", "unavailable"), "partial");
  assert.equal(deriveProtection("failed", "failed"), "failed");
  assert.equal(expiryState(0n, 1), "never");
  assert.equal(expiryState(BigInt(Math.floor(Date.now() / 1000) - 10), Math.floor(Date.now() / 1000)), "expired");
});

test("historical evidence carries source, date and network label", () => {
  const records = getHistoricalRecords();
  assert.ok(records.length >= 6);
  for (const record of records) {
    assert.equal(record.freshness, "Historical");
    assert.ok(record.date.startsWith("2026-10-30"));
    assert.ok(record.source.length > 0);
    assert.ok(record.networkLabel.length > 0);
  }
  const legit = records.filter((r) => r.scenario === "legit-payment");
  assert.ok(legit.length > 0);
  assert.ok(legit.every((r) => r.networkLabel.includes("Localnet")));
});

test("canonical preview uses the repository hash implementation", () => {
  const values = {
    perTxMax: "2000000", windowMax: "5000000", windowSeconds: "86400",
    windowAnchor: "1793300140", expiresAt: "1793386540",
  };
  const expected = policyHash({
    version: 1, decimals: 6, ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k, BigInt(v)])),
    evmRecipients: [NETWORKS.evm.merchant], solRecipients: [NETWORKS.sol.merchant],
  } as Parameters<typeof policyHash>[0]);
  assert.equal(sumFingerprintPreview(values), expected);
});

test("operator failures produce actionable messages, not raw filesystem errors", () => {
  const run = buildRunFromEvents({
    scenario: "attack-recipient", mode: "testnet", instruction: "x",
    events: [ev("run_started"), ev("run_failed", { reason: "ENOENT: no such file or directory, lstat '/home/user/.spendfloor-keys'" })],
    startedAt: at, finishedAt: at,
  });
  assert.equal(run.outcome, "failed");
  assert.match(run.error ?? "", /Demo keys are missing/);
  assert.doesNotMatch(run.error ?? "", /lstat/);
  assert.equal(run.securityOutcome, "inconclusive");
});

test("scenario instructions are exact allowlisted strings", () => {
  assert.equal(normalizeInstruction(`  ${DEMO_INSTRUCTIONS["attack-recipient"]}  `), DEMO_INSTRUCTIONS["attack-recipient"]);
  assert.notEqual(DEMO_INSTRUCTIONS["attack-recipient"], DEMO_INSTRUCTIONS["legit-payment"]);
  assert.match(DEMO_INSTRUCTIONS["attack-recipient"], /50 SFUSD/);
  assert.match(DEMO_INSTRUCTIONS["legit-payment"], /1 SFUSD/);
});
