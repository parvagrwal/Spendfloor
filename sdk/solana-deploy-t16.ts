// solana-deploy-t16 (T16 Solana leg).
//
//   Run on the OWNER machine only, AFTER deploying the program:
//     SPENDFLOOR_SOL_PROGRAM_ID=<program-id> npx tsx sdk/solana-deploy-t16.ts
//
//   Program deploy (new program ID, since the T07 program keypair is lost;
//   the T07 program BWVM3J3... cannot be upgraded without it):
//     solana program deploy --url https://api.devnet.solana.com \
//       --keypair ~/.spendfloor-keys/sol-owner.json \
//       --program-id solana/target/deploy/spendfloor-keypair.json \
//       solana/target/deploy/spendfloor.so
//
// Creates one SPL SFUSD mint (authority = OWNER), one vault token account
// (owner = policy PDA), one merchant token account, initializes the policy
// PDA (demo/P0 config), and mints 100 SFUSD to the vault. The policy owner
// is the initializer (OWNER) and there is no ownership transfer, so this
// MUST run with the OWNER key. P1/P2 are policy configurations applied
// via set_policy in T17 (one program has one policy PDA, so they are not
// separate on-chain vaults on Solana; on EVM they are separate contracts).
//
// Demo/P0 policy (SFUSD, 6 decimals): per-tx 2, window 5, window 86,400 s,
// anchor = now, expiry = now + 86,400, recipients = {demo merchant}.
// evm_set_hash = SHA-256 over the 20-byte EVM merchant address.
// The demo merchant is receive-only; its keys are not stored anywhere.
// Confirmation uses HTTP polling (devnet WS confirmation is unreliable).
// This script NEVER prints key material.

import { createHash } from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
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
const EVM_MERCHANT = "0x61f1c99d674bcd333578AC4f538F46AbC7bB4106";
const SOL_MERCHANT = "8e6f1AWYV4unGiaoDciMkAXvPdUZvpNCtPK6pz2kmZhS";
const FUND = 100_000_000; // 100 SFUSD, 6 decimals
const VERSION = 1;
const DECIMALS = 6;
const PER_TX = 2_000_000;
const WINDOW = 5_000_000;
const WINDOW_SECONDS = 86400;

const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
const RENT_SYSVAR = new PublicKey(
  "SysvarRent111111111111111111111111111111111",
);
const MINT_LEN = 82;
const TOKEN_ACCOUNT_LEN = 165;

const fail = (msg: string): never => {
  console.log(`FAIL  ${msg}`);
  process.exit(1);
};

if (!PROGRAM_ID_RAW) fail("SPENDFLOOR_SOL_PROGRAM_ID is not set");
const PROGRAM_ID = new PublicKey(PROGRAM_ID_RAW as string);

// --- Custody pre-flight ---
const kind = machineKind();
if (kind !== "owner") {
  fail(`this machine is "${kind}", not "owner"; refusing to deploy`);
}
if (hasPrivateKey("sol", "agent")) {
  fail("AGENT SOL key exists on this owner machine (custody violation)");
}
if (hasPrivateKey("sol", "submitter")) {
  fail("SUBMITTER SOL key exists on this owner machine (custody violation)");
}
if (!hasPrivateKey("sol", "owner")) fail("OWNER SOL key absent on this machine");
const owner = loadSolKeypair("owner");
const expectedOwner = registryAddress("sol", "owner");
if (!expectedOwner) fail("registry missing owner address");
const agentAddr = registryAddress("sol", "agent");
if (!agentAddr) fail("registry missing agent address");
if (owner.publicKey.toBase58() !== expectedOwner) {
  fail("OWNER local key does not match registry address");
}
const agentPubkey = new PublicKey(agentAddr as string);
const merchantPubkey = new PublicKey(SOL_MERCHANT);
console.log(`program: ${PROGRAM_ID.toBase58()}`);
console.log(`owner: ${owner.publicKey.toBase58()}`);
console.log(`agent: ${agentAddr}`);
console.log(`merchant (SOL): ${SOL_MERCHANT}`);

const connection = new Connection(RPC, "confirmed");
const [policy] = PublicKey.findProgramAddressSync(
  [Buffer.from("policy")],
  PROGRAM_ID,
);
console.log(`policy PDA: ${policy.toBase58()}`);

const evmSetHash = createHash("sha256")
  .update(Buffer.from(EVM_MERCHANT.slice(2), "hex"))
  .digest();
console.log(`evmSetHash: 0x${evmSetHash.toString("hex")}`);

// --- HTTP-poll confirmation (devnet WS is unreliable) ---
async function sendAndConfirm(ixs: TransactionInstruction[], signers: Keypair[]): Promise<string> {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash();
  const tx = new Transaction({
    feePayer: owner.publicKey,
    blockhash,
    lastValidBlockHeight,
  });
  tx.add(...ixs);
  tx.sign(owner, ...signers);
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
  });
  for (let i = 0; i < 60; i++) {
    const st = await connection.getSignatureStatus(sig);
    const s = st.value;
    if (s && s.err) fail(`tx ${sig} failed: ${JSON.stringify(s.err)}`);
    if (s && s.confirmationStatus && s.confirmationStatus !== "processed") {
      return sig;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  fail(`tx ${sig} did not confirm in 60 s`);
  throw new Error("unreachable");
}

// --- 1. Create the SPL mint (authority = OWNER) ---
const mintKp = Keypair.generate();
const mintRent = await connection.getMinimumBalanceForRentExemption(MINT_LEN);
{
  const initMintData = Buffer.concat([
    Buffer.from([0]),
    Buffer.from([DECIMALS]),
    owner.publicKey.toBuffer(),
    Buffer.from([0]), // no freeze authority
  ]);
  const sig = await sendAndConfirm(
    [
      SystemProgram.createAccount({
        fromPubkey: owner.publicKey,
        newAccountPubkey: mintKp.publicKey,
        lamports: mintRent,
        space: MINT_LEN,
        programId: TOKEN_PROGRAM_ID,
      }),
      new TransactionInstruction({
        keys: [
          { pubkey: mintKp.publicKey, isSigner: false, isWritable: true },
          { pubkey: RENT_SYSVAR, isSigner: false, isWritable: false },
        ],
        programId: TOKEN_PROGRAM_ID,
        data: initMintData,
      }),
    ],
    [mintKp],
  );
  console.log(`mint: ${mintKp.publicKey.toBase58()} (tx ${sig})`);
}

// --- 2. Vault token account (owner = policy PDA) + merchant token account ---
async function createTokenAccount(ownerPubkey: PublicKey): Promise<PublicKey> {
  const acctKp = Keypair.generate();
  const rent = await connection.getMinimumBalanceForRentExemption(
    TOKEN_ACCOUNT_LEN,
  );
  const sig = await sendAndConfirm(
    [
      SystemProgram.createAccount({
        fromPubkey: owner.publicKey,
        newAccountPubkey: acctKp.publicKey,
        lamports: rent,
        space: TOKEN_ACCOUNT_LEN,
        programId: TOKEN_PROGRAM_ID,
      }),
      new TransactionInstruction({
        keys: [
          { pubkey: acctKp.publicKey, isSigner: false, isWritable: true },
          { pubkey: mintKp.publicKey, isSigner: false, isWritable: false },
          { pubkey: ownerPubkey, isSigner: false, isWritable: false },
          { pubkey: RENT_SYSVAR, isSigner: false, isWritable: false },
        ],
        programId: TOKEN_PROGRAM_ID,
        data: Buffer.from([1]),
      }),
    ],
    [acctKp],
  );
  console.log(`token account (owner ${ownerPubkey.toBase58()}): ${acctKp.publicKey.toBase58()} (tx ${sig})`);
  return acctKp.publicKey;
}
const vaultToken = await createTokenAccount(policy);
const merchantToken = await createTokenAccount(merchantPubkey);

// --- 3. Initialize the policy PDA (demo/P0) ---
function disc(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}
function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}
function u64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n), 0);
  return b;
}
function i64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n), 0);
  return b;
}
{
  const now = Math.floor(Date.now() / 1000);
  const data = Buffer.concat([
    disc("initialize"),
    u32(VERSION),
    Buffer.from([DECIMALS]),
    agentPubkey.toBuffer(),
    u64(PER_TX),
    u64(WINDOW),
    u64(WINDOW_SECONDS),
    i64(now),
    i64(now + 86400),
    u32(1),
    merchantPubkey.toBuffer(),
    evmSetHash,
    mintKp.publicKey.toBuffer(),
  ]);
  const sig = await sendAndConfirm(
    [
      new TransactionInstruction({
        keys: [
          { pubkey: owner.publicKey, isSigner: true, isWritable: true },
          { pubkey: policy, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        programId: PROGRAM_ID,
        data,
      }),
    ],
    [],
  );
  console.log(`policy initialized (tx ${sig})`);
}

// --- 4. Mint 100 SFUSD to the vault token account ---
{
  const mintToData = Buffer.concat([Buffer.from([7]), u64(FUND)]);
  const sig = await sendAndConfirm(
    [
      new TransactionInstruction({
        keys: [
          { pubkey: mintKp.publicKey, isSigner: false, isWritable: true },
          { pubkey: vaultToken, isSigner: false, isWritable: true },
          { pubkey: owner.publicKey, isSigner: true, isWritable: false },
        ],
        programId: TOKEN_PROGRAM_ID,
        data: mintToData,
      }),
    ],
    [],
  );
  console.log(`minted 100 SFUSD to vault token account (tx ${sig})`);
}

console.log("OK  T16 Solana deploy complete");
