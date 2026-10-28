// Golden-vector tests for the canonical encoding (T05).
// Run: npx tsx --test policy/test/golden.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  encodePolicy,
  evmSetHash,
  policyHash,
  sha256,
  solSetHash,
  toHex,
  type PolicyInput,
} from "../src/canonical.js";

interface GoldenFile {
  name: string;
  policy: {
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
  canonicalBytesHex: string;
  evmSetHash: string;
  solSetHash: string;
  policyHash: string;
}

const goldens: GoldenFile[] = JSON.parse(
  readFileSync(new URL("./golden-hashes.json", import.meta.url), "utf8")
);

function toInput(g: GoldenFile): PolicyInput {
  return {
    version: g.policy.version,
    decimals: g.policy.decimals,
    perTxMax: BigInt(g.policy.perTxMax),
    windowMax: BigInt(g.policy.windowMax),
    windowSeconds: BigInt(g.policy.windowSeconds),
    windowAnchor: BigInt(g.policy.windowAnchor),
    expiresAt: BigInt(g.policy.expiresAt),
    evmRecipients: g.policy.evmRecipients,
    solRecipients: g.policy.solRecipients,
  };
}

test("golden file holds exactly 5 vectors", () => {
  assert.equal(goldens.length, 5);
});

for (const g of goldens) {
  test(`${g.name}: encoding, set hashes and policyHash reproduce`, () => {
    const p = toInput(g);
    assert.equal(toHex(encodePolicy(p)), g.canonicalBytesHex);
    assert.equal(toHex(evmSetHash(p.evmRecipients)), g.evmSetHash);
    assert.equal(toHex(solSetHash(p.solRecipients)), g.solSetHash);
    assert.equal(policyHash(p), g.policyHash);
    assert.equal(encodePolicy(p).length, 122);
  });
}

test("G5 (reversed recipients) hashes identically to G2", () => {
  const g2 = goldens.find((g) => g.name.startsWith("G2"))!;
  const g5 = goldens.find((g) => g.name.startsWith("G5"))!;
  assert.equal(policyHash(toInput(g5)), policyHash(toInput(g2)));
});

test("recipient order does not change a set hash", () => {
  const [a, b] = goldens[1].policy.evmRecipients;
  assert.equal(toHex(evmSetHash([a, b])), toHex(evmSetHash([b, a])));
  const [x, y] = goldens[1].policy.solRecipients;
  assert.equal(toHex(solSetHash([x, y])), toHex(solSetHash([y, x])));
});

test("empty set hash is the SHA-256 of empty input", () => {
  assert.equal(
    toHex(evmSetHash([])),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  );
  assert.equal(toHex(sha256(new Uint8Array(0))), toHex(evmSetHash([])));
});

test("a one-micro-unit change changes the policyHash", () => {
  const p = toInput(goldens[0]);
  const q = { ...p, perTxMax: p.perTxMax + 1n };
  assert.notEqual(policyHash(q), policyHash(p));
});

test("invalid inputs are rejected", () => {
  const p = toInput(goldens[0]);
  assert.throws(() => encodePolicy({ ...p, evmRecipients: [] }), /1\.\.8/);
  assert.throws(
    () => encodePolicy({ ...p, evmRecipients: ["0x0000000000000000000000000000000000000000"] }),
    /zero address/
  );
  assert.throws(() => encodePolicy({ ...p, perTxMax: 1n << 64n }), /u64 range/);
  assert.throws(() => encodePolicy({ ...p, expiresAt: 1n << 63n }), /i64 range/);
  assert.throws(
    () => encodePolicy({ ...p, evmRecipients: [p.evmRecipients[0], p.evmRecipients[0]] }),
    /duplicate/
  );
});
