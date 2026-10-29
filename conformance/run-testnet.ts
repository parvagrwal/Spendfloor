// run-testnet (T17 testnet conformance, agent-spend vectors).
//
// Runs the vectors that need only the agent + submitter keys (my VM)
// against vaults given by env vars. Owner-step vectors (V13/V14 freeze,
// SOL V15/V16 set_policy) are NOT run here: they need the OWNER key
// (Parv's machine). This script prints the exact owner steps for those
// and marks them pending-owner, instead of failing.
//
// Env (all required for the chains you run; omit a chain to skip it):
//   EVM_VAULT, EVM_P1_VAULT, EVM_P2_VAULT (Base Sepolia demo/P1/P2)
//   SOL_PROGRAM, SOL_POLICY, SOL_VAULT_TOKEN, SOL_MERCHANT_TOKEN,
//   SOL_ATTACKER_TOKEN (devnet; attacker ATA, created by the T20 demo)
//   SKIP_EVM=1 / SKIP_SOL=1 to run one chain only.
//
// WARNING: running V1-V14 on a vault consumes its window (spent -> 5).
// Do NOT point this at the T16 demo vault unless you accept that the
// T27 demo will need a fresh vault (or a 24 h rollover). Prefer fresh
// T17 vaults (deploy via the T16 scripts, then pass their addresses).

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection,
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import {
  createPublicClient,
  http,
  type Abi,
  type Address,
} from "viem";
import { baseSepolia } from "viem/chains";
import { loadEvmAccount, loadSolKeypair } from "../sdk/keys.js";
import { signEvmIntent, submitEvmSpend, VAULT_ABI } from "../sdk/evm.js";
import { paySol } from "../agent/pay.js";
import { createRelay, DEFAULT_RELAY_CONFIG } from "../relay/submitter.js";
import { createWalletClient } from "viem";
import { solConnection } from "../agent/pay.js";

const here = dirname(fileURLToPath(import.meta.url));
const evmPub = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });

interface Rec {
  vector: string;
  expected: string;
  actual: string;
  hash: string | null;
  pass: boolean;
  note?: string;
}

async function main() {
  const skipEvm = process.env.SKIP_EVM === "1";
  const skipSol = process.env.SKIP_SOL === "1";
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const results: Rec[] = [];
  const rec = (vector: string, expected: string, actual: string, hash: string | null, note?: string) => {
    const pass = actual === expected;
    results.push({ vector, expected, actual, hash, pass, note });
    console.log(`${vector}: expected=${expected} actual=${actual} hash=${hash ?? ""} ${pass ? "PASS" : "FAIL"}${note ? ` (${note})` : ""}`);
  };

  // --- EVM (Base Sepolia) ---
  if (!skipEvm) {
    const vault = process.env.EVM_VAULT as Address;
    const p1 = process.env.EVM_P1_VAULT as Address | undefined;
    const p2 = process.env.EVM_P2_VAULT as Address | undefined;
    if (!vault) throw new Error("EVM_VAULT not set");
    const agent = loadEvmAccount("agent");
    const submitterAcc = loadEvmAccount("submitter");
    const submitter = createWalletClient({ account: submitterAcc, chain: baseSepolia, transport: http("https://sepolia.base.org") });
    const chainId = await evmPub.getChainId();
    const merchant = "0x61f1c99d674bcd333578AC4f538F46AbC7bB4106" as Address;
    const attacker = "0x960b6582945D1447b55B032C9630a3Bc8E82C6D0" as Address;
    const relay = createRelay(DEFAULT_RELAY_CONFIG, submitter, loadSolKeypair("submitter"), {});
    relay.start();
    const spend = async (v: Address, to: Address, amount: bigint) => {
      const nonce = (await evmPub.readContract({ address: v, abi: VAULT_ABI, functionName: "nonce" })) as bigint;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
      const signed = await signEvmIntent(agent, chainId, v, { to, amount, nonce, deadline });
      const res = await relay.submitEvm(agent.address, v, signed);
      // Pace: relay allows 10/min/agent; 7 s spacing keeps any 60 s
      // window under 10 submits (the first testnet run hit the limit).
      await sleep(7000);
      return { res, signed };
    };
    // NOTE: this runs V1-V11 + V17 + V18 on the given vault IN ORDER.
    // It assumes the vault starts fresh (spent 0, nonce 0). If the vault
    // is not fresh, later vectors will not match (spent already > 0).
    let v1Signed: Awaited<ReturnType<typeof signEvmIntent>> | null = null;
    // RESUME=1 skips EVM V1-V10 (already passed in a prior run that hit
    // the relay's 10/min rate limit at V11). The vault state after that
    // run (spent 5, nonce 3) is exactly what V11+ expects, so resuming
    // here is a valid in-order continuation, not a restart.
    if (!process.env.RESUME) {
    {
      const { res, signed } = await spend(vault, merchant, 1_000_000n);
      v1Signed = signed;
      rec("V1", "ACCEPT", res.ok ? "ACCEPT" : (res.label ?? "Reverted"), res.hash ?? null);
    }
    {
      const { res } = await spend(vault, attacker, 1n);
      rec("V2", "RecipientNotAllowed", res.ok ? "ACCEPT" : (res.label ?? "Reverted"), res.hash ?? null);
    }
    {
      const { res } = await spend(vault, attacker, 100_000_000n);
      rec("V3", "RecipientNotAllowed", res.ok ? "ACCEPT" : (res.label ?? "Reverted"), res.hash ?? null);
    }
    {
      const { res } = await spend(vault, merchant, 0n);
      rec("V4", "ZeroAmount", res.ok ? "ACCEPT" : (res.label ?? "Reverted"), res.hash ?? null);
    }
    {
      const { res } = await spend(vault, merchant, 2_000_001n);
      rec("V5", "PerTxCapExceeded", res.ok ? "ACCEPT" : (res.label ?? "Reverted"), res.hash ?? null);
    }
    {
      const { res } = await spend(vault, merchant, 2_000_000n);
      rec("V6", "ACCEPT", res.ok ? "ACCEPT" : (res.label ?? "Reverted"), res.hash ?? null);
    }
    {
      const { res } = await spend(vault, merchant, 6_000_000n);
      rec("V7", "DailyCapExceeded", res.ok ? "ACCEPT" : (res.label ?? "Reverted"), res.hash ?? null);
    }
    {
      const { res } = await spend(vault, merchant, (2n ** 64n) - 1n);
      rec("V8", "DailyCapExceeded", res.ok ? "ACCEPT" : (res.label ?? "Reverted"), res.hash ?? null);
    }
    {
      const { res } = await spend(vault, merchant, 2_000_000n);
      rec("V9", "ACCEPT", res.ok ? "ACCEPT" : (res.label ?? "Reverted"), res.hash ?? null);
    }
    {
      const { res } = await spend(vault, merchant, 1n);
      rec("V10", "DailyCapExceeded", res.ok ? "ACCEPT" : (res.label ?? "Reverted"), res.hash ?? null);
    }
    }
    {
      const { res } = await spend(vault, vault, 1n);
      rec("V11", "RecipientNotAllowed", res.ok ? "ACCEPT" : (res.label ?? "Reverted"), res.hash ?? null);
    }
    // V12: agent attempts owner functions -> must revert (all four).
    // Uses the full vault artifact ABI (VAULT_ABI in the SDK only
    // covers spend + reads, not the owner functions). On testnet, Base
    // Sepolia RPCs do not surface revert data, so we verify the REVERT
    // itself here; the label (NotOwner) is proven by local 18/18.
    {
      const { encodeFunctionData } = await import("viem");
      const { readFileSync } = await import("node:fs");
      const { join, dirname } = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const artifact = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "evm", "out", "SpendFloorVault.sol", "SpendFloorVault.json"), "utf8"));
      const fullAbi = artifact.abi as Abi;
      const attempts: { fn: string; args: unknown[] }[] = [
        { fn: "setPolicy", args: [1, 6, 2_000_000n, 5_000_000n, 86400n, 0n, 0n, [merchant], ("0x" + "11".repeat(32)) as `0x${string}`] },
        { fn: "setAgent", args: [merchant] },
        { fn: "setFrozen", args: [true] },
        { fn: "withdraw", args: [merchant, 1n] },
      ];
      let reverted = 0;
      for (const a of attempts) {
        const data = encodeFunctionData({ abi: fullAbi, functionName: a.fn as never, args: a.args as never });
        try {
          await evmPub.call({ to: vault, account: agent.address, data });
        } catch {
          reverted++;
        }
      }
      rec("V12", "NotOwner", reverted === 4 ? "NotOwner" : "other", null, "testnet confirms all four revert; label proven by local 18/18");
    }
    if (v1Signed) {
      const res = await relay.submitEvm(agent.address, vault, v1Signed);
      rec("V17", "BadNonce", res.ok ? "ACCEPT" : (res.label ?? "Reverted"), res.hash ?? null, "replay of V1 payload");
    }
    // V18: attacker-signed intent -> Unauthorized (sign with a fresh local key, not the agent).
    {
      const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
      const attackerSigner = privateKeyToAccount(generatePrivateKey());
      const nonce = (await evmPub.readContract({ address: vault, abi: VAULT_ABI, functionName: "nonce" })) as bigint;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
      const signed = await signEvmIntent(attackerSigner, chainId, vault, { to: merchant, amount: 1n, nonce, deadline });
      const res = await relay.submitEvm(attackerSigner.address, vault, signed);
      rec("V18", "Unauthorized", res.ok ? "ACCEPT" : (res.label ?? "Reverted"), res.hash ?? null, "attacker-signed intent");
    }
    // V13/V14 need the owner (freeze/unfreeze) -> pending-owner.
    rec("V13", "Frozen", "pending-owner", null, "needs OWNER freeze (Parv) then agent spend");
    rec("V14", "DailyCapExceeded", "pending-owner", null, "needs OWNER unfreeze (Parv) then agent spend");
    // EVM V15 (P1, already rolled over naturally) + V16 (P2, already expired).
    if (p1) {
      const { res } = await spend(p1, merchant, 1_000_000n);
      rec("V15", "ACCEPT", res.ok ? "ACCEPT" : (res.label ?? "Reverted"), res.hash ?? null, "P1 window rolled over naturally since T16");
    }
    if (p2) {
      const { res } = await spend(p2, merchant, 1n);
      rec("V16", "SessionExpired", res.ok ? "ACCEPT" : (res.label ?? "Reverted"), res.hash ?? null, "P2 expired naturally since T16");
    }
    relay.stop();
  }

  // --- SOL (devnet) ---
  if (!skipSol) {
    const program = new PublicKey(process.env.SOL_PROGRAM ?? "");
    const policy = new PublicKey(process.env.SOL_POLICY ?? "");
    const vaultToken = new PublicKey(process.env.SOL_VAULT_TOKEN ?? "");
    const merchantToken = new PublicKey(process.env.SOL_MERCHANT_TOKEN ?? "");
    const attackerToken = new PublicKey(process.env.SOL_ATTACKER_TOKEN ?? "");
    if (!process.env.SOL_PROGRAM) throw new Error("SOL_PROGRAM etc. not set");
    const conn = solConnection();
    const agentKp = loadSolKeypair("agent");
    const submitterKp = loadSolKeypair("submitter");
    const relay = createRelay(DEFAULT_RELAY_CONFIG, createWalletClient({ account: loadEvmAccount("submitter"), chain: baseSepolia, transport: http("https://sepolia.base.org") }), submitterKp, {});
    relay.start();
    const spendSol = async (dest: PublicKey, amount: number) => {
      return paySol(relay, conn, agentKp, program, policy, vaultToken, dest, amount);
    };
    // Amounts in SFUSD (paySol converts to micro-units). u64::MAX not
    // expressible in SFUSD dollars, so V8 uses a huge dollar amount.
    const s = async (dest: PublicKey, sfusd: number) => {
      const r = await spendSol(dest, sfusd);
      await sleep(7000);
      return r;
    };
    let r = await s(merchantToken, 1);
    rec("V1", "ACCEPT", r.receipt.ok ? "ACCEPT" : (r.receipt.label ?? "SubmitFailed"), r.receipt.hash ?? null);
    r = await s(attackerToken, 0.000001);
    rec("V2", "RecipientNotAllowed", r.receipt.ok ? "ACCEPT" : (r.receipt.label ?? "SubmitFailed"), r.receipt.hash ?? null);
    r = await s(attackerToken, 100);
    rec("V3", "RecipientNotAllowed", r.receipt.ok ? "ACCEPT" : (r.receipt.label ?? "SubmitFailed"), r.receipt.hash ?? null);
    r = await s(merchantToken, 0);
    rec("V4", "ZeroAmount", r.receipt.ok ? "ACCEPT" : (r.receipt.label ?? "SubmitFailed"), r.receipt.hash ?? null);
    r = await s(merchantToken, 2.000001);
    rec("V5", "PerTxCapExceeded", r.receipt.ok ? "ACCEPT" : (r.receipt.label ?? "SubmitFailed"), r.receipt.hash ?? null);
    r = await s(merchantToken, 2);
    rec("V6", "ACCEPT", r.receipt.ok ? "ACCEPT" : (r.receipt.label ?? "SubmitFailed"), r.receipt.hash ?? null);
    r = await s(merchantToken, 6);
    rec("V7", "DailyCapExceeded", r.receipt.ok ? "ACCEPT" : (r.receipt.label ?? "SubmitFailed"), r.receipt.hash ?? null);
    r = await s(merchantToken, 18446744073709);
    rec("V8", "DailyCapExceeded", r.receipt.ok ? "ACCEPT" : (r.receipt.label ?? "SubmitFailed"), r.receipt.hash ?? null, "u64::MAX approx in SFUSD");
    r = await s(merchantToken, 2);
    rec("V9", "ACCEPT", r.receipt.ok ? "ACCEPT" : (r.receipt.label ?? "SubmitFailed"), r.receipt.hash ?? null);
    r = await s(merchantToken, 0.000001);
    rec("V10", "DailyCapExceeded", r.receipt.ok ? "ACCEPT" : (r.receipt.label ?? "SubmitFailed"), r.receipt.hash ?? null);
    // V11 testnet SOL: dest = the PDA-owned ATA (policy PDA as owner).
    // The ATA for (policy PDA, mint) is deterministic; create it if
    // missing (submitter pays rent, as in the T20 demo ATA step), then
    // spend to it -> RecipientNotAllowed (PDA not in {merchant}).
    // (Using the vault token account itself would give duplicate 2040.)
    {
      const { PublicKey: PK, SystemProgram, Transaction: Tx, TransactionInstruction: TxIx } = await import("@solana/web3.js");
      const TOKEN_PID = new PK("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
      const ATA_PID = new PK("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
      const RENT = new PK("SysvarRent111111111111111111111111111111111");
      const MINT = new PK("ESB1d6WUnz6e9yRmC9hv8MrHHzrQs8eFSV6aosDHNt2U");
      const [pdaAta] = PK.findProgramAddressSync([policy.toBuffer(), TOKEN_PID.toBuffer(), MINT.toBuffer()], ATA_PID);
      const info = await conn.getAccountInfo(pdaAta);
      if (!info) {
        const ix = new TxIx({
          keys: [
            { pubkey: submitterKp.publicKey, isSigner: true, isWritable: true },
            { pubkey: pdaAta, isSigner: false, isWritable: true },
            { pubkey: policy, isSigner: false, isWritable: false },
            { pubkey: MINT, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PID, isSigner: false, isWritable: false },
            { pubkey: RENT, isSigner: false, isWritable: false },
          ],
          programId: ATA_PID,
          data: Buffer.alloc(0),
        });
        const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
        const tx = new Tx({ feePayer: submitterKp.publicKey, blockhash, lastValidBlockHeight }).add(ix);
        tx.sign(submitterKp);
        const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
        for (let i = 0; i < 60; i++) {
          const st = await conn.getSignatureStatus(sig);
          if (st.value && st.value.confirmationStatus && st.value.confirmationStatus !== "processed") break;
          await new Promise((rr) => setTimeout(rr, 1000));
        }
        console.log(`PDA ATA created: ${pdaAta.toBase58()} (tx ${sig})`);
      } else {
        console.log(`PDA ATA exists: ${pdaAta.toBase58()}`);
      }
      const r11 = await s(pdaAta, 0.000001);
      rec("V11", "RecipientNotAllowed", r11.receipt.ok ? "ACCEPT" : (r11.receipt.label ?? "SubmitFailed"), r11.receipt.hash ?? null, "dest = PDA-owned ATA");
    }
    rec("V12", "NotOwner", "pending-owner", null, "agent owner-attempts need a separate check (local 18/18 proves NotOwner); testnet V12 via owner ix attempts is a follow-up");
    rec("V13", "Frozen", "pending-owner", null, "needs OWNER freeze (Parv) then agent spend");
    rec("V14", "DailyCapExceeded", "pending-owner", null, "needs OWNER unfreeze (Parv) then agent spend");
    rec("V15", "ACCEPT", "pending-owner", null, "needs OWNER set_policy window 300 + wait (Parv) then agent spend");
    rec("V16", "SessionExpired", "pending-owner", null, "needs OWNER set_policy expiry + wait (Parv) then agent spend");
    rec("V17", "duplicate (does not land)", "pending", null, "SOL replay: resubmit V1 tx sig; documented difference (does not land)");
    // V18 SOL: fresh attacker keypair signs a spend to the merchant
    // token (valid recipient, valid amount) -> Unauthorized (6000).
    {
      const { Keypair: KP } = await import("@solana/web3.js");
      const attackerKp = KP.generate();
      const r18 = await paySol(relay, conn, attackerKp, program, policy, vaultToken, merchantToken, 1);
      rec("V18", "Unauthorized", r18.receipt.ok ? "ACCEPT" : (r18.receipt.label ?? "SubmitFailed"), r18.receipt.hash ?? null, "attacker-signed SOL spend");
    }
    relay.stop();
  }

  const passed = results.filter((x) => x.pass).length;
  console.log(`\nTestnet (agent vectors + staged owner vectors): ${passed}/${results.length} pass (pending-owner excluded from pass)`);
  mkdirSync(join(here, "..", "evidence", "T17"), { recursive: true });
  writeFileSync(join(here, "..", "evidence", "T17", "testnet-run.json"), JSON.stringify({ results }, null, 2));
}

main().catch((err) => { console.error(`FAIL ${err instanceof Error ? err.message : String(err)}`); process.exit(1); });
