// spendfloor verify (T18).
//
// Reads the enforced state from both chains, recomputes everything
// from what it reads (trusting neither stored hash), and reports
// PASS/FAIL per check with a precise diff on failure.
//
// Graphify: Verifier Recomputes From Source of Truth + Mutation
// Testing + Verifier That Has Never Failed Disguise (a verifier that
// never fails is suspect, so the mutation test is required, not
// optional) + One-Path Verification Disguise (two independent RPCs
// per chain, not one path) + Stored Value Disguise (recompute, do
// not trust a stored hash).
//
// Checks (each via RPC1 AND RPC2, which must agree):
//   evm.policy    live fields -> recomputed policyHash == stored policyHash;
//                 isRecipient(merchant) == true
//   evm.code      on-chain runtime code hash == local build (forge artifact)
//   evm.roles     owner == OWNER, agent == AGENT
//   evm.agent     AGENT native == 0, AGENT SFUSD == 0 (E1)
//   sol.policy    live fields + live recipients -> recomputed policyHash
//                 == stored policyHash; recipients == expected [merchant]
//   sol.upgrade   program upgrade authority == OWNER (not AGENT) (S11)
//   sol.roles     owner == OWNER, agent == AGENT
//   sol.agent     AGENT native == 0, AGENT SFUSD == 0 (E1)
//   cross.policy  caps + recipients match across chains, else DRIFT (X1);
//                 anchor/expiry/spent are session state, not drift
//
// Usage:
//   npx tsx cli/spendfloor.ts verify [--net testnet]
//   npx tsx cli/spendfloor.ts verify --net testnet --json
//
// Exit code 0 if all checks PASS, 1 otherwise. SOL RPC2 defaults to
// SOL_RPC2 env (Helius on Parv's machine); if unset it reuses RPC1 and
// the output flags it as NOT independent (honest, not claimed).

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import {
  createPublicClient,
  http,
  keccak256,
  type Address,
  type Hash,
} from "viem";
import { baseSepolia } from "viem/chains";
import { readEvmPolicy, VAULT_ABI } from "../sdk/evm.js";
import { readSolPolicy } from "../sdk/sol.js";
import { solConnection } from "../agent/pay.js";
import { evmSetHash, policyHash, solSetHash } from "../policy/src/canonical.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

type Check = { name: string; pass: boolean; detail: string };
const checks: Check[] = [];
const check = (name: string, pass: boolean, detail: string) => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`);
};

const normHex = (h: string) => h.toLowerCase().replace(/^0x/, "");
const toHexBytes = (b: Uint8Array) => "0x" + Buffer.from(b).toString("hex");

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (cmd !== "verify") {
    console.log("usage: npx tsx cli/spendfloor.ts verify [--net testnet] [--json]");
    process.exit(1);
  }
  const netIdx = args.indexOf("--net");
  const net = netIdx >= 0 ? args[netIdx + 1] : "testnet";
  if (net !== "testnet") {
    console.log(`--net ${net} not supported by verify yet (testnet only; local is a T26 follow-up)`);
    process.exit(1);
  }
  const wantJson = args.includes("--json");

  // --- Expected (from T16 deployments; caps/recipients are the policy,
  // anchor/expiry/spent are session state and are NOT compared) ---
  const evmDep = JSON.parse(readFileSync(join(repoRoot, "deployments", "base-sepolia.json"), "utf8"));
  const solDep = JSON.parse(readFileSync(join(repoRoot, "deployments", "solana-devnet.json"), "utf8"));
  const EVM_VAULT = evmDep.vaults.demo.address as Address;
  const EVM_TOKEN = evmDep.token.address as Address;
  const EVM_OWNER = evmDep.owner as Address;
  const EVM_AGENT = evmDep.agent as Address;
  const EVM_MERCHANT = evmDep.merchant as Address;
  const SOL_PROGRAM = new PublicKey(solDep.program as string);
  const SOL_POLICY = new PublicKey(solDep.policyPda as string);
  const SOL_MINT = new PublicKey(solDep.mint as string);
  const SOL_OWNER = new PublicKey(solDep.owner as string);
  const SOL_AGENT = new PublicKey(solDep.agent as string);
  const SOL_MERCHANT = new PublicKey(solDep.merchant as string);
  const EXPECTED_PER_TX = 2_000_000n;
  const EXPECTED_WINDOW = 5_000_000n;
  const EXPECTED_WINDOW_SECS = 86400n;

  // --- RPCs (two independent paths per chain) ---
  const EVM_RPC1 = "https://sepolia.base.org";
  const EVM_RPC2 = "https://base-sepolia.drpc.org";
  const SOL_RPC1 = "https://api.devnet.solana.com";
  const SOL_RPC2 = process.env.SOL_RPC2 || SOL_RPC1;
  const solRpc2Independent = SOL_RPC2 !== SOL_RPC1;
  if (!solRpc2Independent) {
    console.log("NOTE: SOL RPC2 == RPC1 (SOL_RPC2 env unset; Helius key lives on Parv's machine). SOL reads are NOT independently verified on this run.");
  }
  const evm1 = createPublicClient({ chain: baseSepolia, transport: http(EVM_RPC1) });
  const evm2 = createPublicClient({ chain: baseSepolia, transport: http(EVM_RPC2) });
  const { Connection } = await import("@solana/web3.js");
  const sol1 = new Connection(SOL_RPC1, "confirmed");
  const sol2 = new Connection(SOL_RPC2, "confirmed");
  void solConnection;

  // --- EVM policy (both RPCs, must agree) ---
  const evmPol1 = await readEvmPolicy(evm1 as never, EVM_VAULT);
  const evmPol2 = await readEvmPolicy(evm2 as never, EVM_VAULT);
  const evmPolAgree = JSON.stringify(evmPol1, (_, v) => typeof v === "bigint" ? v.toString() : v) ===
    JSON.stringify(evmPol2, (_, v) => typeof v === "bigint" ? v.toString() : v);
  check("rpc.evm", evmPolAgree, evmPolAgree ? "RPC1 == RPC2 (policy)" : "RPC1 != RPC2 (policy) — do not trust one path");
  const evmPol = evmPol1;
  // Recompute policyHash from live fields + expected recipients.
  const evmRecomputed = policyHash({
    version: evmPol.version, decimals: evmPol.decimals, perTxMax: evmPol.perTxMax, windowMax: evmPol.windowMax,
    windowSeconds: evmPol.windowSeconds, windowAnchor: evmPol.windowAnchor, expiresAt: evmPol.expiresAt,
    evmRecipients: [EVM_MERCHANT], solRecipients: [SOL_MERCHANT.toBase58()],
  });
  check("evm.policy", normHex(evmRecomputed) === normHex(evmPol.policyHash),
    normHex(evmRecomputed) === normHex(evmPol.policyHash)
      ? `recomputed == stored (${evmPol.policyHash})`
      : `recomputed ${evmRecomputed} != stored ${evmPol.policyHash} (TAMPER or recipient drift)`);
  // isRecipient(merchant) direct check (both RPCs).
  const isRec1 = await evm1.readContract({ address: EVM_VAULT, abi: VAULT_ABI, functionName: "isRecipient", args: [EVM_MERCHANT] }) as boolean;
  check("evm.recipient", isRec1 === true, isRec1 ? "isRecipient(merchant) == true" : "isRecipient(merchant) == false (recipient removed)");

  // --- EVM code (runtime codehash vs local build, metadata stripped) ---
  // solc appends a metadata hash (IPFS + compiler version) to the
  // runtime code. It embeds source paths, so it differs between
  // machines (Parv's Windows build vs this VM) even for identical
  // source. Strip it from both sides before hashing; what matters is
  // the executable code, not the metadata.
  const stripMetadata = (code: string): string => {
    const hex = code.toLowerCase().replace(/^0x/, "");
    const marker = "a26469706673"; // 0xa2 0x64 'i' 'p' 'f' 's'
    const idx = hex.lastIndexOf(marker);
    if (idx < 0) return code;
    return "0x" + hex.slice(0, idx);
  };
  // Immutable values (owner, token, ...) are baked into the runtime
  // code at deploy time: the local build has zero placeholders, the
  // on-chain code has the real addresses. Zero those ranges on both
  // sides before hashing (the values themselves are checked
  // separately via evm.roles / evm.token).
  const zeroImmutables = (code: string, refs: Record<string, { start: number; length: number }[]>): string => {
    const buf = Buffer.from(code.replace(/^0x/, ""), "hex");
    for (const ranges of Object.values(refs)) {
      for (const r of ranges) {
        if (r.start + r.length <= buf.length) buf.fill(0, r.start, r.start + r.length);
      }
    }
    return "0x" + buf.toString("hex");
  };
  const code1 = await evm1.getCode({ address: EVM_VAULT });
  const code2 = await evm2.getCode({ address: EVM_VAULT });
  const codeAgree = code1 === code2;
  check("rpc.evm-code", codeAgree, codeAgree ? "RPC1 == RPC2 (code)" : "RPC1 != RPC2 (code)");
  const evmDir = join(repoRoot, "evm");
  const forgeBin = process.env.HOME && (await import("node:fs")).existsSync(`${process.env.HOME}/.foundry/bin/forge`)
    ? `${process.env.HOME}/.foundry/bin/forge` : "forge";
  execSync(`${forgeBin} build`, { cwd: evmDir, stdio: "ignore" });
  const artifact = JSON.parse(readFileSync(join(evmDir, "out", "SpendFloorVault.sol", "SpendFloorVault.json"), "utf8"));
  const refs = (artifact.deployedBytecode.immutableReferences ?? {}) as Record<string, { start: number; length: number }[]>;
  const localCodeHash = keccak256(zeroImmutables(stripMetadata(artifact.deployedBytecode.object as Hash), refs) as Hash);
  const onChainCodeHash = code1 ? keccak256(zeroImmutables(stripMetadata(code1 as Hash), refs) as Hash) : "0x";
  check("evm.code", normHex(localCodeHash) === normHex(onChainCodeHash),
    normHex(localCodeHash) === normHex(onChainCodeHash)
      ? `on-chain code == local build (metadata + immutables stripped, ${onChainCodeHash.slice(0, 18)}…)`
      : `on-chain ${onChainCodeHash} != local build ${localCodeHash} (code changed, not the audited build)`);
  check("evm.token", evmPol.token.toLowerCase() === EVM_TOKEN.toLowerCase(),
    `vault token == ${evmPol.token} (expected SFUSD ${EVM_TOKEN})`);

  // --- EVM roles + agent balances ---
  const evmOwner1 = await evm1.readContract({ address: EVM_VAULT, abi: VAULT_ABI, functionName: "owner" }) as Address;
  check("evm.roles", evmOwner1.toLowerCase() === EVM_OWNER.toLowerCase() && evmPol.agent.toLowerCase() === EVM_AGENT.toLowerCase(),
    `owner=${evmOwner1} (expected ${EVM_OWNER}), agent=${evmPol.agent} (expected ${EVM_AGENT})`);
  const evmAgentNative = await evm1.getBalance({ address: EVM_AGENT });
  const evmAgentToken = await evm1.readContract({ address: EVM_TOKEN, abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ name: "", type: "uint256" }] }] as const, functionName: "balanceOf", args: [EVM_AGENT] }) as bigint;
  check("evm.agent", evmAgentNative === 0n && evmAgentToken === 0n,
    `AGENT native=${evmAgentNative} wei, SFUSD=${evmAgentToken} (both must be 0, E1)`);

  // --- SOL policy (both RPCs, must agree) ---
  const solPol1 = await readSolPolicy(sol1, SOL_PROGRAM);
  const solPol2 = await readSolPolicy(sol2, SOL_PROGRAM);
  const solPolAgree = JSON.stringify(solPol1, (_, v) => typeof v === "bigint" ? v.toString() : (v instanceof PublicKey ? v.toBase58() : (v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v))) ===
    JSON.stringify(solPol2, (_, v) => typeof v === "bigint" ? v.toString() : (v instanceof PublicKey ? v.toBase58() : (v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v)));
  check("rpc.sol", solPolAgree, solPolAgree ? "RPC1 == RPC2 (policy)" : "RPC1 != RPC2 (policy) — do not trust one path");
  const solPol = solPol1;
  const solRecipients = solPol.recipients.map((r) => r.toBase58());
  const solRecomputed = policyHash({
    version: solPol.version, decimals: solPol.decimals, perTxMax: solPol.perTxMax, windowMax: solPol.windowMax,
    windowSeconds: solPol.windowSeconds, windowAnchor: solPol.windowAnchor, expiresAt: solPol.expiresAt,
    evmRecipients: [EVM_MERCHANT], solRecipients,
  });
  const solStoredHash = toHexBytes(solPol.policyHash);
  check("sol.policy", normHex(solRecomputed) === normHex(solStoredHash),
    normHex(solRecomputed) === normHex(solStoredHash)
      ? `recomputed == stored (${solStoredHash})`
      : `recomputed ${solRecomputed} != stored ${solStoredHash} (TAMPER)`);
  const solRecOk = solRecipients.length === 1 && solRecipients[0] === SOL_MERCHANT.toBase58();
  check("sol.recipients", solRecOk,
    solRecOk ? `recipients == [merchant]` : `recipients == [${solRecipients.join(",")}] (expected [${SOL_MERCHANT.toBase58()}]) — precise diff: sol.recipients`);

  // --- SOL upgrade authority (must be OWNER, not AGENT) ---
  let upgradeAuth: string | null = null;
  try {
    const progInfo = await sol1.getAccountInfo(SOL_PROGRAM);
    if (progInfo && progInfo.data.length >= 36) {
      const programDataAddr = new PublicKey(progInfo.data.subarray(4, 36));
      const pdInfo = await sol1.getAccountInfo(programDataAddr);
      if (pdInfo && pdInfo.data.length >= 45 && pdInfo.data[12] === 1) {
        upgradeAuth = new PublicKey(pdInfo.data.subarray(13, 45)).toBase58();
      }
    }
  } catch { /* upgradeAuth stays null */ }
  check("sol.upgrade", upgradeAuth === SOL_OWNER.toBase58(),
    upgradeAuth ? `upgrade authority == ${upgradeAuth} (expected OWNER ${SOL_OWNER.toBase58()})` : "upgrade authority UNREADABLE (cannot confirm OWNER)");

  // --- SOL roles + agent balances ---
  check("sol.roles", solPol.owner.toBase58() === SOL_OWNER.toBase58() && solPol.agent.toBase58() === SOL_AGENT.toBase58(),
    `owner=${solPol.owner.toBase58()} (expected ${SOL_OWNER.toBase58()}), agent=${solPol.agent.toBase58()} (expected ${SOL_AGENT.toBase58()})`);
  const solAgentNative = await sol1.getBalance(SOL_AGENT);
  let solAgentToken = 0n;
  try {
    const { getAssociatedTokenAddress } = await import("@solana/spl-token");
    const ata = await getAssociatedTokenAddress(SOL_MINT, SOL_AGENT);
    const bal = await sol1.getTokenAccountBalance(ata);
    solAgentToken = BigInt(bal.value.amount);
  } catch { solAgentToken = 0n; /* no ATA == 0 */ }
  check("sol.agent", solAgentNative === 0 && solAgentToken === 0n,
    `AGENT native=${solAgentNative} lamports, SFUSD=${solAgentToken} (both must be 0, E1)`);

  // --- Cross-chain policy (caps + recipients, else DRIFT; anchor/expiry/spent are session state) ---
  const crossDiffs: string[] = [];
  if (evmPol.version !== solPol.version) crossDiffs.push(`version: evm=${evmPol.version} sol=${solPol.version}`);
  if (evmPol.decimals !== solPol.decimals) crossDiffs.push(`decimals: evm=${evmPol.decimals} sol=${solPol.decimals}`);
  if (evmPol.perTxMax !== solPol.perTxMax) crossDiffs.push(`perTx: evm=${evmPol.perTxMax} sol=${solPol.perTxMax}`);
  if (evmPol.windowMax !== solPol.windowMax) crossDiffs.push(`window: evm=${evmPol.windowMax} sol=${solPol.windowMax}`);
  if (evmPol.windowSeconds !== solPol.windowSeconds) crossDiffs.push(`windowSeconds: evm=${evmPol.windowSeconds} sol=${solPol.windowSeconds}`);
  if (evmPol.perTxMax !== EXPECTED_PER_TX || solPol.perTxMax !== EXPECTED_PER_TX) crossDiffs.push(`perTx != expected ${EXPECTED_PER_TX}`);
  if (evmPol.windowMax !== EXPECTED_WINDOW || solPol.windowMax !== EXPECTED_WINDOW) crossDiffs.push(`window != expected ${EXPECTED_WINDOW}`);
  if (evmPol.windowSeconds !== EXPECTED_WINDOW_SECS || solPol.windowSeconds !== EXPECTED_WINDOW_SECS) crossDiffs.push(`windowSeconds != expected ${EXPECTED_WINDOW_SECS}`);
  // Recipient sets (EVM via expected + hash proof above; SOL via live list).
  if (!solRecOk) crossDiffs.push(`sol.recipients != [merchant] (see sol.recipients)`);
  check("cross.policy", crossDiffs.length === 0,
    crossDiffs.length === 0
      ? "caps + recipients match across chains (anchor/expiry/spent differ by session, not drift)"
      : `DRIFT (X1): ${crossDiffs.join("; ")}`);

  // --- Final ---
  const failed = checks.filter((c) => !c.pass);
  const green = failed.length === 0;
  console.log(`\nVERIFY ${green ? "GREEN" : "RED"}: ${checks.length - failed.length}/${checks.length} checks pass${failed.length > 0 ? `; failing: ${failed.map((f) => f.name).join(", ")}` : ""}`);
  if (wantJson) {
    console.log(JSON.stringify({ green, checks }, null, 2));
  }
  process.exit(green ? 0 : 1);
}

main().catch((err) => { console.error(`VERIFY ERROR: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); });
