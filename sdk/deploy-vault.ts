// deploy-vault (T06 Sepolia leg, step 1 of 2).
//
//   Run on the OWNER machine only:
//     cd ~/spendfloor/evm && forge build
//     cd ~/spendfloor && npx tsx sdk/deploy-vault.ts
//
// Deploys the spike vault, then funds it, both from the OWNER key.
// Prints the vault address: send that address to Muse for the spend leg.
// Custody pre-flight (mirrors fund-check): this machine must be the owner
// machine, the OWNER key must match the registry, and no AGENT or SUBMITTER
// key may exist here. Any violation exits 1 before anything is sent.
// This script NEVER prints key material. Exit 0 only when both receipts
// show status success. The bytecode was compiled with evm_version=cancun
// per evm/foundry.toml; a successful deploy is T06 criterion 6.

import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseEther,
} from "viem";
import { baseSepolia } from "viem/chains";
import {
  hasPrivateKey,
  loadEvmAccount,
  machineKind,
  registryAddress,
} from "./keys.js";

const RPC = process.env.SPENDFLOOR_EVM_RPC ?? "https://sepolia.base.org";
const DAILY_CAP = parseEther("0.002");
const PER_TX_CAP = parseEther("0.0005");
const FUND = parseEther("0.005");
const GAS_BUFFER = parseEther("0.002");

const fail = (msg: string): never => {
  console.log(`FAIL  ${msg}`);
  process.exit(1);
};

// --- Custody pre-flight ---
const kind = machineKind();
if (kind !== "owner") fail(`this machine is "${kind}", not "owner"; refusing to deploy`);
if (hasPrivateKey("evm", "agent")) fail("AGENT EVM key exists on this owner machine (custody violation)");
if (hasPrivateKey("evm", "submitter")) fail("SUBMITTER EVM key exists on this owner machine (custody violation)");
if (!hasPrivateKey("evm", "owner")) fail("OWNER EVM key absent on this machine");
const owner = loadEvmAccount("owner");
const expectedOwner = registryAddress("evm", "owner");
if (!expectedOwner || owner.address !== expectedOwner) {
  fail("OWNER local key does not match registry address");
}
const agent = registryAddress("evm", "agent");
const submitter = registryAddress("evm", "submitter");
if (!agent || !submitter) fail("registry missing agent or submitter address");
console.log(`machine: ${kind}`);
console.log(`owner: ${owner.address}`);
console.log(`agent: ${agent}`);
console.log(`allowlist: ${expectedOwner}, ${submitter}`);
console.log(`dailyCap: ${formatEther(DAILY_CAP)} ETH, perTxCap: ${formatEther(PER_TX_CAP)} ETH, fund: ${formatEther(FUND)} ETH`);
console.log(`rpc: ${RPC}`);
console.log("");

// --- Artifact (forge build must have run in evm/ first) ---
const artifactUrl = new URL("../evm/out/Vault.sol/Vault.json", import.meta.url);
function loadArtifact(): { abi: any; bytecode: { object: string } } {
  try {
    return JSON.parse(readFileSync(artifactUrl, "utf8")) as { abi: any; bytecode: { object: string } };
  } catch {
    return fail("Vault artifact not found at evm/out/Vault.sol/Vault.json (run: cd evm && forge build)");
  }
}
const artifact = loadArtifact();
if (!artifact.bytecode?.object || artifact.bytecode.object === "0x") {
  fail("Vault artifact has empty bytecode");
}

// --- Balance pre-check ---
const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
const walletClient = createWalletClient({ account: owner, chain: baseSepolia, transport: http(RPC) });
const ownerBalance = await publicClient.getBalance({ address: owner.address });
console.log(`owner balance before: ${formatEther(ownerBalance)} ETH`);
if (ownerBalance < FUND + GAS_BUFFER) {
  fail(`owner balance ${formatEther(ownerBalance)} ETH below fund + gas buffer ${formatEther(FUND + GAS_BUFFER)} ETH`);
}

// --- Deploy ---
console.log("deploying vault...");
const deployHash = await walletClient.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode.object as `0x${string}`,
  args: [agent as `0x${string}`, [expectedOwner as `0x${string}`, submitter as `0x${string}`], DAILY_CAP, PER_TX_CAP],
});
console.log(`deploy tx: ${deployHash}`);
const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash, timeout: 120_000 });
console.log(`deploy receipt: status=${deployReceipt.status} block=${deployReceipt.blockNumber}`);
if (deployReceipt.status !== "success") fail("deploy receipt status is not success");
const vault = deployReceipt.contractAddress ?? fail("deploy receipt has no contract address");
console.log(`vault: ${vault}`);
console.log("evm_version=cancun bytecode deployed: T06 criterion 6 satisfied");

// --- Fund ---
console.log(`funding vault with ${formatEther(FUND)} ETH...`);
const fundHash = await walletClient.sendTransaction({ to: vault, value: FUND });
console.log(`fund tx: ${fundHash}`);
const fundReceipt = await publicClient.waitForTransactionReceipt({ hash: fundHash, timeout: 120_000 });
console.log(`fund receipt: status=${fundReceipt.status} block=${fundReceipt.blockNumber}`);
if (fundReceipt.status !== "success") fail("fund receipt status is not success");
const vaultBalance = await publicClient.getBalance({ address: vault });
const ownerAfter = await publicClient.getBalance({ address: owner.address });
console.log(`vault balance: ${formatEther(vaultBalance)} ETH`);
console.log(`owner balance after: ${formatEther(ownerAfter)} ETH`);
console.log("");
console.log(`deploy-vault: PASS :: vault=${vault} deploy=${deployHash} fund=${fundHash}`);
console.log("NEXT: send the vault address to Muse for the Sepolia spend leg.");
