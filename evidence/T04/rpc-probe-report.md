# T04 RPC probe report (CLOSED 2026-10-29 — SOL RPC2 = Helius devnet)
Date: 2026-10-20. Tool: sdk/rpc-probe.ts (read-only; no transactions submitted).
Two vantage points: Muse VM (egress-proxied, distorts concurrency) and
Parv's WSL machine (normal internet; the deciding numbers).

## Owner machine (Parv WSL) — burst x50, then pace x25 at 5 req/s

| Chain | Endpoint | Burst OK | Burst 429 | Pace OK | Pace 429 | Pace median | Verdict |
|---|---|---|---|---|---|---|---|
| EVM | sepolia.base.org (RPC1) | 44 | 6 | 25 | 0 | 306 ms | PACE PASS |
| EVM | base-sepolia-rpc.publicnode.com | 50 | 0 | 25 | 0 | 171 ms | PACE PASS |
| EVM | base-sepolia.drpc.org | 50 | 0 | 25 | 0 | 76 ms | PACE PASS |
| EVM | base-sepolia.blockpi.network | 0 | 0 | - | - | - | DEAD (HTTP 503) |
| SOL | api.devnet.solana.com (RPC1) | 40 | 10 | 0 | 25 | - | PACE FAIL (see caveat) |
| SOL | devnet.solana.com (alias) | 0 | 0 | - | - | - | DEAD (fetch failed) |
| SOL | solana-devnet.drpc.org | 0 | 0 | - | - | - | HTTP 400: devnet not on free plan |
| SOL | solana-devnet.blockpi.network | 0 | 0 | - | - | - | HTTP 404 (endpoint gone) |

CAVEAT (SOL RPC1 pace): the pace test ran seconds after the 50-call burst
from the same IP. Solana devnet limits are 100 req/10 s/IP and 40 req/10 s
per method, so the pace calls inherited the burst's penalty window (burst
stopped at exactly 40 OK = the per-method cap). The 25/25 429 pace result
measures post-burst throttling, NOT clean demo pace. A clean pace-only
retest in a quiet window is still owed before T04 can close.

## Muse VM (for the record)
- EVM dRPC: burst 48/50 OK, 0 x 429, pace 25/25 PASS (median 69 ms).
- EVM official/PublicNode/BlockPI: all burst calls timed out (VM proxy
  concurrency limit); sequential reads on sepolia.base.org work (fund-check).
- SOL: official endpoints unreachable (VM egress); dRPC HTTP 400; BlockPI 404.

## Decisions
- EVM RPC1 = https://sepolia.base.org (official).
- EVM RPC2 = https://base-sepolia.drpc.org — FREE, keyless. Only candidate
  that passed from BOTH machines. PublicNode is the recorded alternate
  (perfect scores from the owner machine).
- SOL RPC1 = https://api.devnet.solana.com (official).
- SOL RPC2 = NONE keyless found. Per plan fallback: Helius devnet
  (FREE with signup, key required) — pending Parv's signup; until then the
  independent read is explorer.solana.com (cluster=devnet).

## Update 2026-10-29 (VM) — 2 of 3 owed items landed
- Sequencer send test: PASS. Tool: sdk/sequencer-send-test.ts (new, T04).
  SUBMITTER self-send 0.0001 ETH via the sequencer endpoint
  https://sepolia-sequencer.base.org (first try, no fallback needed).
  Tx 0x350455a9033cc0f9d3c6b261368fe4f447f76dddb853d4e3349b03649b12e731,
  receipt status=success, block 51695770, gasUsed 21000.
  Read-back via PublicNode confirmed the same receipt; SUBMITTER balance
  moved by gas only (0.03 -> 0.029999874 ETH). Full output:
  evidence/T04/sequencer-send-test-2026-10-29.txt.
- Clean SOL pace-only retest: RPC1 (api.devnet.solana.com) PACE PASS —
  pace x25 @5/s: ok=25, 429=0, median 70ms, via the new --pace-only mode in
  sdk/rpc-probe.ts (no preceding burst, quiet window). This closes the
  Oct 20 caveat: the old 25/25 429 result was post-burst throttling, not
  demo pace. Full output: evidence/T04/pace-retest-2026-10-29.txt.
- EVM RPC note (raw signal, 2026-10-29): dRPC dropped connections twice
  and sepolia.base.org returned HTTP 403 to a Python check during the
  T03 balance verification, while PublicNode answered. Node-based reads
  via sepolia.base.org worked the same day (fund-check pre-flight). The
  RPC2 choice (dRPC, PublicNode alternate) will be exercised again by
  the T06 EVM spike; the gate does not bend for a flaky RPC.
- Alias/dRPC/BlockPI SOL pace lines (probe finished 2026-10-29):
  alias 0/25 (all net errors — timeouts from the VM), dRPC 0/25 (all HTTP
  errors — devnet not on free plan, as on Oct 20), BlockPI 0/25 (all HTTP
  errors — endpoint gone, as on Oct 20). All three PACE FAIL, matching
  their Oct 20 DEAD status. No keyless SOL RPC2 exists; Helius remains
  the only candidate.

## Still owed to close T04
Nothing — T04 closed 2026-10-29 (see section below).

## T04 CLOSED 2026-10-29 (owner machine) — Helius pace PASS
- Helius devnet (keyed) pace x25 @5/s: ok=25, 429=0, median 352ms -> PACE PASS.
  Tool: sdk/rpc-probe.ts --chain sol --pace-only --helius (key from
  SPENDFLOOR_HELIUS_API_KEY env; output shows redacted URL only).
  Full output: evidence/T04/helius-pace-2026-10-29.txt.
- Same run re-confirmed RPC1 from the owner machine: 25/25, 429=0,
  median 75ms (VM: 70ms). Alias/dRPC/BlockPI all PACE FAIL again,
  matching VM + Oct 20. No keyless SOL RPC2 exists.
- Decisions (final): SOL RPC1 = https://api.devnet.solana.com; SOL RPC2 =
  Helius devnet (FREE with signup, keyed). EVM unchanged: RPC1 =
  https://sepolia.base.org, RPC2 = dRPC (FREE keyless), PublicNode alternate.
- Nothing still owed. T04 box ticked in the tracker.
