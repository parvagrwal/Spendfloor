import { type Hex } from "viem";

/** Ignore only the pinned compiler's terminal metadata. Immutable operands
 * must be the same in every use and collectively match the deployment. */
export function matchesRuntime(
  local: Hex,
  live: Hex,
  refs: Record<string, { start: number; length: number }[]>,
  values: Hex[],
): boolean {
  const executable = (hex: Hex) =>
    Buffer.from(
      hex
        .slice(2)
        .replace(
          /a2646970667358221220[0-9a-f]{64}64736f6c63430008250033$/i,
          "",
        ),
      "hex",
    );
  const expected = executable(local),
    actual = executable(live);
  if (expected.length === 0 || actual.length !== expected.length) return false;
  const remaining = new Set(
    values.map((v) => v.slice(2).toLowerCase().padStart(64, "0")),
  );
  for (const sites of Object.values(refs)) {
    let group: string | undefined;
    for (const { start, length } of sites) {
      if (length !== 32 || start < 0 || start + length > actual.length)
        return false;
      const operand = actual.subarray(start, start + length).toString("hex");
      if (group !== undefined && operand !== group) return false;
      group = operand;
      actual.fill(0, start, start + length);
    }
    if (!group || !remaining.delete(group)) return false;
  }
  return remaining.size === 0 && actual.equals(expected);
}
