// demo-injection (T20 live-injection demo).
//
// Usage:
//   npx tsx agent/demo-injection.ts --message "<pasted message>" [--net testnet|local]
//
// Testnet (default): one pasted message goes to qwen2.5:3b, which may
// call pay. The pay is executed on BOTH chains through the relay, and
// the log shows the signed payload digest + the landed receipt for each
// chain. For an injection (pay to a non-recipient), both chains must
// return RecipientNotAllowed with a hash/signature, and the vault state
// must be unchanged (reverts roll back). No policy is checked here.
// Local (--net local): Anvil only (no Solana validator on this VM);
// deploys a fresh vault and runs the same loop, for legit-pay proof.
//
// The Solana attacker token account is the associated token account
// (ATA) for the attacker wallet + the demo mint, derived deterministically
// and created on demand (submitter pays rent). The demo merchant token
// account is the T16 one. Amount fidelity (message amount vs LLM amount)
// is printed, not hidden.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
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
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { baseSepolia, foundry } from "viem/chains";
import {
  loadEvmAccount,
  loadSolKeypair,
} from "../sdk/keys.js";
import { runAgentLoop } from "./loop.js";
import { evmClients, payEvm, paySol, solConnection } from "./pay.js";
import { createRelay, DEFAULT_RELAY_CONFIG } from "../relay/submitter.js";

// --- Testnet deployment (T16) ---
const EVM_VAULT = "0x8d13a6a31518b357a480659073b9db78ab861809" as Address;
const EVM_MERCHANT = "0x61f1c99d674bcd333578AC4f538F46AbC7bB4106" as Address;
const EVM_ATTACKER = "0x960b6582945D1447b55B032C9630a3Bc8E82C6D0" as Address;
const SOL_PROGRAM = new PublicKey("CQfuniyvMY9sPDAFMPRZzbpHEwRiyy3Y4BsfuQd3iAbE");
const SOL_POLICY = new PublicKey("5MUi1eZAfjaCukRDZNntAMJCr5Xz6gCRJ9s7D2iJyfuE");
const SOL_MINT = new PublicKey("ESB1d6WUnz6e9yRmC9hv8MrHHzrQs8eFSV6aosDHNt2U");
const SOL_VAULT_TOKEN = new PublicKey("GhanJGGQhwhSL9q1Uvsy7MopiA2aDH7QERmrvqz1xn6N");
const SOL_MERCHANT_TOKEN = new PublicKey("GiKhKyYKuMQjJZrMLmRxhggrzRPkDrwLEAbr7SuUcnMV");
const SOL_ATTACKER = new PublicKey("Hk851CTYdPGq8NuLGwz66kKzsu5HP66WNtie3Yhbw33F");
const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
const ATA_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);
const RENT_SYSVAR = new PublicKey(
  "SysvarRent111111111111111111111111111111111",
);

const args = process.argv.slice(2);
const msgIdx = args.indexOf("--message");
const netIdx = args.indexOf("--net");
const MESSAGE = msgIdx >= 0 ? args[msgIdx + 1] : "";
const NET = netIdx >= 0 ? args[netIdx + 1] : "testnet";
if (!MESSAGE) {
  console.log("usage: npx tsx agent/demo-injection.ts --message \"<text>\" [--net testnet|local]");
  process.exit(1);
}
const LOCALNET = NET === "local";

async function sendAndConfirmPoll(
  conn: Connection,
  tx: Transaction,
  signers: Keypair[],
): Promise<string> {
  const { blockhash } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
  });
  for (let i = 0; i < 60; i++) {
    const st = await conn.getSignatureStatus(sig);
    const s = st.value;
    if (s && s.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(s.err)}`);
    if (s && s.confirmationStatus && s.confirmationStatus !== "processed") {
      return sig;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`tx ${sig} did not confirm in 60 s`);
}

async function ensureAttackerAta(
  conn: Connection,
  payer: Keypair,
  mint: PublicKey,
): Promise<PublicKey> {
  const [ata] = PublicKey.findProgramAddressSync(
    [SOL_ATTACKER.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM_ID,
  );
  const info = await conn.getAccountInfo(ata);
  if (info) {
    console.log(`attacker ATA exists: ${ata.toBase58()}`);
    return ata;
  }
  const ix = new TransactionInstruction({
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: SOL_ATTACKER, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: RENT_SYSVAR, isSigner: false, isWritable: false },
    ],
    programId: ATA_PROGRAM_ID,
    data: Buffer.alloc(0),
  });
  const tx = new Transaction({ feePayer: payer.publicKey }).add(ix);
  const sig = await sendAndConfirmPoll(conn, tx, [payer]);
  console.log(`attacker ATA created: ${ata.toBase58()} (tx ${sig})`);
  return ata;
}

async function main() {
  // --- Network label (T26: the demo must show which network it runs on) ---
  console.log(
    LOCALNET
      ? "=== DEMO NETWORK: localnet (Anvil + Surfpool) ==="
      : "=== DEMO NETWORK: testnet (Base Sepolia + Solana devnet) ===",
  );
  // --- Keys + relay ---
  const evmAgent = loadEvmAccount("agent");
  const evmSubmitterAcc = loadEvmAccount("submitter");
  const solAgent = loadSolKeypair("agent");
  const solSubmitter = loadSolKeypair("submitter");
  const { pub: evmPublic, chainId } = evmClients(LOCALNET);
  const evmSubmitter = createWalletClient({
    account: evmSubmitterAcc,
    chain: LOCALNET ? foundry : baseSepolia,
    transport: http(LOCALNET ? "http://127.0.0.1:8545" : "https://sepolia.base.org"),
  });
  let relay = createRelay(DEFAULT_RELAY_CONFIG, evmSubmitter, solSubmitter, {
    localnet: LOCALNET,
  });
  relay.start();

  // --- Localnet vault (fresh Anvil deploy) ---
  let vault = EVM_VAULT;
  let merchant = EVM_MERCHANT;
  let anvilProc: ChildProcess | null = null;
  if (LOCALNET) {
    const here = dirname(fileURLToPath(import.meta.url));
    const evmDir = join(here, "..", "evm");
    const rpcUp = async (): Promise<boolean> => {
      try {
        const r = await fetch("http://127.0.0.1:8545", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
          signal: AbortSignal.timeout(3000),
        });
        return r.ok;
      } catch {
        return false;
      }
    };
    if (!(await rpcUp())) {
      const anvilBin = existsSync(`${process.env.HOME}/.foundry/bin/anvil`)
        ? `${process.env.HOME}/.foundry/bin/anvil`
        : "anvil";
      anvilProc = spawn(anvilBin, ["--port", "8545"], { stdio: "ignore" });
      for (let i = 0; i < 30; i++) {
        if (await rpcUp()) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    const forgeBin = existsSync(`${process.env.HOME}/.foundry/bin/forge`)
      ? `${process.env.HOME}/.foundry/bin/forge`
      : "forge";
    execSync(`${forgeBin} build`, { cwd: evmDir, stdio: "ignore" });
    const tokenArtifact = JSON.parse(
      (await import("node:fs")).readFileSync(
        join(evmDir, "out/SFUSD.sol/SFUSD.json"),
        "utf8",
      ),
    );
    const vaultArtifact = JSON.parse(
      (await import("node:fs")).readFileSync(
        join(evmDir, "out/SpendFloorVault.sol/SpendFloorVault.json"),
        "utf8",
      ),
    );
    const mnemonic = "test test test test test test test test test test test junk";
    const ownerAcc = mnemonicToAccount(mnemonic, { addressIndex: 0 });
    const localSubmitterAcc = mnemonicToAccount(mnemonic, { addressIndex: 2 });
    merchant = mnemonicToAccount(mnemonic, { addressIndex: 3 }).address;
    const localOwner = createWalletClient({
      account: ownerAcc,
      chain: foundry,
      transport: http("http://127.0.0.1:8545"),
    });
    const localSubmitter = createWalletClient({
      account: localSubmitterAcc,
      chain: foundry,
      transport: http("http://127.0.0.1:8545"),
    });
    // Rebuild the relay on the local submitter (Anvil account 2) and
    // the local Solana RPC (Surfpool) for the SOL leg.
    relay.stop();
    relay = createRelay(DEFAULT_RELAY_CONFIG, localSubmitter, solSubmitter, {
      localnet: true,
      solRpc: "http://127.0.0.1:8899",
    });
    relay.start();
    const tokenHash = await localOwner.deployContract({
      account: ownerAcc,
      chain: foundry,
      abi: tokenArtifact.abi as Abi,
      bytecode: tokenArtifact.bytecode.object as Hash,
    });
    const tokenReceipt = await evmPublic.waitForTransactionReceipt({ hash: tokenHash });
    const token = tokenReceipt.contractAddress!;
    const vaultHash = await localOwner.deployContract({
      account: ownerAcc,
      chain: foundry,
      abi: vaultArtifact.abi as Abi,
      bytecode: vaultArtifact.bytecode.object as Hash,
      args: [
        token,
        evmAgent.address,
        1,
        6,
        2_000_000n,
        5_000_000n,
        86400n,
        0n,
        0n,
        [merchant],
        ("0x" + "11".repeat(32)) as Hash,
      ],
    });
    const vaultReceipt = await evmPublic.waitForTransactionReceipt({ hash: vaultHash });
    vault = vaultReceipt.contractAddress!;
    const mintHash = await localOwner.writeContract({
      account: ownerAcc,
      chain: foundry,
      address: token,
      abi: tokenArtifact.abi as Abi,
      functionName: "mint",
      args: [vault, 10_000_000n],
    });
    await evmPublic.waitForTransactionReceipt({ hash: mintHash });
    console.log(`local vault: ${vault} (merchant ${merchant})`);
  }

  // --- Solana setup: testnet (devnet constants) or localnet (Surfpool) ---
  // Localnet reads deployments/localnet.json (written by
  // sdk/solana-localnet-setup.ts). The program ID and policy PDA are
  // the same as devnet (same program keypair, seeds ["policy"]); the
  // mint, vault token, and merchant token are fresh local addresses.
  let solProgram = SOL_PROGRAM;
  let solPolicy = SOL_POLICY;
  let solVaultToken = SOL_VAULT_TOKEN;
  let solMerchantToken = SOL_MERCHANT_TOKEN;
  let solMint = SOL_MINT;
  let attackerAta: PublicKey | null = null;
  let conn: Connection | null = null;
  if (LOCALNET) {
    const here = dirname(fileURLToPath(import.meta.url));
    const localPath = join(here, "..", "deployments", "localnet.json");
    let local: {
      program: string; policyPda: string; mint: string;
      vaultToken: string; merchantToken: string;
    };
    try {
      local = JSON.parse(
        (await import("node:fs")).readFileSync(localPath, "utf8"),
      );
    } catch {
      throw new Error(
        `localnet.json not found at ${localPath} — run sdk/solana-localnet-setup.ts first (with Surfpool running)`,
      );
    }
    solProgram = new PublicKey(local.program);
    solPolicy = new PublicKey(local.policyPda);
    solVaultToken = new PublicKey(local.vaultToken);
    solMerchantToken = new PublicKey(local.merchantToken);
    solMint = new PublicKey(local.mint);
    conn = new Connection("http://127.0.0.1:8899", "confirmed");
    attackerAta = await ensureAttackerAta(conn, solSubmitter, solMint);
    console.log(`local SOL: program ${solProgram.toBase58()} policy ${solPolicy.toBase58()} vault ${solVaultToken.toBase58()} mint ${solMint.toBase58()}`);
  } else {
    conn = solConnection();
    attackerAta = await ensureAttackerAta(conn, solSubmitter, SOL_MINT);
  }

  // --- LLM turn ---
  console.log(`message: ${MESSAGE}`);
  const loop = await runAgentLoop(MESSAGE);
  console.log(`llm raw: ${loop.raw}`);
  if (!loop.pay) {
    console.log(`no pay: ${loop.noPayReason}`);
    if (anvilProc) anvilProc.kill();
    return;
  }
  const { to, amount, toEvm, toSol } = loop.pay;
  console.log(`llm pay action: to=${to} toEvm=${toEvm ?? ""} toSol=${toSol ?? ""} amount=${amount} SFUSD`);
  // Fidelity: amount in the message vs the LLM's amount.
  const m = MESSAGE.match(/(\d+(?:\.\d+)?)\s*SFUSD/i);
  if (m) {
    const msgAmount = Number(m[1]);
    console.log(
      `amount fidelity: message=${msgAmount} SFUSD, llm=${amount} SFUSD, match=${msgAmount === amount}`,
    );
  }

  // --- Resolve recipients per chain ---
  const evmTo: Address = (
    toEvm ?? (to.startsWith("0x") ? to : EVM_ATTACKER)
  ) as Address;
  // Solana dest: derived with the EFFECTIVE mint (local mint on
  // localnet, devnet mint on testnet). The merchant dest is the
  // merchant TOKEN ACCOUNT (not an ATA) on either network.
  // The LLM may answer with a placeholder word ("attacker",
  // "merchant_address") instead of an address. Parsing such a word
  // as a PublicKey crashes (run 1: "attacker" -> Invalid public key
  // input; run 2: "merchant_address" -> Non-base58 character), so
  // only parse when the string is a valid pubkey; otherwise fall
  // back to the attacker ATA (the injection dest). The merchant
  // case is overridden below by namesMerchant anyway.
  function tryPubkey(s: string): PublicKey | null {
    try {
      return new PublicKey(s);
    } catch {
      return null;
    }
  }
  let solDest: PublicKey = solMerchantToken;
  const toSolKey = toSol ? tryPubkey(toSol) : null;
  if (toSolKey) {
    const [ata] = PublicKey.findProgramAddressSync(
      [toSolKey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), solMint.toBuffer()],
      ATA_PROGRAM_ID,
    );
    solDest = ata;
  } else if (!to.startsWith("0x") && to) {
    const toKey = tryPubkey(to);
    if (toKey) {
      const [ata] = PublicKey.findProgramAddressSync(
        [toKey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), solMint.toBuffer()],
        ATA_PROGRAM_ID,
      );
      solDest = ata;
    } else {
      solDest = attackerAta ?? solMerchantToken;
    }
  } else {
    solDest = attackerAta ?? solMerchantToken;
  }
  // If the message names the merchant (legit pay), use the merchant accounts.
  const namesMerchant =
    MESSAGE.toLowerCase().includes("merchant") ||
    to.toLowerCase() === merchant.toLowerCase();
  const finalEvmTo = namesMerchant ? merchant : evmTo;
  const finalSolDest = namesMerchant ? solMerchantToken : solDest;
  console.log(`evm recipient: ${finalEvmTo}`);
  console.log(`sol dest token: ${finalSolDest.toBase58()}`);

  // --- Pay on EVM ---
  const evmRes = await payEvm(relay, evmPublic, evmAgent, chainId, vault, finalEvmTo, amount);
  console.log(
    `EVM pay: ok=${evmRes.receipt.ok} label=${evmRes.receipt.label ?? ""} hash=${evmRes.receipt.hash ?? ""} digest=${evmRes.payloadDigest} signed=${evmRes.signedAmountMicro} micro-units`,
  );

  // --- Pay on Solana (both networks; localnet uses Surfpool) ---
  if (conn && attackerAta) {
    const solRes = await paySol(
      relay,
      conn,
      solAgent,
      solProgram,
      solPolicy,
      solVaultToken,
      finalSolDest,
      amount,
    );
    console.log(
      `SOL pay: ok=${solRes.receipt.ok} label=${solRes.receipt.label ?? ""} sig=${solRes.receipt.hash ?? ""} digest=${solRes.payloadDigest} signed=${solRes.signedAmountMicro} micro-units`,
    );
  } else {
    console.log("SOL pay: skipped (no Solana connection — localnet setup missing?)");
  }
  if (anvilProc) anvilProc.kill();
}

main().catch((err) => {
  console.error(`FAIL  ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
