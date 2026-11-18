// SpendFloor key custody (T02).
//
// Private keys live OUTSIDE the repo, in KEYS_DIR (default ~/.spendfloor-keys,
// override with SPENDFLOOR_KEYS_DIR). This module never logs key material;
// it only ever exposes addresses in the clear.
//
// Custody model (MUSE.md core rule):
//   - the OWNER machine holds OWNER keys only, and generates nothing else
//   - the AGENT machine holds AGENT + SUBMITTER keys only, never OWNER
// A marker file KEYS_DIR/MACHINE ("owner" | "agent") records which machine
// this is. gen-key.ts enforces the split at generation time and
// fund-check.ts asserts it after the fact.

import { existsSync, readFileSync, openSync, closeSync, fstatSync, constants, realpathSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

export const CHAINS = ["evm", "sol"] as const;
export type Chain = (typeof CHAINS)[number];

export const ROLES = ["owner", "agent", "submitter"] as const;
export type Role = (typeof ROLES)[number];

export type MachineKind = "owner" | "agent";

export const KEYS_DIR =
  process.env.SPENDFLOOR_KEYS_DIR ?? join(homedir(), ".spendfloor-keys");

const repo = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
/** Resolve existing ancestors as well as the requested name (including symlinks). */
export function requireExternalPath(path: string): void {
  let parent = resolve(path);
  while (!existsSync(parent)) parent = dirname(parent);
  const real = realpathSync(parent);
  if (real === repo || real.startsWith(repo + sep)) throw new Error("private keys must be outside the checkout");
}
export function checkKeyDirectory(): void {
  requireExternalPath(KEYS_DIR);
  const dir = lstatSync(KEYS_DIR);
  if (!dir.isDirectory() || (dir.mode & 0o077) !== 0 || (process.getuid && dir.uid !== process.getuid())) throw new Error("key directory must be private and owned by the current user (chmod 700)");
}

export function keyFilePath(chain: Chain, role: Role): string {
  return join(KEYS_DIR, `${chain}-${role}.json`);
}

export function machineKind(): MachineKind {
  checkKeyDirectory();
  const marker = join(KEYS_DIR, "MACHINE");
  if (!existsSync(marker)) {
    throw new Error(
      `No machine marker at ${marker}. Run gen-key once with --machine owner|agent.`
    );
  }
  const value = readFileSync(marker, "utf8").trim();
  if (value !== "owner" && value !== "agent") {
    throw new Error("Invalid MACHINE marker");
  }
  return value;
}

/** Which roles this machine is allowed to hold private keys for. */
export function allowedRoles(kind: MachineKind): Role[] {
  return kind === "owner" ? ["owner"] : ["agent", "submitter"];
}

export function hasPrivateKey(chain: Chain, role: Role): boolean {
  return existsSync(keyFilePath(chain, role));
}

type EvmKeyFile = { type: "spendfloor/evm-key/v1"; privateKey: `0x${string}` };
type SolKeyFile =
  | { type: "spendfloor/sol-key/v1"; secretKey: number[] }
  | number[]; // bare array, solana-keygen compatible

function readPrivateJson(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0) throw new Error(`unsafe key file type, size or permissions: ${path}`);
    try { return JSON.parse(readFileSync(fd, "utf8")); }
    catch { throw new Error(`invalid key file: ${path}`); } // never include secret bytes in a parse error
  } finally { closeSync(fd); }
}

export function loadEvmAccount(role: Role): PrivateKeyAccount {
  if (!allowedRoles(machineKind()).includes(role)) throw new Error("role not permitted on this machine");
  const path = keyFilePath("evm", role);
  if (!existsSync(path)) throw new Error(`EVM key absent: ${path}`);
  const parsed = readPrivateJson(path) as EvmKeyFile;
  if (parsed?.type !== "spendfloor/evm-key/v1" || typeof parsed.privateKey !== "string" || !/^0x[0-9a-f]{64}$/i.test(parsed.privateKey)) {
    throw new Error(`Unrecognized EVM key file format: ${path}`);
  }
  try { return privateKeyToAccount(parsed.privateKey); } catch { throw new Error(`invalid EVM private key: ${path}`); }
}

export function loadSolKeypair(role: Role): Keypair {
  if (!allowedRoles(machineKind()).includes(role)) throw new Error("role not permitted on this machine");
  const path = keyFilePath("sol", role);
  if (!existsSync(path)) throw new Error(`SOL key absent: ${path}`);
  const parsed = readPrivateJson(path) as SolKeyFile;
  const secret = Array.isArray(parsed) ? parsed : parsed?.type === "spendfloor/sol-key/v1" ? parsed.secretKey : undefined;
  if (!Array.isArray(secret) || secret.length !== 64 || !secret.every(b => Number.isInteger(b) && b >= 0 && b <= 255)) {
    throw new Error(`Unrecognized SOL key file format: ${path}`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

// --- Public address registry (in-repo, safe to share) ---

type Registry = Record<Chain, Record<Role, string | null>>;

export function loadRegistry(): Registry {
  const url = new URL("./addresses.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Registry;
}

export function registryAddress(chain: Chain, role: Role): string | null {
  return loadRegistry()[chain][role];
}
