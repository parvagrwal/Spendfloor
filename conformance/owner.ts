// owner (T17 owner steps + reset, for Parv's machine).
//
// The owner key lives ONLY on Parv's machine (custody). This script
// runs the owner-only steps that the T17 testnet run cannot do from
// the agent machine (my VM): freeze/unfreeze, set_policy, and the
// final reset that restores the demo vaults for T27.
//
// Usage (from ~/spendfloor, after extracting this file):
//   npx tsx conformance/owner.ts evm-freeze
//   npx tsx conformance/owner.ts evm-unfreeze
//   npx tsx conformance/owner.ts evm-reset
//   npx tsx conformance/owner.ts sol-freeze
//   npx tsx conformance/owner.ts sol-unfreeze
//   npx tsx conformance/owner.ts sol-set-window
//   npx tsx conformance/owner.ts sol-set-expiry
//   npx tsx conformance/owner.ts sol-reset
//
// EVM vault (demo): 0x8d13a6a31518b357a480659073b9db78ab861809
// SOL program: CQfuniyvMY9sPDAFMPRZzbpHEwRiyy3Y4BsfuQd3iAbE
// SOL policy PDA: 5MUi1eZAfjaCukRDZNntAMJCr5Xz6gCRJ9s7D2iJyfuE
// SOL merchant (recipient): 8e6f1AWYV4unGiaoDciMkAXvPdUZvpNCtPK6pz2kmZhS
// SOL mint: ESB1d6WUnz6e9yRmC9hv8MrHHzrQs8eFSV6aosDHNt2U
// EVM merchant (recipient): 0x61f1c99d674bcd333578AC4f538F46AbC7bB4106

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
  type Abi,
  type Address,
  type Hash,
  type PublicClient,
} from "viem";
import { baseSepolia, foundry } from "viem/chains";
import { loadEvmAccount, loadSolKeypair } from "../sdk/keys.js";
import { readEvmPolicy } from "../sdk/evm.js";
import { discriminator, readSolPolicy } from "../sdk/sol.js";

const here = dirname(fileURLToPath(import.meta.url));
// Same chain pattern as sdk/deploy-t16.ts (union type): plain
// baseSepolia trips a viem generic mismatch between the public and
// wallet clients' Block types.
const CHAIN = process.env.SPENDFLOOR_LOCALNET === "1" ? foundry : baseSepolia;
const EVM_VAULT = "0x8d13a6a31518b357a480659073b9db78ab861809" as Address;
const EVM_MERCHANT = "0x61f1c99d674bcd333578AC4f538F46AbC7bB4106" as Address;
const SOL_PROGRAM = new PublicKey("CQfuniyvMY9sPDAFMPRZzbpHEwRiyy3Y4BsfuQd3iAbE");
const SOL_POLICY = new PublicKey("5MUi1eZAfjaCukRDZNntAMJCr5Xz6gCRJ9s7D2iJyfuE");
const SOL_MERCHANT = new PublicKey("8e6f1AWYV4unGiaoDciMkAXvPdUZvpNCtPK6pz2kmZhS");
const SOL_MINT = new PublicKey("ESB1d6WUnz6e9yRmC9hv8MrHHzrQs8eFSV6aosDHNt2U");

const cmd = process.argv[2];
if (!cmd) {
  console.log("usage: npx tsx conformance/owner.ts <evm-freeze|evm-unfreeze|evm-reset|sol-freeze|sol-unfreeze|sol-set-window|sol-set-expiry|sol-reset>");
  process.exit(1);
}

async function sendSolAndConfirm(conn: Connection, tx: Transaction, signers: Keypair[]): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  for (let i = 0; i < 60; i++) {
    const st = await conn.getSignatureStatus(sig);
    const s = st.value;
    if (s && s.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(s.err)}`);
    if (s && s.confirmationStatus && s.confirmationStatus !== "processed") return sig;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`tx ${sig} did not confirm in 60 s`);
}

function u32le(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v, 0);
  return b;
}
function u64le(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v, 0);
  return b;
}
function i64le(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(v, 0);
  return b;
}

async function evmSetFrozen(frozen: boolean) {
  const evmDir = join(here, "..", "evm");
  const forgeBin = process.env.HOME && (await import("node:fs")).existsSync(`${process.env.HOME}/.foundry/bin/forge`)
    ? `${process.env.HOME}/.foundry/bin/forge`
    : "forge";
  execSync(`${forgeBin} build`, { cwd: evmDir, stdio: "ignore" });
  const artifact = JSON.parse(readFileSync(join(evmDir, "out", "SpendFloorVault.sol", "SpendFloorVault.json"), "utf8"));
  const pub = createPublicClient({ chain: CHAIN, transport: http("https://sepolia.base.org") });
  const ownerAcc = loadEvmAccount("owner");
  const owner = createWalletClient({ account: ownerAcc, chain: CHAIN, transport: http("https://sepolia.base.org") });
  const h = await owner.writeContract({ account: ownerAcc, chain: CHAIN, address: EVM_VAULT, abi: artifact.abi as Abi, functionName: "setFrozen", args: [frozen] });
  const r = await pub.waitForTransactionReceipt({ hash: h });
  console.log(`evm setFrozen(${frozen}): status=${r.status} hash=${h}`);
}

async function evmReset() {
  const evmDir = join(here, "..", "evm");
  const forgeBin = process.env.HOME && (await import("node:fs")).existsSync(`${process.env.HOME}/.foundry/bin/forge`)
    ? `${process.env.HOME}/.foundry/bin/forge`
    : "forge";
  execSync(`${forgeBin} build`, { cwd: evmDir, stdio: "ignore" });
  const artifact = JSON.parse(readFileSync(join(evmDir, "out", "SpendFloorVault.sol", "SpendFloorVault.json"), "utf8"));
  const pub = createPublicClient({ chain: CHAIN, transport: http("https://sepolia.base.org") });
  const ownerAcc = loadEvmAccount("owner");
  const owner = createWalletClient({ account: ownerAcc, chain: CHAIN, transport: http("https://sepolia.base.org") });
  const pol = await readEvmPolicy(pub as unknown as PublicClient, EVM_VAULT);
  // Anchor = wall-clock now (the vault's window is anchored at this
  // timestamp; a few seconds of skew vs block time is immaterial).
  const now = BigInt(Math.floor(Date.now() / 1000));
  // FORCE a new window: setPolicy does NOT reset spent by itself;
  // spent only resets when the window index changes on a spend. So
  // anchor 2 windows before now, guaranteeing the new index
  // (stored + 2, or +1 with clock skew) differs from the stored
  // currentWindow, so the next spend resets spent to 0. Without this,
  // a reset with anchor=now leaves the index unchanged (0 == 0) and
  // the vault stays full (spent 5) — the T17 post-reset finding.
  const anchor = now - (pol.currentWindow + 2n) * pol.windowSeconds;
  // The EVM policy view does not return the recipient list (only the
  // hash), so the reset re-uses the demo merchant (unchanged since T16).
  const h = await owner.writeContract({
    account: ownerAcc, chain: CHAIN, address: EVM_VAULT, abi: artifact.abi as Abi, functionName: "setPolicy",
    args: [pol.version, pol.decimals, pol.perTxMax, pol.windowMax, pol.windowSeconds, anchor, now + 86400n, [EVM_MERCHANT], pol.solSetHash as Hash],
  });
  const r = await pub.waitForTransactionReceipt({ hash: h });
  console.log(`evm reset (new anchor ${anchor}): status=${r.status} hash=${h}`);
}

async function solIx(ownerKp: Keypair, data: Buffer): Promise<string> {
  const conn = new Connection("https://api.devnet.solana.com", "confirmed");
  const ix = new TransactionInstruction({
    keys: [
      { pubkey: ownerKp.publicKey, isSigner: true, isWritable: true },
      { pubkey: SOL_POLICY, isSigner: false, isWritable: true },
    ],
    programId: SOL_PROGRAM,
    data,
  });
  const tx = new Transaction({ feePayer: ownerKp.publicKey }).add(ix);
  return sendSolAndConfirm(conn, tx, [ownerKp]);
}

async function solSetFrozen(frozen: boolean) {
  const ownerKp = loadSolKeypair("owner");
  const data = Buffer.concat([discriminator("set_frozen"), Buffer.from([frozen ? 1 : 0])]);
  const sig = await solIx(ownerKp, data);
  console.log(`sol set_frozen(${frozen}): sig=${sig}`);
}

async function solSetPolicy(windowSecs: bigint, expiry: bigint) {
  const ownerKp = loadSolKeypair("owner");
  const conn = new Connection("https://api.devnet.solana.com", "confirmed");
  const pol = await readSolPolicy(conn, SOL_PROGRAM);
  // Preserve the policy's caps/recipients/evm hash; only the window,
  // anchor, and expiry change. Anchor = now.
  const now = BigInt(Math.floor(Date.now() / 1000));
  const recipients = pol.recipients.length > 0 ? pol.recipients : [SOL_MERCHANT];
  const evmHashBytes = Buffer.from(pol.evmSetHash);
  let data = Buffer.concat([discriminator("set_policy")]);
  data = Buffer.concat([data, u32le(pol.version), Buffer.from([pol.decimals]), u64le(pol.perTxMax), u64le(pol.windowMax), u64le(windowSecs), i64le(now), i64le(expiry)]);
  data = Buffer.concat([data, u32le(recipients.length)]);
  for (const r of recipients) {
    data = Buffer.concat([data, r.toBuffer()]);
  }
  data = Buffer.concat([data, evmHashBytes]);
  const sig = await solIx(ownerKp, data);
  console.log(`sol set_policy window=${windowSecs} expiry=${expiry} anchor=${now}: sig=${sig}`);
}

async function main() {
  if (cmd === "evm-freeze") await evmSetFrozen(true);
  else if (cmd === "evm-unfreeze") await evmSetFrozen(false);
  else if (cmd === "evm-reset") await evmReset();
  else if (cmd === "sol-freeze") await solSetFrozen(true);
  else if (cmd === "sol-unfreeze") await solSetFrozen(false);
  else if (cmd === "sol-set-window") {
    // V15: a fresh 300 s window with a live session (expiry +24 h, so
    // the spends ACCEPT). Expiry 0 would mean already-expired (now >= 0).
    const now = BigInt(Math.floor(Date.now() / 1000));
    await solSetPolicy(300n, now + 86400n);
  }
  else if (cmd === "sol-set-expiry") {
    const now = BigInt(Math.floor(Date.now() / 1000));
    await solSetPolicy(86400n, now + 180n);
  } else if (cmd === "sol-reset") {
    const now = BigInt(Math.floor(Date.now() / 1000));
    await solSetPolicy(86400n, now + 86400n);
  } else {
    console.log(`unknown command: ${cmd}`);
    process.exit(1);
  }
}

main().catch((err) => { console.error(`FAIL ${err instanceof Error ? err.message : String(err)}`); process.exit(1); });
