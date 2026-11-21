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
  http, isAddress,
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
const SOL_MERCHANT = "8e6f1AWYV4unGiaoDciMkAXvPdUZvpNCtPK6pz2kmZhS";
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
// --json-events adds machine-readable lifecycle lines for the local operator
// adapter. It never changes what is executed or what the demo enforces.
const jsonEvents = args.includes("--json-events");
function emit(type: string, data: Record<string, unknown> = {}): void {
  if (jsonEvents) {
    console.log(`SPENDFLOOR_EVENT ${JSON.stringify({ type, at: new Date().toISOString(), ...data })}`);
  }
}
const msgIdx = args.indexOf("--message");
const netIdx = args.indexOf("--net");
const MESSAGE = msgIdx >= 0 ? args[msgIdx + 1] : "";
const NET = netIdx >= 0 ? args[netIdx + 1] : "testnet";
if (!MESSAGE) {
  console.log("usage: npx tsx agent/demo-injection.ts --message \"<text>\" [--net testnet|local]");
  process.exit(1);
}
if (NET !== "testnet" && NET !== "local") throw new Error("unsupported demo network");
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

let anvilProc: ChildProcess | null = null;
async function main() {
  // --- Network label (T26: the demo must show which network it runs on) ---
  console.log(
    LOCALNET
      ? "=== DEMO NETWORK: localnet (Anvil + Surfpool) ==="
      : "=== DEMO NETWORK: testnet (Base Sepolia + Solana devnet) ===",
  );
  emit("run_started", { network: NET, message: MESSAGE });
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
  let sponsor: Parameters<typeof createRelay>[1] = evmSubmitter;

  // --- Localnet vault (fresh Anvil deploy) ---
  let vault = EVM_VAULT;
  let merchant = EVM_MERCHANT;

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
    sponsor = localSubmitter;
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
    // Validate the Solana fields before constructing PublicKeys. The
    // repo still ships the old T16 localnet.json (EVM-only), which
    // lacks these fields; without this check, new PublicKey(undefined)
    // throws a confusing error instead of the clear setup message.
    const requiredSolFields = [
      "program",
      "policyPda",
      "mint",
      "vaultToken",
      "merchantToken",
    ] as const;
    const missingSolFields = requiredSolFields.filter((k) => !local[k]);
    if (missingSolFields.length > 0) {
      throw new Error(
        `deployments/localnet.json is missing the Solana fields (${missingSolFields.join(", ")}); it may be the old EVM-only version — run sdk/solana-localnet-setup.ts first (with Surfpool running) to regenerate it`,
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

  const relay = createRelay(DEFAULT_RELAY_CONFIG, sponsor, solSubmitter, {
    localnet: LOCALNET, targets: {evmVaults: [vault], solVault: {program: solProgram, vaultToken: solVaultToken, agent: solAgent.publicKey}},
  });
  relay.start();
  // --- LLM turn ---
  console.log(`message: ${MESSAGE}`);
  emit("agent_processing", { network: NET });
  const loop = await runAgentLoop(MESSAGE);
  console.log(`llm raw: ${loop.raw}`);
  if (!loop.pay) {
    console.log(`no pay: ${loop.noPayReason}`);
    emit("agent_no_pay", { reason: loop.noPayReason, raw: loop.raw });
    emit("run_complete", { outcome: "no_action" });

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

  // Only the two named demo contacts have a cross-chain address mapping.
  // Never infer a recipient by searching unrelated words in the user's message.
  const merchantAlias = ["merchant", "merchant_address", merchant.toLowerCase()];
  const attackerAlias = ["attacker", "attacker_address", EVM_ATTACKER.toLowerCase()];
  const contact = to.startsWith("0x") ? to.toLowerCase() : to;
  const isMerchant = merchantAlias.includes(contact) || to === SOL_MERCHANT;
  const isAttacker = attackerAlias.includes(contact) || to === SOL_ATTACKER.toBase58();
  const finalEvmTo = toEvm ?? (isMerchant ? merchant : isAttacker ? EVM_ATTACKER : to);
  if (!isAddress(finalEvmTo)) throw new Error("no unambiguous EVM recipient; not paying");
  const solWallet = toSol ? new PublicKey(toSol) : isMerchant ? new PublicKey(SOL_MERCHANT) : isAttacker ? SOL_ATTACKER : new PublicKey(to);
  const finalSolDest = solWallet.toBase58() === SOL_MERCHANT ? solMerchantToken : PublicKey.findProgramAddressSync(
    [solWallet.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), solMint.toBuffer()], ATA_PROGRAM_ID)[0];
  console.log(`evm recipient: ${finalEvmTo}`);
  console.log(`sol dest token: ${finalSolDest.toBase58()}`);
  emit("agent_signed", {
    amountSfusd: amount,
    to: to,
    evmRecipient: finalEvmTo,
    solRecipient: finalSolDest.toBase58(),
  });

  // --- Pay on EVM ---
  emit("submitter_relaying", { chain: "evm", vault });
  const evmRes = await payEvm(relay, evmPublic, evmAgent, chainId, vault, finalEvmTo, amount);
  console.log(
    `EVM pay: ok=${evmRes.receipt.ok} label=${evmRes.receipt.label ?? ""} hash=${evmRes.receipt.hash ?? ""} digest=${evmRes.payloadDigest} signed=${evmRes.signedAmountMicro} micro-units`,
  );
  emit("chain_result", {
    chain: "evm",
    ok: evmRes.receipt.ok,
    label: evmRes.receipt.label ?? null,
    hash: evmRes.receipt.hash ?? null,
    digest: evmRes.payloadDigest,
    signedAmountMicro: evmRes.signedAmountMicro.toString(),
    raw: evmRes.receipt.raw ?? null,
  });

  // --- Pay on Solana (both networks; localnet uses Surfpool) ---
  if (conn && attackerAta) {
    emit("submitter_relaying", { chain: "sol", program: solProgram.toBase58() });
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
    emit("chain_result", {
      chain: "sol",
      ok: solRes.receipt.ok,
      label: solRes.receipt.label ?? null,
      hash: solRes.receipt.hash ?? null,
      digest: solRes.payloadDigest,
      signedAmountMicro: solRes.signedAmountMicro.toString(),
      raw: solRes.receipt.raw ?? null,
    });
  } else {
    console.log("SOL pay: skipped (no Solana connection — localnet setup missing?)");
    emit("chain_skipped", { chain: "sol", reason: "no Solana connection (localnet setup missing)" });
  }
  emit("run_complete", { outcome: evmRes.receipt.ok ? "accepted" : "completed" });
}

main().finally(() => anvilProc?.kill()).catch((err) => {
  console.error(`FAIL  ${err instanceof Error ? err.message : String(err)}`);
  emit("run_failed", { reason: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
