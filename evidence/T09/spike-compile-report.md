# T09 SPIKE-COMPILE — close-out report (ACCEPTANCE NOT MET 2026-10-29)

## Hypothesis / acceptance (tracker, verbatim)

T09 — SPIKE-COMPILE (S, Lane C, dep T05), PRD H14 gate. Files:
`policy/src/llm-draft.ts`, `policy/src/diff.ts`. Acceptance: ≥8 of 10
English policies schema-valid; 0 diffs marked "looser" than intended.

## Method

- Model: qwen2.5:7b, temperature 0, local Ollama on the Muse VM
  (models cached from Oct 20; the Ollama binary was found on the VM
  after the download URL 404'd — no model re-download was needed).
- Strict schema (T05 canonical form): version must be 1, decimals must
  be 6, windowSeconds 60..31536000, recipients 1..8 per chain, exact
  addresses copied (no zero, no duplicates), bigint fields as decimal
  strings (a safe JSON integer is accepted as the same value), exactly
  the 9 fields, no extras.
- Diff rules (diff.ts): perTxMax / windowMax drafted above intended =
  looser (more money). windowSeconds drafted below intended = looser
  (the same window cap replenishes faster). Any drafted recipient not
  in the intended set = looser (an unapproved destination). expiresAt
  later than intended = looser (0 = no expiry). windowAnchor different
  = "different", never looser or tighter (it shifts the window but
  changes no allowance).
- Gate: schema-valid ≥ 8 AND looser == 0. Thresholds do not bend.

## Results — three runs, same verdict

| Run | Prompt change | Valid | Clean JSON | Looser | Verdict |
|-----|---------------|-------|------------|--------|---------|
| 1 | Base prompt | 10/10 | 10/10 | 1 (C6) | FAIL |
| 2 | + "append exactly six zeros" rule + large-number examples (different values, same magnitude — no test answers) | 10/10 | 10/10 | 1 (C6) | FAIL |
| 3 | + self-check rule (divide each cap by 1000000, must equal the dollar amount, fix before outputting) | 10/10 | 10/10 | 1 (C6) | FAIL |

All three runs pass the validity leg (10/10 ≥ 8) and all 30 drafts are
clean JSON (no extraction needed). All three fail the looser leg on the
same case. Overall: **T09 acceptance NOT met. Tracker box stays
unticked. No run 4 (agreed stop after 3 runs).**

## C6 diagnosis — the persistent miss

C6 year window. Intended: $1000 per transaction (1,000,000,000),
$50,000 per year (50,000,000,000), 1-year window, 1 EVM + 1 SOL
recipient, no expiry.

- Run 1 drafted: perTx 100,000,000,000 ($100,000, 100x), window
  5,000,000,000,000 ($5,000,000, 100x).
- Run 2 drafted: perTx 100,000,000,000 ($100,000, 100x), window
  50,000,000,000 ($50,000, correct).
- Run 3 drafted: perTx 100,000,000,000 ($100,000, 100x), window
  500,000,000,000 ($500,000, 10x).

The per-transaction error is IDENTICAL in all three runs ($1000 →
$100,000), despite three different prompts. The window error moves
(100x, correct, 10x) but never goes tighter. Everything else in C6 is
correct in all runs (window, recipients, expiry). This is a stable
model blind spot on the $1000 per-transaction conversion in the
year-window case, not random noise and not a wording issue the tried
fixes could move. Note: C8's $100,000 converts correctly in all runs,
so the model CAN produce 100,000,000,000 — it just maps $1000 to it
here.

## Other cases (all runs)

- No other case is looser in any run. 9 of 10 cases are valid in every
  run, and the only invalid-adjacent signal anywhere is C6's looseness.
- TIGHTER cases (safe direction, not failures): C2 (runs 1–2; run 3
  exact), C4 (run 1; runs 2–3 exact), C5 (runs 1–2 window tighter; run
  3 exact caps), C9 (expiry earlier than intended in all runs — the
  policy expires sooner, safe).
- DIFFERENT verdicts are windowAnchor-only (expected: the English does
  not specify an anchor except in C10, so the LLM picks a default,
  usually 0). C10's anchor never matches the specified 2026-10-29
  00:00 UTC (1793232000) in any run — the LLM does not convert the
  stated window-start date to the intended anchor. That is
  "different", not looser, so it does not fail the gate, but it is a
  second conversion gap for T25: the anchor must be set
  programmatically, not drafted.
- C1 and C4 reach EQUAL (exact match including anchor) in runs 2–3.

## H14 gate + fallback

H14's condition is validity below 8/10 → hand-write YAML. Validity is
10/10 in all runs, so the H14 fallback does NOT apply. The failure is
looseness, which has no documented fallback. Hand-writing YAML would
bypass the LLM and would not prove the compile spike, so it is not
used here.

## Verdict + what this means

- T09 acceptance NOT met (0 looser required; 1 looser in all 3 runs).
  Box stays unticked. No run 4.
- The positive finding (strong): the 7B drafts schema-valid, clean
  JSON policies 30/30 across 3 runs, with exact recipient copying
  (including the 16-address case) and correct windows and expiries.
  The drafting pipeline (prompt + validation + diff) works.
- The negative finding (the spike's real result): the 7B cannot be
  trusted on cap conversion without a verification step — it
  persistently inflates C6's per-transaction cap 100x, and the diff
  check catches it every time. That catch IS the safety property
  working: a raw LLM draft must never be signed without the diff
  check. This is the guard T25 must keep.
- For T25 (English → policy → owner signs): either a stronger model,
  a programmatic cap clamp or verification (recompute caps from
  dollars in code, not in the LLM), or human review of the diff before
  signing. The diff tool (diff.ts) is the reusable guard.

## Evidence files

- `evidence/T09/compile-run-2026-10-29-run1.txt` +
  `evidence/T09/compile-results-2026-10-29-run1.json` (run 1)
- `evidence/T09/compile-run-2026-10-29-run2.txt` +
  `evidence/T09/compile-results-2026-10-29-run2.json` (run 2)
- `evidence/T09/compile-run-2026-10-29.txt` +
  `evidence/T09/compile-results-2026-10-29.json` (run 3, final)
- This report: `evidence/T09/spike-compile-report.md`
- Code (run 3 prompt in llm-draft.ts): `policy/src/llm-draft.ts`,
  `policy/src/diff.ts`, `policy/test/compile-cases.json`,
  `policy/test/run-compile.ts`
