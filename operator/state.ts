// Read-only chain state adapter. This is the ONLY path the UI uses for live
// policy data. It reuses the repository's SDK reads and canonical hashing;
// it never reimplements the hash or any policy check.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { Connection, PublicKey } from "@solana/web3.js";
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { baseSepolia } from "viem/chains";
import { readEvmPolicy, VAULT_ABI } from "../sdk/evm.js";
import { readSolPolicy } from "../sdk/sol.js";
import { hasPrivateKey, machineKind } from "../sdk/keys.js";
import { policyHash, type PolicyInput } from "../policy/src/canonical.js";
import { DEMO_MODE, NETWORKS, SCENARIOS } from "./config.js";
import type {
  ChainKey,
  ChainPolicyView,
  ExecutionState,
  PolicyValues,
  SystemStatus,
  VerificationState,
} from "./types.js";

const EVM_RPC = "https://sepolia.base.org";
const SOL_RPC = "https://api.devnet.solana.com";
const READ_TIMEOUT_MS = 9000;

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function friendlyError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  if (/timeout|abort/i.test(text)) return "RPC request timed out; chain state could not be verified";
  if (/fetch|network|ENOTFOUND|ECONNREFUSED|Failed to fetch/i.test(text))
    return "RPC endpoint unreachable; chain state could not be verified";
  if (/policy account not found/i.test(text)) return "Solana policy account not found on the configured program";
  return text.slice(0, 240);
}

export function deriveProtection(evm: VerificationState, sol: VerificationState): VerificationState {
  if (evm === "verified" && sol === "verified") return "verified";
  if (evm === "failed" && sol === "failed") return "failed";
  if (evm === "unavailable" && sol === "unavailable") return "unavailable";
  return "partial";
}

export function expiryState(expiresAt: bigint, nowSec: number): "active" | "expired" | "never" | "unknown" {
  if (expiresAt === 0n) return "never";
  if (expiresAt < 0n) return "unknown";
  return expiresAt > BigInt(nowSec) ? "active" : "expired";
}

function microToSfusd(micro: string): string {
  const value = BigInt(micro);
  const whole = value / 1_000_000n;
  const frac = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function policyValues(input: {
  version: number;
  decimals: number;
  perTxMax: bigint;
  windowMax: bigint;
  windowSeconds: bigint;
  windowAnchor: bigint;
  expiresAt: bigint;
  frozen: boolean;
  recipients: string[];
}): PolicyValues {
  return {
    version: input.version,
    decimals: input.decimals,
    perTxMax: input.perTxMax.toString(),
    windowMax: input.windowMax.toString(),
    windowSeconds: input.windowSeconds.toString(),
    windowAnchor: input.windowAnchor.toString(),
    expiresAt: input.expiresAt.toString(),
    frozen: input.frozen,
    recipientCount: input.recipients.length,
    recipients: [...input.recipients],
  };
}

export function policyInputFrom(values: {
  version: number;
  decimals: number;
  perTxMax: string;
  windowMax: string;
  windowSeconds: string;
  windowAnchor: string;
  expiresAt: string;
}, recipients: { evm: string[]; sol: string[] }): PolicyInput {
  return {
    version: values.version,
    decimals: values.decimals,
    perTxMax: BigInt(values.perTxMax),
    windowMax: BigInt(values.windowMax),
    windowSeconds: BigInt(values.windowSeconds),
    windowAnchor: BigInt(values.windowAnchor),
    expiresAt: BigInt(values.expiresAt),
    evmRecipients: recipients.evm,
    solRecipients: recipients.sol,
  };
}

/** Map a normalized SDK SpendResult or demo event to a UI lifecycle state.
 *  Transport failures and on-chain reverts are deliberately distinct. */
export function classifyExecution(input: {
  ok: boolean;
  label?: string | null;
  hash?: string | null;
}): ExecutionState {
  if (input.ok) return "confirmed";
  const label = input.label ?? "";
  if (label === "Timeout") return "timed_out";
  if (label === "RecipientNotAllowed" || label === "DailyCapExceeded" || label === "PerTxCapExceeded" ||
      label === "Frozen" || label === "SessionExpired" || label === "ZeroAmount" ||
      label === "Unauthorized" || label === "BadNonce" || label === "IntentExpired" ||
      label === "DeadlineTooFar" || label === "InvalidAgent" || label === "InvalidPolicy" ||
      label === "InvalidAccounts" || label === "DuplicateAccounts" || label === "Reentrant" ||
      label === "InsufficientFunds" || label === "NotOwner" || label === "Reverted") {
    return input.hash ? "rejected" : "unknown";
  }
  return "failed";
}

interface LiveRead {
  evm: {
    view: ChainPolicyView;
    values: PolicyValues | null;
    attackerAuthorized: boolean | null;
    merchantAuthorized: boolean | null;
  };
  sol: {
    view: ChainPolicyView;
    values: PolicyValues | null;
    attackerAuthorized: boolean | null;
    merchantAuthorized: boolean | null;
  };
}

async function readEvm(): Promise<LiveRead["evm"]> {
  const observedAt = new Date().toISOString();
  const base: ChainPolicyView = {
    chain: "evm",
    name: NETWORKS.evm.name,
    state: "unavailable",
    source: "Unavailable",
    observedAt,
    identifier: NETWORKS.evm.vault,
    identifierLabel: "Vault contract",
    explorerUrl: `${NETWORKS.evm.explorer}/address/${NETWORKS.evm.vault}`,
    policy: null,
    computedFingerprint: null,
    storedFingerprint: null,
    fingerprintMatchesStored: null,
    expiryState: "unknown",
    error: null,
  };
  try {
    const client = createPublicClient({
      chain: baseSepolia,
      transport: http(EVM_RPC, { timeout: READ_TIMEOUT_MS }),
    }) as PublicClient;
    const vaultAddress = NETWORKS.evm.vault as Address;
    const pol = await withTimeout(readEvmPolicy(client, vaultAddress), READ_TIMEOUT_MS, "EVM policy read timed out");
    const [attacker, merchant] = await withTimeout(Promise.all([
      client.readContract({ address: vaultAddress, abi: VAULT_ABI, functionName: "isRecipient", args: [NETWORKS.evm.attacker as Address] }),
      client.readContract({ address: vaultAddress, abi: VAULT_ABI, functionName: "isRecipient", args: [NETWORKS.evm.merchant as Address] }),
    ]), READ_TIMEOUT_MS, "EVM recipient read timed out") as [boolean, boolean];
    // The deployment record pins the verified recipient set; verify(CLI)
    // recomputes the hash from live fields + this set. Membership of both
    // concrete addresses is additionally checked live above.
    const recipients = [NETWORKS.evm.merchant];
    const values = policyValues({
      version: pol.version,
      decimals: pol.decimals,
      perTxMax: pol.perTxMax,
      windowMax: pol.windowMax,
      windowSeconds: pol.windowSeconds,
      windowAnchor: pol.windowAnchor,
      expiresAt: pol.expiresAt,
      frozen: pol.frozen,
      recipients,
    });
    const computed = policyHash(policyInputFrom(values, {
      evm: recipients,
      sol: [NETWORKS.sol.merchant],
    }));
    const stored = pol.policyHash.toLowerCase();
    return {
      view: {
        ...base,
        state: "verified",
        source: "Live",
        policy: values,
        computedFingerprint: computed,
        storedFingerprint: stored,
        fingerprintMatchesStored: `0x${computed}` === stored,
        expiryState: expiryState(pol.expiresAt, Math.floor(Date.now() / 1000)),
      },
      values,
      attackerAuthorized: attacker,
      merchantAuthorized: merchant,
    };
  } catch (err) {
    return { view: { ...base, state: "failed", error: friendlyError(err) }, values: null, attackerAuthorized: null, merchantAuthorized: null };
  }
}

async function readSol(): Promise<LiveRead["sol"]> {
  const observedAt = new Date().toISOString();
  const base: ChainPolicyView = {
    chain: "sol",
    name: NETWORKS.sol.name,
    state: "unavailable",
    source: "Unavailable",
    observedAt,
    identifier: NETWORKS.sol.program,
    identifierLabel: "Anchor program",
    explorerUrl: `${NETWORKS.sol.explorer}/address/${NETWORKS.sol.program}?cluster=devnet`,
    policy: null,
    computedFingerprint: null,
    storedFingerprint: null,
    fingerprintMatchesStored: null,
    expiryState: "unknown",
    error: null,
  };
  try {
    const conn = new Connection(SOL_RPC, "confirmed");
    const pol = await withTimeout(readSolPolicy(conn, new PublicKey(NETWORKS.sol.program)), READ_TIMEOUT_MS, "Solana policy read timed out");
    const recipients = pol.recipients.map((r) => r.toBase58());
    const values = policyValues({
      version: pol.version,
      decimals: pol.decimals,
      perTxMax: pol.perTxMax,
      windowMax: pol.windowMax,
      windowSeconds: pol.windowSeconds,
      windowAnchor: pol.windowAnchor,
      expiresAt: pol.expiresAt,
      frozen: pol.frozen,
      recipients,
    });
    const computed = policyHash(policyInputFrom(values, {
      evm: [NETWORKS.evm.merchant],
      sol: recipients,
    }));
    const stored = `0x${Buffer.from(pol.policyHash).toString("hex")}`;
    return {
      view: {
        ...base,
        state: "verified",
        source: "Live",
        policy: values,
        computedFingerprint: computed,
        storedFingerprint: stored,
        fingerprintMatchesStored: `0x${computed}` === stored,
        expiryState: expiryState(pol.expiresAt, Math.floor(Date.now() / 1000)),
      },
      values,
      attackerAuthorized: recipients.includes(NETWORKS.sol.attacker),
      merchantAuthorized: recipients.includes(NETWORKS.sol.merchant),
    };
  } catch (err) {
    return { view: { ...base, state: "failed", error: friendlyError(err) }, values: null, attackerAuthorized: null, merchantAuthorized: null };
  }
}

function toolAvailable(command: string): boolean {
  if (existsSync(`${homedir()}/.foundry/bin/${command}`)) return true;
  return spawnSync("which", [command], { stdio: "ignore" }).status === 0;
}

async function ollamaAvailable(): Promise<boolean> {
  const url = process.env.OLLAMA_URL ?? "http://localhost:11434";
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}

let cache: { at: number; status: SystemStatus } | null = null;

export async function readSystemStatus(force = false): Promise<SystemStatus> {
  if (!force && cache && Date.now() - cache.at < 8000) return cache.status;
  const [evm, sol, ollama] = await Promise.all([readEvm(), readSol(), ollamaAvailable()]);
  const protection = deriveProtection(evm.view.state, sol.view.state);
  const generatedAt = new Date().toISOString();
  let ownerKeysHere = false;
  try { ownerKeysHere = machineKind() === "owner"; } catch { /* no marker on this host */ }
  const recipients = Object.values(SCENARIOS).flatMap((scenario) =>
    (["evm", "sol"] as ChainKey[]).map((chain) => {
      const live = chain === "evm" ? evm : sol;
      const authorized = chain === "evm"
        ? scenario.id === "attack-recipient" ? live.attackerAuthorized : live.merchantAuthorized
        : scenario.id === "attack-recipient" ? live.attackerAuthorized : live.merchantAuthorized;
      return {
        scenario: scenario.id,
        chain,
        address: scenario.recipient[chain],
        authorized,
        basis: authorized === null
          ? "Live authorization read unavailable; deployment record lists only the merchant"
          : chain === "evm"
            ? "Live isRecipient() read on the vault contract"
            : "Live recipient list read from the Anchor policy account",
      };
    }),
  );
  const fingerprints = [evm.view.computedFingerprint, sol.view.computedFingerprint].filter(Boolean) as string[];
  const allMatches = evm.view.state === "verified" && sol.view.state === "verified"
    && evm.view.fingerprintMatchesStored === true && sol.view.fingerprintMatchesStored === true
    && fingerprints.length === 2 && fingerprints[0] === fingerprints[1];
  const anyMismatch = evm.view.fingerprintMatchesStored === false || sol.view.fingerprintMatchesStored === false
    || (fingerprints.length === 2 && fingerprints[0] !== fingerprints[1]);
  const status: SystemStatus = {
    generatedAt,
    environment: "TESTNET DEMO",
    mode: DEMO_MODE,
    protection,
    demoEnabled: process.env.SPENDFLOOR_DEMO_ENABLE === "1",
    prerequisites: {
      agentKeys: hasPrivateKey("evm", "agent") && hasPrivateKey("sol", "agent"),
      submitterKeys: hasPrivateKey("evm", "submitter") && hasPrivateKey("sol", "submitter"),
      ownerKeysHere,
      ollama,
      foundry: toolAvailable("anvil") && toolAvailable("forge"),
      ollamaCheckedAt: generatedAt,
    },
    chains: { evm: evm.view, sol: sol.view },
    canonical: {
      fingerprint: allMatches || fingerprints.length > 0 ? fingerprints[0] ?? null : null,
      method: "SHA-256",
      source: fingerprints.length > 0 ? "Live" : "Unavailable",
      observation: fingerprints.length > 0 ? "freshly computed from live chain reads" : "unavailable",
      comparison: allMatches ? "matched" : anyMismatch ? "mismatched" : "not-performed",
      comparedAt: allMatches || anyMismatch ? generatedAt : null,
      detail: allMatches
        ? "Recomputed from live fields on both chains; both stored hashes and the cross-chain fingerprint agree."
        : anyMismatch
          ? "At least one stored hash or cross-chain comparison disagreed with the live fields. Do not trust this run."
          : "Both-chain comparison was not completed; no verification claim is made.",
    },
    policy: evm.values ?? sol.values,
    policySource: evm.values || sol.values ? "Live" : "Unavailable",
    recipientAuthorization: recipients,
    note: "Read-only adapter. Historical verification scores and October 2026 snapshots are never shown as current state.",
  };
  cache = { at: Date.now(), status };
  return status;
}

export function clearStatusCache(): void {
  cache = null;
}

export function sumFingerprintPreview(values: {
  perTxMax: string;
  windowMax: string;
  windowSeconds: string;
  windowAnchor: string;
  expiresAt: string;
}): string {
  // The preview uses the demo deployment's public recipient sets and the
  // existing canonical implementation. It is never submitted on-chain.
  return policyHash(policyInputFrom({
    version: 1,
    decimals: 6,
    ...values,
  }, { evm: [NETWORKS.evm.merchant], sol: [NETWORKS.sol.merchant] }));
}

export function humanPolicy(values: PolicyValues | null): string | null {
  if (!values) return null;
  return `${microToSfusd(values.perTxMax)} SFUSD per tx / ${microToSfusd(values.windowMax)} SFUSD per window`;
}
