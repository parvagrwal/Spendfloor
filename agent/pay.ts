// pay (T20 pay tool).
//
// The agent's ONLY tool. It signs what the LLM asked and submits it
// through the relay. It enforces NOTHING (C9): no cap check, no
// recipient check, no frozen check, no client-side policy of any kind.
// The vault is the sole enforcement. A nonce read is not policy (it is
// replay protection the vault enforces anyway); an intent-digest read
// is for the log, not for gating.
//
// Every pay returns a machine-generated receipt plus the signed payload
// digest, so the on-chain transaction can be matched to what the signer
// signed:
//   EVM: the vault's intentDigest (what the vault recovers) + the tx hash.
//   Solana: the transaction signature (which commits to the spend ix).
// Amount fidelity (LLM output vs the message's amount) is checked by
// the caller, not here: this tool signs exactly what the LLM said, so
// a slip in the LLM's output is visible in the log, not hidden by the
// tool.

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  createPublicClient,
  http,
  type Account,
  type Address,
  type Hash,
  type PublicClient,
} from "viem";
import { baseSepolia, foundry } from "viem/chains";
import type { SpendResult } from "../sdk/errors.js";
import { buildSpendInstruction } from "../sdk/sol.js";
import {
  signEvmIntent,
  VAULT_ABI,
} from "../sdk/evm.js";
import type { Relay } from "../relay/submitter.js";

export interface PayReceipt {
  chain: "evm" | "sol";
  /** What the LLM asked for (SFUSD, dollars). */
  llmAmountSfusd: number;
  /** What was actually signed (micro-units, 6 decimals). */
  signedAmountMicro: bigint;
  /** EVM: the vault's intentDigest. Solana: the tx signature. */
  payloadDigest: string;
  receipt: SpendResult;
}

const toMicro = (sfusd: number): bigint => BigInt(Math.round(sfusd * 1_000_000));

export async function payEvm(
  relay: Relay,
  evmPublic: PublicClient,
  agent: Account,
  chainId: number,
  vault: Address,
  to: Address,
  llmAmountSfusd: number,
): Promise<PayReceipt> {
  const amountMicro = toMicro(llmAmountSfusd);
  const nonce = (await evmPublic.readContract({
    address: vault,
    abi: VAULT_ABI,
    functionName: "nonce",
  })) as bigint;
  // Deadline from the chain's block timestamp, not wall clock (T17
  // lesson: Anvil warps run its clock ahead of real time, so a wall-
  // clock deadline can already be past -> IntentExpired, which is
  // what killed T27's first legit control). The vault checks the
  // deadline against block.timestamp, so block time is the correct
  // source on both Anvil and testnet.
  const block = await evmPublic.getBlock({ blockTag: "latest" });
  const deadline = block.timestamp + 300n;
  const signed = await signEvmIntent(agent, chainId, vault, {
    to,
    amount: amountMicro,
    nonce,
    deadline,
  });
  const digest = (await evmPublic.readContract({
    address: vault,
    abi: VAULT_ABI,
    functionName: "intentDigest",
    args: [to, amountMicro, nonce, deadline],
  })) as Hash;
  const receipt = await relay.submitEvm(agent.address, vault, signed);
  return {
    chain: "evm",
    llmAmountSfusd,
    signedAmountMicro: amountMicro,
    payloadDigest: digest,
    receipt,
  };
}

export async function paySol(
  relay: Relay,
  connection: Connection,
  agentKp: Keypair,
  programId: PublicKey,
  policy: PublicKey,
  vaultToken: PublicKey,
  destToken: PublicKey,
  llmAmountSfusd: number,
): Promise<PayReceipt> {
  const amountMicro = toMicro(llmAmountSfusd);
  const ix = buildSpendInstruction(
    programId,
    policy,
    vaultToken,
    destToken,
    agentKp.publicKey,
    amountMicro,
  );
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash();
  const tx = new Transaction({
    feePayer: relay.solSubmitterAddress(),
    blockhash,
    lastValidBlockHeight,
  }).add(ix);
  tx.sign(agentKp); // partial: agent only; the relay adds the fee payer sig
  const serialized = tx.serialize({ requireAllSignatures: false });
  const receipt = await relay.submitSol(agentKp.publicKey.toBase58(), serialized);
  // The signature is the payload digest: it commits to the spend ix.
  const sig = receipt.hash ?? "";
  return {
    chain: "sol",
    llmAmountSfusd,
    signedAmountMicro: amountMicro,
    payloadDigest: sig,
    receipt,
  };
}

/** Load the agent + submitter clients for a chain (testnet or localnet). */
export function evmClients(localnet: boolean): {
  pub: PublicClient;
  chainId: number;
} {
  const chain = localnet ? foundry : baseSepolia;
  const rpc = localnet ? "http://127.0.0.1:8545" : "https://sepolia.base.org";
  return {
    pub: createPublicClient({ chain, transport: http(rpc) }) as PublicClient,
    chainId: localnet ? 31337 : 84532,
  };
}

export function solConnection(): Connection {
  return new Connection("https://api.devnet.solana.com", "confirmed");
}
