// Shared error labels and result types for the SpendFloor SDK (T15).
//
// A failed spend never throws a raw RPC error at the caller. It returns a
// SpendResult with a normalized label (one of the vault/program error
// names, or a transport label) plus the transaction hash/signature when
// the transaction landed, so the caller can look it up. Role separation
// is structural: the agent signs, the submitter pays, the owner
// administers. No SDK function lets one key do two roles, and there is
// no direct-transfer shortcut around the vault.

export type SpendLabel =
  | "Unauthorized"
  | "BadNonce"
  | "IntentExpired"
  | "DeadlineTooFar"
  | "Frozen"
  | "SessionExpired"
  | "ZeroAmount"
  | "RecipientNotAllowed"
  | "DailyCapExceeded"
  | "PerTxCapExceeded"
  | "NotOwner"
  | "InvalidAgent"
  | "InvalidPolicy"
  | "InsufficientFunds"
  | "InvalidAccounts"
  | "DuplicateAccounts"
  | "Reentrant"
  | "Reverted"
  | "SubmitFailed"
  | "Timeout"
  | "RpcError";

export interface SpendResult {
  ok: boolean;
  /** Transaction hash (EVM) or signature (Solana), when broadcast/landed. */
  hash?: string;
  /** Normalized label for a failure. Absent on success. */
  label?: SpendLabel;
  /** Raw error text, for debugging only. Never the label. */
  raw?: string;
}

/** Solana program error codes (SpendError, Anchor offset 6000). */
export const SOL_ERROR_CODES: Record<number, SpendLabel> = {
  6000: "Unauthorized",
  6001: "Frozen",
  6002: "ZeroAmount",
  6003: "RecipientNotAllowed",
  6004: "DailyCapExceeded",
  6005: "PerTxCapExceeded",
  6006: "InvalidAgent",
  6007: "InvalidPolicy",
  6008: "NotOwner",
  6009: "InsufficientFunds",
  6010: "SessionExpired",
  6011: "InvalidAccounts",
  // Anchor's default duplicate-mutable-account check (S13).
  2040: "DuplicateAccounts",
};

/** EVM custom error names (SpendFloorVault). */
export const EVM_ERROR_NAMES = new Set([
  "Unauthorized",
  "BadNonce",
  "IntentExpired",
  "DeadlineTooFar",
  "Frozen",
  "SessionExpired",
  "ZeroAmount",
  "RecipientNotAllowed",
  "DailyCapExceeded",
  "PerTxCapExceeded",
  "NotOwner",
  "InvalidAgent",
  "InvalidPolicy",
  "Reentrant",
]);

export function isSpendLabel(s: string): s is SpendLabel {
  return (
    (EVM_ERROR_NAMES.has(s) as boolean) ||
    s === "InsufficientFunds" ||
    s === "InvalidAccounts" ||
    s === "DuplicateAccounts" ||
    s === "Reverted" ||
    s === "SubmitFailed" ||
    s === "Timeout" ||
    s === "RpcError"
  );
}
