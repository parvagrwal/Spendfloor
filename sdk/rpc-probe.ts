// rpc-probe (T04). Read-only: this script never submits a transaction.
// The sequencer send test is a separate step, run after T03 funding.
//
//   tsx rpc-probe.ts [--chain evm|sol] [--pace-only] [--helius]
//
// For each candidate endpoint:
//   1. BURST: 50 read calls fired at once. Counts HTTP 429s and errors.
//   2. DEMO PACE: 25 read calls at 5 req/s (the demo's stated pace).
//      Acceptance needs ZERO 429s here.
// Prints a table the T04 report is built from.
// --pace-only runs ONLY the 25-call demo-pace sequence, with no preceding
// burst. Use it for quiet-window retests: a burst's penalty window otherwise
// contaminates the pace result (T04 SOL caveat, 2026-10-20 report).
// --helius adds the Helius devnet endpoint (SOL RPC2 candidate). It needs
// SPENDFLOOR_HELIUS_API_KEY set in the environment; the key is never
// printed — output shows a redacted URL only. Helius mode forces
// pace-only: the free tier allows 10 req/s, so a 50-call burst would only
// measure rate-limiting and burn credits.

type Endpoint = { chain: "evm" | "sol"; label: string; url: string; method: string; display?: string };

const ENDPOINTS: Endpoint[] = [
  { chain: "evm", label: "RPC1 official", url: "https://sepolia.base.org", method: "eth_blockNumber" },
  { chain: "evm", label: "PublicNode", url: "https://base-sepolia-rpc.publicnode.com", method: "eth_blockNumber" },
  { chain: "evm", label: "dRPC", url: "https://base-sepolia.drpc.org", method: "eth_blockNumber" },
  { chain: "evm", label: "BlockPI", url: "https://base-sepolia.blockpi.network/v1/rpc/public", method: "eth_blockNumber" },
  { chain: "sol", label: "RPC1 official", url: "https://api.devnet.solana.com", method: "getBlockHeight" },
  { chain: "sol", label: "official alias", url: "https://devnet.solana.com", method: "getBlockHeight" },
  { chain: "sol", label: "dRPC", url: "https://solana-devnet.drpc.org", method: "getBlockHeight" },
  { chain: "sol", label: "BlockPI", url: "https://solana-devnet.blockpi.network/v1/rpc/public", method: "getBlockHeight" },
];

const TIMEOUT_MS = 10_000;

type CallResult =
  | { kind: "ok"; ms: number }
  | { kind: "http429"; ms: number }
  | { kind: "httpError"; status: number; ms: number }
  | { kind: "rpcError"; message: string; ms: number }
  | { kind: "netError"; message: string; ms: number };

async function call(ep: Endpoint, id: number): Promise<CallResult> {
  const start = Date.now();
  try {
    const res = await fetch(ep.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: ep.method, params: [] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const ms = Date.now() - start;
    if (res.status === 429) return { kind: "http429", ms };
    if (!res.ok) return { kind: "httpError", status: res.status, ms };
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) return { kind: "rpcError", message: body.error.message ?? "rpc error", ms };
    return { kind: "ok", ms };
  } catch (e) {
    return { kind: "netError", message: (e as Error).message.slice(0, 80), ms: Date.now() - start };
  }
}

function summarize(results: CallResult[]) {
  const ok = results.filter((r) => r.kind === "ok");
  const lat = ok.map((r) => r.ms).sort((a, b) => a - b);
  const median = lat.length ? lat[Math.floor(lat.length / 2)] : null;
  return {
    ok: ok.length,
    http429: results.filter((r) => r.kind === "http429").length,
    httpError: results.filter((r) => r.kind === "httpError").length,
    rpcError: results.filter((r) => r.kind === "rpcError").length,
    netError: results.filter((r) => r.kind === "netError").length,
    medianMs: median,
    firstError:
      results.find((r) => r.kind === "rpcError" || r.kind === "netError" || r.kind === "httpError"),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function probe(ep: Endpoint) {
  console.log(`\n=== ${ep.chain.toUpperCase()} ${ep.label} :: ${ep.display ?? ep.url} (${ep.method}) ===`);
  if (!paceOnly) {
    const burst = await Promise.all(Array.from({ length: 50 }, (_, i) => call(ep, i + 1)));
    const b = summarize(burst);
    console.log(
      `burst x50:   ok=${b.ok} 429=${b.http429} httpErr=${b.httpError} rpcErr=${b.rpcError} netErr=${b.netError}` +
        (b.medianMs != null ? ` median=${b.medianMs}ms` : "")
    );
    if (b.firstError && b.ok === 0) {
      const fe = b.firstError;
      console.log(
        `  first error: ${fe.kind}` +
          (fe.kind === "rpcError" || fe.kind === "netError" ? ` :: ${fe.message}` : "") +
          (fe.kind === "httpError" ? ` :: HTTP ${fe.status}` : "")
      );
    }
    if (b.ok === 0) {
      console.log("pace x25:    skipped (endpoint did not answer the burst)");
      return;
    }
  } else {
    console.log("pace-only mode: burst skipped (quiet-window retest)");
  }
  const pace: CallResult[] = [];
  for (let i = 0; i < 25; i++) {
    const t0 = Date.now();
    pace.push(await call(ep, 1000 + i));
    const wait = 200 - (Date.now() - t0);
    if (wait > 0) await sleep(wait);
  }
  const p = summarize(pace);
  console.log(
    `pace x25 @5/s: ok=${p.ok} 429=${p.http429} httpErr=${p.httpError} rpcErr=${p.rpcError} netErr=${p.netError}` +
      (p.medianMs != null ? ` median=${p.medianMs}ms` : "") +
      (p.http429 === 0 && p.ok === 25 ? "  -> PACE PASS (zero 429)" : "  -> PACE FAIL")
  );
}

const chainArg = process.argv.includes("--chain")
  ? process.argv[process.argv.indexOf("--chain") + 1]
  : "all";
const heliusMode = process.argv.includes("--helius");
const paceOnly = process.argv.includes("--pace-only") || heliusMode;
if (heliusMode) {
  const heliusKey = (process.env.SPENDFLOOR_HELIUS_API_KEY ?? "").trim();
  if (!heliusKey) {
    console.log("FAIL  --helius needs SPENDFLOOR_HELIUS_API_KEY set in the environment");
    process.exit(1);
  }
  if (chainArg === "all" || chainArg === "sol") {
    ENDPOINTS.push({
      chain: "sol",
      label: "Helius devnet (keyed)",
      url: `https://devnet.helius-rpc.com/?api-key=${heliusKey}`,
      method: "getBlockHeight",
      display: "https://devnet.helius-rpc.com/?api-key=***",
    });
    console.log("Helius devnet endpoint enabled (key from environment; key never printed)");
  }
}
const targets = ENDPOINTS.filter((e) => chainArg === "all" || e.chain === chainArg);
console.log(`rpc-probe: ${targets.length} endpoints, read-only, mode=${paceOnly ? "pace-only" : "burst+pace"}${heliusMode ? ", helius=on" : ""}, ${new Date().toISOString()}`);
for (const ep of targets) await probe(ep);
console.log("\nrpc-probe done. No transactions were submitted.");
