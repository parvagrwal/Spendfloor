// spend-once (T17 owner-step vectors).
//
// Does ONE agent spend (via the relay) and prints the label + hash.
// Used for the owner-step vectors that the testnet runner cannot do
// alone (V13/V14 freeze, V15/V16 rollover/expiry): Parv runs the owner
// step on his machine, then this script does the agent spend from the
// agent machine (my VM) and reports what the vault said.
//
// Usage:
//   npx tsx conformance/spend-once.ts evm <dest-address> <amount-sfusd>
//   npx tsx conformance/spend-once.ts sol <dest-token-account> <amount-sfusd>
//
// Defaults (demo deployment, T16):
//   EVM vault 0x8d13a6a31518b357a480659073b9db78ab861809
//   SOL program CQfuniyvMY9sPDAFMPRZzbpHEwRiyy3Y4BsfuQd3iAbE
//   SOL policy 5MUi1eZAfjaCukRDZNntAMJCr5Xz6gCRJ9s7D2iJyfuE
//   SOL vault token GhanJGGQhwhSL9q1Uvsy7MopiA2aDH7QERmrvqz1xn6N

import { PublicKey } from "@solana/web3.js";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
} from "viem";
import { baseSepolia } from "viem/chains";
import { loadEvmAccount, loadSolKeypair } from "../sdk/keys.js";
import { signEvmIntent, VAULT_ABI } from "../sdk/evm.js";
import { paySol, solConnection } from "../agent/pay.js";
import { createRelay, DEFAULT_RELAY_CONFIG } from "../relay/submitter.js";

const chain = process.argv[2];
const dest = process.argv[3];
const amountSfusd = Number(process.argv[4]);
if (!chain || !dest || !Number.isFinite(amountSfusd)) {
  console.log("usage: npx tsx conformance/spend-once.ts <evm|sol> <dest> <amount-sfusd>");
  process.exit(1);
}

const EVM_VAULT = "0x8d13a6a31518b357a480659073b9db78ab861809" as Address;
const SOL_PROGRAM = new PublicKey("CQfuniyvMY9sPDAFMPRZzbpHEwRiyy3Y4BsfuQd3iAbE");
const SOL_POLICY = new PublicKey("5MUi1eZAfjaCukRDZNntAMJCr5Xz6gCRJ9s7D2iJyfuE");
const SOL_VAULT_TOKEN = new PublicKey("GhanJGGQhwhSL9q1Uvsy7MopiA2aDH7QERmrvqz1xn6N");

async function main() {
  const evmPub = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
  const relay = createRelay(
    DEFAULT_RELAY_CONFIG,
    createWalletClient({ account: loadEvmAccount("submitter"), chain: baseSepolia, transport: http("https://sepolia.base.org") }),
    loadSolKeypair("submitter"),
    {},
  );
  relay.start();
  try {
    if (chain === "evm") {
      const agent = loadEvmAccount("agent");
      const chainId = await evmPub.getChainId();
      const nonce = (await evmPub.readContract({ address: EVM_VAULT, abi: VAULT_ABI, functionName: "nonce" })) as bigint;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
      const amount = BigInt(Math.round(amountSfusd * 1_000_000));
      const signed = await signEvmIntent(agent, chainId, EVM_VAULT, { to: dest as Address, amount, nonce, deadline });
      const res = await relay.submitEvm(agent.address, EVM_VAULT, signed);
      console.log(`EVM spend: to=${dest} amount=${amountSfusd} SFUSD ok=${res.ok} label=${res.label ?? "none"} hash=${res.hash ?? "none"}`);
    } else if (chain === "sol") {
      const conn = solConnection();
      const agentKp = loadSolKeypair("agent");
      const r = await paySol(relay, conn, agentKp, SOL_PROGRAM, SOL_POLICY, SOL_VAULT_TOKEN, new PublicKey(dest), amountSfusd);
      console.log(`SOL spend: to=${dest} amount=${amountSfusd} SFUSD ok=${r.receipt.ok} label=${r.receipt.label ?? "none"} hash=${r.receipt.hash ?? "none"}`);
    } else {
      console.log(`unknown chain: ${chain}`);
      process.exit(1);
    }
  } finally {
    relay.stop();
  }
}

main().catch((err) => { console.error(`FAIL ${err instanceof Error ? err.message : String(err)}`); process.exit(1); });
