// Pure reference model for the SpendFloor spend decision (T30).
// Mirrors the EVM vault (evm/src/SpendFloorVault.sol spendWithSig)
// and the Solana program (solana/programs/spendfloor/src/lib.rs
// decide()) in one place, so both implementations are tested
// against this model, not only against each other (training:
// reference-model-first, one precedence order).
//
// No I/O, no chain access, no signature recovery: the caller
// resolves the signer/account checks and passes the resolved
// values. Amounts are BigInt so the 2^64-1 case (V8) is exact.
// InsufficientFunds and account-malformation checks (InvalidPolicy,
// InvalidAccounts) are NOT policy labels and are NOT modelled here;
// they are separate failures outside the spend decision.

export const DEADLINE_CAP = 300n; // seconds (EVM DEADLINE_CAP)

export type Chain = "evm" | "sol";

export interface ReferencePolicy {
  perTxMax: bigint;
  windowMax: bigint;
  windowSeconds: bigint;
  anchor: bigint; // unix seconds
  expiresAt: bigint; // 0 = no expiry
  recipients: ReadonlySet<string>; // resolved ids: EVM `to` / SOL dest token owner
  frozen: boolean;
  agent: string; // agent id, for the never-a-recipient check
}

export interface ReferenceState {
  currentWindow: bigint;
  spentInWindow: bigint;
  nonce: bigint; // EVM only; ignored for SOL
}

export interface SpendRequest {
  chain: Chain;
  signerIsAgent: boolean; // resolved: sig recovers to agent (EVM) / agent account matches (SOL)
  recipient: string; // resolved: EVM `to` / SOL dest token owner
  amount: bigint; // micro-units
  nonce?: bigint; // EVM only
  deadline?: bigint; // EVM only (unix seconds)
  blockhashExpired?: boolean; // SOL only (runtime-level)
  duplicate?: boolean; // SOL only (runtime signature dedupe)
}

export type DecideOutcome =
  | { ok: true; spentInWindow: bigint; windowIndex: bigint; nonce: bigint | null }
  | { ok: false; label: string };

// Window index, clamped the way both programs clamp it:
// now < anchor maps to window 0 (never a negative index).
export function windowIndexAt(now: bigint, anchor: bigint, windowSeconds: bigint): bigint {
  if (now < anchor) return 0n;
  return (now - anchor) / windowSeconds;
}

export function decide(
  policy: ReferencePolicy,
  state: ReferenceState,
  request: SpendRequest,
  now: bigint,
): DecideOutcome {
  // SOL transport (runtime-level, before any program check): an
  // expired blockhash or a duplicate signature never lands, so
  // there is no program label — the outcome is NotLanded.
  // This is the documented V17 evidence difference: the EVM replay
  // lands as BadNonce, the SOL duplicate does not land at all.
  if (request.chain === "sol" && (request.blockhashExpired || request.duplicate)) {
    return { ok: false, label: "NotLanded" };
  }
  // 1. Unauthorized
  if (!request.signerIsAgent) return { ok: false, label: "Unauthorized" };
  // EVM transport (vault-level, between Unauthorized and Frozen),
  // in vault order: BadNonce -> IntentExpired -> DeadlineTooFar.
  if (request.chain === "evm") {
    if (request.nonce === undefined || request.deadline === undefined) {
      throw new Error("EVM request needs nonce and deadline");
    }
    if (request.nonce !== state.nonce) return { ok: false, label: "BadNonce" };
    if (now > request.deadline) return { ok: false, label: "IntentExpired" };
    if (request.deadline > now + DEADLINE_CAP) return { ok: false, label: "DeadlineTooFar" };
  }
  // 2. Frozen
  if (policy.frozen) return { ok: false, label: "Frozen" };
  // 3. SessionExpired (expiresAt == 0 means no expiry)
  if (policy.expiresAt !== 0n && now >= policy.expiresAt) {
    return { ok: false, label: "SessionExpired" };
  }
  // 4. ZeroAmount
  if (request.amount === 0n) return { ok: false, label: "ZeroAmount" };
  // 5. RecipientNotAllowed. The agent is never a recipient, even if
  // a rotation made it one (T11 finding, both programs).
  if (request.recipient === policy.agent || !policy.recipients.has(request.recipient)) {
    return { ok: false, label: "RecipientNotAllowed" };
  }
  // Window rollover: a new window resets spent to 0 before the
  // cap checks. Freezing does NOT reset spent (V14).
  const windowIndex = windowIndexAt(now, policy.anchor, policy.windowSeconds);
  const spent = windowIndex !== state.currentWindow ? 0n : state.spentInWindow;
  // 6. DailyCapExceeded. BigInt sum, so no overflow: this is
  // equivalent to the EVM saturating form
  // (spent >= windowMax || amount > windowMax - spent) for
  // amount > 0, and to the SOL u128 form (next <= windowMax).
  const next = spent + request.amount;
  if (next > policy.windowMax) return { ok: false, label: "DailyCapExceeded" };
  // 7. PerTxCapExceeded
  if (request.amount > policy.perTxMax) return { ok: false, label: "PerTxCapExceeded" };
  return {
    ok: true,
    spentInWindow: next,
    windowIndex,
    nonce: request.chain === "evm" ? state.nonce + 1n : null,
  };
}
