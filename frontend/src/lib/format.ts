import type { ChainKey, ExecutionState, Freshness, PolicyValues, VerificationState } from "./types";

export function microToSfusd(micro: string | null | undefined): string {
  if (!micro) return "—";
  const value = BigInt(micro);
  const whole = value / 1_000_000n;
  const frac = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function shortId(value: string | null | undefined, head = 10, tail = 8): string {
  if (!value) return "—";
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
}

export function formatDate(date: string | null | undefined): string {
  if (!date) return "—";
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

export function statusLabel(state: VerificationState): string {
  switch (state) {
    case "verified": return "Verified";
    case "partial": return "Partial";
    case "failed": return "Verification failed";
    default: return "Unavailable";
  }
}

export function executionLabel(state: ExecutionState): string {
  switch (state) {
    case "not_started": return "Not started";
    case "processing": return "Processing";
    case "signed": return "Signed";
    case "submitted": return "Submitted";
    case "confirmed": return "Confirmed";
    case "rejected": return "Rejected";
    case "failed": return "Failed";
    case "timed_out": return "Timed out";
    default: return "Unknown outcome";
  }
}

export function freshnessLabel(source: Freshness): string {
  return source === "Unavailable" ? "Unavailable" : source;
}

export function chainShortName(chain: ChainKey): string {
  return chain === "evm" ? "BASE" : "SOL";
}

export function policySummary(policy: PolicyValues | null): string {
  if (!policy) return "Policy state unavailable";
  return `${microToSfusd(policy.perTxMax)} SFUSD per tx · ${microToSfusd(policy.windowMax)} SFUSD / ${Number(policy.windowSeconds) / 3600} h window`;
}
