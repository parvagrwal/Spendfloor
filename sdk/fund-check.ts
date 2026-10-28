// fund-check (T02 acceptance, reused by later tasks).
//
//   tsx fund-check.ts
//
// Prints OWNER / AGENT / SUBMITTER addresses on both chains from the
// in-repo registry, then asserts the custody rules on THIS machine:
//   1. Every registry address is filled in.
//   2. No forbidden private key exists here (agent machine: no OWNER key;
//      owner machine: no AGENT or SUBMITTER key). This is the R-10 check:
//      the OWNER key is ABSENT from the agent machine.
//   3. Any private key held here matches its registry address.
//   4. AGENT native balance is exactly 0 on both chains (live RPC read).
// Exit 0 only when every assert passes.

import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import { createPublicClient, formatEther, http } from "viem";
import { baseSepolia } from "viem/chains";
import {
  CHAINS,
  ROLES,
  allowedRoles,
  hasPrivateKey,
  loadEvmAccount,
  loadRegistry,
  loadSolKeypair,
  machineKind,
  type Role,
} from "./keys.js";

const EVM_RPC = process.env.SPENDFLOOR_EVM_RPC ?? "https://sepolia.base.org";
const SOL_RPC = process.env.SPENDFLOOR_SOL_RPC ?? "https://api.devnet.solana.com";

let failures = 0;
const ok = (msg: string) => console.log(`OK    ${msg}`);
const fail = (msg: string) => {
  failures += 1;
  console.log(`FAIL  ${msg}`);
};

const kind = machineKind();
console.log(`machine: ${kind}`);
console.log(`rpc:     evm=${EVM_RPC} sol=${SOL_RPC}`);
console.log("");

const registry = loadRegistry();

// 1 + address table
for (const chain of CHAINS) {
  for (const role of ROLES) {
    const addr = registry[chain][role];
    if (addr) {
      console.log(`${chain.toUpperCase()} ${role.padEnd(9)} ${addr}`);
    } else {
      fail(`${chain.toUpperCase()} ${role} address NOT GENERATED yet`);
    }
  }
}
console.log("");

// 2 + 3: custody and key/registry match
const allowed = allowedRoles(kind);
for (const chain of CHAINS) {
  for (const role of ROLES) {
    const present = hasPrivateKey(chain, role);
    if (!allowed.includes(role) && present) {
      fail(
        `${chain} ${role} private key EXISTS on a ${kind} machine (custody violation)`
      );
    }
    if (!allowed.includes(role) && !present) {
      ok(`${chain} ${role} private key absent on this ${kind} machine`);
    }
    if (allowed.includes(role) && present) {
      const loaded =
        chain === "evm"
          ? loadEvmAccount(role).address
          : loadSolKeypair(role).publicKey.toBase58();
      const expected = registry[chain][role];
      if (expected && loaded === expected) {
        ok(`${chain} ${role} local key matches registry address`);
      } else if (expected) {
        fail(`${chain} ${role} local key does NOT match registry address`);
      }
    }
    if (allowed.includes(role) && !present) {
      console.log(
        `NOTE  ${chain} ${role} key not generated on this machine yet`
      );
    }
  }
}
console.log("");

// 4: balances, agent must be exactly zero
const evm = createPublicClient({ chain: baseSepolia, transport: http(EVM_RPC) });
const sol = new Connection(SOL_RPC, "confirmed");

async function balance(chain: "evm" | "sol", role: Role): Promise<bigint> {
  const addr = registry[chain][role];
  if (!addr) throw new Error("no address");
  if (chain === "evm") return evm.getBalance({ address: addr as `0x${string}` });
  return BigInt(await sol.getBalance(new PublicKey(addr)));
}

for (const chain of CHAINS) {
  for (const role of ROLES) {
    const addr = registry[chain][role];
    if (!addr) continue;
    try {
      const bal = await balance(chain, role);
      const human =
        chain === "evm"
          ? `${formatEther(bal)} ETH`
          : `${Number(bal) / LAMPORTS_PER_SOL} SOL`;
      console.log(`${chain.toUpperCase()} ${role.padEnd(9)} balance: ${human}`);
      if (role === "agent") {
        if (bal === 0n) ok(`${chain} AGENT balance is exactly 0`);
        else fail(`${chain} AGENT balance is NOT zero (${human})`);
      }
    } catch (e) {
      fail(`${chain} ${role} balance read failed: ${(e as Error).message}`);
    }
  }
}

console.log("");
if (failures > 0) {
  console.log(`fund-check: ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("fund-check: all asserts passed");
