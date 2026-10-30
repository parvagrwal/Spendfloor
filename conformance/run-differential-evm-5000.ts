// Differential EVM runner (T31). Replays the generator's sequence
// on a fresh Anvil vault and compares every outcome + state to
// decide()'s expected values (from differential-inputs.txt).
// Time: Anvil cannot go backwards to 1970, so the vault's anchor
// (deploy time) differs from the generator's ANCHOR by an offset;
// every spend warps to (now + offset), which preserves all window
// and expiry comparisons exactly (they are all differences).
// Run: npx tsx conformance/run-differential-evm.ts
// Requires Anvil on 127.0.0.1:8545 (starts one if absent).
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
const evmOut = join(here, "..", "evidence", "T31");
mkdirSync(evmOut, { recursive: true });

const ANCHOR = 1_000_000n;

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

  // Header: policy + expiry from the inputs file.
  const txt = readFileSync(join(evmOut, "differential-inputs-5000.txt"), "utf8");
  const header = txt.split("\n").find((l) => l.startsWith("# policy"))!;
  const expiry = BigInt(header.split("expiry ")[1].split(" ")[0]);
  const expiresIn = expiry - ANCHOR;

  // Deploy (anchor = deploy block time; offset computed after).
  const tokenHash = await owner.deployContract({
    account: ownerAcc, chain: foundry, abi: tokenArtifact.abi as Abi, bytecode: tokenArtifact.bytecode.object as Hash,
  });
  const tokenReceipt = await pub.waitForTransactionReceipt({ hash: tokenHash });
  const token = tokenReceipt.contractAddress!;
  const block0 = await pub.getBlock({ blockTag: "latest" });
  const deployNow = block0.timestamp;
  const vaultHash = await owner.deployContract({
    account: ownerAcc, chain: foundry, abi: vaultArtifact.abi as Abi, bytecode: vaultArtifact.bytecode.object as Hash,
    args: [token, agentAcc.address, 1, 6, 2_000_000n, 5_000_000n, 86400n, deployNow, deployNow + expiresIn, [merchant], ("0x" + "11".repeat(32)) as Hash],
  });
  const vaultReceipt = await pub.waitForTransactionReceipt({ hash: vaultHash });
  const vault = vaultReceipt.contractAddress!;
  const mintHash = await owner.writeContract({
    account: ownerAcc, chain: foundry, address: token, abi: tokenArtifact.abi as Abi, functionName: "mint", args: [vault, 1_000_000_000_000n],
  });
  await pub.waitForTransactionReceipt({ hash: mintHash });

  const policy = (await pub.readContract({ address: vault, abi: VAULT_ABI, functionName: "policy" })) as unknown as [number, number, bigint, bigint, bigint, bigint, bigint, Hash];
  const vaultAnchor = policy[5];
  const vaultExpiry = policy[6];
  const offset = vaultAnchor - ANCHOR;
  if (vaultExpiry !== expiry + offset) throw new Error(`expiry mismatch: vault ${vaultExpiry} vs expected ${expiry + offset}`);
  console.log(`vault ${vault} anchor ${vaultAnchor} expiry ${vaultExpiry} offset ${offset}`);

  async function warpTo(ts: bigint) {
    await pub.request({ method: "anvil_setNextBlockTimestamp" as never, params: [`0x${ts.toString(16)}`] } as never);
    await pub.request({ method: "evm_mine" as never, params: [] } as never);
  }

  const lines = txt.split("\n").filter((l) => l && !l.startsWith("#"));
  let spends = 0;
  let divergences = 0;
  const divList: string[] = [];
  const labelCounts = new Map<string, number>();
  for (const line of lines) {
    if (line === "FREEZE" || line === "UNFREEZE") {
      const h = await owner.writeContract({ account: ownerAcc, chain: foundry, address: vault, abi: vaultArtifact.abi as Abi, functionName: "setFrozen", args: [line === "FREEZE"] });
      await pub.waitForTransactionReceipt({ hash: h });
      continue;
    }
    const parts = line.split(",");
    // SPEND,i,now,amount,rk,sk,expectedLabel,expectedSpent,expectedWindow
    const [, , nowS, amountS, rk, sk, expLabel, expSpentS, expWindowS] = parts;
    const now = BigInt(nowS);
    const amount = BigInt(amountS);
    const to: Address = rk === "M" ? merchant : rk === "A" ? attacker : vault;
    const signer = sk === "G" ? agentAcc : attackerAcc;
    await warpTo(now + offset);
    const nonce = (await pub.readContract({ address: vault, abi: VAULT_ABI, functionName: "nonce" })) as bigint;
    const block = await pub.getBlock({ blockTag: "latest" });
    const deadline = block.timestamp + 100n;
    const signed = await signEvmIntent(signer, chainId, vault, { to, amount, nonce, deadline });
    const res = await submitEvmSpend(pub, submitter, vault, signed);
    const actualLabel = res.ok ? "ACCEPT" : (res.label ?? "Reverted");
    const spent = (await pub.readContract({ address: vault, abi: VAULT_ABI, functionName: "spentInWindow" })) as bigint;
    const window = (await pub.readContract({ address: vault, abi: VAULT_ABI, functionName: "currentWindow" })) as bigint;
    labelCounts.set(actualLabel, (labelCounts.get(actualLabel) ?? 0) + 1);
    spends++;
    if (actualLabel !== expLabel || spent !== BigInt(expSpentS) || window !== BigInt(expWindowS)) {
      divergences++;
      divList.push(`${line} | actual label ${actualLabel} spent ${spent} window ${window}`);
      if (divergences <= 10) console.log(`DIVERGENCE: ${divList[divList.length - 1]}`);
    }
    if (spends % 1000 === 0) console.log(`... ${spends} spends, ${divergences} divergences`);
  }

  const summary = {
    chain: "evm",
    spends,
    divergences,
    labelCounts: Object.fromEntries(labelCounts),
    firstDivergences: divList.slice(0, 20),
    vault,
    anchor: vaultAnchor.toString(),
    expiry: vaultExpiry.toString(),
    offset: offset.toString(),
  };
  writeFileSync(join(evmOut, "differential-evm-5000.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(`EVM done: ${spends} spends, ${divergences} divergences`);
  console.log("label counts:", JSON.stringify(summary.labelCounts));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
