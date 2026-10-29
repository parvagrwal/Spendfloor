// run-local-evm (T17 local EVM conformance).
//
// Deploys fresh vaults on Anvil and runs V1-V18 in order (P0 for
// V1-V14 + V17 + V18, P1 for V15 rollover, P2 for V16 expiry).
// Writes results JSON to evidence/T17/evm-local.json and prints a
// per-vector summary. No relay (conformance is about the vault, not
// the forwarder); the submitter sends via the SDK's forced-landing
// submit, the agent signs, the owner deploys + freezes.
//
// Amounts are micro-units (SFUSD 6 decimals). Labels come from the
// SDK's submit result (Anvil returns revert data, so labels decode
// exactly here, unlike Base Sepolia's public RPCs).

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Address,
  type Hash,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { signEvmIntent, submitEvmSpend, VAULT_ABI } from "../sdk/evm.js";

const MNEMONIC = "test test test test test test test test test test test junk";
const RPC = "http://127.0.0.1:8545";
const here = dirname(fileURLToPath(import.meta.url));
const evmDir = join(here, "..", "evm");

interface VecResult {
  vector: string;
  expected: string;
  actual: string;
  hash: string | null;
  pass: boolean;
  note?: string;
}

const results: VecResult[] = [];
function record(vector: string, expected: string, actual: string, hash: string | null, note?: string) {
  const pass = actual === expected;
  results.push({ vector, expected, actual, hash, pass, note });
  console.log(`${vector}: expected=${expected} actual=${actual} hash=${hash ?? ""} ${pass ? "PASS" : "FAIL"}${note ? ` (${note})` : ""}`);
}

async function rpcUp(): Promise<boolean> {
  try {
    const r = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(3000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function main() {
  let anvilProc: ChildProcess | null = null;
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
  const { execSync } = await import("node:child_process");
  const forgeBin = existsSync(`${process.env.HOME}/.foundry/bin/forge`)
    ? `${process.env.HOME}/.foundry/bin/forge`
    : "forge";
  execSync(`${forgeBin} build`, { cwd: evmDir, stdio: "ignore" });
  const tokenArtifact = JSON.parse(readFileSync(join(evmDir, "out/SFUSD.sol/SFUSD.json"), "utf8"));
  const vaultArtifact = JSON.parse(readFileSync(join(evmDir, "out/SpendFloorVault.sol/SpendFloorVault.json"), "utf8"));
  const pub = createPublicClient({ chain: foundry, transport: http(RPC) });
  const ownerAcc = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });
  const agentAcc = mnemonicToAccount(MNEMONIC, { addressIndex: 1 });
  const submitterAcc = mnemonicToAccount(MNEMONIC, { addressIndex: 2 });
  const merchant = mnemonicToAccount(MNEMONIC, { addressIndex: 3 }).address;
  const attackerAcc = mnemonicToAccount(MNEMONIC, { addressIndex: 4 });
  const attacker = attackerAcc.address;
  const owner = createWalletClient({ account: ownerAcc, chain: foundry, transport: http(RPC) });
  const agentW = createWalletClient({ account: agentAcc, chain: foundry, transport: http(RPC) });
  const submitter = createWalletClient({ account: submitterAcc, chain: foundry, transport: http(RPC) });
  const chainId = await pub.getChainId();

  async function deployVault(perTx: bigint, window: bigint, windowSecs: bigint, expiresIn: bigint): Promise<Address> {
    const tokenHash = await owner.deployContract({
      account: ownerAcc, chain: foundry, abi: tokenArtifact.abi as Abi, bytecode: tokenArtifact.bytecode.object as Hash,
    });
    const tokenReceipt = await pub.waitForTransactionReceipt({ hash: tokenHash });
    const token = tokenReceipt.contractAddress!;
    const block = await pub.getBlock({ blockTag: "latest" });
    const now = block.timestamp;
    const vaultHash = await owner.deployContract({
      account: ownerAcc, chain: foundry, abi: vaultArtifact.abi as Abi, bytecode: vaultArtifact.bytecode.object as Hash,
      args: [token, agentAcc.address, 1, 6, perTx, window, windowSecs, now, expiresIn === 0n ? 0n : now + expiresIn, [merchant], ("0x" + "11".repeat(32)) as Hash],
    });
    const vaultReceipt = await pub.waitForTransactionReceipt({ hash: vaultHash });
    const vault = vaultReceipt.contractAddress!;
    const mintHash = await owner.writeContract({
      account: ownerAcc, chain: foundry, address: token, abi: tokenArtifact.abi as Abi, functionName: "mint", args: [vault, 100_000_000n],
    });
    await pub.waitForTransactionReceipt({ hash: mintHash });
    return vault;
  }

  async function spend(vault: Address, to: Address, amount: bigint, signer = agentAcc) {
    const nonce = (await pub.readContract({ address: vault, abi: VAULT_ABI, functionName: "nonce" })) as bigint;
    // Deadline from ANVIL's clock, not the wall clock: after a warp,
    // Anvil time runs ahead of real time, and a wall-clock deadline
    // would already be expired (IntentExpired masking the real label).
    const block = await pub.getBlock({ blockTag: "latest" });
    const deadline = block.timestamp + 300n;
    const signed = await signEvmIntent(signer, chainId, vault, { to, amount, nonce, deadline });
    const res = await submitEvmSpend(pub, submitter, vault, signed);
    return { res, signed };
  }

  async function warpTo(ts: bigint) {
    await pub.request({ method: "anvil_setNextBlockTimestamp" as never, params: [`0x${ts.toString(16)}`] } as never);
    // Mine the warped block immediately, so the latest block IS the
    // warped time. Otherwise spend() would compute its deadline from
    // the pre-warp block and the warped spend could land past it
    // (IntentExpired masking the real label).
    await pub.request({ method: "evm_mine" as never, params: [] } as never);
  }

  // --- P0: V1-V14 in order ---
  const vault = await deployVault(2_000_000n, 5_000_000n, 86400n, 86400n);
  console.log(`P0 vault: ${vault}`);
  let v1Signed: Awaited<ReturnType<typeof signEvmIntent>> | null = null;
  // V1: merchant 1 -> ACCEPT
  {
    const { res, signed } = await spend(vault, merchant, 1_000_000n);
    v1Signed = signed;
    record("V1", "ACCEPT", res.ok ? "ACCEPT" : (res.label ?? "Reverted"), res.hash ?? null);
  }
  // V2: attacker 0.000001 -> RecipientNotAllowed
  {
    const { res } = await spend(vault, attacker, 1n);
    record("V2", "RecipientNotAllowed", res.ok ? "ACCEPT" : (res.label ?? "Reverted"), res.hash ?? null);
  }
  // V3: attacker, full balance -> RecipientNotAllowed
  {
    const { res } = await spend(vault, attacker, 100_000_000n);
    record("V3", "RecipientNotAllowed", res.ok ? "ACCEPT" : (res.label ?? "Reverted"), res.hash ?? null);
  }
  // V4: merchant 0 -> ZeroAmount
  {
    const { res } = await spend(vault, merchant, 0n);
    record("V4", "ZeroAmount", res.ok ? "ACCEPT" : (res.label ?? "Reverted"), res.hash ?? null);
  }
  // V5: merchant 2.000001 (spent 1) -> PerTxCapExceeded
  {
    const { res } = await spend(vault, merchant, 2_000_001n);
    record("V5", "PerTxCapExceeded", res.ok ? "ACCEPT" : (res.label ?? "Reverted"), res.hash ?? null);
  }
  // V6: merchant 2.0 (spent 1) -> ACCEPT (spent 3)
  {
    const { res } = await spend(vault, merchant, 2_000_000n);
    record("V6", "ACCEPT", res.ok ? "ACCEPT" : (res.label ?? "Reverted"), res.hash ?? null);
  }
  // V7: merchant 6.0 (spent 3) -> DailyCapExceeded
  {
    const { res } = await spend(vault, merchant, 6_000_000n);
    record("V7", "DailyCapExceeded", res.ok ? "ACCEPT" : (res.label ?? "Reverted"), res.hash ?? null);
  }
  // V8: merchant 2^64-1 (spent 3) -> DailyCapExceeded, no overflow
  {
    const { res } = await spend(vault, merchant, (2n ** 64n) - 1n);
    record("V8", "DailyCapExceeded", res.ok ? "ACCEPT" : (res.label ?? "Reverted"), res.hash ?? null);
  }
  // V9: merchant 2.0 (spent 3) -> ACCEPT (spent 5)
  {
    const { res } = await spend(vault, merchant, 2_000_000n);
    record("V9", "ACCEPT", res.ok ? "ACCEPT" : (res.label ?? "Reverted"), res.hash ?? null);
  }
  // V10: merchant 0.000001 (spent 5) -> DailyCapExceeded
  {
    const { res } = await spend(vault, merchant, 1n);
    record("V10", "DailyCapExceeded", res.ok ? "ACCEPT" : (res.label ?? "Reverted"), res.hash ?? null);
  }
  // V11: recipient = vault itself -> RecipientNotAllowed
  {
    const { res } = await spend(vault, vault, 1n);
    record("V11", "RecipientNotAllowed", res.ok ? "ACCEPT" : (res.label ?? "Reverted"), res.hash ?? null);
  }
  // V12: agent signs owner functions -> NotOwner (all four)
  {
    const attempts: { name: string; fn: string; args: unknown[] }[] = [
      { name: "setPolicy", fn: "setPolicy", args: [1, 6, 2_000_000n, 5_000_000n, 86400n, 0n, 0n, [merchant], ("0x" + "11".repeat(32)) as Hash] },
      { name: "setAgent", fn: "setAgent", args: [merchant] },
      { name: "setFrozen", fn: "setFrozen", args: [true] },
      { name: "withdraw", fn: "withdraw", args: [merchant, 1n] },
    ];
    let allNotOwner = true;
    for (const a of attempts) {
      try {
        const h = await agentW.writeContract({ account: agentAcc, chain: foundry, address: vault, abi: vaultArtifact.abi as Abi, functionName: a.fn, args: a.args as never });
        await pub.waitForTransactionReceipt({ hash: h });
        allNotOwner = false;
        console.log(`V12 ${a.name}: landed (unexpected)`);
      } catch (e) {
        const text = e instanceof Error ? e.message : String(e);
        const isNotOwner = text.includes("NotOwner");
        if (!isNotOwner) allNotOwner = false;
        console.log(`V12 ${a.name}: reverted NotOwner=${isNotOwner}`);
      }
    }
    record("V12", "NotOwner", allNotOwner ? "NotOwner" : "other", null, "plan says Unauthorized; implementations use NotOwner on both chains");
  }
  // V13: owner freezes -> merchant spend -> Frozen
  {
    const h = await owner.writeContract({ account: ownerAcc, chain: foundry, address: vault, abi: vaultArtifact.abi as Abi, functionName: "setFrozen", args: [true] });
    await pub.waitForTransactionReceipt({ hash: h });
    const { res } = await spend(vault, merchant, 1n);
    record("V13", "Frozen", res.ok ? "ACCEPT" : (res.label ?? "Reverted"), res.hash ?? null);
  }
  // V14: owner unfreezes -> merchant spend -> DailyCapExceeded (spent still 5)
  {
    const h = await owner.writeContract({ account: ownerAcc, chain: foundry, address: vault, abi: vaultArtifact.abi as Abi, functionName: "setFrozen", args: [false] });
    await pub.waitForTransactionReceipt({ hash: h });
    const { res } = await spend(vault, merchant, 1n);
    record("V14", "DailyCapExceeded", res.ok ? "ACCEPT" : (res.label ?? "Reverted"), res.hash ?? null);
  }
  // V17: resubmit V1's exact payload -> BadNonce (lands)
  {
    if (!v1Signed) throw new Error("V1 signed payload not saved");
    const res = await submitEvmSpend(pub, submitter, vault, v1Signed);
    record("V17", "BadNonce", res.ok ? "ACCEPT" : (res.label ?? "Reverted"), res.hash ?? null, "replay of V1 payload");
  }
  // V18: intent signed by attacker key -> Unauthorized
  {
    const { res } = await spend(vault, merchant, 1n, attackerAcc);
    record("V18", "Unauthorized", res.ok ? "ACCEPT" : (res.label ?? "Reverted"), res.hash ?? null, "attacker-signed intent");
  }
  // --- P1: V15 rollover ---
  {
    const p1 = await deployVault(2_000_000n, 5_000_000n, 300n, 86400n);
    console.log(`P1 vault: ${p1}`);
    const r1 = await spend(p1, merchant, 1_000_000n);
    console.log(`V15 setup spend: ok=${r1.res.ok}`);
    const block = await pub.getBlock({ blockTag: "latest" });
    await warpTo(block.timestamp + 301n);
    const { res } = await spend(p1, merchant, 1_000_000n);
    record("V15", "ACCEPT", res.ok ? "ACCEPT" : (res.label ?? "Reverted"), res.hash ?? null, "P1 window 300s, warped +301s");
  }
  // --- P2: V16 expiry ---
  {
    const p2 = await deployVault(2_000_000n, 5_000_000n, 86400n, 180n);
    console.log(`P2 vault: ${p2}`);
    const block = await pub.getBlock({ blockTag: "latest" });
    await warpTo(block.timestamp + 181n);
    const { res } = await spend(p2, merchant, 1n);
    record("V16", "SessionExpired", res.ok ? "ACCEPT" : (res.label ?? "Reverted"), res.hash ?? null, "P2 expiry +180s, warped +181s");
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\nEVM local: ${passed}/${results.length} pass`);
  mkdirSync(join(here, "..", "evidence", "T17"), { recursive: true });
  writeFileSync(join(here, "..", "evidence", "T17", "evm-local.json"), JSON.stringify({ chain: "evm", net: "local", passed, total: results.length, results }, null, 2));
  if (anvilProc) anvilProc.kill();
  if (passed !== results.length) process.exit(1);
}

main().catch((err) => { console.error(`FAIL ${err instanceof Error ? err.message : String(err)}`); process.exit(1); });
