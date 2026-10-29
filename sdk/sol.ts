// Solana side of the SpendFloor SDK (T15).
//
// Roles are separate arguments, never one key: the agent signs the
// spend instruction, the submitter pays fees. The agent key is never
// the fee payer and never holds funds.
//
// Forced landing: every submit skips preflight simulation, so a policy
// failure lands on-chain (meta.err) instead of being rejected before
// broadcast with no signature. Confirmation polls getSignatureStatus
// over HTTP, never WebSocket (the devnet WS path is unreliable; see
// T07). A landed failure is decoded from meta.err (program Custom
// code) or the logs into a normalized label, so it returns
// { label, signature }, not a raw RPC error.

import { createHash } from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { SOL_ERROR_CODES, type SpendLabel, type SpendResult } from "./errors.js";

export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

export interface SolPolicyState {
  owner: PublicKey;
  agent: PublicKey;
  version: number;
  decimals: number;
  perTxMax: bigint;
  windowMax: bigint;
  windowSeconds: bigint;
  windowAnchor: bigint;
  expiresAt: bigint;
  recipients: PublicKey[];
  evmSetHash: Uint8Array;
  policyHash: Uint8Array;
  frozen: boolean;
  window: bigint;
  spent: bigint;
  bump: number;
  mint: PublicKey;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Anchor discriminator: first 8 bytes of SHA-256("global:<name>"). */
export function discriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

/** Policy PDA: seeds [b"policy"] under the program id. */
export function policyPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("policy")], programId);
}

/**
 * Build the spend instruction. Account order must match the program's
 * Spend context: policy, vault_token, dest_token, agent, token_program.
 * Data: discriminator + amount u64 little-endian.
 */
export function buildSpendInstruction(
  programId: PublicKey,
  policy: PublicKey,
  vaultToken: PublicKey,
  destToken: PublicKey,
  agent: PublicKey,
  amount: bigint,
): TransactionInstruction {
  const data = Buffer.alloc(16);
  discriminator("spend").copy(data, 0);
  data.writeBigUInt64LE(amount, 8);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: policy, isSigner: false, isWritable: true },
      { pubkey: vaultToken, isSigner: false, isWritable: true },
      { pubkey: destToken, isSigner: false, isWritable: true },
      { pubkey: agent, isSigner: true, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/** Poll getSignatureStatus over HTTP until confirmed/finalized or timeout. */
async function waitForSignature(
  connection: Connection,
  signature: string,
  timeoutMs = 60_000,
): Promise<{ err: unknown; logs: string[] } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = await connection.getSignatureStatus(signature).catch(() => null);
    const value = st?.value;
    if (value?.confirmationStatus === "confirmed" || value?.confirmationStatus === "finalized") {
      const tx = await connection.getTransaction(signature, { commitment: "confirmed" }).catch(() => null);
      return { err: value.err, logs: tx?.meta?.logMessages ?? [] };
    }
    if (value?.err) {
      const tx = await connection.getTransaction(signature, { commitment: "confirmed" }).catch(() => null);
      return { err: value.err, logs: tx?.meta?.logMessages ?? [] };
    }
    await sleep(1000);
  }
  return null;
}

/** Map a confirmed transaction's error to a normalized label. */
function labelFromSolErr(err: unknown, logs: string[]): SpendLabel {
  // meta.err shape: { InstructionError: [index, { Custom: code }] }.
  try {
    const e = err as { InstructionError?: [number, { Custom?: number }] };
    const code = e?.InstructionError?.[1]?.Custom;
    if (typeof code === "number" && SOL_ERROR_CODES[code]) return SOL_ERROR_CODES[code];
  } catch {
    // Fall through to the log scan.
  }
  for (const line of logs) {
    const m = line.match(/Custom program error: 0x([0-9a-fA-F]+)/) ?? line.match(/"Custom":\s*(\d+)/);
    if (m) {
      const code = parseInt(m[1], m[1].startsWith("0x") || /^[0-9a-fA-F]+$/.test(m[1]) && m[1].length > 4 ? 16 : 10);
      if (SOL_ERROR_CODES[code]) return SOL_ERROR_CODES[code];
    }
    const anchor = line.match(/Error Code: (\w+)/);
    if (anchor) {
      const names: Record<string, SpendLabel> = {
        Unauthorized: "Unauthorized",
        Frozen: "Frozen",
        ZeroAmount: "ZeroAmount",
        RecipientNotAllowed: "RecipientNotAllowed",
        DailyCapExceeded: "DailyCapExceeded",
        PerTxCapExceeded: "PerTxCapExceeded",
        InvalidAgent: "InvalidAgent",
        InvalidPolicy: "InvalidPolicy",
        NotOwner: "NotOwner",
        InsufficientFunds: "InsufficientFunds",
        SessionExpired: "SessionExpired",
        InvalidAccounts: "InvalidAccounts",
      };
      if (names[anchor[1]]) return names[anchor[1]];
    }
  }
  return "Reverted";
}

/**
 * Agent signs the spend, submitter pays. Returns { ok, hash } on a
 * landed success, or { ok: false, label, hash } on a landed failure.
 * A send that never broadcasts returns SubmitFailed with no hash; a
 * broadcast that never confirms in time returns Timeout with the
 * signature, so the caller can check it later.
 */
export async function submitSolSpend(
  connection: Connection,
  programId: PublicKey,
  policy: PublicKey,
  vaultToken: PublicKey,
  destToken: PublicKey,
  agent: Keypair,
  submitter: Keypair,
  amount: bigint,
  opts: { timeoutMs?: number } = {},
): Promise<SpendResult> {
  const ix = buildSpendInstruction(programId, policy, vaultToken, destToken, agent.publicKey, amount);
  const tx = new Transaction().add(ix);
  tx.feePayer = submitter.publicKey;
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.sign(agent, submitter);
  let signature: string;
  try {
    signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  } catch (err) {
    return { ok: false, label: "SubmitFailed", raw: err instanceof Error ? err.message : String(err) };
  }
  const landed = await waitForSignature(connection, signature, opts.timeoutMs);
  if (!landed) return { ok: false, label: "Timeout", hash: signature };
  if (!landed.err) return { ok: true, hash: signature };
  return { ok: false, label: labelFromSolErr(landed.err, landed.logs), hash: signature };
}

/** Parse a policy account (Borsh layout; offsets match the program). */
export function parsePolicyAccount(data: Buffer): SolPolicyState {
  let off = 8;
  const readPubkey = () => {
    const k = new PublicKey(data.subarray(off, off + 32));
    off += 32;
    return k;
  };
  const readU64 = () => {
    const v = data.readBigUInt64LE(off);
    off += 8;
    return v;
  };
  const readI64 = () => {
    const v = data.readBigInt64LE(off);
    off += 8;
    return v;
  };
  const owner = readPubkey();
  const agent = readPubkey();
  const version = data.readUInt32LE(off);
  off += 4;
  const decimals = data[off];
  off += 1;
  const perTxMax = readU64();
  const windowMax = readU64();
  const windowSeconds = readU64();
  const windowAnchor = readI64();
  const expiresAt = readI64();
  const nRecipients = data.readUInt32LE(off);
  off += 4;
  const recipients: PublicKey[] = [];
  for (let i = 0; i < nRecipients; i++) recipients.push(readPubkey());
  const evmSetHash = new Uint8Array(data.subarray(off, off + 32));
  off += 32;
  const policyHash = new Uint8Array(data.subarray(off, off + 32));
  off += 32;
  const frozen = data[off] !== 0;
  off += 1;
  const window = readU64();
  const spent = readU64();
  const bump = data[off];
  off += 1;
  const mint = readPubkey();
  return {
    owner, agent, version, decimals, perTxMax, windowMax, windowSeconds,
    windowAnchor, expiresAt, recipients, evmSetHash, policyHash, frozen,
    window, spent, bump, mint,
  };
}

/** Read the policy account + a token account's balance. */
export async function readSolPolicy(
  connection: Connection,
  programId: PublicKey,
): Promise<SolPolicyState> {
  const [policy] = policyPda(programId);
  const info = await connection.getAccountInfo(policy);
  if (!info) throw new Error("policy account not found");
  return parsePolicyAccount(info.data as Buffer);
}

export { SystemProgram };
