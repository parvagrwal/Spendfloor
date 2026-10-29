// deploy-t16 (T16 EVM leg).
//
//   Testnet (run on the OWNER machine only):
//     cd ~/spendfloor/evm && forge build
//     cd ~/spendfloor && npx tsx sdk/deploy-t16.ts
//
//   Localnet (Anvil, no custody check, throwaway accounts):
//     SPENDFLOOR_LOCALNET=1 npx tsx sdk/deploy-t16.ts
//
// Deploys one SFUSD token plus three vaults (demo/P0, P1, P2) and mints
// 100 SFUSD to each vault, all from the OWNER key. The vault owner is the
// deployer (msg.sender) and the vault has no ownership transfer, so the
// testnet run MUST be the OWNER key; a submitter deploy would make the
// submitter the permanent vault owner (custody violation).
//
// Policies (SFUSD, 6 decimals):
//   demo/P0: per-tx 2, window 5, window 86,400 s, anchor = now,
//            expiry = now + 86,400, recipients = {demo merchant}
//   P1:     same, but window_seconds = 300 (short window for the V15
//            rollover vector in T17)
//   P2:     same, but expires_at = now + 180 s (near expiry for the V16
//            vector in T17)
// The demo merchant is receive-only; its keys are not stored anywhere.
// The EVM vaults take solSetHash = SHA-256 over the 32-byte Solana
// merchant address (the cross-chain set hash from T05/T14).
// This script NEVER prints key material.

import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
import { baseSepolia, foundry } from "viem/chains";
import { PublicKey } from "@solana/web3.js";
import {
  hasPrivateKey,
  loadEvmAccount,
  machineKind,
  registryAddress,
} from "./keys.js";

const EVM_MERCHANT = "0x61f1c99d674bcd333578AC4f538F46AbC7bB4106" as Address;
const SOL_MERCHANT = "8e6f1AWYV4unGiaoDciMkAXvPdUZvpNCtPK6pz2kmZhS";
const FUND = 100_000_000n; // 100 SFUSD, 6 decimals
const VERSION = 1;
const DECIMALS = 6;
const PER_TX = 2_000_000n;
const WINDOW = 5_000_000n;

const LOCALNET = process.env.SPENDFLOOR_LOCALNET === "1";
const RPC = LOCALNET
  ? "http://127.0.0.1:8545"
  : (process.env.SPENDFLOOR_EVM_RPC ?? "https://sepolia.base.org");
const CHAIN = LOCALNET ? foundry : baseSepolia;

const fail = (msg: string): never => {
  console.log(`FAIL  ${msg}`);
  process.exit(1);
};

const solSetHash = (): Hash => {
  const bytes = new PublicKey(SOL_MERCHANT).toBytes();
  return ("0x" + createHash("sha256").update(bytes).digest("hex")) as Hash;
};

// --- Accounts ---
let ownerAcc: ReturnType<typeof loadEvmAccount>;
let agentAddr: Address;
if (LOCALNET) {
  const mnemonic =
    "test test test test test test test test test test test junk";
  ownerAcc = mnemonicToAccount(mnemonic, {
    addressIndex: 0,
  }) as unknown as ReturnType<typeof loadEvmAccount>;
  agentAddr = mnemonicToAccount(mnemonic, { addressIndex: 1 }).address;
  console.log("mode: localnet (Anvil)");
} else {
  const kind = machineKind();
  if (kind !== "owner") {
    fail(`this machine is "${kind}", not "owner"; refusing to deploy`);
  }
  if (hasPrivateKey("evm", "agent")) {
    fail("AGENT EVM key exists on this owner machine (custody violation)");
  }
  if (hasPrivateKey("evm", "submitter")) {
    fail("SUBMITTER EVM key exists on this owner machine (custody violation)");
  }
  if (!hasPrivateKey("evm", "owner")) fail("OWNER EVM key absent on this machine");
  ownerAcc = loadEvmAccount("owner");
  const expectedOwner = registryAddress("evm", "owner");
  if (!expectedOwner || ownerAcc.address !== expectedOwner) {
    fail("OWNER local key does not match registry address");
  }
  const agent = registryAddress("evm", "agent");
  if (!agent) fail("registry missing agent address");
  agentAddr = agent as Address;
  console.log("mode: testnet (Base Sepolia)");
}
console.log(`owner: ${ownerAcc.address}`);
console.log(`agent: ${agentAddr}`);
console.log(`merchant (EVM): ${EVM_MERCHANT}`);
console.log(`merchant (SOL): ${SOL_MERCHANT}`);
console.log(`solSetHash: ${solSetHash()}`);

const pub = createPublicClient({ chain: CHAIN, transport: http(RPC) });
const wallet = createWalletClient({
  account: ownerAcc,
  chain: CHAIN,
  transport: http(RPC),
});

// --- Build + artifacts ---
const here = dirname(fileURLToPath(import.meta.url));
const evmDir = join(here, "..", "evm");
try {
  execSync("forge build", { cwd: evmDir, stdio: "ignore" });
} catch {
  fail("forge build failed (is Foundry on PATH?)");
}
const tokenArtifact = JSON.parse(
  readFileSync(join(evmDir, "out/SFUSD.sol/SFUSD.json"), "utf8"),
);
const vaultArtifact = JSON.parse(
  readFileSync(
    join(evmDir, "out/SpendFloorVault.sol/SpendFloorVault.json"),
    "utf8",
  ),
);

// --- Deploy SFUSD ---
const tokenHash = await wallet.deployContract({
  account: ownerAcc,
  chain: CHAIN,
  abi: tokenArtifact.abi as Abi,
  bytecode: tokenArtifact.bytecode.object as Hash,
});
const tokenReceipt = await pub.waitForTransactionReceipt({ hash: tokenHash });
if (tokenReceipt.status !== "success") fail("SFUSD deploy receipt failed");
const token = tokenReceipt.contractAddress!;
console.log(`SFUSD: ${token} (tx ${tokenHash})`);

// --- Deploy the three vaults ---
const now = BigInt(Math.floor(Date.now() / 1000));
const policies = [
  {
    name: "demo",
    windowSeconds: 86400n,
    expiry: now + 86400n,
  },
  {
    name: "P1",
    windowSeconds: 300n,
    expiry: now + 86400n,
  },
  {
    name: "P2",
    windowSeconds: 86400n,
    expiry: now + 180n,
  },
];
const vaults: Record<string, Address> = {};
for (const p of policies) {
  const hash = await wallet.deployContract({
    account: ownerAcc,
    chain: CHAIN,
    abi: vaultArtifact.abi as Abi,
    bytecode: vaultArtifact.bytecode.object as Hash,
    args: [
      token,
      agentAddr,
      VERSION,
      DECIMALS,
      PER_TX,
      WINDOW,
      p.windowSeconds,
      now,
      p.expiry,
      [EVM_MERCHANT],
      solSetHash(),
    ],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") fail(`${p.name} vault deploy receipt failed`);
  vaults[p.name] = receipt.contractAddress!;
  console.log(`${p.name} vault: ${vaults[p.name]} (tx ${hash})`);
}

// --- Mint 100 SFUSD to each vault ---
for (const p of policies) {
  const hash = await wallet.writeContract({
    account: ownerAcc,
    chain: CHAIN,
    address: token,
    abi: tokenArtifact.abi as Abi,
    functionName: "mint",
    args: [vaults[p.name], FUND],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") fail(`mint to ${p.name} vault failed`);
  console.log(`minted 100 SFUSD to ${p.name} vault (tx ${hash})`);
}

console.log("OK  T16 EVM deploy complete");
