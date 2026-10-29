// sol-key-to-bare (helper for Solana CLI deploys).
//
//   Usage: npx tsx sdk/sol-key-to-bare.ts <role> [out-path]
//
// Writes the secret key of a stored Solana keypair as a bare JSON array
// (the format the Solana CLI needs) to /tmp/<role>-bare.json by default.
// The stored file may be bare or wrapped; the loader handles both.
// Delete the output file after the CLI step that needed it: it holds
// private key material. This script NEVER prints key material.

import { writeFileSync } from "node:fs";
import { loadSolKeypair } from "./keys.js";

const role = process.argv[2];
if (!role) {
  console.log("FAIL  usage: npx tsx sdk/sol-key-to-bare.ts <role> [out-path]");
  process.exit(1);
}
const out = process.argv[3] ?? `/tmp/sol-${role}-bare.json`;
const kp = loadSolKeypair(role as "owner" | "agent" | "submitter");
writeFileSync(out, JSON.stringify(Array.from(kp.secretKey)));
console.log(`wrote ${out} (delete it after the CLI step)`);
