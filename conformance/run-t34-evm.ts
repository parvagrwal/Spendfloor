// Per-field tamper + replay matrix, EVM side (T34). Mirrors the SOL t34 test
// (4/4) with the EVM's EIP-712 field set: each signed field tampered one at
// a time -> Unauthorized; replay rejected after agent rotation, on a frozen
// vault, and against a second deployment.
// Run: npx tsx conformance/run-t34-evm.ts
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
const outDir = join(here, "..", "evidence", "T34");
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
  const newAgentAcc = mnemonicToAccount(MNEMONIC, { addressIndex: 5 });
  const owner = createWalletClient({ account: ownerAcc, chain: foundry, transport: http(RPC) });
  const submitter = createWalletClient({ account: submitterAcc, chain: foundry, transport: http(RPC) });
  const chainId = await pub.getChainId();

  async function deployVault(): Promise<Address> {
    const tokenHash = await owner.deployContract({
      account: ownerAcc, chain: foundry, abi: tokenArtifact.abi as Abi, bytecode: tokenArtifact.bytecode.object as Hash,
    });
    const tokenReceipt = await pub.waitForTransactionReceipt({ hash: tokenHash });
    const token = tokenReceipt.contractAddress!;
    const block0 = await pub.getBlock({ blockTag: "latest" });
    const deployNow = block0.timestamp;
    const vaultHash = await owner.deployContract({
      account: ownerAcc, chain: foundry, abi: vaultArtifact.abi as Abi, bytecode: vaultArtifact.bytecode.object as Hash,
      args: [token, agentAcc.address, 1, 6, 2_000_000n, 5_000_000n, 86400n, deployNow, deployNow + 864000n, [merchant], ("0x" + "11".repeat(32)) as Hash],
    });
    const vaultReceipt = await pub.waitForTransactionReceipt({ hash: vaultHash });
    const vault = vaultReceipt.contractAddress!;
    const mintHash = await owner.writeContract({
      account: ownerAcc, chain: foundry, address: token, abi: tokenArtifact.abi as Abi, functionName: "mint", args: [vault, 1_000_000_000_000n],
    });
    await pub.waitForTransactionReceipt({ hash: mintHash });
    return vault;
  }

  async function freshIntent(vault: Address, signer: typeof agentAcc, to: Address, amount: bigint) {
    const nonce = (await pub.readContract({ address: vault, abi: VAULT_ABI, functionName: "nonce" })) as bigint;
    const block = await pub.getBlock({ blockTag: "latest" });
    return signEvmIntent(signer, chainId, vault, { to, amount, nonce, deadline: block.timestamp + 100n });
  }

  const vault = await deployVault();
  const checks: { name: string; expected: string; actual: string; pass: boolean }[] = [];
  async function check(name: string, expected: string, actual: string) {
    const pass = actual === expected;
    checks.push({ name, expected, actual, pass });
    console.log(`${pass ? "PASS" : "FAIL"}: ${name} (expected ${expected}, got ${actual})`);
  }

  // 1. Baseline valid spend.
  {
    const signed = await freshIntent(vault, agentAcc, merchant, 1_000_000n);
    const res = await submitEvmSpend(pub, submitter, vault, signed);
    await check("baseline valid spend", "ACCEPT", res.ok ? "ACCEPT" : (res.label ?? "Reverted"));
  }
  // 2-7. Field tampers (one field changed, original signature kept).
  {
    const base = await freshIntent(vault, agentAcc, merchant, 1_000_000n);
    const variants: [string, object][] = [
      ["tamper to (merchant -> attacker)", { to: attacker }],
      ["tamper amount (1 -> 2 SFUSD)", { amount: 2_000_000n }],
      ["tamper deadline (+1s)", { deadline: base.deadline + 1n }],
      ["tamper nonce (+1)", { nonce: base.nonce + 1n }],
    ];
    for (const [name, override] of variants) {
      const res = await submitEvmSpend(pub, submitter, vault, { ...base, ...override });
      await check(name, "Unauthorized", res.ok ? "ACCEPT" : (res.label ?? "Reverted"));
    }
    // Tamper chainId: sign under chainId 1, submit to the real vault.
    const wrongChain = await signEvmIntent(agentAcc, 1, vault, { to: merchant, amount: 1_000_000n, nonce: base.nonce, deadline: base.deadline });
    const resChain = await submitEvmSpend(pub, submitter, vault, wrongChain);
    await check("tamper chainId (sign 1, submit 31337)", "Unauthorized", resChain.ok ? "ACCEPT" : (resChain.label ?? "Reverted"));
    // Tamper domain: sign for a dummy verifyingContract, submit to the real vault.
    const dummyVault = "0x0000000000000000000000000000000000000001" as Address;
    const wrongDomain = await signEvmIntent(agentAcc, chainId, dummyVault, { to: merchant, amount: 1_000_000n, nonce: base.nonce, deadline: base.deadline });
    const resDomain = await submitEvmSpend(pub, submitter, vault, wrongDomain);
    await check("tamper domain (sign dummy vault, submit real vault)", "Unauthorized", resDomain.ok ? "ACCEPT" : (resDomain.label ?? "Reverted"));
  }
  // 8. Replay after rotation: old agent's fresh intent, after setAgent(new).
  {
    const h = await owner.writeContract({ account: ownerAcc, chain: foundry, address: vault, abi: vaultArtifact.abi as Abi, functionName: "setAgent", args: [newAgentAcc.address] });
    await pub.waitForTransactionReceipt({ hash: h });
    const signed = await freshIntent(vault, agentAcc, merchant, 1_000_000n);
    const res = await submitEvmSpend(pub, submitter, vault, signed);
    await check("replay after rotation (old agent signs)", "Unauthorized", res.ok ? "ACCEPT" : (res.label ?? "Reverted"));
  }
  // 9. Replay on frozen: current agent's fresh intent, after setFrozen(true).
  {
    const h = await owner.writeContract({ account: ownerAcc, chain: foundry, address: vault, abi: vaultArtifact.abi as Abi, functionName: "setFrozen", args: [true] });
    await pub.waitForTransactionReceipt({ hash: h });
    const signed = await freshIntent(vault, newAgentAcc, merchant, 1_000_000n);
    const res = await submitEvmSpend(pub, submitter, vault, signed);
    await check("replay on frozen (current agent signs)", "Frozen", res.ok ? "ACCEPT" : (res.label ?? "Reverted"));
  }
  // 10. Second deployment: vault1-signed intent submitted to vault2.
  {
    const vault2 = await deployVault();
    const signed = await freshIntent(vault, newAgentAcc, merchant, 1_000_000n);
    const res = await submitEvmSpend(pub, submitter, vault2, signed);
    await check("second deployment (vault1 sig to vault2)", "Unauthorized", res.ok ? "ACCEPT" : (res.label ?? "Reverted"));
  }

  const failed = checks.filter((c) => !c.pass);
  const summary = { chain: "evm", checks: checks.length, passed: checks.length - failed.length, failed: failed.map((c) => c.name), detail: checks };
  writeFileSync(join(outDir, "evm-run.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(`EVM T34 done: ${checks.length - failed.length}/${checks.length} pass`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
