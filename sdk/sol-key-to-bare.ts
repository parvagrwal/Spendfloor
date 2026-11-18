// Export only to a new owner-readable file. Remove it after the CLI operation.
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSolKeypair, ROLES, requireExternalPath } from "./keys.js";

const role = ROLES.find(r => r === process.argv[2]);
if (!role) throw new Error("usage: sol-key-to-bare.ts owner|agent|submitter [new-file]");
const kp = loadSolKeypair(role);
const out = process.argv[3] ?? join(mkdtempSync(join(tmpdir(), "spendfloor-export-")), `${role}.json`);
requireExternalPath(out);
writeFileSync(out, JSON.stringify(Array.from(kp.secretKey)), {flag: "wx", mode: 0o600});
console.log(`wrote ${out} (private key; remove after use)`);
