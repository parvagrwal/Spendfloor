// T22 SOL raw overspend — standalone attempt, no app spend logic.
// The spend instruction is built by hand (Anchor discriminator + account
// order from the program interface) and submitted directly via web3.js.
// Key loading uses the project's existing SDK loader (sdk/keys.ts, the same
// loader T17/T20/T27 used) — this script does NOT read key files itself.
// It prints ONLY public values (pubkeys, tx signature, program error).
//
// Intended attempt: spend 50 SFUSD to the ATTACKER (not allowlisted, and over
// both caps). Expected result: the transaction FAILS with the program's
// RecipientNotAllowed error (6003), and the policy reads back unchanged.
import { createHash } from 'node:crypto';
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { loadSolKeypair } from '../../sdk/keys.js';

const PROGRAM = new PublicKey('CQfuniyvMY9sPDAFMPRZzbpHEwRiyy3Y4BsfuQd3iAbE');
const POLICY = new PublicKey('5MUi1eZAfjaCukRDZNntAMJCr5Xz6gCRJ9s7D2iJyfuE');
const VAULT_TOKEN = new PublicKey('GhanJGGQhwhSL9q1Uvsy7MopiA2aDH7QERmrvqz1xn6N');
const ATTACKER_ATA = new PublicKey('94o4pwuHjHWu6GjFuxit9yNYFGg8V5Rgw8uPh6LzSNrz');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const AMOUNT = 50000000n; // 50 SFUSD, 6dp: over perTx 2 and window 5, to a non-recipient

async function main() {
  const agent = loadSolKeypair('agent');
  const submitter = loadSolKeypair('submitter');
  console.log('agent (signer):', agent.publicKey.toBase58());
  console.log('submitter (fee payer):', submitter.publicKey.toBase58());

  // Anchor discriminator: first 8 bytes of sha256("global:spend").
  const disc = createHash('sha256').update('global:spend').digest().subarray(0, 8);
  const data = Buffer.alloc(16);
  disc.copy(data, 0);
  data.writeBigUInt64LE(AMOUNT, 8);

  // Spend accounts in program order: policy, vault_token, dest_token,
  // agent (signer), token_program (readonly).
  const ix = new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: POLICY, isSigner: false, isWritable: true },
      { pubkey: VAULT_TOKEN, isSigner: false, isWritable: true },
      { pubkey: ATTACKER_ATA, isSigner: false, isWritable: true },
      { pubkey: agent.publicKey, isSigner: true, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data,
  });

  const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const tx = new Transaction({ feePayer: submitter.publicKey, blockhash, lastValidBlockHeight });
  tx.add(ix);
  tx.sign(agent, submitter);
  try {
    const sig = await conn.sendRawTransaction(tx.serialize());
    console.log('tx signature:', sig);
    const conf = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    console.log('confirmation error:', conf.value.err ? JSON.stringify(conf.value.err) : 'none (UNEXPECTED: overspend landed)');
  } catch (e: any) {
    console.log('submission failed (expected for a policy violation):', e?.message ?? String(e));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
