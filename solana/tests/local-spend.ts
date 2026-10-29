// Local validator attack tests for the T07 spike program.
//
//   Run after: solana-test-validator (localnet) + program deployed to it.
//     npx tsx solana/tests/local-spend.ts
//
// Uses raw web3.js instructions (no Anchor client): discriminators are
// sha256("global:<name>")[0..8], args are borsh (u64 LE, u8, pubkey bytes).
// Agent co-signs with 0 lamports; submitter pays fees. Expected failures
// are sent with skipPreflight so they land with meta.err, and the error
// name is asserted from the program logs. Exit 0 only when every leg passes.
// All keys here are throwaway local-test keys, never used on devnet.

import { createHash } from "node:crypto";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const RPC = "http://127.0.0.1:8899";
const PROGRAM_ID = new PublicKey("CQfuniyvMY9sPDAFMPRZzbpHEwRiyy3Y4BsfuQd3iAbE");
const DAILY_CAP = 2_000_000;
const PER_TX_CAP = 500_000;

const fail = (msg: string): never => {
  console.log(`FAIL  ${msg}`);
  process.exit(1);
};

function disc(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function u64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

const connection = new Connection(RPC, "confirmed");
const owner = Keypair.generate();
const agent = Keypair.generate();
const submitter = Keypair.generate();
const alice = Keypair.generate().publicKey;
const bob = Keypair.generate().publicKey;
const carol = Keypair.generate().publicKey;

async function airdrop(to: PublicKey, sol: number) {
  const sig = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, "confirmed");
}

async function assertAgentZero(stage: string) {
  const bal = await connection.getBalance(agent.publicKey);
  console.log(`agent balance (${stage}): ${bal} lamports`);
  if (bal !== 0) fail(`AGENT balance is not 0 at ${stage}`);
}

function policyPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("policy")], PROGRAM_ID);
}

async function sendIx(
  ix: TransactionInstruction,
  signers: Keypair[],
  feePayer: PublicKey,
  skipPreflight: boolean,
): Promise<{ sig: string; err: unknown; logs: string[] }> {
  const tx = new Transaction().add(ix);
  tx.feePayer = feePayer;
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.sign(...signers);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight });
  await connection.confirmTransaction(sig, "confirmed");
  const parsed = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  return { sig, err: parsed?.meta?.err ?? null, logs: parsed?.meta?.logMessages ?? [] };
}

function expectErrName(logs: string[], name: string) {
  const hit = logs.some((l) => l.includes(name));
  if (!hit) fail(`expected error ${name} in logs, got: ${logs.join(" | ").slice(0, 400)}`);
}

const [policy] = policyPda();
console.log(`program: ${PROGRAM_ID.toBase58()}`);
console.log(`policy PDA: ${policy.toBase58()}`);
console.log(`owner: ${owner.publicKey.toBase58()}`);
console.log(`agent: ${agent.publicKey.toBase58()} (must stay 0 lamports)`);
console.log(`submitter: ${submitter.publicKey.toBase58()}`);
console.log("");

await airdrop(owner.publicKey, 10);
await airdrop(submitter.publicKey, 5);
await assertAgentZero("before");

// --- Initialize policy (owner) ---
{
  const data = Buffer.concat([
    disc("initialize"),
    agent.publicKey.toBuffer(),
    Buffer.from([2, 0, 0, 0]),
    alice.toBuffer(),
    bob.toBuffer(),
    u64(DAILY_CAP),
    u64(PER_TX_CAP),
  ]);
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: owner.publicKey, isSigner: true, isWritable: true },
      { pubkey: policy, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
  const r = await sendIx(ix, [owner], owner.publicKey, false);
  if (r.err) fail(`initialize failed: ${JSON.stringify(r.err)}`);
  console.log("initialize: ok");
}

// --- Fund the policy PDA (owner) ---
{
  const sig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: policy, lamports: 5_000_000 }),
    ),
    [owner],
  );
  console.log(`fund policy: +5,000,000 lamports, ${sig.slice(0, 16)}...`);
}

async function spend(
  to: PublicKey,
  amount: number,
  agentKp: Keypair,
  skipPreflight: boolean,
): Promise<{ sig: string; err: unknown; logs: string[] }> {
  const data = Buffer.concat([disc("spend"), u64(amount)]);
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: policy, isSigner: false, isWritable: true },
      { pubkey: to, isSigner: false, isWritable: true },
      { pubkey: agentKp.publicKey, isSigner: true, isWritable: false },
    ],
    data,
  });
  return sendIx(ix, [agentKp, submitter], submitter.publicKey, skipPreflight);
}

async function setFrozen(frozen: boolean) {
  const data = Buffer.concat([disc("set_frozen"), Buffer.from([frozen ? 1 : 0])]);
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: owner.publicKey, isSigner: true, isWritable: false },
      { pubkey: policy, isSigner: false, isWritable: true },
    ],
    data,
  });
  const r = await sendIx(ix, [owner], owner.publicKey, false);
  if (r.err) fail(`set_frozen(${frozen}) failed: ${JSON.stringify(r.err)}`);
  console.log(`set_frozen(${frozen}): ok`);
}

// --- 1. Valid spend ---
{
  const r = await spend(alice, 100_000, agent, false);
  if (r.err) fail(`valid spend failed: ${JSON.stringify(r.err)}`);
  console.log("valid spend 100,000 -> alice: ok");
}
await assertAgentZero("after valid spend");

// --- 2. Wrong agent ---
{
  const wrong = Keypair.generate();
  const r = await spend(alice, 100_000, wrong, true);
  if (!r.err) fail("wrong-agent spend unexpectedly succeeded");
  expectErrName(r.logs, "Unauthorized");
  console.log("wrong agent: Unauthorized ok");
}

// --- 3. Zero amount ---
{
  const r = await spend(alice, 0, agent, true);
  if (!r.err) fail("zero-amount spend unexpectedly succeeded");
  expectErrName(r.logs, "ZeroAmount");
  console.log("zero amount: ZeroAmount ok");
}

// --- 4. Non-allowlisted recipient ---
{
  const r = await spend(carol, 100_000, agent, true);
  if (!r.err) fail("non-allowlisted spend unexpectedly succeeded");
  expectErrName(r.logs, "RecipientNotAllowed");
  console.log("non-allowlisted: RecipientNotAllowed ok");
}

// --- 5. Frozen, then unfreeze ---
await setFrozen(true);
{
  const r = await spend(alice, 100_000, agent, true);
  if (!r.err) fail("frozen spend unexpectedly succeeded");
  expectErrName(r.logs, "Frozen");
  console.log("frozen: Frozen ok");
}
await setFrozen(false);
{
  const r = await spend(alice, 100_000, agent, false);
  if (r.err) fail(`spend after unfreeze failed: ${JSON.stringify(r.err)}`);
  console.log("spend after unfreeze: ok (spent now 200,000)");
}

// --- 6. Over per-tx cap ---
{
  const r = await spend(alice, 600_000, agent, true);
  if (!r.err) fail("over-per-tx spend unexpectedly succeeded");
  expectErrName(r.logs, "PerTxCapExceeded");
  console.log("over per-tx: PerTxCapExceeded ok");
}

// --- 7. Fill to the daily cap, then exceed it ---
for (const amt of [500_000, 500_000, 500_000, 300_000]) {
  const r = await spend(bob, amt, agent, false);
  if (r.err) fail(`cap-fill spend ${amt} failed: ${JSON.stringify(r.err)}`);
}
console.log("cap fill: spent now 2,000,000 (daily cap reached)");
{
  const r = await spend(alice, 100_000, agent, true);
  if (!r.err) fail("over-daily spend unexpectedly succeeded");
  expectErrName(r.logs, "DailyCapExceeded");
  console.log("over daily: DailyCapExceeded ok");
}

// --- 8. Both caps exceeded -> DailyCapExceeded wins (precedence) ---
{
  const r = await spend(alice, 600_000, agent, true);
  if (!r.err) fail("both-caps spend unexpectedly succeeded");
  expectErrName(r.logs, "DailyCapExceeded");
  console.log("both caps: DailyCapExceeded ok (precedence)");
}
await assertAgentZero("after all legs");

console.log("");
console.log("local-spend: PASS :: valid, wrong-agent, zero, non-allowlisted, frozen, per-tx, daily, precedence all green on local validator");
