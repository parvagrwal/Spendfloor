// spend-sepolia (T06 Sepolia leg, step 2 of 2).
//
//   Run on the AGENT machine (Muse VM) only, after the owner deploys:
//     SPENDFLOOR_VAULT_ADDRESS=0x... npx tsx sdk/spend-sepolia.ts
//
// The AGENT signs intents, the SUBMITTER submits them. Valid spends must
// land status 1; over-cap attempts and the tampered intent must mine
// status 0 and decode locally (via eth_call) to DailyCapExceeded and
// Unauthorized. AGENT native balance must be 0 throughout (criterion 4).
// Over-cap and tampered sends use an EXPLICIT gas limit, skipping gas
// estimation, so the revert mines instead of failing locally (plan: the
// viem explicit-gas flag is itself verified by this script).
// Signing note: the agent signs the RAW digest from intentDigest with
// account.sign({ hash }) — NOT signMessage, which would add a second
// prefix and break verification.
// Resume: if a run stops after the valid spends (as happened on the first
// Sepolia run when the decoder missed the nested revert data), re-run with
// SPENDFLOOR_SPEND_RESUME=1. It skips the valid spends (asserting the
// 0.0003 ETH spent total first), replay-decodes the already-mined over-cap
// attempt, then sends the remaining over-cap attempts and the tampered intent.
// This script NEVER prints key material. Exit 0 only when every leg passes.

import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  encodeFunctionData,
  formatEther,
  http,
  keccak256,
  parseEther,
  toHex,
} from "viem";
import { baseSepolia } from "viem/chains";
import {
  hasPrivateKey,
  loadEvmAccount,
  machineKind,
  registryAddress,
} from "./keys.js";

const RPC = process.env.SPENDFLOOR_EVM_RPC ?? "https://sepolia.base.org";
const VAULT_ENV = process.env.SPENDFLOOR_VAULT_ADDRESS;
const VALID_AMOUNT = parseEther("0.0001");
const OVER_CAP_AMOUNT = parseEther("0.002");
const EXPLICIT_GAS = 200000n;

const fail = (msg: string): never => {
  console.log(`FAIL  ${msg}`);
  process.exit(1);
};

if (!VAULT_ENV) fail("SPENDFLOOR_VAULT_ADDRESS is not set");
const VAULT = VAULT_ENV as `0x${string}`;

// --- Custody pre-flight ---
const kind = machineKind();
if (kind !== "agent") fail(`this machine is "${kind}", not "agent"; refusing to spend`);
if (hasPrivateKey("evm", "owner")) fail("OWNER EVM key exists on this agent machine (custody violation)");
if (!hasPrivateKey("evm", "agent")) fail("AGENT EVM key absent on this machine");
if (!hasPrivateKey("evm", "submitter")) fail("SUBMITTER EVM key absent on this machine");
const agent = loadEvmAccount("agent");
const submitter = loadEvmAccount("submitter");
const expectedAgent = registryAddress("evm", "agent");
const expectedSubmitter = registryAddress("evm", "submitter");
const expectedOwner = registryAddress("evm", "owner");
if (!expectedAgent || agent.address !== expectedAgent) fail("AGENT local key does not match registry address");
if (!expectedSubmitter || submitter.address !== expectedSubmitter) fail("SUBMITTER local key does not match registry address");
if (!expectedOwner) fail("registry missing owner address");
console.log(`machine: ${kind}`);
console.log(`vault: ${VAULT}`);
console.log(`agent: ${agent.address} (must stay 0 wei)`);
console.log(`submitter: ${submitter.address}`);
console.log(`rpc: ${RPC}`);
console.log("");

const artifactUrl = new URL("../evm/out/Vault.sol/Vault.json", import.meta.url);
let abi: any;
try {
  abi = (JSON.parse(readFileSync(artifactUrl, "utf8")) as { abi: any }).abi;
} catch {
  fail("Vault artifact not found at evm/out/Vault.sol/Vault.json (run: cd evm && forge build)");
}
const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
const walletClient = createWalletClient({ account: submitter, chain: baseSepolia, transport: http(RPC) });

async function assertAgentZero(stage: string) {
  const bal = await publicClient.getBalance({ address: agent.address });
  console.log(`agent balance (${stage}): ${formatEther(bal)} ETH`);
  if (bal !== 0n) fail(`AGENT balance is not 0 at ${stage}`);
}

async function signIntent(to: `0x${string}`, amount: bigint) {
  const digest = (await publicClient.readContract({
    address: VAULT,
    abi,
    functionName: "intentDigest",
    args: [to, amount],
  })) as `0x${string}`;
  // This viem version's account.sign returns a 65-byte hex string (r || s || v),
  // not a Signature object. It signs the digest raw (verified: recoverAddress
  // of the digest returns the agent address), so no extra prefix is added.
  const sigHex = (await agent.sign({ hash: digest })) as unknown as string;
  if (!sigHex.startsWith("0x") || sigHex.length !== 132) fail(`unexpected signature shape: length ${sigHex.length}`);
  const r = `0x${sigHex.slice(2, 66)}` as `0x${string}`;
  const s = `0x${sigHex.slice(66, 130)}` as `0x${string}`;
  const v = parseInt(sigHex.slice(130, 132), 16);
  if (v !== 27 && v !== 28) fail(`unexpected signature v byte: ${v}`);
  return { digest, v, r, s };
}

async function submitSpend(
  to: `0x${string}`,
  amount: bigint,
  sig: { v: number; r: `0x${string}`; s: `0x${string}` },
  explicitGas: boolean,
) {
  const args = [to, amount, sig.v, sig.r, sig.s] as const;
  const data = encodeFunctionData({ abi, functionName: "spend", args });
  const hash = explicitGas
    ? await walletClient.sendTransaction({ to: VAULT, data, gas: EXPLICIT_GAS })
    : await walletClient.writeContract({
        address: VAULT,
        abi,
        functionName: "spend",
        args,
      });
  return { hash, data };
}

async function decodeRevert(data: `0x${string}`): Promise<string> {
  // Local decode: replay the exact calldata via eth_call, then decode.
  // The node returns the revert data on the raw RPC error, several cause
  // levels down from viem's top error, so walk the whole chain.
  try {
    await publicClient.call({ account: submitter.address, to: VAULT, data });
    return "(eth_call did not revert)";
  } catch (e) {
    let cur: any = e;
    for (let i = 0; i < 6 && cur; i++) {
      const raw = cur.data as string | undefined;
      if (typeof raw === "string" && raw.startsWith("0x") && raw.length >= 10) {
        try {
          const decoded = decodeErrorResult({ abi, data: raw as `0x${string}` });
          return decoded.errorName;
        } catch {
          // Not decodable against the vault ABI; keep walking.
        }
      }
      cur = cur.cause;
    }
    // Last resort: selector substring over the full stringified error.
    const text = `${e}`;
    const dailySel = keccak256(toHex("DailyCapExceeded()")).slice(0, 10);
    const unauthSel = keccak256(toHex("Unauthorized()")).slice(0, 10);
    if (text.includes(dailySel)) return "DailyCapExceeded";
    if (text.includes(unauthSel)) return "Unauthorized";
    return `(undecoded revert: ${text.slice(0, 300)})`;
  }
}

const RESUME = process.env.SPENDFLOOR_SPEND_RESUME === "1";
await assertAgentZero("before");

if (RESUME) {
  // Prior run already landed the 3 valid spends; confirm that state, then
  // replay-decode the already-mined over-cap attempt (no new transaction).
  const day0 = (await publicClient.readContract({
    address: VAULT,
    abi,
    functionName: "dayNow",
  })) as bigint;
  const spent0 = (await publicClient.readContract({
    address: VAULT,
    abi,
    functionName: "spentOnDay",
    args: [day0],
  })) as bigint;
  console.log(`resume: prior valid spends confirmed, spent=${formatEther(spent0)} ETH`);
  if (spent0 !== VALID_AMOUNT * 3n) fail(`resume: expected spent ${formatEther(VALID_AMOUNT * 3n)} ETH, got ${formatEther(spent0)} ETH`);
  const to = expectedSubmitter as `0x${string}`;
  const sig = await signIntent(to, OVER_CAP_AMOUNT);
  const replayArgs = [to, OVER_CAP_AMOUNT, sig.v, sig.r, sig.s] as const;
  const replayData = encodeFunctionData({ abi, functionName: "spend", args: replayArgs });
  const decoded1 = await decodeRevert(replayData);
  console.log(`over-cap 1/3 (replay of the already-mined attempt): decoded=${decoded1}`);
  if (decoded1 !== "DailyCapExceeded") fail(`over-cap 1 replay decoded to ${decoded1}, not DailyCapExceeded`);
} else {
  // --- 3 of 3 valid spends (criterion 2) ---
  const validTargets: `0x${string}`[] = [
    expectedSubmitter as `0x${string}`,
    expectedOwner as `0x${string}`,
    expectedSubmitter as `0x${string}`,
  ];
  for (let i = 0; i < validTargets.length; i++) {
    const to = validTargets[i];
    const sig = await signIntent(to, VALID_AMOUNT);
    const { hash } = await submitSpend(to, VALID_AMOUNT, sig, false);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    console.log(`valid spend ${i + 1}/3: to=${to} amount=${formatEther(VALID_AMOUNT)} ETH hash=${hash} status=${receipt.status} block=${receipt.blockNumber}`);
    if (receipt.status !== "success") fail(`valid spend ${i + 1} status is not success`);
  }
  await assertAgentZero("after valid spends");
}

// --- 3 of 3 over-cap attempts (criterion 3) ---
const overCapAttempts = RESUME ? [2, 3] : [1, 2, 3];
for (const n of overCapAttempts) {
  const to = expectedSubmitter as `0x${string}`;
  const sig = await signIntent(to, OVER_CAP_AMOUNT);
  const t0 = Date.now();
  const { hash, data } = await submitSpend(to, OVER_CAP_AMOUNT, sig, true);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  const elapsed = (Date.now() - t0) / 1000;
  const decoded = await decodeRevert(data);
  console.log(`over-cap ${n}/3: hash=${hash} status=${receipt.status} block=${receipt.blockNumber} minedIn=${elapsed.toFixed(1)}s decoded=${decoded}`);
  if (receipt.status !== "reverted") fail(`over-cap ${n} status is not reverted`);
  if (elapsed > 30) fail(`over-cap ${n} took ${elapsed.toFixed(1)}s, over the 30s bar`);
  if (decoded !== "DailyCapExceeded") fail(`over-cap ${n} decoded to ${decoded}, not DailyCapExceeded`);
}
await assertAgentZero("after over-cap attempts");

// --- 1 of 1 tampered intent (criterion 5) ---
{
  const to = expectedSubmitter as `0x${string}`;
  const sig = await signIntent(to, VALID_AMOUNT);
  const tamperedAmount = VALID_AMOUNT * 2n;
  const { hash, data } = await submitSpend(to, tamperedAmount, sig, true);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  const decoded = await decodeRevert(data);
  console.log(`tampered: signed=${formatEther(VALID_AMOUNT)} submitted=${formatEther(tamperedAmount)} hash=${hash} status=${receipt.status} block=${receipt.blockNumber} decoded=${decoded}`);
  if (receipt.status !== "reverted") fail("tampered intent status is not reverted");
  if (decoded !== "Unauthorized") fail(`tampered intent decoded to ${decoded}, not Unauthorized`);
}
await assertAgentZero("after tampered intent");

// --- Vault spent total must be exactly the 3 valid spends ---
const day = (await publicClient.readContract({
  address: VAULT,
  abi,
  functionName: "dayNow",
})) as bigint;
const spent = (await publicClient.readContract({
  address: VAULT,
  abi,
  functionName: "spentOnDay",
  args: [day],
})) as bigint;
console.log(`vault spent today: ${formatEther(spent)} ETH (expected ${formatEther(VALID_AMOUNT * 3n)} ETH)`);
if (spent !== VALID_AMOUNT * 3n) fail("vault spent total does not match the 3 valid spends");
console.log("");
console.log("spend-sepolia: PASS :: 3/3 valid status 1, 3/3 over-cap status 0 + DailyCapExceeded, 1/1 tampered Unauthorized, agent 0 throughout");
