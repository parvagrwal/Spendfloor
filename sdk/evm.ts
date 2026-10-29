// EVM side of the SpendFloor SDK (T15).
//
// Roles are separate arguments, never one wallet: the agent signs the
// EIP-712 intent, the submitter pays gas and sends it. The agent key is
// never used as a fee payer and never holds funds.
//
// Forced landing: every submit uses an explicit gas limit, so a policy
// revert mines on-chain (status 0) instead of failing at gas estimation
// with no hash. Confirmation polls the receipt over HTTP, never WebSocket
// (the devnet WS path is unreliable; see T07). A mined revert is
// replayed via eth_call to decode the custom error into a normalized
// label, so a failure returns { label, hash }, not a raw RPC error.

import {
  decodeErrorResult,
  encodeFunctionData,
  parseAbi,
  parseSignature,
  type Account,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
} from "viem";
import { EVM_ERROR_NAMES, type SpendLabel, type SpendResult } from "./errors.js";

export const VAULT_ABI = parseAbi([
  "function spendWithSig(address to, uint256 amount, uint256 nonce, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
  "function policy() view returns (uint32 version, uint8 decimals, uint64 perTxMax, uint64 windowMax, uint64 windowSeconds, int64 windowAnchor, int64 expiresAt, bytes32 solSetHash)",
  "function policyHash() view returns (bytes32)",
  "function agent() view returns (address)",
  "function frozen() view returns (bool)",
  "function nonce() view returns (uint256)",
  "function spentInWindow() view returns (uint256)",
  "function currentWindow() view returns (uint256)",
  "function isRecipient(address) view returns (bool)",
  "function intentDigest(address,uint256,uint256,uint256) view returns (bytes32)",
  "function token() view returns (address)",
  "function owner() view returns (address)",
  "error Unauthorized()",
  "error BadNonce()",
  "error IntentExpired()",
  "error DeadlineTooFar()",
  "error Frozen()",
  "error SessionExpired()",
  "error ZeroAmount()",
  "error RecipientNotAllowed()",
  "error DailyCapExceeded()",
  "error PerTxCapExceeded()",
  "error NotOwner()",
  "error InvalidAgent()",
  "error InvalidPolicy()",
  "error Reentrant()",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
]);

/** Explicit gas for submits: high enough for spendWithSig, and it forces
 *  policy reverts to mine (status 0) instead of failing estimation. */
export const DEFAULT_GAS = 300_000n;

export interface EvmIntent {
  to: Address;
  amount: bigint;
  nonce: bigint;
  deadline: bigint;
}

export interface SignedEvmIntent extends EvmIntent {
  v: number;
  r: Hash;
  s: Hash;
}

export interface EvmPolicyState {
  version: number;
  decimals: number;
  perTxMax: bigint;
  windowMax: bigint;
  windowSeconds: bigint;
  windowAnchor: bigint;
  expiresAt: bigint;
  solSetHash: Hash;
  policyHash: Hash;
  agent: Address;
  frozen: boolean;
  nonce: bigint;
  spentInWindow: bigint;
  currentWindow: bigint;
  token: Address;
  owner: Address;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Agent signs the EIP-712 spend intent. Domain must match the vault:
 * name "SpendFloorVault", version "1", chainId of the chain, and the
 * vault address as verifyingContract. viem's signTypedData produces
 * exactly the digest the vault recovers (intentDigest).
 */
export async function signEvmIntent(
  agent: Account,
  chainId: number,
  vault: Address,
  intent: EvmIntent,
): Promise<SignedEvmIntent> {
  if (!agent.signTypedData) throw new Error("agent account cannot sign typed data");
  const signature = await agent.signTypedData({
    domain: { name: "SpendFloorVault", version: "1", chainId, verifyingContract: vault },
    types: {
      Spend: [
        { name: "to", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Spend",
    message: { to: intent.to, amount: intent.amount, nonce: intent.nonce, deadline: intent.deadline },
  });
  const { v, r, s } = parseSignature(signature);
  return { ...intent, v: Number(v), r, s };
}

/** Decode a mined revert by replaying the call, so the label is exact. */
async function decodeRevertLabel(
  publicClient: PublicClient,
  vault: Address,
  signed: SignedEvmIntent,
): Promise<SpendLabel> {
  try {
    const data = encodeFunctionData({
      abi: VAULT_ABI,
      functionName: "spendWithSig",
      args: [signed.to, signed.amount, signed.nonce, signed.deadline, signed.v, signed.r, signed.s],
    });
    await publicClient.call({ to: vault, data });
    return "Reverted";
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    // First: walk the error cause chain for a `data` field (viem's
    // RawContractError carries the raw revert data there). The old
    // regex grabbed the FIRST hex in the message, which is often the
    // vault address from "Raw Call Arguments", not the revert data.
    let cur: unknown = err;
    for (let i = 0; i < 10 && cur && typeof cur === "object"; i++) {
      const c = cur as Record<string, unknown>;
      if (typeof c.data === "string" && c.data.startsWith("0x") && c.data.length >= 10) {
        try {
          const decoded = decodeErrorResult({ abi: VAULT_ABI, data: c.data as Hash });
          if (decoded.errorName === "ERC20InsufficientBalance") return "InsufficientFunds";
          if (EVM_ERROR_NAMES.has(decoded.errorName)) return decoded.errorName as SpendLabel;
        } catch {
          // Not a known error selector; keep walking.
        }
      }
      const next = (c.cause ?? c.raw) as unknown;
      if (!next || next === cur) break;
      cur = next;
    }
    // Fallback: regex + name scan (as before).
    try {
      const m = text.match(/0x[0-9a-fA-F]+/);
      if (m) {
        const decoded = decodeErrorResult({ abi: VAULT_ABI, data: m[0] as Hash });
        if (decoded.errorName === "ERC20InsufficientBalance") return "InsufficientFunds";
        if (EVM_ERROR_NAMES.has(decoded.errorName)) return decoded.errorName as SpendLabel;
      }
    } catch {
      // Fall through to the name scan below.
    }
    for (const name of EVM_ERROR_NAMES) {
      if (text.includes(name)) return name as SpendLabel;
    }
    if (text.includes("ERC20InsufficientBalance")) return "InsufficientFunds";
    return "Reverted";
  }
}

/** Poll for a receipt over HTTP until it lands or the timeout hits. */
async function waitForReceipt(
  publicClient: PublicClient,
  hash: Hash,
  timeoutMs = 60_000,
): Promise<{ status: string } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await publicClient.getTransactionReceipt({ hash }).catch(() => null);
    if (receipt) return receipt;
    await sleep(1000);
  }
  return null;
}

/**
 * Submitter sends a signed intent. Returns { ok, hash } on a landed
 * success, or { ok: false, label, hash } on a landed revert. A send
 * that never broadcasts (RPC rejection) returns SubmitFailed with no
 * hash; a broadcast that never confirms in time returns Timeout with
 * the hash, so the caller can check it later.
 */
export async function submitEvmSpend(
  publicClient: PublicClient,
  submitter: WalletClient,
  vault: Address,
  signed: SignedEvmIntent,
  opts: { gas?: bigint; timeoutMs?: number } = {},
): Promise<SpendResult> {
  const data = encodeFunctionData({
    abi: VAULT_ABI,
    functionName: "spendWithSig",
    args: [signed.to, signed.amount, signed.nonce, signed.deadline, signed.v, signed.r, signed.s],
  });
  let hash: Hash;
  try {
    const submitterAccount = submitter.account;
    if (!submitterAccount) throw new Error("submitter wallet has no account");
    hash = await submitter.sendTransaction({
      to: vault,
      data,
      gas: opts.gas ?? DEFAULT_GAS,
      account: submitterAccount,
      chain: submitter.chain,
    });
  } catch (err) {
    return { ok: false, label: "SubmitFailed", raw: err instanceof Error ? err.message : String(err) };
  }
  const receipt = await waitForReceipt(publicClient, hash, opts.timeoutMs);
  if (!receipt) return { ok: false, label: "Timeout", hash };
  if (receipt.status === "success") return { ok: true, hash };
  const label = await decodeRevertLabel(publicClient, vault, signed);
  return { ok: false, label, hash };
}

/** Read the vault's policy + runtime state (one call per field). */
export async function readEvmPolicy(
  publicClient: PublicClient,
  vault: Address,
): Promise<EvmPolicyState> {
  const [policy, policyHash, agent, frozen, nonce, spentInWindow, currentWindow, token, owner] =
    await Promise.all([
      publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "policy" }),
      publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "policyHash" }),
      publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "agent" }),
      publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "frozen" }),
      publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "nonce" }),
      publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "spentInWindow" }),
      publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "currentWindow" }),
      publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "token" }),
      publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "owner" }),
    ]);
  return {
    version: policy[0],
    decimals: policy[1],
    perTxMax: policy[2],
    windowMax: policy[3],
    windowSeconds: policy[4],
    windowAnchor: policy[5],
    expiresAt: policy[6],
    solSetHash: policy[7],
    policyHash,
    agent,
    frozen,
    nonce,
    spentInWindow,
    currentWindow,
    token,
    owner,
  };
}
