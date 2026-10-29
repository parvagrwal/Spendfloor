// Diff a drafted policy against the intended policy (T09, SPIKE-COMPILE).
// The security-relevant direction is LOOSER: a draft that lets MORE money
// move, to MORE destinations, FASTER, or for LONGER than intended is a
// defect even if every other field matches. The overall verdict is LOOSER
// if ANY field is looser, so a single loosening cannot hide behind
// tightenings elsewhere.
//
// Field rules:
// - perTxMax / windowMax: drafted > intended = looser (more money).
// - windowSeconds: drafted < intended = looser (the same window cap
//   replenishes faster). Drafted > intended = tighter.
// - recipients: any drafted recipient NOT in the intended set = looser
//   (a destination the owner never approved). A strict subset = tighter.
//   Sets compare order-insensitively, matching the set-hash semantics.
// - expiresAt: intended 0 means no expiry, so any drafted expiry is
//   tighter and only 0 is equal. Otherwise drafted later = looser.
// - windowAnchor: a different anchor shifts the window but changes no
//   allowance, so it is "different", never looser or tighter.

import type { PolicyInput } from "./canonical.js";

export type FieldVerdict = "looser" | "tighter" | "equal" | "different";
export type OverallVerdict = "LOOSER" | "TIGHTER" | "EQUAL" | "DIFFERENT";

export interface DiffResult {
  fields: {
    perTxMax: FieldVerdict;
    windowMax: FieldVerdict;
    windowSeconds: FieldVerdict;
    evmRecipients: FieldVerdict;
    solRecipients: FieldVerdict;
    expiresAt: FieldVerdict;
    windowAnchor: FieldVerdict;
  };
  overall: OverallVerdict;
}

function cmpAmount(drafted: bigint, intended: bigint): FieldVerdict {
  if (drafted > intended) return "looser";
  if (drafted < intended) return "tighter";
  return "equal";
}

function cmpRecipients(drafted: string[], intended: string[], evm: boolean): FieldVerdict {
  const norm = (a: string) => (evm ? a.toLowerCase() : a);
  const d = new Set(drafted.map(norm));
  const i = new Set(intended.map(norm));
  const extra = [...d].filter((x) => !i.has(x));
  if (extra.length > 0) return "looser";
  if (d.size < i.size) return "tighter";
  return "equal";
}

function cmpExpiresAt(drafted: bigint, intended: bigint): FieldVerdict {
  if (intended === 0n) return drafted === 0n ? "equal" : "tighter";
  return cmpAmount(drafted, intended);
}

export function diffPolicies(drafted: PolicyInput, intended: PolicyInput): DiffResult {
  const fields: DiffResult["fields"] = {
    perTxMax: cmpAmount(drafted.perTxMax, intended.perTxMax),
    windowMax: cmpAmount(drafted.windowMax, intended.windowMax),
    windowSeconds:
      drafted.windowSeconds < intended.windowSeconds
        ? "looser"
        : drafted.windowSeconds > intended.windowSeconds
          ? "tighter"
          : "equal",
    evmRecipients: cmpRecipients(drafted.evmRecipients, intended.evmRecipients, true),
    solRecipients: cmpRecipients(drafted.solRecipients, intended.solRecipients, false),
    expiresAt: cmpExpiresAt(drafted.expiresAt, intended.expiresAt),
    windowAnchor: drafted.windowAnchor === intended.windowAnchor ? "equal" : "different",
  };
  const values = Object.values(fields);
  const overall: OverallVerdict = values.includes("looser")
    ? "LOOSER"
    : values.includes("tighter")
      ? "TIGHTER"
      : values.every((v) => v === "equal")
        ? "EQUAL"
        : "DIFFERENT";
  return { fields, overall };
}
