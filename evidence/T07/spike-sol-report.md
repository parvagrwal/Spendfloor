# T07 SPIKE-SOL — close-out report (CLOSED 2026-10-29)

## Hypothesis (tracker, verbatim)

"With pinned Anchor 1.2.0, a minimal spend program deploys to devnet within
the SOL we hold; a 0-lamport AGENT key can co-sign spends paid by the
SUBMITTER; rejected spends land as failed transactions with the custom
error."

## Pass criteria (all five)

1. Builds with pinned toolchain within 90 min of fixing.
2. `.so` size + `solana rent` recorded, deploy succeeds, actual SOL spent
   recorded, program visible in Explorer — feeds the **H12 gate**.
3. 3/3 spends succeed with AGENT at 0 lamports.
4. 3/3 over-cap attempts sent with preflight skipped land with `meta.err`,
   logs show `DailyCapExceeded`.
5. Upgrade authority = OWNER.

## Program

Files: `solana/programs/spendfloor/src/lib.rs` (program `spendfloor`),
`solana/Anchor.toml`, `solana/Cargo.toml`,
`solana/programs/spendfloor/Cargo.toml`.

Design: one policy PDA (seeds `["policy"]`) holds BOTH the policy and the
funds, mirroring the EVM vault. Instructions: `initialize` (owner signer;
agent != default, allowlist 1..=8), `set_allowed` + `set_frozen`
(owner-only), `spend` (agent is a Signer; key match checked in logic, then
the pure `decide()` runs D6 order and returns new spent_today; day =
Clock unix_timestamp / 86_400 with rollover reset; checked_add overflow →
DailyCapExceeded). Errors (Anchor codes 6000+ in order): Unauthorized 6000,
Frozen 6001, ZeroAmount 6002, RecipientNotAllowed 6003, DailyCapExceeded
6004, PerTxCapExceeded 6005, InvalidAgent 6006, InvalidAllowlist 6007,
NotOwner 6008, InsufficientFunds 6009 (added with the transfer fix below).

Spike limits (documented, T12a lands them): no withdraw, no
deadline/session, caps + agent immutable after initialize, no rent-exempt
guard on spends (spike spends sit far above rent-exempt).

## Build — PASS (criterion 1)

Pinned toolchain: anchor-cli 1.2.0, solana-cli 4.1.2, cargo/rustc 1.99.1.
`anchor build` green on the VM and on the owner machine (owner-machine
first build downloaded AVM platform tools via a rustup child; output is
piped to anchor so the terminal looks empty, and venue wifi made it slow —
do not kill it, the download restarts; later hit a DNS failure fetching
the 1.99.1 toolchain, cleared on retry).

- v1 `.so`: 149,848 bytes, program rent-exempt minimum 0.76187808 SOL,
  IDL generated. Owner-machine `.so` byte-identical size (149,848).
- v2 `.so` (transfer fix below): 149,424 bytes.
- Build fixes recorded: overflow-checks profile required by Anchor;
  spend() borrow-scope fix; `idl-build` feature required by Anchor 1.2.0;
  test helper `T: Debug` bound; recipient `AccountInfo` →
  `UncheckedAccount` (deprecation).

Evidence: `evidence/T07/anchor-build-2026-10-29.txt`.

## Unit tests — PASS (10/10)

`cargo test`: valid, over-daily, over-per-tx, non-allowlisted, frozen,
wrong-agent, zero, precedence combos, day rollover, spent overflow.
Remaining warnings are benign "unexpected cfg condition value"
derive-macro noise (anchor 1.2.0 macros vs rustc 1.99.1 check-cfg).

Evidence: `evidence/T07/unit-tests-2026-10-29.txt`.

## Local validator leg — CANCELLED (environment limit, not code)

`solana-test-validator` cannot start in the VM sandbox: it panics on
`assertion failed: io_uring_supported()` after logging `io_uring NOT
supported: Operation not permitted`. The local test script
(`solana/tests/local-spend.ts`, written, never run) stays in the file set
for the record. The devnet legs below are the actual T07 criteria, so the
spike proceeds there; the unit tests already prove the decision logic.

## Deploy — DONE (criterion 2)

- Program ID (devnet, generated on the owner machine):
  `BWVM3J3QfWoco8b1GUFCzX1T7vDhuKHQbN5FDShUXhbC`.
- Deploy tx:
  `3jDzDYmNdjramYqMGRucMDuSx49uhaDFC5fRodjkWZZvEXyBkSsGh39DDVNBatcbZUDCHjVocJmBJnmZANJyQFRc`.
- VM-verified: program account exists under the upgradeable loader;
  `solana program show` reports ProgramData
  `Ddq4LTn3MBzXhUjiWJVWYWHtwm817CNxGFpzNSWzRgQC`, data length 149,848
  (v1), slot 516399208.
- Upgrade authority = OWNER
  (`HgLp84c1mcmTVVohLRU6oDWqzWabjoMkbot65mQ785v`) — verified via the CLI
  show output AND the spend script's independent ProgramData parse.
  Criterion 5 PASSED.
- Owner key file is the wrapped format, so the CLI needs a temporary
  bare-array copy for deploys (created, used, deleted each time).
- Cost so far: program balance 0.76210668 SOL (rent + program account).

## Init + fund — DONE

Init script `sdk/solana-init-policy.ts` (owner machine, custody
pre-flight). Params: agent = SOL AGENT, allowlist = [OWNER, SUBMITTER],
daily_cap 2,000,000 lamports, per_tx_cap 500,000 lamports, fund
5,000,000 lamports.

- Init tx:
  `4FZEbDHGMMJcSYupWULYWjMgWe6ZRZThiEHUmGCXU52QpfPucxCjpHRMfFa8FoLALgKxKqDYCg5Q3Yw16WcB5MV3`.
- Fund tx:
  `4SrUZ3eKYmXhz1vNcsBdgzXvVCbErKNTszhknZyL8c6uTRsCZuYoYtQoDzKNL1ZH6eUYuh6NoyB7L2n5LtPHhXGf`.
- Policy PDA: `2S7DmjooMbshtoDE8fWdkirmT6RCJrkV2oFiJZWYjy5X`.
- Policy balance after: 7,509,520 lamports (2,509,520 rent + 5,000,000
  fund). Owner 5.2362952 → 5.22877568 SOL: exactly fund + rent + 10,000
  lamports fees (2 txs). Every lamport accounted for.
- Two earlier init attempts failed on RPC fetch (venue network; one each
  on RPC1 and Helius) before any transaction; the retry on the default
  RPC succeeded without flags. Nothing on-chain changed on the failures.
- Side note (fixed, not a funds risk): the init script printed the RPC
  URL as-is, which exposed the Helius key in chat output when the Helius
  URL was used. Both SOL scripts now redact `api-key` in the printed
  URL. The Helius key is RPC-only (no funds at risk) and should be
  rotated in the dashboard when possible.

## First devnet spend attempt — FAILED, root cause found, fixed

The spend script (`sdk/solana-spend-devnet.ts`) pre-checks all passed:
agent 0 lamports, policy spent 0, upgrade authority OWNER, PDA matches
the init. The first valid spend (100,000 lamports to SUBMITTER) failed in
simulation:

```
Program log: Instruction: Spend
Transfer: `from` must not carry data
Program failed: invalid program argument
```

Root cause: the System Program refuses a transfer whose source account
carries data, and the policy PDA carries the policy struct. The
one-PDA-holds-state-and-funds plus system-transfer-CPI design is
invalid. This is what the spike is for: it caught a real design flaw
before it reached the full program.

Fix (v2): the program moves lamports directly
(`try_borrow_mut_lamports` debit + credit) instead of a system transfer
CPI. The program owns the policy account, so the runtime permits the
debit; crediting any account is always permitted. Added an
`InsufficientFunds` balance check before mutating state (transactions
are atomic, so a failure rolls back the spent update too). The spend
instruction no longer takes a system_program account; both TS clients
were updated to match. VM rebuild green, 10/10 unit tests still pass,
v2 `.so` 149,424 bytes.

Evidence: `evidence/T07/devnet-spend-2026-10-29-attempt1.txt` (first attempt log).

## Upgrade — DONE (v2 live)

First upgrade attempt (owner machine) failed: blockhash expired mid-upload
on venue wifi, 19 write transactions failed. The program and policy were
untouched (still v1, still funded). The partial buffer account
`9PM1ABGiQtbsuozTpKxvhwEwYxnv3N5w7V2EfR3ZDndb` holds buffer rent SOL;
closing it returns the SOL to the owner (cleanup still outstanding at
close-out — the buffer's recovery phrase appeared in chat output and must
never be repeated; closing the buffer makes it useless).

Second attempt succeeded. Upgrade tx:
`2VxNXwPFmVvGLkK6hqb7xthBgCaHoCTjbTwYKseb6H9odKoe54MMSzRC3mPHHZxPUgVMe5wizjJqdMjBSv1ArRpE`
(slot 516404566; loader log "Upgraded program BWVM..."; err null).
`solana program show` after the upgrade still reports data length 149,848:
the upgrade does not shrink the programdata account, so the field shows
the original v1 allocation, not the v2 size. The v2 code is proven live by
the spends below (v1 would fail them with "from must not carry data").
No re-init was needed; policy state persisted across the upgrade.

## Devnet legs — PASS (criteria 3, 4)

First resume run hit a client-side confirmation problem, not a chain
problem: the VM's WebSocket path to devnet fails TLS (`ws error: write
EPROTO ... wrong version number`), so `confirmTransaction` threw a 30 s
timeout after the first valid spend had already been SENT. The
transaction itself landed: signature
`5CDkPSfBkecsCQm3qizE8WLtC3H94sxnyjzxi955oVz4UAWnTrEBj86h2QkPzZmTGMDMaChBgnhNmhyvC2JJMiHQ`
(slot 516405253, err null) — valid spend 1/3, 100,000 lamports to
SUBMITTER, already on-chain. Evidence:
`evidence/T07/devnet-spend-2026-10-29-attempt2.txt`.

Fix: the spend script now confirms by polling `getSignatureStatuses`
over plain HTTP (no WebSocket) and resumes from the policy's spent total
instead of resending valid spends that already landed. Rerun results
(`evidence/T07/devnet-spend-2026-10-29.txt`):

- Pre-checks: upgrade authority OWNER, agent 0 lamports, policy spent
  100,000 (the landed first spend), resuming 1/3.
- Valid spend 2/3: 100,000 lamports to OWNER, sig `BtKkGuSE...3v6J`,
  err null, slot 516405676.
- Valid spend 3/3: 100,000 lamports to SUBMITTER, sig `49Yv2TNt...QrmF`,
  err null, slot 516405687.
- Agent 0 lamports after valid spends.
- Over-cap 1/3: 2,000,000 lamports, sig `4EPw4B5H...ZKJu`,
  `InstructionError [0, {Custom: 6004}]`, logs `DailyCapExceeded`,
  slot 516405697.
- Over-cap 2/3: sig `2cLkLzYX...8xmC`, Custom 6004, logs
  `DailyCapExceeded`, slot 516405708.
- Over-cap 3/3: sig `3Sy8edp3...EoNf`, Custom 6004, logs
  `DailyCapExceeded`, slot 516405717.
- Agent 0 lamports after over-cap attempts. Policy spent after:
  300,000 lamports (expected 300,000).
- Verdict line: `solana-spend-devnet: PASS :: 3/3 valid null err, 3/3
  over-cap meta.err + DailyCapExceeded, agent 0 throughout, upgrade
  authority OWNER`.

Policy PDA history (`getSignaturesForAddress`) independently confirms all
eight transactions (init, fund, 3 valid, 3 over-cap) with matching slots
and errors. Criteria 3 and 4 PASSED.

## H12 gate — PASSED

Program live on devnet with spends + over-cap errors proven (see above).
No Squads fallback needed. Tracker H12 box ticked.

## Evidence files

- `evidence/T07/anchor-build-2026-10-29.txt`
- `evidence/T07/unit-tests-2026-10-29.txt`
- `evidence/T07/devnet-spend-2026-10-29.txt` (final run: resume + PASS)
- `evidence/T07/devnet-spend-2026-10-29-attempt1.txt` (v1 transfer failure)
- `evidence/T07/devnet-spend-2026-10-29-attempt2.txt` (WebSocket confirmation failure; first spend landed anyway)
- This report: `evidence/T07/spike-sol-report.md` (CLOSED 2026-10-29)
