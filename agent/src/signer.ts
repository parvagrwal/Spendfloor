// Local intent signer for the agent. Loads the AGENT key from OUTSIDE the
// repo (sdk/keys.ts custody rules apply: on the owner machine this throws,
// which is the correct behavior) and signs the intent digest locally.
// It never builds, signs, or submits a blockchain transaction.
import { createHash, createPrivateKey, sign as ed25519Sign } from "node:crypto";
import { loadEvmAccount, loadSolKeypair } from "../../sdk/keys.js";

export interface PayIntent {
  chain: "evm" | "sol";
  to: string;
  amountMicro: string;
}

export interface SignedIntent {
  digest: string; // 0x-prefixed sha256 of the canonical intent bytes
  signer: string; // the AGENT address that signed
  signature: string; // hex
}

/** Canonical intent bytes: the thing T20 will match against on-chain failures. */
export function intentDigestBytes(intent: PayIntent): Uint8Array {
  const to = intent.chain === "evm" ? intent.to.toLowerCase() : intent.to;
  const text = `SPENDFLOOR/intent/v1\n${intent.chain}\n${to}\n${intent.amountMicro}`;
  return new Uint8Array(createHash("sha256").update(text, "utf8").digest());
}

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export async function signIntent(intent: PayIntent): Promise<SignedIntent> {
  const digestBytes = intentDigestBytes(intent);
  const digest = `0x${Buffer.from(digestBytes).toString("hex")}`;
  if (intent.chain === "evm") {
    const account = loadEvmAccount("agent"); // throws if absent (custody)
    const signature = await account.sign({ hash: digest as `0x${string}` });
    return { digest, signer: account.address, signature };
  }
  const keypair = loadSolKeypair("agent"); // throws if absent (custody)
  const seed = keypair.secretKey.subarray(0, 32);
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed)]);
  const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const signature = ed25519Sign(null, Buffer.from(digestBytes), key);
  return {
    digest,
    signer: keypair.publicKey.toBase58(),
    signature: `0x${signature.toString("hex")}`,
  };
}
