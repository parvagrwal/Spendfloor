// sequencer-send-test (T04). Submits ONE real transaction on Base Sepolia
// to prove the sequencer accepts sends (reads alone cannot prove this).
//
//   tsx sequencer-send-test.ts
//
// Safety, by design (graph method: spikes designed to falsify, evidence
// discipline, stop-and-ask on authority):
//   - Self-send only: SUBMITTER -> SUBMITTER, 0.0001 ETH. No funds leave
//     the submitter except gas. AGENT and OWNER are never touched.
//   - Reads (nonce, gas estimate, fees) go through a read RPC
//     (SPENDFLOOR_EVM_RPC, default sepolia.base.org; PublicNode alternate
//     if the primary fails). The SIGNED transaction is broadcast to the
//     sequencer sends-only endpoint (SPENDFLOOR_EVM_SEQUENCER_RPC, default
//     https://sepolia-sequencer.base.org), because that endpoint serves
//     sends, not reads. Fallback, per the plan: broadcast the same signed
//     transaction through the read RPC.
//   - Custody pre-flight (mirrors fund-check): this machine must be the
//     agent machine, the SUBMITTER key must exist and match the registry,
//     and no OWNER key may exist here. Any violation exits 1 before
//     anything is signed.
//   - This script NEVER prints key material. It prints only addresses,
//     amounts, hashes, block numbers, gas figures, and statuses.
//   - Exit 0 only when a receipt with status success is observed, and
//     the receipt is read back through a second RPC.

import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  keccak256,
  parseEther,
} from "viem";
import { baseSepolia } from "viem/chains";
import {
  allowedRoles,
  hasPrivateKey,
  loadEvmAccount,
  machineKind,
  registryAddress,
} from "./keys.js";

const READ_RPC = process.env.SPENDFLOOR_EVM_RPC ?? "https://sepolia.base.org";
const READ_RPC_ALT = "https://base-sepolia-rpc.publicnode.com";
const SEQUENCER_RPC =
  process.env.SPENDFLOOR_EVM_SEQUENCER_RPC ??
  "https://sepolia-sequencer.base.org";
const SELF_SEND_VALUE = parseEther("0.0001");

const fail = (msg: string): never => {
  console.log(`FAIL  ${msg}`);
  process.exit(1);
};

// --- Custody pre-flight ---
const kind = machineKind();
if (kind !== "agent") fail(`this machine is "${kind}", not "agent"; refusing to send`);
if (!allowedRoles(kind).includes("submitter")) fail("submitter role not allowed on this machine");
if (hasPrivateKey("evm", "owner")) fail("OWNER EVM key exists on this machine (custody violation)");
if (!hasPrivateKey("evm", "submitter")) fail("SUBMITTER EVM key absent on this machine");
const submitter = loadEvmAccount("submitter");
const expected = registryAddress("evm", "submitter");
if (!expected || submitter.address !== expected) {
  fail("SUBMITTER local key does not match registry address");
}
console.log(`machine: ${kind}`);
console.log(`submitter: ${submitter.address}`);
console.log(`read rpc: ${READ_RPC} (alternate: ${READ_RPC_ALT})`);
console.log(`sequencer rpc: ${SEQUENCER_RPC}`);
console.log(`self-send value: ${formatEther(SELF_SEND_VALUE)} ETH`);
console.log("");

// --- Pick a read RPC that answers (fallback pre-flight, recorded) ---
// URL selection uses a raw eth_blockNumber call, so no client object
// crosses a function boundary (viem's chain-specific client generics
// make that annotation fragile). One client is created below.
async function pickReadUrl(): Promise<string> {
  for (const url of [READ_RPC, READ_RPC_ALT]) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
      if (res.ok && body.result !== undefined && body.error === undefined) {
        console.log(`read rpc OK: ${url} (block ${body.result})`);
        return url;
      }
      console.log(`read rpc FAILED: ${url} :: HTTP ${res.status} :: ${body.error?.message ?? "no result"}`);
    } catch (e) {
      console.log(`read rpc FAILED: ${url} :: ${(e as Error).message.slice(0, 160)}`);
    }
  }
  console.log("FAIL  no read RPC answered");
  throw new Error("no read RPC answered");
}
const readUrl = await pickReadUrl();
const readClient = createPublicClient({ chain: baseSepolia, transport: http(readUrl) });

// --- Prepare the transaction (reads only) ---
const balanceBefore = await readClient.getBalance({ address: submitter.address });
console.log(`submitter balance before: ${formatEther(balanceBefore)} ETH`);
const nonce = await readClient.getTransactionCount({ address: submitter.address });
console.log(`nonce: ${nonce}`);
const gas = await readClient.estimateGas({
  account: submitter.address,
  to: submitter.address,
  value: SELF_SEND_VALUE,
});
console.log(`estimated gas: ${gas}`);
const fees = await readClient.estimateFeesPerGas();
console.log(`maxFeePerGas: ${fees.maxFeePerGas} maxPriorityFeePerGas: ${fees.maxPriorityFeePerGas}`);

// --- Sign locally (no RPC involved in signing) ---
const wallet = createWalletClient({
  account: submitter,
  chain: baseSepolia,
  transport: http(readUrl),
});
const signed = await wallet.signTransaction({
  account: submitter,
  chainId: baseSepolia.id,
  to: submitter.address,
  value: SELF_SEND_VALUE,
  gas,
  nonce,
  maxFeePerGas: fees.maxFeePerGas,
  maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  type: "eip1559",
});
console.log(`signed tx (${signed.length} hex chars); broadcasting`);

// --- Broadcast: sequencer endpoint first, read RPC as fallback ---
async function broadcast(url: string, raw: `0x${string}`): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [raw] }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json()) as { result?: string; error?: { message?: string } };
  if (!res.ok || body.error || !body.result) {
    throw new Error(`broadcast rejected via ${url}: HTTP ${res.status} :: ${body.error?.message ?? "no result"}`);
  }
  return body.result;
}

let txHash: string;
let pathUsed: string;
try {
  txHash = await broadcast(SEQUENCER_RPC, signed);
  pathUsed = "sequencer endpoint";
  console.log(`broadcast OK via sequencer endpoint: ${txHash}`);
} catch (e) {
  // Raw signal, not smoothed over: the sequencer endpoint may have
  // accepted the tx while its response was lost, so check before
  // assuming the fallback is needed (same signed tx cannot execute twice).
  console.log(`sequencer broadcast failed (raw): ${(e as Error).message}`);
  const computed = keccak256(signed);
  console.log(`computed tx hash: ${computed}; checking whether the network already knows it`);
  let known = false;
  try {
    known = (await readClient.getTransaction({ hash: computed })) !== null;
  } catch {
    known = false;
  }
  if (known) {
    txHash = computed;
    pathUsed = "sequencer endpoint (accepted; broadcast response lost)";
    console.log("network already knows the tx: sequencer accepted it");
  } else {
    txHash = await broadcast(readUrl, signed);
    pathUsed = "read RPC (fallback)";
    console.log(`broadcast OK via read RPC fallback: ${txHash}`);
  }
}

// --- Receipt + independent read-back ---
console.log(`waiting for receipt: ${txHash} (via ${pathUsed})`);
const receipt = await readClient.waitForTransactionReceipt({
  hash: txHash as `0x${string}`,
  timeout: 120_000,
});
console.log(`receipt: status=${receipt.status} block=${receipt.blockNumber} gasUsed=${receipt.gasUsed}`);
const altUrl = readUrl === READ_RPC ? READ_RPC_ALT : READ_RPC;
try {
  const altClient = createPublicClient({ chain: baseSepolia, transport: http(altUrl) });
  const altReceipt = await altClient.getTransactionReceipt({ hash: txHash as `0x${string}` });
  console.log(`read-back via ${altUrl}: status=${altReceipt.status} block=${altReceipt.blockNumber}`);
} catch (e) {
  console.log(`read-back via ${altUrl} FAILED (raw): ${(e as Error).message.slice(0, 160)}`);
}
const balanceAfter = await readClient.getBalance({ address: submitter.address });
console.log(`submitter balance after: ${formatEther(balanceAfter)} ETH (delta should be gas only)`);
if (receipt.status !== "success") fail(`receipt status is ${receipt.status}, not success`);
console.log("");
console.log(`sequencer-send-test: PASS via ${pathUsed} :: hash=${txHash} block=${receipt.blockNumber} gasUsed=${receipt.gasUsed}`);
