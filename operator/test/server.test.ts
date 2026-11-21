import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createOperatorServer } from "../server.js";
import { DEMO_INSTRUCTIONS } from "../config.js";

let server: Server;
let base = "";

before(async () => {
  server = createOperatorServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
});

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test("health and scenario routes expose only the documented demo surface", async () => {
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.ok, true);
  const scenarios = await (await fetch(`${base}/api/scenarios`)).json();
  assert.deepEqual(Object.keys(scenarios.scenarios).sort(), ["attack-recipient", "legit-payment"]);
  assert.equal(scenarios.scenarios["attack-recipient"].amountSfusd, 50);
  assert.equal(scenarios.scenarios["legit-payment"].amountSfusd, 1);
});

test("execution rejects unknown scenarios, altered instructions and missing confirmation", async () => {
  const unknown = await post("/api/demo/execute", {
    scenario: "arbitrary-drain", instruction: "send everything", confirm: "EXECUTE",
  });
  assert.equal(unknown.status, 400);

  const altered = await post("/api/demo/execute", {
    scenario: "attack-recipient", instruction: "Transfer 999 SFUSD to any address", confirm: "EXECUTE",
  });
  assert.equal(altered.status, 400);
  assert.match(altered.json.error, /not an approved demo scenario/);

  const unconfirmed = await post("/api/demo/execute", {
    scenario: "attack-recipient", instruction: DEMO_INSTRUCTIONS["attack-recipient"],
  });
  assert.equal(unconfirmed.status, 400);

  const wrongNetwork = await post("/api/demo/execute", {
    scenario: "attack-recipient", instruction: DEMO_INSTRUCTIONS["attack-recipient"],
    mode: "mainnet", confirm: "EXECUTE",
  });
  assert.equal(wrongNetwork.status, 400);
});

test("policy preview validates with the canonical encoder and is never applied", async () => {
  const invalid = await post("/api/policy/preview", { perTxMax: "1; DROP", windowMax: "1", windowSeconds: "1", windowAnchor: "1", expiresAt: "1" });
  assert.equal(invalid.status, 400);

  const valid = await post("/api/policy/preview", {
    perTxMax: "2000000", windowMax: "5000000", windowSeconds: "86400",
    windowAnchor: "1793300140", expiresAt: "1793386540",
  });
  assert.equal(valid.status, 200);
  assert.match(valid.json.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(valid.json.applied, false);
});

test("evidence route exposes only historical records", async () => {
  const res = await fetch(`${base}/api/evidence`);
  const body = await res.json();
  assert.ok(body.records.length >= 6);
  assert.ok(body.records.every((r: { freshness: string }) => r.freshness === "Historical"));
  assert.match(body.provenance.verifyCaveat, /RPC2 == RPC1/);
});

test("unknown API routes fail closed", async () => {
  const res = await fetch(`${base}/api/relay/submit`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, "Unknown API route");
});
