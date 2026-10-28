// Canonical policy encoding + policyHash — the TS reference implementation
// (T05). The Solidity (T10) and Rust (T12a/T12b) implementations must
// produce byte-identical output; T14 proves it against
// policy/test/golden-hashes.json.
//
// Encoding (per IMPLEMENTATION_PLAN §2; all fixed-width, big-endian):
//
//   preimage = "SPENDFLOOR/v1"   13 ASCII bytes, no terminator, no length
//            || version          u32   (4 bytes)
//            || decimals         u8    (1 byte)
//            || per_tx_max       u64   (8 bytes, micro-units)
//            || window_max       u64   (8 bytes, micro-units)
//            || window_seconds   u64   (8 bytes)
//            || window_anchor    i64   (8 bytes, two's complement)
//            || expires_at       i64   (8 bytes, two's complement)
//            || evmSetHash       32 bytes
//            || solSetHash       32 bytes
//   policyHash = SHA-256(preimage), lowercase hex. Preimage length: 122.
//
// Set hash = SHA-256 over that chain's recipient address bytes concatenated
// in ascending byte order (EVM: 20-byte addresses; Solana: 32-byte pubkeys).
// Recipient labels are metadata and are NOT hashed. `frozen` and the roles
// are NOT part of the hash (verify checks them separately).

import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";

export const POLICY_TAG = "SPENDFLOOR/v1";
export const PREIMAGE_LENGTH = 122;

export interface PolicyInput {
  version: number; // u32; schema fixes it at 1
  decimals: number; // u8; schema fixes it at 6 for SFUSD
  perTxMax: bigint; // u64 micro-units
  windowMax: bigint; // u64 micro-units
  windowSeconds: bigint; // u64
  windowAnchor: bigint; // i64 unix seconds
  expiresAt: bigint; // i64 unix seconds
  evmRecipients: string[]; // 0x-prefixed 20-byte hex addresses
  solRecipients: string[]; // base58 32-byte pubkeys
}

const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

export function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

export function toHex(data: Uint8Array): string {
  return Buffer.from(data).toString("hex");
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function setHash(rawAddresses: Uint8Array[]): Uint8Array {
  const sorted = [...rawAddresses].sort(compareBytes);
  const total = sorted.reduce((n, a) => n + a.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const a of sorted) {
    buf.set(a, off);
    off += a.length;
  }
  return sha256(buf);
}

export function evmAddressBytes(address: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(`invalid EVM address: ${address}`);
  }
  return new Uint8Array(Buffer.from(address.slice(2), "hex"));
}

export function solPubkeyBytes(pubkey: string): Uint8Array {
  // PublicKey validates base58 and the 32-byte length.
  return new Uint8Array(new PublicKey(pubkey).toBytes());
}

export function evmSetHash(addresses: string[]): Uint8Array {
  return setHash(addresses.map(evmAddressBytes));
}

export function solSetHash(pubkeys: string[]): Uint8Array {
  return setHash(pubkeys.map(solPubkeyBytes));
}

function checkU64(name: string, v: bigint) {
  if (v < 0n || v > U64_MAX) throw new Error(`${name} out of u64 range: ${v}`);
}
function checkI64(name: string, v: bigint) {
  if (v < I64_MIN || v > I64_MAX) throw new Error(`${name} out of i64 range: ${v}`);
}

function validatePolicy(p: PolicyInput) {
  if (!Number.isInteger(p.version) || p.version < 0 || p.version > 0xffffffff) {
    throw new Error(`version out of u32 range: ${p.version}`);
  }
  if (!Number.isInteger(p.decimals) || p.decimals < 0 || p.decimals > 0xff) {
    throw new Error(`decimals out of u8 range: ${p.decimals}`);
  }
  checkU64("perTxMax", p.perTxMax);
  checkU64("windowMax", p.windowMax);
  checkU64("windowSeconds", p.windowSeconds);
  checkI64("windowAnchor", p.windowAnchor);
  checkI64("expiresAt", p.expiresAt);
  for (const [chain, list] of [
    ["evm", p.evmRecipients],
    ["sol", p.solRecipients],
  ] as const) {
    if (list.length < 1 || list.length > 8) {
      throw new Error(`${chain} recipients must be 1..8, got ${list.length}`);
    }
    const seen = new Set<string>();
    for (const r of list) {
      const bytes = chain === "evm" ? evmAddressBytes(r) : solPubkeyBytes(r);
      if (bytes.every((b) => b === 0)) throw new Error(`${chain} recipient is the zero address`);
      const key = toHex(bytes);
      if (seen.has(key)) throw new Error(`duplicate ${chain} recipient: ${r}`);
      seen.add(key);
    }
  }
}

export function encodePolicy(p: PolicyInput): Uint8Array {
  validatePolicy(p);
  const tag = new TextEncoder().encode(POLICY_TAG);
  const buf = new Uint8Array(PREIMAGE_LENGTH);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 0;
  buf.set(tag, off);
  off += tag.length;
  view.setUint32(off, p.version, false);
  off += 4;
  view.setUint8(off, p.decimals);
  off += 1;
  view.setBigUint64(off, p.perTxMax, false);
  off += 8;
  view.setBigUint64(off, p.windowMax, false);
  off += 8;
  view.setBigUint64(off, p.windowSeconds, false);
  off += 8;
  view.setBigInt64(off, p.windowAnchor, false);
  off += 8;
  view.setBigInt64(off, p.expiresAt, false);
  off += 8;
  buf.set(evmSetHash(p.evmRecipients), off);
  off += 32;
  buf.set(solSetHash(p.solRecipients), off);
  off += 32;
  if (off !== PREIMAGE_LENGTH) throw new Error(`preimage length bug: ${off}`);
  return buf;
}

export function policyHash(p: PolicyInput): string {
  return toHex(sha256(encodePolicy(p)));
}
