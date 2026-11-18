/** Convert a JSON number's decimal representation, not a rounded binary product. */
export function toMicro(value: number): bigint {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error("invalid SFUSD amount");
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(value));
  if (!match) throw new Error("amount must be in whole micro-units");
  const amount =
    BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0"));
  if (amount > 0xffffffffffffffffn) throw new Error("amount exceeds u64");
  return amount;
}
