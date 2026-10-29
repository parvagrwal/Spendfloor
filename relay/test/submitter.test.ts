// submitter.test (T19 relay tests).
//
// Run: npx tsx --test relay/test/submitter.test.ts (from repo root).
// Spawns Anvil when port 8545 is free, reuses a running Anvil, kills
// only what it spawned. No testnet spends: the testnet vaults stay fresh
// for T17/T20. The relay's Solana chain path is NOT tested here (no
// local validator on this VM); it is proven on devnet in T17/T20, where
// the agent uses the relay for real spends. The Solana relay code path
// is the SDK's submitSolSpend pattern with split signing (agent signs
// first, relay co-signs as fee payer).
//
// The agent key here is FRESH and unfunded (0 ETH), not an Anvil default
// account, so the "relay off" test is real: without the relay, the agent
// has no gas and no submitter key, so it cannot broadcast.

import assert from "node:assert/strict";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Address,
  type Hash,
  type PublicClient,
} from "viem";
import {
  generatePrivateKey,
  mnemonicToAccount,
  privateKeyToAccount,
} from "viem/accounts";
import { foundry } from "viem/chains";
import { Keypair } from "@solana/web3.js";
import {
  createRelay,
  DEFAULT_RELAY_CONFIG,
  RateLimiter,
  Relay,
} from "../submitter.js";
import { signEvmIntent, submitEvmSpend, VAULT_ABI } from "../../sdk/evm.js";

const EVM_RPC = "http://127.0.0.1:8545";
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
const DUMMY_SOL_SET_HASH = ("0x" + "11".repeat(32)) as Hash;

const here = dirname(fileURLToPath(import.meta.url));
const evmDir = join(here, "..", "..", "evm");

function homeBin(name: string, fallback: string): string {
  return existsSync(fallback) ? fallback : name;
}
async function rpcUp(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, {
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
async function waitForRpc(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await rpcUp(url)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`RPC did not come up: ${url}`);
}

let anvilProc: ChildProcess | null = null;
let evmOwner: ReturnType<typeof createWalletClient>;
let evmPublic: PublicClient;
let evmSubmitter: ReturnType<typeof createWalletClient>;
let evmToken: Address;
let vaultA: Address;
let vaultB: Address;
let agentAcc: ReturnType<typeof privateKeyToAccount>;
let merchant: Address;

test.before(async () => {
  // --- Anvil ---
  if (!(await rpcUp(EVM_RPC))) {
    const anvilBin = homeBin("anvil", `${process.env.HOME}/.foundry/bin/anvil`);
    anvilProc = spawn(anvilBin, ["--port", "8545"], { stdio: "ignore" });
    await waitForRpc(EVM_RPC, 30_000);
  }
  // --- Build + deploy ---
  const forgeBin = homeBin("forge", `${process.env.HOME}/.foundry/bin/forge`);
  execSync(`${forgeBin} build`, { cwd: evmDir, stdio: "ignore" });
  const tokenArtifact = JSON.parse(
    readFileSync(join(evmDir, "out/SFUSD.sol/SFUSD.json"), "utf8"),
  );
  const vaultArtifact = JSON.parse(
    readFileSync(
      join(evmDir, "out/SpendFloorVault.sol/SpendFloorVault.json"),
      "utf8",
    ),
  );
  const ownerAcc = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 0 });
  const submitterAcc = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 2 });
  merchant = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 3 }).address;
  agentAcc = privateKeyToAccount(generatePrivateKey()); // fresh, 0 ETH
  evmPublic = createPublicClient({
    chain: foundry,
    transport: http(EVM_RPC),
  }) as unknown as PublicClient;
  evmOwner = createWalletClient({
    account: ownerAcc,
    chain: foundry,
    transport: http(EVM_RPC),
  });
  evmSubmitter = createWalletClient({
    account: submitterAcc,
    chain: foundry,
    transport: http(EVM_RPC),
  });
  const tokenHash = await evmOwner.deployContract({
    account: ownerAcc,
    chain: foundry,
    abi: tokenArtifact.abi as Abi,
    bytecode: tokenArtifact.bytecode.object as Hash,
  });
  const tokenReceipt = await evmPublic.waitForTransactionReceipt({
    hash: tokenHash,
  });
  evmToken = tokenReceipt.contractAddress!;
  const deployVault = async (): Promise<Address> => {
    const h = await evmOwner.deployContract({
      account: ownerAcc,
      chain: foundry,
      abi: vaultArtifact.abi as Abi,
      bytecode: vaultArtifact.bytecode.object as Hash,
      args: [
        evmToken,
        agentAcc.address,
        1,
        6,
        2_000_000n,
        5_000_000n,
        86400n,
        0n,
        0n,
        [merchant],
        DUMMY_SOL_SET_HASH,
      ],
    });
    const r = await evmPublic.waitForTransactionReceipt({ hash: h });
    return r.contractAddress!;
  };
  vaultA = await deployVault();
  vaultB = await deployVault();
  for (const v of [vaultA, vaultB]) {
    const mh = await evmOwner.writeContract({
      account: ownerAcc,
      chain: foundry,
      address: evmToken,
      abi: tokenArtifact.abi as Abi,
      functionName: "mint",
      args: [v, 10_000_000n],
    });
    await evmPublic.waitForTransactionReceipt({ hash: mh });
  }
});

test.after(() => {
  if (anvilProc) anvilProc.kill();
});

const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 300);
async function spent(vault: Address): Promise<bigint> {
  return (await evmPublic.readContract({
    address: vault,
    abi: VAULT_ABI,
    functionName: "spentInWindow",
  })) as bigint;
}
async function nonce(vault: Address): Promise<bigint> {
  return (await evmPublic.readContract({
    address: vault,
    abi: VAULT_ABI,
    functionName: "nonce",
  })) as bigint;
}

test("relay on: V1 lands through the relay", async () => {
  const relay = createRelay(DEFAULT_RELAY_CONFIG, evmSubmitter, Keypair.generate(), {
    localnet: true,
  });
  relay.start();
  const signed = await signEvmIntent(agentAcc, 31337, vaultA, {
    to: merchant,
    amount: 1_000_000n,
    nonce: 0n,
    deadline: deadline(),
  });
  const res = await relay.submitEvm("agent", vaultA, signed);
  assert.equal(res.ok, true, `V1 via relay failed: ${res.label}`);
  assert.ok(res.hash, "V1 via relay has no hash");
  assert.equal(await spent(vaultA), 1_000_000n);
  assert.equal(await nonce(vaultA), 1n);
  relay.stop();
});

test("relay off: agent cannot spend (fails closed)", async () => {
  const relay = createRelay(DEFAULT_RELAY_CONFIG, evmSubmitter, Keypair.generate(), {
    localnet: true,
  });
  // Never started: submit must throw before any broadcast.
  await assert.rejects(
    () =>
      relay.submitEvm("agent", vaultA, {
        to: merchant,
        amount: 1_000_000n,
        nonce: 1n,
        deadline: deadline(),
        v: 27,
        r: ("0x" + "00".repeat(32)) as Hash,
        s: ("0x" + "00".repeat(32)) as Hash,
      }),
    /relay is off/,
  );
  assert.equal(await spent(vaultA), 1_000_000n, "off relay must not move spent");
  assert.equal(await nonce(vaultA), 1n, "off relay must not move nonce");
  // Direct submit by the unfunded agent key must also fail: the agent
  // signs a valid intent but cannot pay gas to broadcast it, so the
  // spend never lands (no hash) and vault state is unchanged.
  const agentWallet = createWalletClient({
    account: agentAcc,
    chain: foundry,
    transport: http(EVM_RPC),
  });
  const directSigned = await signEvmIntent(agentAcc, 31337, vaultA, {
    to: merchant,
    amount: 1_000_000n,
    nonce: 1n,
    deadline: deadline(),
  });
  const direct = await submitEvmSpend(evmPublic, agentWallet, vaultA, directSigned);
  assert.equal(direct.ok, false, "direct agent submit must not land");
  assert.equal(direct.label, "SubmitFailed");
  assert.equal(direct.hash, undefined, "direct agent submit must not broadcast");
  assert.equal(await spent(vaultA), 1_000_000n, "direct submit must not move spent");
  assert.equal(await nonce(vaultA), 1n, "direct submit must not move nonce");
});

test("relay forwards over-cap spend; vault rejects it (no policy in relay)", async () => {
  const relay = createRelay(DEFAULT_RELAY_CONFIG, evmSubmitter, Keypair.generate(), {
    localnet: true,
  });
  relay.start();
  const signed = await signEvmIntent(agentAcc, 31337, vaultA, {
    to: merchant,
    amount: 3_000_000n, // over the 2,000,000 per-tx cap
    nonce: 1n,
    deadline: deadline(),
  });
  const res = await relay.submitEvm("agent", vaultA, signed);
  assert.equal(res.ok, false, "over-cap spend must not land ok");
  assert.equal(res.label, "PerTxCapExceeded");
  assert.ok(res.hash, "rejected spend must still carry its hash");
  assert.equal(await spent(vaultA), 1_000_000n, "revert must not move spent");
  assert.equal(await nonce(vaultA), 1n, "revert must not move nonce");
  relay.stop();
});

test("rate limit: third submit in a minute is rejected", async () => {
  const cfg = { ...DEFAULT_RELAY_CONFIG, maxPerMinutePerAgent: 2 };
  const relay = createRelay(cfg, evmSubmitter, Keypair.generate(), {
    localnet: true,
  });
  relay.start();
  for (let i = 0; i < 2; i++) {
    const signed = await signEvmIntent(agentAcc, 31337, vaultB, {
      to: merchant,
      amount: 1_000_000n,
      nonce: BigInt(i),
      deadline: deadline(),
    });
    const res = await relay.submitEvm("agent", vaultB, signed);
    assert.equal(res.ok, true, `rate-limit setup spend ${i} failed`);
  }
  const third = await signEvmIntent(agentAcc, 31337, vaultB, {
    to: merchant,
    amount: 1_000_000n,
    nonce: 2n,
    deadline: deadline(),
  });
  await assert.rejects(() => relay.submitEvm("agent", vaultB, third), /rate limit/);
  assert.equal(await spent(vaultB), 2_000_000n, "rate-limited spend must not land");
  assert.equal(await nonce(vaultB), 2n);
  relay.stop();
});

test("rate limiter unit test (no chain)", () => {
  const lim = new RateLimiter({
    ...DEFAULT_RELAY_CONFIG,
    maxPerMinutePerAgent: 2,
    maxPerMinuteGlobal: 100,
  });
  lim.check("a");
  lim.check("a");
  assert.throws(() => lim.check("a"), /rate limit/);
  lim.check("b"); // a different agent is unaffected
});

test("relay off unit test (no chain, never started)", async () => {
  const relay = new Relay(
    DEFAULT_RELAY_CONFIG,
    createPublicClient({ chain: foundry, transport: http(EVM_RPC) }),
    evmSubmitter as unknown as Parameters<typeof createRelay>[1],
    // @ts-expect-error dummy connection: submit throws before any RPC use
    null,
    Keypair.generate(),
  );
  await assert.rejects(
    () =>
      relay.submitEvm("agent", vaultA, {
        to: merchant,
        amount: 1_000_000n,
        nonce: 0n,
        deadline: deadline(),
        v: 27,
        r: ("0x" + "00".repeat(32)) as Hash,
        s: ("0x" + "00".repeat(32)) as Hash,
      }),
    /relay is off/,
  );
});
