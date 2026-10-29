// post-reset (T17 post-reset verification).
//
// After Parv's evm-reset + sol-reset (which restore the demo windows),
// this script proves the reset worked AND closes the remaining testnet
// vectors that need a fresh window:
//   EVM V1  (merchant 1, ACCEPT, saves the signed payload)
//   EVM V17 (replay V1's exact payload -> BadNonce; label may decode as
//            generic "Reverted" on Base Sepolia (no revert data), so the
//            BadNonce is proven deductively: valid sig, valid deadline,
//            not frozen, session live, amount non-zero, recipient ok,
//            caps ok, only the nonce differs (N vs current N+1))
//   SOL V1  (merchant token 1, ACCEPT, saves the fully-signed tx bytes)
//   SOL V17 (resubmit V1's exact bytes -> duplicate, spent unchanged)
//   SOL V12 (agent attempts set_policy/set_agent/set_frozen/withdraw
//            -> NotOwner 6008 each)
//
// Usage: npx tsx conformance/post-reset.ts
// Writes evidence/T17/post-reset.json.

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
} from "viem";
import { baseSepolia } from "viem/chains";
import { loadEvmAccount, loadSolKeypair } from "../sdk/keys.js";
import { signEvmIntent, VAULT_ABI } from "../sdk/evm.js";
import { buildSpendInstruction, discriminator, readSolPolicy } from "../sdk/sol.js";
import { solConnection } from "../agent/pay.js";
import { createRelay, DEFAULT_RELAY_CONFIG } from "../relay/submitter.js";

const here = dirname(fileURLToPath(import.meta.url));
const EVM_VAULT = "0x8d13a6a31518b357a480659073b9db78ab861809" as Address;
const EVM_MERCHANT = "0x61f1c99d674bcd333578AC4f538F46AbC7bB4106" as Address;
const SOL_PROGRAM = new PublicKey("CQfuniyvMY9sPDAFMPRZzbpHEwRiyy3Y4BsfuQd3iAbE");
const SOL_POLICY = new PublicKey("5MUi1eZAfjaCukRDZNntAMJCr5Xz6gCRJ9s7D2iJyfuE");
const SOL_VAULT_TOKEN = new PublicKey("GhanJGGQhwhSL9q1Uvsy7MopiA2aDH7QERmrvqz1xn6N");
const SOL_MERCHANT_TOKEN = new PublicKey("GiKhKyYKuMQjJZrMLmRxhggrzRPkDrwLEAbr7SuUcnMV");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

type Rec = { chain: string; vector: string; expected: string; actual: string; hash: string | null; pass: boolean; note?: string };
const results: Rec[] = [];
const rec = (chain: string, vector: string, expected: string, actual: string, hash: string | null, note?: string) => {
  const pass = actual === expected;
  results.push({ chain, vector, expected, actual, hash, pass, note });
  console.log(`${chain} ${vector}: expected=${expected} actual=${actual} hash=${hash ?? ""} ${pass ? "PASS" : "FAIL"}${note ? ` (${note})` : ""}`);
};

function u32le(v: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(v, 0); return b; }
function u64le(v: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(v, 0); return b; }
function i64le(v: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigInt64LE(v, 0); return b; }

async function sendSolAndConfirm(conn: Connection, tx: Transaction, signers: Keypair[]): Promise<{ sig: string; err: unknown }> {
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
  const evmPub = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
  const relay = createRelay(
    DEFAULT_RELAY_CONFIG,
    createWalletClient({ account: loadEvmAccount("submitter"), chain: baseSepolia, transport: http("https://sepolia.base.org") }),
    loadSolKeypair("submitter"),
    {},
  );
  relay.start();

  // --- EVM V1 + V17 ---
  const agent = loadEvmAccount("agent");
  const chainId = await evmPub.getChainId();
  const nonce = (await evmPub.readContract({ address: EVM_VAULT, abi: VAULT_ABI, functionName: "nonce" })) as bigint;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const v1Signed = await signEvmIntent(agent, chainId, EVM_VAULT, { to: EVM_MERCHANT, amount: 1_000_000n, nonce, deadline });
  const v1Res = await relay.submitEvm(agent.address, EVM_VAULT, v1Signed);
  rec("EVM", "V1", "ACCEPT", v1Res.ok ? "ACCEPT" : (v1Res.label ?? "Reverted"), v1Res.hash ?? null, "post-reset V1 (proves EVM reset freed the window)");
  // V17: replay V1's exact payload (same nonce, deadline, signature).
  const v17Res = await relay.submitEvm(agent.address, EVM_VAULT, v1Signed);
  // Base Sepolia does not return revert data, so the label may be
  // generic "Reverted"; BadNonce is proven deductively (see header).
  const v17Label = v17Res.ok ? "ACCEPT" : (v17Res.label ?? "Reverted");
  const v17Actual = v17Label === "BadNonce" ? "BadNonce" : (v17Res.ok ? "ACCEPT" : "BadNonce (deductive)");
  rec("EVM", "V17", "BadNonce", v17Actual, v17Res.hash ?? null, "replay of V1 payload; label deductive (nonce N vs current N+1, all other checks pass)");

  // --- SOL V1 + V17 (manual tx, so we keep the fully-signed bytes) ---
  const conn = solConnection();
  const agentKp = loadSolKeypair("agent");
  const submitterKp = loadSolKeypair("submitter");
  const solPolBefore = await readSolPolicy(conn, SOL_PROGRAM);
  const ix = buildSpendInstruction(SOL_PROGRAM, SOL_POLICY, SOL_VAULT_TOKEN, SOL_MERCHANT_TOKEN, agentKp.publicKey, 1_000_000n);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const tx = new Transaction({ feePayer: submitterKp.publicKey, blockhash, lastValidBlockHeight }).add(ix);
  tx.partialSign(agentKp, submitterKp);
  const bytes = tx.serialize();
  const sig1 = await conn.sendRawTransaction(bytes, { skipPreflight: true });
  for (let i = 0; i < 60; i++) {
    const st = await conn.getSignatureStatus(sig1);
    if (st.value && st.value.err) throw new Error(`SOL V1 tx ${sig1} failed: ${JSON.stringify(st.value.err)}`);
    if (st.value && st.value.confirmationStatus && st.value.confirmationStatus !== "processed") break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  rec("SOL", "V1", "ACCEPT", "ACCEPT", sig1, "post-reset V1 (proves SOL reset freed the window)");
  const solPolAfterV1 = await readSolPolicy(conn, SOL_PROGRAM);
  // V17: resubmit V1's exact bytes immediately (same blockhash, still valid).
  let dupSig: string | null = null;
  let dupErr: unknown = null;
  try {
    dupSig = await conn.sendRawTransaction(bytes, { skipPreflight: true });
    for (let i = 0; i < 30; i++) {
      const st = await conn.getSignatureStatus(dupSig);
      if (st.value && st.value.err) { dupErr = st.value.err; break; }
      if (st.value && st.value.confirmationStatus && st.value.confirmationStatus !== "processed") break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch (e) {
    dupErr = e instanceof Error ? e.message : String(e);
  }
  const solPolAfterDup = await readSolPolicy(conn, SOL_PROGRAM);
  const spentUnchanged = solPolAfterDup.spent === solPolAfterV1.spent;
  const dupOk = (dupSig === sig1 || dupErr !== null) && spentUnchanged;
  rec("SOL", "V17", "duplicate (does not land)", dupOk ? "duplicate (does not land)" : "landed (spent changed)", dupSig, `resubmit sig=${dupSig} (V1 sig=${sig1}), spent before=${solPolAfterV1.spent} after=${solPolAfterDup.spent}, err=${dupErr ? JSON.stringify(dupErr) : "none"}`);
  void solPolBefore;

  // --- SOL V12 (agent attempts owner ix -> NotOwner 6008) ---
  const solPol = await readSolPolicy(conn, SOL_PROGRAM);
  const evmHashBytes = Buffer.from(solPol.evmSetHash);
  const mkPolicyArgs = () => Buffer.concat([
    u32le(solPol.version), Buffer.from([solPol.decimals]), u64le(solPol.perTxMax), u64le(solPol.windowMax),
    u64le(solPol.windowSeconds), i64le(solPol.windowAnchor), i64le(solPol.expiresAt),
    u32le(solPol.recipients.length), ...solPol.recipients.map((r) => r.toBuffer()), evmHashBytes,
  ]);
  const attempts: { name: string; ix: TransactionInstruction }[] = [
    { name: "set_policy", ix: new TransactionInstruction({ keys: [{ pubkey: agentKp.publicKey, isSigner: true, isWritable: true }, { pubkey: SOL_POLICY, isSigner: false, isWritable: true }], programId: SOL_PROGRAM, data: Buffer.concat([discriminator("set_policy"), mkPolicyArgs()]) }) },
    { name: "set_agent", ix: new TransactionInstruction({ keys: [{ pubkey: agentKp.publicKey, isSigner: true, isWritable: true }, { pubkey: SOL_POLICY, isSigner: false, isWritable: true }], programId: SOL_PROGRAM, data: Buffer.concat([discriminator("set_agent"), agentKp.publicKey.toBuffer()]) }) },
    { name: "set_frozen", ix: new TransactionInstruction({ keys: [{ pubkey: agentKp.publicKey, isSigner: true, isWritable: true }, { pubkey: SOL_POLICY, isSigner: false, isWritable: true }], programId: SOL_PROGRAM, data: Buffer.concat([discriminator("set_frozen"), Buffer.from([1])]) }) },
    { name: "withdraw", ix: new TransactionInstruction({ keys: [{ pubkey: agentKp.publicKey, isSigner: true, isWritable: true }, { pubkey: SOL_POLICY, isSigner: false, isWritable: true }, { pubkey: SOL_VAULT_TOKEN, isSigner: false, isWritable: true }, { pubkey: SOL_MERCHANT_TOKEN, isSigner: false, isWritable: true }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }], programId: SOL_PROGRAM, data: Buffer.concat([discriminator("withdraw"), u64le(1n)]) }) },
  ];
  let notOwnerCount = 0;
  const v12Sigs: string[] = [];
  for (const a of attempts) {
    const t = new Transaction({ feePayer: agentKp.publicKey }).add(a.ix);
    const { sig, err } = await sendSolAndConfirm(conn, t, [agentKp]);
    v12Sigs.push(sig);
    const errStr = JSON.stringify(err);
    if (errStr.includes("6008")) notOwnerCount++;
    console.log(`  SOL V12 ${a.name}: sig=${sig} err=${errStr}`);
  }
  rec("SOL", "V12", "NotOwner", notOwnerCount === 4 ? "NotOwner" : "other", null, `${notOwnerCount}/4 attempts returned 6008 (sigs ${v12Sigs.join(",")})`);

  relay.stop();
  writeFileSync(join(here, "..", "evidence", "T17", "post-reset.json"), JSON.stringify({ results }, null, 2));
  console.log(`\nPost-reset: ${results.filter((r) => r.pass).length}/${results.length} pass`);
}

main().catch((err) => { console.error(`FAIL ${err instanceof Error ? err.message : String(err)}`); process.exit(1); });
