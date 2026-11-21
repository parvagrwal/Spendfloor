import assert from "node:assert/strict";
import test from "node:test";
import { executionLabel, microToSfusd, shortId, statusLabel } from "../src/lib/format.ts";

test("micro-unit formatting keeps six-decimal fidelity", () => {
  assert.equal(microToSfusd("2000000"), "2");
  assert.equal(microToSfusd("1500000"), "1.5");
  assert.equal(microToSfusd("1000001"), "1.000001");
  assert.equal(microToSfusd("0"), "0");
  assert.equal(microToSfusd(null), "—");
});

test("lifecycle labels never collapse timeout into rejection", () => {
  assert.equal(executionLabel("timed_out"), "Timed out");
  assert.equal(executionLabel("rejected"), "Rejected");
  assert.equal(executionLabel("confirmed"), "Confirmed");
  assert.equal(executionLabel("unknown"), "Unknown outcome");
  assert.equal(statusLabel("partial"), "Partial");
  assert.equal(statusLabel("failed"), "Verification failed");
});

test("identifier shortening preserves both ends", () => {
  const hash = `0x${"a".repeat(64)}`;
  assert.equal(shortId(hash, 10, 8), `0xaaaaaaaa…aaaaaaaa`);
  assert.equal(shortId("short", 10, 8), "short");
});
