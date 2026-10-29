// solana-init-policy (T07 devnet leg, step 2 of 2; step 1 is the program deploy).
//
//   Run on the OWNER machine only, after deploying the program:
//     SPENDFLOOR_SOL_PROGRAM_ID=<program-id> npx tsx sdk/solana-init-policy.ts
//
// Initializes the policy PDA (agent, allowlist, caps) and funds it.
// Custody pre-flight mirrors fund-check: owner machine only, SOL OWNER key
// matches the registry, no SOL AGENT or SUBMITTER key here.
// This script NEVER prints key material. Exit 0 only when both transactions
// confirm without error.

import { createHash } from "node:crypto";
import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  hasPrivateKey,
  loadSolKeypair,
  machineKind,
  registryAddress,
} from "./keys.js";

const RPC = process.env.SPENDFLOOR_SOL_RPC ?? "https://api.devnet.solana.com";
const PROGRAM_ID_RAW = process.env.SPENDFLOOR_SOL_PROGRAM_ID;
const DAILY_CAP = 2_000_000;
const PER_TX_CAP = 500_000;
const FUND = 5_000_000;
const BUFFER = 0.02 * LAMPORTS_PER_SOL;

const fail = (msg: string): never => {
  console.log(`FAIL  ${msg}`);
  process.exit(1);
};

if (!PROGRAM_ID_RAW) fail("SPENDFLOOR_SOL_PROGRAM_ID is not set");
const PROGRAM_ID = new PublicKey(PROGRAM_ID_RAW as string);

// --- Custody pre-flight ---
const kind = machineKind();
if (kind !== "owner") fail(`this machine is "${kind}", not "owner"; refusing to initialize`);
if (hasPrivateKey("sol", "agent")) fail("AGENT SOL key exists on this owner machine (custody violation)");
if (hasPrivateKey("sol", "submitter")) fail("SUBMITTER SOL key exists on this owner machine (custody violation)");
if (!hasPrivateKey("sol", "owner")) fail("OWNER SOL key absent on this machine");
const owner = loadSolKeypair("owner");
const expectedOwner = registryAddress("sol", "owner") ?? fail("registry missing owner address");
const agent = registryAddress("sol", "agent") ?? fail("registry missing agent address");
const submitter = registryAddress("sol", "submitter") ?? fail("registry missing submitter address");
if (owner.publicKey.toBase58() !== expectedOwner) {
  fail("OWNER local key does not match registry address");
}
console.log(`machine: ${kind}`);
console.log(`program: ${PROGRAM_ID.toBase58()}`);
console.log(`owner: ${owner.publicKey.toBase58()}`);
console.log(`agent: ${agent}`);
console.log(`allowlist: ${expectedOwner}, ${submitter}`);
console.log(`dailyCap: ${DAILY_CAP} lamports, perTxCap: ${PER_TX_CAP} lamports, fund: ${FUND} lamports`);
console.log(`rpc: ${RPC.replace(/api-key=[^&]*/g, "api-key=***")}`);
console.log("");

const connection = new Connection(RPC, "confirmed");
const [policy] = PublicKey.findProgramAddressSync([Buffer.from("policy")], PROGRAM_ID);
console.log(`policy PDA: ${policy.toBase58()}`);

const ownerBalance = await connection.getBalance(owner.publicKey);
console.log(`owner balance before: ${ownerBalance / LAMPORTS_PER_SOL} SOL`);
if (ownerBalance < FUND + BUFFER) {
  fail(`owner balance below fund + buffer (${(FUND + BUFFER) / LAMPORTS_PER_SOL} SOL)`);
}

function disc(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function u64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

// --- Initialize policy ---
const initData = Buffer.concat([
  disc("initialize"),
  new PublicKey(agent).toBuffer(),
  Buffer.from([2, 0, 0, 0]),
  new PublicKey(expectedOwner).toBuffer(),
  new PublicKey(submitter).toBuffer(),
  u64(DAILY_CAP),
  u64(PER_TX_CAP),
]);
const initIx = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: owner.publicKey, isSigner: true, isWritable: true },
    { pubkey: policy, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data: initData,
});
console.log("initializing policy...");
const initSig = await sendAndConfirmTransaction(
  connection,
  new Transaction().add(initIx),
  [owner],
  { commitment: "confirmed" },
);
console.log(`init tx: ${initSig}`);
const policyAfterInit = (await connection.getAccountInfo(policy)) ?? fail("policy account missing after init");
console.log(`policy account after init: ${policyAfterInit.lamports} lamports`);

// --- Fund policy ---
console.log(`funding policy with ${FUND} lamports...`);
const fundSig = await sendAndConfirmTransaction(
  connection,
  new Transaction().add(
    SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: policy, lamports: FUND }),
  ),
  [owner],
  { commitment: "confirmed" },
);
console.log(`fund tx: ${fundSig}`);
const policyBalance = await connection.getBalance(policy);
const ownerAfter = await connection.getBalance(owner.publicKey);
console.log(`policy balance: ${policyBalance} lamports`);
console.log(`owner balance after: ${ownerAfter / LAMPORTS_PER_SOL} SOL`);
console.log("");
console.log(`solana-init-policy: PASS :: policy=${policy.toBase58()} init=${initSig} fund=${fundSig}`);
console.log("NEXT: send the program ID + init tx to Muse for the devnet spend leg.");
