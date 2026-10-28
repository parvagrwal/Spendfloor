// Generate ONE role keypair for ONE chain (T02).
//
//   tsx gen-key.ts --chain evm|sol --role owner|agent|submitter [--machine owner|agent]
//
// Rules:
//   - Keys are written to KEYS_DIR (outside the repo), file mode 0600.
//   - Refuses to overwrite an existing key file.
//   - First run on a machine must pass --machine, which writes the MACHINE
//     marker. After that the marker rules: an agent machine can never
//     generate an owner key, an owner machine can never generate agent or
//     submitter keys. Custody is enforced here, not by convention.
//   - Prints ONLY the public address. Never prints key material.

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  CHAINS,
  KEYS_DIR,
  ROLES,
  allowedRoles,
  keyFilePath,
  type Chain,
  type MachineKind,
  type Role,
} from "./keys.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const chain = arg("chain") as Chain | undefined;
const role = arg("role") as Role | undefined;
const machineArg = arg("machine") as MachineKind | undefined;

if (!chain || !CHAINS.includes(chain)) {
  console.error("--chain must be one of: evm, sol");
  process.exit(2);
}
if (!role || !ROLES.includes(role)) {
  console.error("--role must be one of: owner, agent, submitter");
  process.exit(2);
}

mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 });
try {
  chmodSync(KEYS_DIR, 0o700);
} catch {
  /* best effort on filesystems without POSIX modes */
}

const markerPath = join(KEYS_DIR, "MACHINE");
let kind: MachineKind;
if (existsSync(markerPath)) {
  const { machineKind } = await import("./keys.js");
  kind = machineKind();
  if (machineArg && machineArg !== kind) {
    console.error(
      `This machine is marked "${kind}" but --machine ${machineArg} was passed. Refusing.`
    );
    process.exit(1);
  }
} else {
  if (machineArg !== "owner" && machineArg !== "agent") {
    console.error(
      "First key on this machine: pass --machine owner or --machine agent."
    );
    process.exit(2);
  }
  kind = machineArg;
  writeFileSync(markerPath, kind + "\n", { mode: 0o600 });
  console.log(`Machine marked as: ${kind} (${markerPath})`);
}

if (!allowedRoles(kind).includes(role)) {
  console.error(
    `REFUSED: a "${kind}" machine must never hold a "${role}" key. Custody split is enforced.`
  );
  process.exit(1);
}

const path = keyFilePath(chain, role);
if (existsSync(path)) {
  console.error(`REFUSED: key file already exists, will not overwrite: ${path}`);
  process.exit(1);
}

let address: string;
if (chain === "evm") {
  const privateKey = generatePrivateKey();
  address = privateKeyToAccount(privateKey).address;
  const file = { type: "spendfloor/evm-key/v1", privateKey };
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
} else {
  const keypair = Keypair.generate();
  address = keypair.publicKey.toBase58();
  const file = {
    type: "spendfloor/sol-key/v1",
    secretKey: Array.from(keypair.secretKey),
  };
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
}

console.log(`chain:   ${chain}`);
console.log(`role:    ${role}`);
console.log(`address: ${address}`);
console.log(`file:    ${path} (mode 0600, key material not shown)`);
console.log(
  "Next: put the address into sdk/addresses.json in the repo (addresses are public)."
);
