// solana-localnet-setup (T26, LOCALNET ONLY).
//
// Sets up the SpendFloor Solana leg on a local Surfpool network
// (http://127.0.0.1:8899): creates a local SFUSD mint, a vault token
// account (owner = policy PDA), a merchant token account, initializes
// the policy PDA (demo/P0: perTx 2, window 5, 86400 s, merchant only),
// and mints 100 SFUSD to the vault. Writes deployments/localnet.json.
//
// LOCALNET ONLY — this script deliberately does NOT use the custody
// machinery (keys.js, registry, machineKind). The owner here is a
// THROWAWAY local keypair (generated with solana-keygen, stored
// outside the repo at ~/workspace/surfpool-run/local-owner.json),
// NOT the real testnet owner key. The agent is the real agent pubkey
// (it only signs spends, and its key is on this machine), the
// submitter is the real submitter pubkey (airdropped on Surfpool for
// relay fees). Never run this script against devnet/testnet/mainnet,
// and never commit the local owner keypair file.
//
// Prerequisites (run first):
//   1. Surfpool running: NO_DNA=1 surfpool start  (RPC 127.0.0.1:8899)
//   2. Program deployed: solana program deploy --url http://127.0.0.1:8899
//        --program-id solana/target/deploy/spendfloor-keypair.json
//        solana/target/deploy/spendfloor.so --keypair <local-owner.json>
//   3. Local owner funded: solana airdrop 5 --url http://127.0.0.1:8899
//        --keypair <local-owner.json>
//
// Usage:
//   npx tsx sdk/solana-localnet-setup.ts
//
// Writes: deployments/localnet.json

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const RPC = process.env.SPENDFLOOR_SOL_RPC ?? "http://127.0.0.1:8899";
const PROGRAM_ID = new PublicKey(
  process.env.SPENDFLOOR_SOL_PROGRAM_ID ??
    "CQfuniyvMY9sPDAFMPRZzbpHEwRiyy3Y4BsfuQd3iAbE",
);
const LOCAL_OWNER_PATH =
  process.env.SPENDFLOOR_LOCAL_OWNER_KEYPAIR ??
  path.join(
    process.env.HOME ?? "",
    "workspace",
    "surfpool-run",
    "local-owner.json",
  );
// Real agent + submitter pubkeys (addresses only; their keys are on
// this machine for signing/paying, but this script never signs as them
// except via the relay at demo time — init/mint are signed by the
// LOCAL owner only).
const AGENT = "5Df6mNkbr8J6XETfKAhhwL7JsRVkbr3rgvS6J3tvEBo3";
const SUBMITTER = "8RrdXQBFbrdyLyDnmFgSZU1CXGDknNDVVRLs2iLL84kb";
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

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");

async function main(): Promise<void> {
  console.log("=== LOCALNET ONLY (Surfpool) — not testnet, not mainnet ===");
  if (!fs.existsSync(LOCAL_OWNER_PATH)) {
    fail(`local owner keypair not found: ${LOCAL_OWNER_PATH}`);
  }
  const ownerSecret = JSON.parse(
    fs.readFileSync(LOCAL_OWNER_PATH, "utf8"),
  ) as number[];
  const owner = Keypair.fromSecretKey(Uint8Array.from(ownerSecret));
  const agentPubkey = new PublicKey(AGENT);
  const merchantPubkey = new PublicKey(SOL_MERCHANT);
  const submitterPubkey = new PublicKey(SUBMITTER);
  console.log(`rpc: ${RPC}`);
  console.log(`program: ${PROGRAM_ID.toBase58()}`);
  console.log(`local owner: ${owner.publicKey.toBase58()} (THROWAWAY, localnet only)`);
  console.log(`agent: ${AGENT}`);
  console.log(`merchant (SOL): ${SOL_MERCHANT}`);

  const connection = new Connection(RPC, "confirmed");
  // Health check via raw RPC (web3.js getHealth is not present in
  // every version; a plain getHealth call works everywhere).
  let healthOk = false;
  try {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
    });
    const j = (await res.json()) as { result?: string };
    healthOk = j.result === "ok";
  } catch {
    healthOk = false;
  }
  if (!healthOk) fail(`Surfpool RPC not healthy at ${RPC} (is surfpool start running?)`);
  console.log("surfpool RPC: ok");

  const [policy] = PublicKey.findProgramAddressSync(
    [Buffer.from("policy")],
    PROGRAM_ID,
  );
  console.log(`policy PDA: ${policy.toBase58()}`);
  const existing = await connection.getAccountInfo(policy);
  if (existing) fail(`policy PDA already initialized on this localnet (already set up?)`);

  const evmSetHash = createHash("sha256")
    .update(Buffer.from(EVM_MERCHANT.slice(2), "hex"))
    .digest();
  console.log(`evmSetHash: 0x${evmSetHash.toString("hex")}`);

  async function sendAndConfirm(
    ixs: TransactionInstruction[],
    signers: Keypair[],
  ): Promise<string> {
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

  // --- 0. Airdrop to the submitter (relay fees on Surfpool) ---
  {
    const bal = await connection.getBalance(submitterPubkey);
    if (bal < 1_000_000_000) {
      const sig = await connection.requestAirdrop(submitterPubkey, 2_000_000_000);
      await connection.confirmTransaction(sig, "confirmed");
      console.log(`airdropped 2 SOL to submitter ${SUBMITTER} (tx ${sig})`);
    } else {
      console.log(`submitter already funded: ${bal / 1e9} SOL`);
    }
  }

  // --- 1. Create the SPL mint (authority = local owner) ---
  const mintKp = Keypair.generate();
  const mintRent = await connection.getMinimumBalanceForRentExemption(MINT_LEN);
  {
    const initMintData = Buffer.concat([
      Buffer.from([0]),
      Buffer.from([DECIMALS]),
      owner.publicKey.toBuffer(),
      Buffer.from([0]),
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
  async function createTokenAccount(
    ownerPubkey: PublicKey,
  ): Promise<PublicKey> {
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
    console.log(
      `token account (owner ${ownerPubkey.toBase58()}): ${acctKp.publicKey.toBase58()} (tx ${sig})`,
    );
    return acctKp.publicKey;
  }
  const vaultToken = await createTokenAccount(policy);
  const merchantToken = await createTokenAccount(merchantPubkey);

  // --- 3. Initialize the policy PDA (demo/P0) ---
  function disc(name: string): Buffer {
    return createHash("sha256")
      .update(`global:${name}`)
      .digest()
      .subarray(0, 8);
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

  const out = {
    network: "Solana localnet (Surfpool)",
    label: "localnet",
    rpc: RPC,
    program: PROGRAM_ID.toBase58(),
    policyPda: policy.toBase58(),
    mint: mintKp.publicKey.toBase58(),
    vaultToken: vaultToken.toBase58(),
    merchantToken: merchantToken.toBase58(),
    localOwner: owner.publicKey.toBase58(),
    agent: AGENT,
    submitter: SUBMITTER,
    merchant: SOL_MERCHANT,
    evmMerchant: EVM_MERCHANT,
    perTx: PER_TX,
    window: WINDOW,
    windowSeconds: WINDOW_SECONDS,
    note: "LOCALNET ONLY. Local owner is a throwaway keypair (not the testnet owner). Do not use these addresses on devnet/testnet/mainnet.",
  };
  const outPath = path.join(repoRoot, "deployments", "localnet.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`wrote ${outPath}`);
  console.log("OK  localnet Solana setup complete");
}

main().catch((e) => {
  console.error(`FAIL  ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
