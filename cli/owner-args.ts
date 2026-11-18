import { isAddress, zeroAddress } from "viem";
import { PublicKey } from "@solana/web3.js";

const flags: Record<string, string[]> = {
  freeze: [],
  unfreeze: [],
  withdraw: ["--amount"],
  "set-policy": ["--per-tx", "--window", "--window-secs", "--expiry-secs"],
  "set-agent": ["--evm-agent", "--sol-agent"],
};
/** Validate both legs before starting either irreversible transaction. */
export function ownerArgs(op: string, args: string[]) {
  if (!Object.hasOwn(flags, op)) throw new Error("unknown owner operation");
  const result = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i],
      value = args[i + 1];
    if (!flags[op].includes(name) || !value || result.has(name))
      throw new Error(`invalid or repeated argument: ${name}`);
    if (name === "--evm-agent") {
      if (!isAddress(value) || value.toLowerCase() === zeroAddress)
        throw new Error("invalid EVM agent");
    } else if (name === "--sol-agent") {
      if (new PublicKey(value).equals(PublicKey.default))
        throw new Error("invalid Solana agent");
    } else {
      if (!/^\d{1,20}$/.test(value) || BigInt(value) > 0xffffffffffffffffn)
        throw new Error(`invalid u64: ${name}`);
      if (
        name === "--window-secs" &&
        (BigInt(value) < 60n || BigInt(value) > 31536000n)
      )
        throw new Error("invalid window duration");
      if (
        name === "--expiry-secs" &&
        BigInt(value) + BigInt(Math.ceil(Date.now() / 1000)) >
          0x7fffffffffffffffn
      )
        throw new Error("expiry exceeds i64");
    }
    result.set(name, value);
  }
  return result;
}
