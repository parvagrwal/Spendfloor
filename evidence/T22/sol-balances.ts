// T22 S1/S2 helper: public reads only, loads NO keys.
// Prints the Solana agent's native SOL balance and its SFUSD token balance
// (via its associated token account; a missing ATA means balance 0).
import { Connection, PublicKey } from '@solana/web3.js';
import { ownedTokenBalance } from '../../sdk/token-accounts.js';

async function main() {
  const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
  const agent = new PublicKey('5Df6mNkbr8J6XETfKAhhwL7JsRVkbr3rgvS6J3tvEBo3');
  const mint = new PublicKey('ESB1d6WUnz6e9yRmC9hv8MrHHzrQs8eFSV6aosDHNt2U');
  const lamports = await conn.getBalance(agent);
  console.log('SOL agent native (lamports):', lamports);
  console.log('SOL agent SFUSD (all accounts):', String(await ownedTokenBalance(conn, mint, agent)));
}
main().catch((e) => { console.error(e); process.exit(1); });
