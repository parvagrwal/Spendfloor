// Precedence matrix EVM runner (T33). Replays the 80 feasible cases from
// evidence/T33/precedence-matrix.txt on fresh Anvil vaults (one vault per
// case, so spent/policy state never leaks between cases) and compares each
// outcome label to decide()'s expected winner.
// Time: like T31, Anvil cannot go to 1970, so the vault's anchor is deploy
// time; every case warps to (now + offset) where offset = vaultAnchor - 1000,
// which preserves all window and expiry comparisons exactly.
// Run: npx tsx conformance/run-precedence-evm.ts
// Requires Anvil on 127.0.0.1:8545 (starts one if absent). Do NOT run while
// the T31 EVM runner holds port 8545.
import { spawn, type ChildProcess } from "node:child_process";
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
const outDir = join(here, "..", "evidence", "T33");
mkdirSync(outDir, { recursive: true });

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
  let anvil: ChildProcess | null = null;
  if (!(await rpcUp())) {
    anvil = spawn("anvil", ["--port", "8545"], { stdio: "ignore", detached: true });
    for (let i = 0; i < 30 && !(await rpcUp()); i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!(await rpcUp())) throw new Error("Anvil did not come up");
  }
  try {
    await run();
  } finally {
    if (anvil) {
      try {
        process.kill(-anvil.pid!);
      } catch {
        /* already gone */
      }
    }
  }
}

async function run() {
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
  const submitter = createWalletClient({ account: submitterAcc, chain: foundry, transport: http(RPC) });
  const chainId = await pub.getChainId();

  async function warpTo(ts: bigint) {
    await pub.request({ method: "anvil_setNextBlockTimestamp" as never, params: [`0x${ts.toString(16)}`] } as never);
    await pub.request({ method: "evm_mine" as never, params: [] } as never);
  }

  const txt = readFileSync(join(outDir, "precedence-matrix.txt"), "utf8");
  const cases = txt.split("\n").filter((l) => l.startsWith("CASE,"));
  let mismatches = 0;
  const mismatchList: string[] = [];
  let done = 0;
  for (const line of cases) {
    // CASE,idx,subset,signer,frozen,now,expiry,amount,spent,recipient,expectedWinner
    const [, idxS, , signerS, frozenS, nowS, expiryS, amountS, spentS, recipS, expected] = line.split(",");
    const now = BigInt(nowS);
    const expiry = BigInt(expiryS);
    const amount = BigInt(amountS);
    const targetSpent = BigInt(spentS);
    const to: Address = recipS === "M" ? merchant : attacker;
    const signer = signerS === "G" ? agentAcc : attackerAcc;

    // Fresh vault per case: anchor = deploy time, expiry = deploy + (expiry - 1000).
    const tokenHash = await owner.deployContract({
      account: ownerAcc, chain: foundry, abi: tokenArtifact.abi as Abi, bytecode: tokenArtifact.bytecode.object as Hash,
    });
    const tokenReceipt = await pub.waitForTransactionReceipt({ hash: tokenHash });
    const token = tokenReceipt.contractAddress!;
    const block0 = await pub.getBlock({ blockTag: "latest" });
    const deployNow = block0.timestamp;
    const vaultHash = await owner.deployContract({
      account: ownerAcc, chain: foundry, abi: vaultArtifact.abi as Abi, bytecode: vaultArtifact.bytecode.object as Hash,
      args: [token, agentAcc.address, 1, 6, 2_000_000n, 5_000_000n, 86400n, deployNow, deployNow + (expiry - 1000n), [merchant], ("0x" + "11".repeat(32)) as Hash],
    });
    const vaultReceipt = await pub.waitForTransactionReceipt({ hash: vaultHash });
    const vault = vaultReceipt.contractAddress!;
    const mintHash = await owner.writeContract({
      account: ownerAcc, chain: foundry, address: token, abi: tokenArtifact.abi as Abi, functionName: "mint", args: [vault, 1_000_000_000_000n],
    });
    await pub.waitForTransactionReceipt({ hash: mintHash });
    const policy = (await pub.readContract({ address: vault, abi: VAULT_ABI, functionName: "policy" })) as unknown as [number, number, bigint, bigint, bigint, bigint, bigint, Hash];
    const vaultAnchor = policy[5];
    const offset = vaultAnchor - 1000n;

    await warpTo(now + offset);
    // Buildup spends first (vault unfrozen), so spent reaches the target.
    // Skip buildup when the session is already expired (now >= expiry):
    // no spend can land in an expired session, and SessionExpired (like
    // Unauthorized/Frozen) outranks the cap checks, so spent cannot change
    // the case outcome. (Cases 36-39, 44-47 have now == expiry, spent > 0.)
    let spent = 0n;
    while (now < expiry && spent < targetSpent) {
      const nonce = (await pub.readContract({ address: vault, abi: VAULT_ABI, functionName: "nonce" })) as bigint;
      const block = await pub.getBlock({ blockTag: "latest" });
      const signed = await signEvmIntent(agentAcc, chainId, vault, { to: merchant, amount: 2_000_000n, nonce, deadline: block.timestamp + 100n });
      const res = await submitEvmSpend(pub, submitter, vault, signed);
      if (!res.ok) throw new Error(`case ${idxS} buildup failed: ${res.label}`);
      spent = (await pub.readContract({ address: vault, abi: VAULT_ABI, functionName: "spentInWindow" })) as bigint;
      if (spent > targetSpent) throw new Error(`case ${idxS} buildup overshot: spent ${spent} target ${targetSpent}`);
    }
    if (frozenS === "1") {
      const h = await owner.writeContract({ account: ownerAcc, chain: foundry, address: vault, abi: vaultArtifact.abi as Abi, functionName: "setFrozen", args: [true] });
      await pub.waitForTransactionReceipt({ hash: h });
    }
    const nonce = (await pub.readContract({ address: vault, abi: VAULT_ABI, functionName: "nonce" })) as bigint;
    const block = await pub.getBlock({ blockTag: "latest" });
    const signed = await signEvmIntent(signer, chainId, vault, { to, amount, nonce, deadline: block.timestamp + 100n });
    const res = await submitEvmSpend(pub, submitter, vault, signed);
    const actual = res.ok ? "ACCEPT" : (res.label ?? "Reverted");
    done++;
    if (actual !== expected) {
      mismatches++;
      mismatchList.push(`${line} | actual ${actual}`);
      console.log(`MISMATCH: ${mismatchList[mismatchList.length - 1]}`);
    }
    if (done % 20 === 0) console.log(`... ${done} cases, ${mismatches} mismatches`);
  }

  const summary = { chain: "evm", cases: done, mismatches, mismatchList: mismatchList.slice(0, 20) };
  writeFileSync(join(outDir, "precedence-evm.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(`EVM precedence done: ${done} cases, ${mismatches} mismatches`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
