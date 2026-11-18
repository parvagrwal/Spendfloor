import test from "node:test";
import assert from "node:assert/strict";
import { Connection, Keypair } from "@solana/web3.js";
import { runAgentLoop } from "../agent/loop.js";
import { toMicro } from "../agent/amount.js";
import { ownerArgs } from "../cli/owner-args.js";
import { matchesRuntime } from "../cli/runtime-code.js";
import { ownedTokenBalance, ownerAta } from "../sdk/token-accounts.js";
import { TOKEN_PROGRAM_ID, parsePolicyAccount } from "../sdk/sol.js";
import { validateDraft } from "../policy/src/llm-draft.js";

test("unsigned six-decimal amounts without binary rounding; preserve conformance large-value inputs", () => {
  assert.equal(toMicro(0.000001), 1n);
  assert.equal(toMicro(1.000001), 1_000_001n);
  assert.equal(toMicro(18446744073709), 18446744073709000000n);
  for (const value of [Infinity, NaN, -1, 1e-7, 1.0000004, 18446744073710])
    assert.throws(() => toMicro(value));
});

test("untrusted model output never coerces booleans/strings or pays from surrounding prose", async (t) => {
  let content = "";
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ message: { content } }),
  );
  for (content of [
    "null",
    "[]",
    'explanation {"action":"pay","to":"merchant","amount":2}',
    '{"action":"pay","to":"merchant","amount":true}',
    '{"action":"pay","to":"merchant","amount":"2"}',
  ])
    assert.equal((await runAgentLoop("hello")).pay, null);
  content = '{"action":"pay","to":"merchant","amount":0.5}';
  assert.equal((await runAgentLoop("hello")).pay?.amount, 0.5);
});

test("owner flags reject typos and out-of-range values before either chain is contacted", () => {
  for (const args of [
    ["--amont", "1"],
    ["--amount"],
    ["--amount", "1", "--amount", "2"],
    ["--amount", "-1"],
    ["--amount", "18446744073709551616"],
  ])
    assert.throws(() => ownerArgs("withdraw", args));
  assert.equal(
    ownerArgs("withdraw", ["--amount", "100"]).get("--amount"),
    "100",
  );
  assert.throws(() => ownerArgs("set-policy", ["--window-secs", "1"]));
  assert.throws(() => ownerArgs("set-agent", ["--sol-agent", "invalid!"]));
});

test("drafts match non-negative on-chain time constraints", () => {
  const d = {
    version: 1,
    decimals: 6,
    perTxMax: 1,
    windowMax: 2,
    windowSeconds: 60,
    windowAnchor: 0,
    expiresAt: 0,
    evmRecipients: ["0x" + "1".repeat(40)],
    solRecipients: [Keypair.generate().publicKey.toBase58()],
  };
  assert.ok(validateDraft(d).ok);
  assert.equal(validateDraft({ ...d, windowAnchor: -1 }).ok, false);
  assert.equal(validateDraft({ ...d, solRecipients: [42] }).ok, false);
});

test("malformed account metadata and lengths fail closed", () => {
  assert.throws(() => parsePolicyAccount(Buffer.alloc(100)), /discriminator/);
  const data = Buffer.alloc(150);
  Buffer.from("de8707a3ebb12144", "hex").copy(data);
  data.writeUInt32LE(0xffffffff, 117);
  assert.throws(() => parsePolicyAccount(data), /length/);
});

test("verifier aggregates multiple token accounts and propagates RPC failures", async () => {
  const owner = Keypair.generate().publicKey,
    mint = Keypair.generate().publicKey;
  const data = Buffer.alloc(165);
  mint.toBuffer().copy(data);
  owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(7n, 64);
  const account = { owner: TOKEN_PROGRAM_ID, data };
  const conn = {
    getTokenAccountsByOwner: async () => ({
      value: [{ account }, { account }],
    }),
  } as unknown as Connection;
  assert.equal(await ownedTokenBalance(conn, mint, owner), 14n);
  data[0] ^= 1;
  await assert.rejects(ownedTokenBalance(conn, mint, owner), /unexpected/);
  await assert.rejects(
    ownedTokenBalance(
      {
        getTokenAccountsByOwner: async () => {
          throw Error("offline");
        },
      } as unknown as Connection,
      mint,
      owner,
    ),
    /offline/,
  );
  const { address, create } = ownerAta(mint, owner);
  assert.ok(create.keys[1].pubkey.equals(address));
  assert.deepEqual(create.data, Buffer.from([1]));
});

test("runtime comparison checks every immutable reference and rejects extra bytes", () => {
  const local = `0x60${"00".repeat(64)}` as const;
  const live = `0x60${"11".repeat(64)}` as const;
  const refs = {
    owner: [
      { start: 1, length: 32 },
      { start: 33, length: 32 },
    ],
  };
  const values = [`0x${"11".repeat(32)}` as const];
  assert.ok(matchesRuntime(local, live, refs, values));
  assert.equal(matchesRuntime(local, `${live}00`, refs, values), false);
  assert.equal(
    matchesRuntime(
      local,
      `${live.slice(0, -2)}22` as `0x${string}`,
      refs,
      values,
    ),
    false,
  );
});

test("release preflight attests loader linkage, upgrade authority and program bytes, not just program ID", async () => {
  const { readProgramRelease } = await import("../sdk/program-release.js");
  const { PublicKey } = await import("@solana/web3.js");
  const loader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
  const authority = Keypair.generate().publicKey,
    program = Keypair.generate().publicKey;
  const [linked] = PublicKey.findProgramAddressSync(
    [program.toBuffer()],
    loader,
  );
  const entry = Buffer.alloc(36),
    data = Buffer.alloc(50),
    artifact = Buffer.from([0x7f, 0x45]);
  entry.writeUInt32LE(2);
  linked.toBuffer().copy(entry, 4);
  data.writeUInt32LE(3);
  data[12] = 1;
  authority.toBuffer().copy(data, 13);
  artifact.copy(data, 45);
  const rpc = {
    getMultipleAccountsInfo: async () => [
      { executable: true, owner: loader, data: entry },
      { executable: false, owner: loader, data },
    ],
  } as unknown as Connection;
  const release = await readProgramRelease(rpc, program, artifact);
  assert.ok(release.matches);
  assert.ok(release.authority.equals(authority));
  data[49] = 4;
  assert.equal(
    (await readProgramRelease(rpc, program, artifact)).matches,
    false,
  );
  entry[4] ^= 1;
  await assert.rejects(
    readProgramRelease(rpc, program, artifact),
    /loader linkage/,
  );
});
