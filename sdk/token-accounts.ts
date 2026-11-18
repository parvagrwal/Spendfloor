/** Classic SPL only. Mint filter covers *all* accounts, not just the ATA. */
import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "./sol.js";

export async function ownedTokenBalance(
  connection: Connection,
  mint: PublicKey,
  owner: PublicKey,
): Promise<bigint> {
  const { value } = await connection.getTokenAccountsByOwner(owner, { mint });
  let total = 0n;
  for (const { account } of value) {
    const data = account.data;
    if (
      !account.owner.equals(TOKEN_PROGRAM_ID) ||
      data.length !== 165 ||
      !data.subarray(0, 32).equals(mint.toBuffer()) ||
      !data.subarray(32, 64).equals(owner.toBuffer())
    )
      throw new Error("unexpected token account");
    total += data.readBigUInt64LE(64);
  }
  return total;
}

const ataProgram = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);
export function ownerAta(mint: PublicKey, owner: PublicKey) {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ataProgram,
  );
  const create = new TransactionInstruction({
    programId: ataProgram,
    data: Buffer.from([1]), // CreateIdempotent
    keys: [
      owner,
      address,
      owner,
      mint,
      SystemProgram.programId,
      TOKEN_PROGRAM_ID,
    ].map((pubkey, i) => ({ pubkey, isSigner: i === 0, isWritable: i < 2 })),
  });
  return { address, create };
}
