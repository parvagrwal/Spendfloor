import { PACKET_DATA_SIZE, PublicKey, Transaction } from "@solana/web3.js";
import { buildSpendInstruction, policyPda } from "../sdk/sol.js";

export interface SponsoredSolVault {
  program: PublicKey;
  vaultToken: PublicKey;
  agent: PublicKey;
}

/** Only the amount, destination and blockhash come from the request. Never sign
 * the decoded request itself: compare its message to one built from trusted roles. */
export function checkedEnvelope(
  bytes: Uint8Array,
  payer: PublicKey,
  target: SponsoredSolVault,
  agentId: string,
): Transaction {
  if (bytes.length > PACKET_DATA_SIZE)
    throw new Error("oversized Solana transaction");
  const input = Transaction.from(bytes);
  const ix = input.instructions[0];
  if (
    input.instructions.length !== 1 ||
    ix.keys.length !== 5 ||
    ix.data.length !== 16 ||
    !input.recentBlockhash ||
    agentId !== target.agent.toBase58()
  ) {
    throw new Error("not a sponsored vault spend");
  }
  const expectedIx = buildSpendInstruction(
    target.program,
    policyPda(target.program)[0],
    target.vaultToken,
    ix.keys[2].pubkey,
    target.agent,
    ix.data.readBigUInt64LE(8),
  );
  if (
    expectedIx.keys.some((k) => k.pubkey.equals(payer)) ||
    target.program.equals(payer)
  )
    throw new Error("fee payer cannot be an instruction account");
  const expected = new Transaction({
    feePayer: payer,
    recentBlockhash: input.recentBlockhash,
  }).add(expectedIx);
  if (!expected.serializeMessage().equals(input.serializeMessage()))
    throw new Error("unexpected vault message");
  const sig = input.signatures.find((s) =>
    s.publicKey.equals(target.agent),
  )?.signature;
  if (!sig) throw new Error("missing agent signature");
  expected.addSignature(target.agent, sig);
  if (!expected.verifySignatures(false))
    throw new Error("invalid agent signature");
  return expected;
}
