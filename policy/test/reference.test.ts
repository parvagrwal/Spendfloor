// Reference-model tests (T30). Run:
//   npx tsx --test policy/test/reference.test.ts
// Every vector is V1–V21 from the plan §2 conformance table plus
// the boundary cases (exact per-tx, exact window, now == expiry,
// window edges) and the precedence chain. V12 (agent signing owner
// functions) is NOT a spend decision, so it is not a decide() case:
// owner-only checks are tested in T10/T12b, not here.
import assert from "node:assert/strict";
import test from "node:test";
import {
  decide,
  windowIndexAt,
  type ReferencePolicy,
  type ReferenceState,
  type SpendRequest,
} from "../src/reference.js";

const MERCHANT = "merchant";
const ATTACKER = "attacker";
const VAULT = "vault";
const AGENT = "agent";
const U = 1_000_000n; // 1 SFUSD in micro-units

function p0(over: Partial<ReferencePolicy> = {}): ReferencePolicy {
  return {
    perTxMax: 2n * U,
    windowMax: 5n * U,
    windowSeconds: 86_400n,
    anchor: 1_000n,
    expiresAt: 1_000n + 86_400n, // init + 24h
    recipients: new Set([MERCHANT]),
    frozen: false,
    agent: AGENT,
    ...over,
  };
}

function state(over: Partial<ReferenceState> = {}): ReferenceState {
  return { currentWindow: 0n, spentInWindow: 0n, nonce: 0n, ...over };
}

// now for the plain P0 cases: in window 0 (anchor 1000, window
// 86400) and before expiry (87400).
const NOW = 1_500n;

function req(over: Partial<SpendRequest> = {}): SpendRequest {
  return {
    chain: "evm",
    signerIsAgent: true,
    recipient: MERCHANT,
    amount: 1n * U,
    nonce: 0n,
    // A valid EVM deadline sits in [now, now+300]; NOW+100 is valid
    // for the plain P0 cases (NOW = 1500). Tests at other `now`
    // values pass their own deadline explicitly.
    deadline: NOW + 100n,
    ...over,
  };
}

// (NOW is defined above req, so the default deadline NOW+100 is valid.)

function label(
  policy: ReferencePolicy,
  st: ReferenceState,
  r: SpendRequest,
  now: bigint = NOW,
): string | null {
  const out = decide(policy, st, r, now);
  return out.ok ? null : out.label;
}

test("V1: merchant 1 accepts, spent becomes 1", () => {
  const out = decide(p0(), state(), req(), NOW);
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.spentInWindow, 1n * U);
    assert.equal(out.windowIndex, 0n);
    assert.equal(out.nonce, 1n);
  }
});

test("V2: attacker 0.000001 -> RecipientNotAllowed", () => {
  assert.equal(label(p0(), state(), req({ recipient: ATTACKER, amount: 1n })), "RecipientNotAllowed");
});

test("V3: attacker, full vault balance -> RecipientNotAllowed (recipient beats caps)", () => {
  assert.equal(
    label(p0(), state(), req({ recipient: ATTACKER, amount: 100n * U })),
    "RecipientNotAllowed",
  );
});

test("V4: merchant 0 -> ZeroAmount", () => {
  assert.equal(label(p0(), state(), req({ amount: 0n })), "ZeroAmount");
});

test("V5: spent 1, merchant 2.000001 -> PerTxCapExceeded (window still fits)", () => {
  assert.equal(
    label(p0(), state({ spentInWindow: 1n * U }), req({ amount: 2n * U + 1n })),
    "PerTxCapExceeded",
  );
});

test("V6: spent 1, merchant 2 exactly -> ACCEPT (exact per-tx boundary)", () => {
  const out = decide(p0(), state({ spentInWindow: 1n * U }), req({ amount: 2n * U }), NOW);
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.spentInWindow, 3n * U);
});

test("V7: spent 3, merchant 6 -> DailyCapExceeded (daily beats per-tx)", () => {
  assert.equal(
    label(p0(), state({ spentInWindow: 3n * U }), req({ amount: 6n * U })),
    "DailyCapExceeded",
  );
});

test("V8: spent 3, merchant 2^64-1 -> DailyCapExceeded, no overflow", () => {
  const huge = 2n ** 64n - 1n;
  assert.equal(
    label(p0(), state({ spentInWindow: 3n * U }), req({ amount: huge })),
    "DailyCapExceeded",
  );
});

test("V9: spent 3, merchant 2 exactly -> ACCEPT (exact window boundary)", () => {
  const out = decide(p0(), state({ spentInWindow: 3n * U }), req({ amount: 2n * U }), NOW);
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.spentInWindow, 5n * U);
});

test("V10: spent 5, merchant 0.000001 -> DailyCapExceeded", () => {
  assert.equal(
    label(p0(), state({ spentInWindow: 5n * U }), req({ amount: 1n })),
    "DailyCapExceeded",
  );
});

test("V11: recipient = the vault itself -> RecipientNotAllowed", () => {
  assert.equal(label(p0(), state(), req({ recipient: VAULT })), "RecipientNotAllowed");
});

test("V13: frozen -> Frozen", () => {
  assert.equal(label(p0({ frozen: true }), state(), req()), "Frozen");
});

test("V14: unfreeze does NOT reset spent -> DailyCapExceeded", () => {
  assert.equal(
    label(p0(), state({ spentInWindow: 5n * U }), req({ amount: 1n })),
    "DailyCapExceeded",
  );
});

test("V15: P1 rollover (300 s window) -> spent resets, merchant 1 accepts", () => {
  const p1 = p0({ windowSeconds: 300n });
  // now in window 1 (anchor 1000 + 300 = 1300 is the first new-window instant)
  const out = decide(p1, state({ currentWindow: 0n, spentInWindow: 5n * U }), req({ deadline: 1_400n }), 1_300n);
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.spentInWindow, 1n * U);
    assert.equal(out.windowIndex, 1n);
  }
});

test("V16: P2 past expiry -> SessionExpired", () => {
  const p2 = p0({ expiresAt: 1_000n + 180n });
  assert.equal(label(p2, state(), req({ deadline: 1_300n }), 1_200n), "SessionExpired");
});

test("V17 EVM: resubmit (nonce mismatch) -> BadNonce, lands", () => {
  assert.equal(
    label(p0(), state({ nonce: 5n }), req({ nonce: 0n })),
    "BadNonce",
  );
});

test("V17 SOL: duplicate -> NotLanded, does not land", () => {
  assert.equal(
    label(p0(), state(), req({ chain: "sol", duplicate: true })),
    "NotLanded",
  );
});

test("V18: intent signed by the attacker key -> Unauthorized", () => {
  assert.equal(label(p0(), state(), req({ signerIsAgent: false })), "Unauthorized");
});

test("V19: now == expires_at -> SessionExpired", () => {
  const p = p0();
  assert.equal(label(p, state(), req({ deadline: p.expiresAt + 100n }), p.expiresAt), "SessionExpired");
});

test("V20: first instant of a new window -> spent resets, small spend accepts", () => {
  // P0's default expiry (anchor+86400) coincides with the first
  // window edge, so a later expiry is used here to isolate
  // rollover from expiry (at the edge itself, P0 would be
  // SessionExpired, because expiry is checked before the caps).
  const p = p0({ expiresAt: 200_000n });
  const edge = 1_000n + 86_400n; // anchor + one window
  const out = decide(p, state({ currentWindow: 0n, spentInWindow: 5n * U }), req({ deadline: edge + 100n }), edge);
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.spentInWindow, 1n * U);
    assert.equal(out.windowIndex, 1n);
  }
});

test("V21: +-1 s around a window edge, under local clock control", () => {
  // Same later-expiry isolation as V20 (P0's default expiry is
  // the edge itself).
  const p = p0({ expiresAt: 200_000n });
  const edge = 1_000n + 86_400n;
  const full = state({ currentWindow: 0n, spentInWindow: 5n * U });
  // 1 s before the edge: still the old window, spent counts.
  assert.equal(label(p, full, req({ amount: 1n, deadline: edge - 1n + 100n }), edge - 1n), "DailyCapExceeded");
  // At the edge and 1 s after: new window, spent resets.
  assert.equal(decide(p, full, req({ deadline: edge + 100n }), edge).ok, true);
  assert.equal(decide(p, full, req({ deadline: edge + 1n + 100n }), edge + 1n).ok, true);
});

test("windowIndexAt clamps now < anchor to 0 (both programs)", () => {
  assert.equal(windowIndexAt(999n, 1_000n, 86_400n), 0n);
  assert.equal(windowIndexAt(1_000n, 1_000n, 86_400n), 0n);
  assert.equal(windowIndexAt(1_000n + 86_400n, 1_000n, 86_400n), 1n);
  assert.equal(windowIndexAt(1_000n + 86_400n - 1n, 1_000n, 86_400n), 0n);
});

test("precedence chain: first failing check wins", () => {
  // Unauthorized beats BadNonce.
  assert.equal(
    label(p0(), state({ nonce: 5n }), req({ signerIsAgent: false, nonce: 0n })),
    "Unauthorized",
  );
  // BadNonce beats Frozen (transport sits between Unauthorized and Frozen).
  assert.equal(
    label(p0({ frozen: true }), state({ nonce: 5n }), req({ nonce: 0n })),
    "BadNonce",
  );
  // IntentExpired beats Frozen; DeadlineTooFar is the other transport label.
  assert.equal(
    label(p0({ frozen: true }), state(), req({ deadline: 1_000n }), NOW),
    "IntentExpired",
  );
  assert.equal(
    label(p0(), state(), req({ deadline: NOW + 301n }), NOW),
    "DeadlineTooFar",
  );
  // Frozen beats SessionExpired.
  const expired = p0({ frozen: true, expiresAt: 1_200n });
  assert.equal(label(expired, state(), req({ deadline: 1_600n }), 1_500n), "Frozen");
  // SessionExpired beats ZeroAmount.
  assert.equal(
    label(p0({ expiresAt: 1_200n }), state(), req({ amount: 0n, deadline: 1_600n }), 1_500n),
    "SessionExpired",
  );
  // ZeroAmount beats RecipientNotAllowed.
  assert.equal(
    label(p0(), state(), req({ recipient: ATTACKER, amount: 0n })),
    "ZeroAmount",
  );
  // RecipientNotAllowed beats DailyCap (V3 again, as a precedence case).
  assert.equal(
    label(p0(), state({ spentInWindow: 5n * U }), req({ recipient: ATTACKER, amount: 1n })),
    "RecipientNotAllowed",
  );
  // DailyCap beats PerTx (V7 again, as a precedence case).
  assert.equal(
    label(p0(), state({ spentInWindow: 3n * U }), req({ amount: 6n * U })),
    "DailyCapExceeded",
  );
});

test("SOL: transport is runtime-level (NotLanded) and SOL ignores EVM nonce/deadline", () => {
  // Expired blockhash never lands, even when the policy would accept.
  assert.equal(
    label(p0(), state(), req({ chain: "sol", blockhashExpired: true })),
    "NotLanded",
  );
  // A SOL request carries no nonce/deadline: a stale EVM nonce does
  // not affect the SOL decision.
  const out = decide(p0(), state({ nonce: 99n }), req({ chain: "sol" }), NOW);
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.nonce, null);
});

test("agent is never a recipient, even if a rotation made it one", () => {
  // A policy whose recipient set (wrongly) contains the agent still
  // rejects a spend to the agent.
  const bad = p0({ recipients: new Set([MERCHANT, AGENT]) });
  assert.equal(label(bad, state(), req({ recipient: AGENT })), "RecipientNotAllowed");
});
