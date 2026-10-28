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

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

export const CHAINS = ["evm", "sol"] as const;
export type Chain = (typeof CHAINS)[number];

export const ROLES = ["owner", "agent", "submitter"] as const;
export type Role = (typeof ROLES)[number];

export type MachineKind = "owner" | "agent";

export const KEYS_DIR =
  process.env.SPENDFLOOR_KEYS_DIR ?? join(homedir(), ".spendfloor-keys");

export function keyFilePath(chain: Chain, role: Role): string {
  return join(KEYS_DIR, `${chain}-${role}.json`);
}

export function machineKind(): MachineKind {
  const marker = join(KEYS_DIR, "MACHINE");
  if (!existsSync(marker)) {
    throw new Error(
      `No machine marker at ${marker}. Run gen-key once with --machine owner|agent.`
    );
  }
  const value = readFileSync(marker, "utf8").trim();
  if (value !== "owner" && value !== "agent") {
    throw new Error(`Bad MACHINE marker value: ${JSON.stringify(value)}`);
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

export function loadEvmAccount(role: Role): PrivateKeyAccount {
  const path = keyFilePath("evm", role);
  if (!existsSync(path)) throw new Error(`EVM key absent: ${path}`);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as EvmKeyFile;
  if (parsed.type !== "spendfloor/evm-key/v1" || !parsed.privateKey) {
    throw new Error(`Unrecognized EVM key file format: ${path}`);
  }
  return privateKeyToAccount(parsed.privateKey);
}

export function loadSolKeypair(role: Role): Keypair {
  const path = keyFilePath("sol", role);
  if (!existsSync(path)) throw new Error(`SOL key absent: ${path}`);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as SolKeyFile;
  const secret = Array.isArray(parsed) ? parsed : parsed.secretKey;
  if (!Array.isArray(secret) || secret.length !== 64) {
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
