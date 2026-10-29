// read-policy (T17 post-reset check).
// Prints the demo vault/policy state so we can verify the reset
// actually restored spending headroom (spent resets on the next spend
// only when the window index differs from the stored window).
//
// Usage: npx tsx conformance/read-policy.ts

import { PublicKey } from "@solana/web3.js";
import { createPublicClient, http, type Address } from "viem";
import { baseSepolia } from "viem/chains";
import { readEvmPolicy } from "../sdk/evm.js";
import { readSolPolicy } from "../sdk/sol.js";
import { solConnection } from "../agent/pay.js";

const EVM_VAULT = "0x8d13a6a31518b357a480659073b9db78ab861809" as Address;
const SOL_PROGRAM = new PublicKey("CQfuniyvMY9sPDAFMPRZzbpHEwRiyy3Y4BsfuQd3iAbE");

async function main() {
  const pub = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
  const evm = await readEvmPolicy(pub as never, EVM_VAULT);
  console.log(`EVM demo vault: spentInWindow=${evm.spentInWindow} currentWindow=${evm.currentWindow} windowAnchor=${evm.windowAnchor} windowSeconds=${evm.windowSeconds} frozen=${evm.frozen} nonce=${evm.nonce}`);
  const conn = solConnection();
  const sol = await readSolPolicy(conn, SOL_PROGRAM);
  console.log(`SOL policy: spent=${sol.spent} window=${sol.window} windowAnchor=${sol.windowAnchor} windowSeconds=${sol.windowSeconds} frozen=${sol.frozen} expiresAt=${sol.expiresAt}`);
}

main().catch((err) => { console.error(`FAIL ${err instanceof Error ? err.message : String(err)}`); process.exit(1); });
