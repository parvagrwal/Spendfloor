import test from "node:test";
import assert from "node:assert/strict";
import { Connection, Keypair, Transaction } from "@solana/web3.js";
import { checkedEnvelope } from "../relay/envelope.js";
import {
  RateLimiter,
  DEFAULT_RELAY_CONFIG,
  createRelay,
} from "../relay/submitter.js";
import {
  buildSpendInstruction,
  policyPda,
  broadcastSignedSol,
} from "../sdk/sol.js";
import { base58 } from "@scure/base";
import { createWalletClient, http } from "viem";
import { foundry } from "viem/chains";

function fixture() {
  const payer = Keypair.generate(),
    agent = Keypair.generate();
  const key = () => Keypair.generate().publicKey;
  const target = { program: key(), agent: agent.publicKey, vaultToken: key() };
  const ix = buildSpendInstruction(
    target.program,
    policyPda(target.program)[0],
    target.vaultToken,
    key(),
    agent.publicKey,
    500_000n,
  );
  const tx = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: key().toBase58(),
  }).add(ix);
  const check = () =>
    checkedEnvelope(
      tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
      payer.publicKey,
      target,
      agent.publicKey.toBase58(),
    );
  return { payer, agent, tx, ix, target, check };
}

test("relay signs only canonical spend, preserving the independent signature", () => {
  const { tx, agent, payer, check } = fixture();
  tx.partialSign(agent);
  const safe = check();
  assert.deepEqual(safe.serializeMessage(), tx.serializeMessage());
  safe.partialSign(payer);
  assert.ok(safe.verifySignatures());
});

test("refuse missing signature, altered payload, extra instruction and untrusted deployment", () => {
  const { tx, agent, ix, check } = fixture();
  assert.throws(check, /signature/);
  tx.partialSign(agent);
  ix.data[8] ^= 1;
  assert.throws(check, /signature/);
  tx.add(ix);
  tx.partialSign(agent);
  assert.throws(check, /sponsored vault spend/);
  const other = fixture();
  other.tx.partialSign(other.agent);
  other.target.vaultToken = Keypair.generate().publicKey;
  assert.throws(other.check, /unexpected vault message/);
});

test("local relay refuses unconfigured targets without making any RPC calls", async () => {
  const relay = createRelay(
    DEFAULT_RELAY_CONFIG,
    createWalletClient({ chain: foundry, transport: http() }),
    Keypair.generate(),
    { localnet: true },
  );
  relay.start();
  await assert.rejects(
    relay.submitSol("agent", Buffer.alloc(0)),
    /unconfigured/,
  );
  await assert.rejects(
    relay.submitEvm("agent", "0x0000000000000000000000000000000000000001", {
      to: "0x0000000000000000000000000000000000000002",
      amount: 0n,
      nonce: 0n,
      deadline: 0n,
      v: 27,
      r: "0x",
      s: "0x",
    }),
    /unconfigured/,
  );
});

test("single sliding window bounds all identities and expires exactly at 60 seconds", () => {
  let now = 0;
  const limiter = new RateLimiter(
    { ...DEFAULT_RELAY_CONFIG, maxPerMinuteGlobal: 2, maxPerMinutePerAgent: 1 },
    () => now,
  );
  limiter.check("a");
  assert.throws(() => limiter.check("a"), /agent/);
  limiter.check("b");
  now = 59_999;
  assert.throws(() => limiter.check("c"), /global/);
  now++;
  limiter.check("a");
  limiter.check("c");
  assert.throws(
    () => new RateLimiter({ ...DEFAULT_RELAY_CONFIG, maxPerMinuteGlobal: NaN }),
    /invalid/,
  );
});

test("confirmed success needs zero log lookups; failures and uncertain sends keep the signature", async () => {
  const { tx, agent, payer } = fixture();
  tx.sign(agent, payer);
  const hash = base58.encode(tx.signature!);
  let logs = 0;
  const rpc = {
    sendRawTransaction: async () => hash,
    getSignatureStatus: async () => ({
      value: { confirmationStatus: "confirmed", err: null as unknown },
    }),
    getTransaction: async () => {
      logs++;
      return { meta: { logMessages: ["custom program error: 0x1771"] } };
    },
  };
  const connection = rpc as unknown as Connection;
  assert.deepEqual(await broadcastSignedSol(connection, tx), {
    ok: true,
    hash,
  });
  assert.equal(logs, 0);
  rpc.getSignatureStatus = async () => ({
    value: { confirmationStatus: "confirmed", err: "instruction failed" },
  });
  assert.deepEqual(await broadcastSignedSol(connection, tx), {
    ok: false,
    label: "Frozen",
    hash,
  });
  assert.equal(logs, 1);
  assert.deepEqual(await broadcastSignedSol(connection, tx, 0), {
    ok: false,
    label: "Timeout",
    hash,
  });
  rpc.sendRawTransaction = async () => {
    throw new Error("disconnected");
  };
  const result = await broadcastSignedSol(connection, tx);
  assert.equal(result.label, "RpcError");
  assert.equal(result.hash, hash);
});

test("web3.js JSON-RPC transport handles a request, batch, and provider rejection with the pinned client", async () => {
  let calls = 0;
  const connection = new Connection("http://127.0.0.1:8899", {
    fetch: async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      calls++;
      if (Array.isArray(request))
        return Response.json(
          request.map(({ id }) => ({ jsonrpc: "2.0", id, result: null })),
        );
      return Response.json(
        request.method === "getBalance"
          ? {
              jsonrpc: "2.0",
              id: request.id,
              result: { context: { slot: 1 }, value: 42 },
            }
          : {
              jsonrpc: "2.0",
              id: request.id,
              error: { code: -32000, message: "unavailable" },
            },
      );
    },
  });
  assert.equal(await connection.getBalance(Keypair.generate().publicKey), 42);
  assert.deepEqual(
    await connection.getTransactions(["first", "second"], {
      commitment: "confirmed",
    }),
    [null, null],
  );
  await assert.rejects(connection.getSlot(), /unavailable/);
  assert.equal(calls, 3);
});

test("Solana pay tool through relay yields a fully signed on-wire transaction and receipt (RPC double)", async () => {
  const { agent, payer, target, ix } = fixture();
  const { paySol } = await import("../agent/pay.js");
  const { Relay } = await import("../relay/submitter.js");
  const { createPublicClient } = await import("viem");
  let broadcasts = 0;
  const rpc = {
    getLatestBlockhash: async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 99,
    }),
    getBalance: async () => 20_000_000,
    sendRawTransaction: async (bytes: Buffer) => {
      const sent = Transaction.from(bytes);
      assert.ok(sent.verifySignatures());
      assert.equal(sent.instructions.length, 1);
      assert.equal(sent.instructions[0].data.readBigUInt64LE(8), 1_200_000n);
      broadcasts++;
      return base58.encode(sent.signature!);
    },
    getSignatureStatus: async () => ({
      value: { confirmationStatus: "confirmed", err: null },
    }),
  };
  const connection = rpc as unknown as Connection;
  const relay = new Relay(
    DEFAULT_RELAY_CONFIG,
    createPublicClient({ transport: http("http://127.0.0.1:8545") }),
    createWalletClient({ chain: foundry, transport: http() }),
    connection,
    payer,
    { solVault: target },
  );
  const pay = () =>
    paySol(
      relay,
      connection,
      agent,
      target.program,
      policyPda(target.program)[0],
      target.vaultToken,
      ix.keys[2].pubkey,
      1.2,
    );
  relay.start();
  assert.equal((await pay()).receipt.ok, true);
  rpc.getBalance = async () => 0;
  await assert.rejects(pay(), /exhausted/);
  rpc.getBalance = async () => {
    relay.stop();
    return 20_000_000;
  };
  await assert.rejects(pay(), /relay is off/);
  assert.equal(broadcasts, 1);
});
