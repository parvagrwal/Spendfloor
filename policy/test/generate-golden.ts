// Generates policy/test/golden-hashes.json (T05). Deterministic: the Solana
// recipient pubkeys are derived from fixed seeds, amounts and times are
// frozen constants, so re-running reproduces the same file byte for byte.
//   tsx test/generate-golden.ts
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import {
  encodePolicy,
  evmSetHash,
  policyHash,
  solSetHash,
  toHex,
  type PolicyInput,
} from "../src/canonical.js";

function solFromSeed(label: string): string {
  const seed = createHash("sha256").update(`spendfloor/golden/${label}`).digest();
  return Keypair.fromSeed(new Uint8Array(seed)).publicKey.toBase58();
}

const EVM_A = "0x00000000000000000000000000000000000A11CE";
const EVM_B = "0x0000000000000000000000000000000000000B0B";
const SOL_1 = solFromSeed("sol-merchant-1");
const SOL_2 = solFromSeed("sol-merchant-2");
const BASE = 1760000000n; // frozen anchor constant for all vectors

const P = (
  perTxMax: bigint,
  windowMax: bigint,
  windowSeconds: bigint,
  expiresAt: bigint,
  evmRecipients: string[],
  solRecipients: string[],
  windowAnchor: bigint = BASE
): PolicyInput => ({
  version: 1,
  decimals: 6,
  perTxMax,
  windowMax,
  windowSeconds,
  windowAnchor,
  expiresAt,
  evmRecipients,
  solRecipients,
});

const GOLDENS: { name: string; note: string; policy: PolicyInput }[] = [
  {
    name: "G1-p0-conformance",
    note: "Policy P0 from the plan: per-tx 2, window 5 per 86400 s, expiry +24 h, one merchant per chain.",
    policy: P(2_000_000n, 5_000_000n, 86_400n, BASE + 86_400n, [EVM_A], [SOL_1]),
  },
  {
    name: "G2-p1-short-window-two-recipients",
    note: "P1-style short window (300 s) with two recipients per chain; exercises multi-recipient set hashing.",
    policy: P(1_000_000n, 3_000_000n, 300n, BASE + 86_400n, [EVM_A, EVM_B], [SOL_1, SOL_2]),
  },
  {
    name: "G3-p2-short-expiry-min-amounts",
    note: "P2-style expiry (+180 s), minimum amounts (1 micro-unit) and minimum window (60 s).",
    policy: P(1n, 1n, 60n, BASE + 180n, [EVM_B], [SOL_2]),
  },
  {
    name: "G4-large-values",
    note: "u64-max window and a >2^53 per-tx value; i64 times past the u32 range (2030 / 2100). Catches width and precision bugs.",
    policy: P(
      12345678901234567890n,
      18446744073709551615n,
      31_536_000n,
      4102444800n,
      [EVM_A],
      [SOL_1],
      1893456000n
    ),
  },
  {
    name: "G5-order-invariance",
    note: "Same policy as G2 with recipient lists reversed. MUST produce the identical policyHash as G2 (sets are sorted before hashing; labels are not hashed).",
    policy: P(1_000_000n, 3_000_000n, 300n, BASE + 86_400n, [EVM_B, EVM_A], [SOL_2, SOL_1]),
  },
];

const out = GOLDENS.map(({ name, note, policy }) => ({
  name,
  note,
  policy: {
    version: policy.version,
    decimals: policy.decimals,
    perTxMax: policy.perTxMax.toString(),
    windowMax: policy.windowMax.toString(),
    windowSeconds: policy.windowSeconds.toString(),
    windowAnchor: policy.windowAnchor.toString(),
    expiresAt: policy.expiresAt.toString(),
    evmRecipients: policy.evmRecipients,
    solRecipients: policy.solRecipients,
  },
  canonicalBytesHex: toHex(encodePolicy(policy)),
  evmSetHash: toHex(evmSetHash(policy.evmRecipients)),
  solSetHash: toHex(solSetHash(policy.solRecipients)),
  policyHash: policyHash(policy),
}));

const path = new URL("./golden-hashes.json", import.meta.url);
writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
for (const g of out) console.log(`${g.name}  policyHash=${g.policyHash}`);
console.log(`wrote ${out.length} golden vectors to policy/test/golden-hashes.json`);
