// sol-v12 (T17 SOL V12, standalone).
//
// The agent attempts the four owner instructions (set_policy,
// set_agent, set_frozen, withdraw) with itself as the ix signer.
// Each must revert with NotOwner (6008). The fee payer is the
// SUBMITTER (the agent holds 0 SOL by design, so it cannot pay its
// own fee); the fee payer does not affect the program's owner check,
// which compares the ix's owner account to the policy owner.
//
// Usage: npx tsx conformance/sol-v12.ts
// Appends the V12 result to evidence/T17/post-reset.json.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { loadSolKeypair } from "../sdk/keys.js";
import { discriminator, readSolPolicy } from "../sdk/sol.js";
import { solConnection } from "../agent/pay.js";

const here = dirname(fileURLToPath(import.meta.url));
const SOL_PROGRAM = new PublicKey("CQfuniyvMY9sPDAFMPRZzbpHEwRiyy3Y4BsfuQd3iAbE");
const SOL_POLICY = new PublicKey("5MUi1eZAfjaCukRDZNntAMJCr5Xz6gCRJ9s7D2iJyfuE");
const SOL_VAULT_TOKEN = new PublicKey("GhanJGGQhwhSL9q1Uvsy7MopiA2aDH7QERmrvqz1xn6N");
const SOL_MERCHANT_TOKEN = new PublicKey("GiKhKyYKuMQjJZrMLmRxhggrzRPkDrwLEAbr7SuUcnMV");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

function u32le(v: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(v, 0); return b; }
function u64le(v: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(v, 0); return b; }
function i64le(v: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigInt64LE(v, 0); return b; }

async function sendAndConfirm(conn: Connection, tx: Transaction, signers: Keypair[]): Promise<{ sig: string; err: unknown }> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  for (let i = 0; i < 60; i++) {
    const st = await conn.getSignatureStatus(sig);
    const s = st.value;
    if (s && s.err) return { sig, err: s.err };
    if (s && s.confirmationStatus && s.confirmationStatus !== "processed") return { sig, err: null };
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`tx ${sig} did not confirm in 60 s`);
}

async function main() {
  const conn = solConnection();
  const agentKp = loadSolKeypair("agent");
  const submitterKp = loadSolKeypair("submitter");
  const solPol = await readSolPolicy(conn, SOL_PROGRAM);
  const evmHashBytes = Buffer.from(solPol.evmSetHash);
  const policyArgs = Buffer.concat([
    u32le(solPol.version), Buffer.from([solPol.decimals]), u64le(solPol.perTxMax), u64le(solPol.windowMax),
    u64le(solPol.windowSeconds), i64le(solPol.windowAnchor), i64le(solPol.expiresAt),
    u32le(solPol.recipients.length), ...solPol.recipients.map((r) => r.toBuffer()), evmHashBytes,
  ]);
  const ownerKeys = (ix: TransactionInstruction) => ix;
  const attempts: { name: string; ix: TransactionInstruction }[] = [
    { name: "set_policy", ix: ownerKeys(new TransactionInstruction({ keys: [{ pubkey: agentKp.publicKey, isSigner: true, isWritable: true }, { pubkey: SOL_POLICY, isSigner: false, isWritable: true }], programId: SOL_PROGRAM, data: Buffer.concat([discriminator("set_policy"), policyArgs]) })) },
    { name: "set_agent", ix: ownerKeys(new TransactionInstruction({ keys: [{ pubkey: agentKp.publicKey, isSigner: true, isWritable: true }, { pubkey: SOL_POLICY, isSigner: false, isWritable: true }], programId: SOL_PROGRAM, data: Buffer.concat([discriminator("set_agent"), agentKp.publicKey.toBuffer()]) })) },
    { name: "set_frozen", ix: ownerKeys(new TransactionInstruction({ keys: [{ pubkey: agentKp.publicKey, isSigner: true, isWritable: true }, { pubkey: SOL_POLICY, isSigner: false, isWritable: true }], programId: SOL_PROGRAM, data: Buffer.concat([discriminator("set_frozen"), Buffer.from([1])]) })) },
    { name: "withdraw", ix: ownerKeys(new TransactionInstruction({ keys: [{ pubkey: agentKp.publicKey, isSigner: true, isWritable: true }, { pubkey: SOL_POLICY, isSigner: false, isWritable: true }, { pubkey: SOL_VAULT_TOKEN, isSigner: false, isWritable: true }, { pubkey: SOL_MERCHANT_TOKEN, isSigner: false, isWritable: true }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }], programId: SOL_PROGRAM, data: Buffer.concat([discriminator("withdraw"), u64le(1n)]) })) },
  ];
  let notOwnerCount = 0;
  const sigs: string[] = [];
  for (const a of attempts) {
    // Fee payer = submitter (agent holds 0 SOL); ix signer = agent.
    const t = new Transaction({ feePayer: submitterKp.publicKey }).add(a.ix);
    const { sig, err } = await sendAndConfirm(conn, t, [agentKp, submitterKp]);
    sigs.push(sig);
    const errStr = JSON.stringify(err);
    if (errStr.includes("6008")) notOwnerCount++;
    console.log(`SOL V12 ${a.name}: sig=${sig} err=${errStr}`);
  }
  const pass = notOwnerCount === 4;
  console.log(`SOL V12: expected=NotOwner actual=${pass ? "NotOwner" : "other"} ${pass ? "PASS" : "FAIL"} (${notOwnerCount}/4 returned 6008)`);
  const outPath = join(here, "..", "evidence", "T17", "post-reset.json");
  const data = JSON.parse(readFileSync(outPath, "utf8"));
  data.results.push({ chain: "SOL", vector: "V12", expected: "NotOwner", actual: pass ? "NotOwner" : "other", hash: null, pass, note: `${notOwnerCount}/4 attempts returned 6008 (sigs ${sigs.join(",")}); fee payer submitter, ix signer agent` });
  writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(`post-reset.json updated: ${data.results.length} entries`);
}

main().catch((err) => { console.error(`FAIL ${err instanceof Error ? err.message : String(err)}`); process.exit(1); });
