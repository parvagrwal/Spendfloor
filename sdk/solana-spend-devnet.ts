// solana-spend-devnet (T07 devnet leg, step 3 of 3; step 1 is the program
// deploy, step 2 is the policy init, both on the owner machine).
//
//   Run on the AGENT machine (Muse VM) only, after the owner deploys:
//     SPENDFLOOR_SOL_PROGRAM_ID=<program-id> npx tsx sdk/solana-spend-devnet.ts
//
// The AGENT co-signs with 0 lamports; the SUBMITTER pays fees. Valid spends
// must land with null err; over-cap attempts are sent with preflight
// skipped and must land with meta.err and DailyCapExceeded in the logs.
// AGENT lamports must be 0 throughout, and upgrade authority must be OWNER.
// Confirmation polls over plain HTTP (the VM's WebSocket path to devnet
// fails TLS). If a previous run already landed some valid spends, this
// script resumes from the policy's spent total instead of resending them.
// This script NEVER prints key material. Exit 0 only when every leg passes.

import { createHash } from "node:crypto";
import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  hasPrivateKey,
  loadSolKeypair,
  machineKind,
  registryAddress,
} from "./keys.js";

const RPC = process.env.SPENDFLOOR_SOL_RPC ?? "https://api.devnet.solana.com";
const PROGRAM_ID_RAW = process.env.SPENDFLOOR_SOL_PROGRAM_ID;
const VALID_AMOUNT = 100_000;
const OVER_CAP_AMOUNT = 2_000_000;

const fail = (msg: string): never => {
  console.log(`FAIL  ${msg}`);
  process.exit(1);
};

if (!PROGRAM_ID_RAW) fail("SPENDFLOOR_SOL_PROGRAM_ID is not set");
const PROGRAM_ID = new PublicKey(PROGRAM_ID_RAW as string);

// --- Custody pre-flight ---
const kind = machineKind();
if (kind !== "agent") fail(`this machine is "${kind}", not "agent"; refusing to spend`);
if (hasPrivateKey("sol", "owner")) fail("OWNER SOL key exists on this agent machine (custody violation)");
if (!hasPrivateKey("sol", "agent")) fail("AGENT SOL key absent on this machine");
if (!hasPrivateKey("sol", "submitter")) fail("SUBMITTER SOL key absent on this machine");
const agent = loadSolKeypair("agent");
const submitter = loadSolKeypair("submitter");
const expectedAgent = registryAddress("sol", "agent") ?? fail("registry missing agent address");
const expectedSubmitter = registryAddress("sol", "submitter") ?? fail("registry missing submitter address");
const expectedOwner = registryAddress("sol", "owner") ?? fail("registry missing owner address");
if (agent.publicKey.toBase58() !== expectedAgent) fail("AGENT local key does not match registry address");
if (submitter.publicKey.toBase58() !== expectedSubmitter) fail("SUBMITTER local key does not match registry address");
console.log(`machine: ${kind}`);
console.log(`program: ${PROGRAM_ID.toBase58()}`);
console.log(`agent: ${agent.publicKey.toBase58()} (must stay 0 lamports)`);
console.log(`submitter: ${submitter.publicKey.toBase58()}`);
console.log(`rpc: ${RPC.replace(/api-key=[^&]*/g, "api-key=***")}`);
console.log("");

const connection = new Connection(RPC, "confirmed");
const [policy] = PublicKey.findProgramAddressSync([Buffer.from("policy")], PROGRAM_ID);
console.log(`policy PDA: ${policy.toBase58()}`);

function disc(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function u64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

async function assertAgentZero(stage: string) {
  const bal = await connection.getBalance(agent.publicKey);
  console.log(`agent balance (${stage}): ${bal} lamports`);
  if (bal !== 0) fail(`AGENT balance is not 0 at ${stage}`);
}

async function getUpgradeAuthority(): Promise<string | null> {
  const prog = (await connection.getAccountInfo(PROGRAM_ID)) ?? fail("program account missing on devnet");
  if (prog.data.length < 36) fail(`program account data too short: ${prog.data.length} bytes`);
  const programdataAddress = new PublicKey(prog.data.subarray(4, 36));
  const pd = (await connection.getAccountInfo(programdataAddress)) ?? fail("programdata account missing on devnet");
  if (pd.data.length < 45) fail(`programdata too short: ${pd.data.length} bytes`);
  if (pd.data[12] !== 1) return null;
  return new PublicKey(pd.data.subarray(13, 45)).toBase58();
}

function parseSpentToday(data: Buffer): bigint {
  const len = data.readUInt32LE(72);
  const spentOff = 8 + 32 + 32 + 4 + 32 * len + 8 + 8 + 1 + 8;
  return data.readBigUInt64LE(spentOff);
}

async function readSpent(): Promise<bigint> {
  const acc = (await connection.getAccountInfo(policy)) ?? fail("policy account missing on devnet (was it initialized?)");
  return parseSpentToday(acc.data);
}

async function confirmByPolling(sig: string): Promise<void> {
  // The VM's WebSocket path to devnet fails TLS, so confirmation polls over
  // plain HTTP instead of confirmTransaction's WebSocket subscription.
  const deadline = Date.now() + 90_000;
  for (;;) {
    const [st] = (await connection.getSignatureStatuses([sig])).value;
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return;
    if (Date.now() > deadline) {
      fail(`transaction ${sig.slice(0, 16)}... not confirmed after 90s; check its status before retrying`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function spend(
  to: PublicKey,
  amount: number,
  skipPreflight: boolean,
): Promise<{ sig: string; err: unknown; logs: string[]; slot: number }> {
  const data = Buffer.concat([disc("spend"), u64(amount)]);
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: policy, isSigner: false, isWritable: true },
      { pubkey: to, isSigner: false, isWritable: true },
      { pubkey: agent.publicKey, isSigner: true, isWritable: false },
    ],
    data,
  });
  const tx = new Transaction().add(ix);
  tx.feePayer = submitter.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(agent, submitter);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight });
  await confirmByPolling(sig);
  const parsed = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  return { sig, err: parsed?.meta?.err ?? null, logs: parsed?.meta?.logMessages ?? [], slot: parsed?.slot ?? -1 };
}

// --- Upgrade authority must be OWNER (criterion 5) ---
const authority = await getUpgradeAuthority();
console.log(`upgrade authority: ${authority ?? "(none, immutable)"}`);
if (authority !== expectedOwner) fail(`upgrade authority is ${authority}, not OWNER ${expectedOwner}`);

await assertAgentZero("before");
const spentBefore = await readSpent();
console.log(`policy spent before: ${spentBefore} lamports`);
if (spentBefore % BigInt(VALID_AMOUNT) !== 0n) fail(`policy spent is not a multiple of the valid amount: ${spentBefore}`);
const alreadyDone = Number(spentBefore / BigInt(VALID_AMOUNT));
if (alreadyDone > 3) fail(`policy spent already exceeds the valid total: ${spentBefore}`);
if (alreadyDone > 0) console.log(`resuming: ${alreadyDone}/3 valid spends already landed, sending the remaining ${3 - alreadyDone}`);

// --- 3 of 3 valid spends (criterion 3) ---
const validTargets = [submitter.publicKey, new PublicKey(expectedOwner), submitter.publicKey];
for (let i = alreadyDone; i < validTargets.length; i++) {
  const r = await spend(validTargets[i], VALID_AMOUNT, false);
  console.log(`valid spend ${i + 1}/3: to=${validTargets[i].toBase58().slice(0, 8)}... amount=${VALID_AMOUNT} sig=${r.sig.slice(0, 16)}... err=${r.err === null ? "null" : JSON.stringify(r.err)} slot=${r.slot}`);
  if (r.err !== null) fail(`valid spend ${i + 1} failed: ${JSON.stringify(r.err)}`);
}
await assertAgentZero("after valid spends");

// --- 3 of 3 over-cap attempts (criterion 4) ---
for (let i = 0; i < 3; i++) {
  const r = await spend(submitter.publicKey, OVER_CAP_AMOUNT, true);
  const hasName = r.logs.some((l) => l.includes("DailyCapExceeded"));
  console.log(`over-cap ${i + 1}/3: sig=${r.sig.slice(0, 16)}... err=${r.err === null ? "null" : JSON.stringify(r.err)} logsDailyCapExceeded=${hasName} slot=${r.slot}`);
  if (r.err === null) fail(`over-cap ${i + 1} unexpectedly succeeded`);
  if (!hasName) fail(`over-cap ${i + 1} logs do not show DailyCapExceeded: ${r.logs.join(" | ").slice(0, 400)}`);
}
await assertAgentZero("after over-cap attempts");

// --- Spent total must be exactly the 3 valid spends ---
const spentAfter = await readSpent();
console.log(`policy spent after: ${spentAfter} lamports (expected ${VALID_AMOUNT * 3})`);
if (spentAfter !== BigInt(VALID_AMOUNT * 3)) fail("policy spent total does not match the 3 valid spends");
console.log("");
console.log("solana-spend-devnet: PASS :: 3/3 valid null err, 3/3 over-cap meta.err + DailyCapExceeded, agent 0 throughout, upgrade authority OWNER");
