// Local operator adapter. This process is the ONLY place that may read
// demo keys, call Ollama, or submit through the relay. It is bound to
// loopback by default, exposes a narrow action allowlist, and never
// accepts arbitrary recipients, amounts, networks or transaction bytes.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { DEMO_ENABLED, DEMO_INSTRUCTIONS, DEMO_MODE, NETWORKS, REPO_ROOT, SCENARIOS, normalizeInstruction } from "./config.js";
import { executeScenario, getLastRun, isDemoRunning } from "./demo.js";
import { clearStatusCache, readSystemStatus, sumFingerprintPreview } from "./state.js";
import { getHistoricalRecords, HISTORICAL_PROVENANCE } from "./evidence.js";

const HOST = process.env.SPENDFLOOR_OPERATOR_HOST ?? "127.0.0.1";
const PORT = Number(process.env.SPENDFLOOR_OPERATOR_PORT ?? 8787);
const SERVE_STATIC = process.argv.includes("--serve-static");
const DIST = join(REPO_ROOT, "frontend", "dist");

const executeSchema = z.object({
  scenario: z.enum(["attack-recipient", "legit-payment"]),
  instruction: z.string().min(1).max(500),
  mode: z.enum(["testnet", "local"]).optional(),
  confirm: z.literal("EXECUTE"),
});
const previewSchema = z.object({
  perTxMax: z.string().regex(/^\d{1,20}$/),
  windowMax: z.string().regex(/^\d{1,20}$/),
  windowSeconds: z.string().regex(/^\d{1,20}$/),
  windowAnchor: z.string().regex(/^\d{1,19}$/),
  expiresAt: z.string().regex(/^\d{1,19}$/),
});

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body, null, 2));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8192) { reject(new Error("request body too large")); req.destroy(); return; }
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error("invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2",
  ".ico": "image/x-icon", ".map": "application/json",
};

function serveStatic(pathname: string, res: ServerResponse): void {
  const requested = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const safe = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const file = join(DIST, safe);
  if (!file.startsWith(DIST)) { json(res, 403, { error: "Forbidden" }); return; }
  const target = existsSync(file) && statSync(file).isFile() ? file : join(DIST, "index.html");
  if (!existsSync(target)) { json(res, 404, { error: "Frontend build missing. Run npm run build." }); return; }
  res.writeHead(200, { "content-type": MIME[extname(target)] ?? "application/octet-stream", "cache-control": "no-cache" });
  createReadStream(target).pipe(res);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;
  try {
    if (req.method === "GET" && path === "/api/health") {
      json(res, 200, { ok: true, service: "spendfloor-operator", mode: DEMO_MODE, time: new Date().toISOString() });
      return;
    }
    if (req.method === "GET" && path === "/api/status") {
      json(res, 200, await readSystemStatus(url.searchParams.get("refresh") === "1"));
      return;
    }
    if (req.method === "GET" && path === "/api/scenarios") {
      json(res, 200, {
        mode: DEMO_MODE,
        demoEnabled: DEMO_ENABLED,
        scenarios: SCENARIOS,
        instructions: DEMO_INSTRUCTIONS,
        networks: NETWORKS,
      });
      return;
    }
    if (req.method === "GET" && path === "/api/evidence") {
      json(res, 200, { records: getHistoricalRecords(), provenance: HISTORICAL_PROVENANCE });
      return;
    }
    if (req.method === "GET" && path === "/api/demo/latest") {
      json(res, 200, { run: getLastRun(), running: isDemoRunning() });
      return;
    }
    if (req.method === "POST" && path === "/api/demo/execute") {
      const parsed = executeSchema.safeParse(await readBody(req));
      if (!parsed.success) { json(res, 400, { error: "Invalid execution request", detail: parsed.error.issues[0]?.message }); return; }
      const { scenario, instruction, mode } = parsed.data;
      if (normalizeInstruction(instruction) !== normalizeInstruction(DEMO_INSTRUCTIONS[scenario])) {
        json(res, 400, {
          error: "Instruction is not an approved demo scenario",
          detail: "The operator accepts only the exact instruction shown for the selected scenario. Restore the scenario instruction and retry.",
        });
        return;
      }
      if (mode && mode !== DEMO_MODE) {
        json(res, 400, { error: `Operator is configured for ${DEMO_MODE}, not ${mode}`, detail: "Set SPENDFLOOR_DEMO_NET on the operator host to change networks." });
        return;
      }
      if (!DEMO_ENABLED) {
        json(res, 403, {
          error: "Live demo execution is disabled on this operator",
          detail: "Set SPENDFLOOR_DEMO_ENABLE=1 on the operator host after verifying keys, Ollama and RPC access. No transaction was submitted.",
        });
        return;
      }
      if (isDemoRunning()) { json(res, 409, { error: "A demo run is already in progress" }); return; }
      const run = await executeScenario(scenario, DEMO_MODE);
      clearStatusCache();
      json(res, 200, run);
      return;
    }
    if (req.method === "POST" && path === "/api/policy/preview") {
      const parsed = previewSchema.safeParse(await readBody(req));
      if (!parsed.success) { json(res, 400, { error: "Invalid policy values", detail: parsed.error.issues[0]?.message }); return; }
      try {
        const fingerprint = sumFingerprintPreview(parsed.data);
        json(res, 200, {
          fingerprint,
          method: "SHA-256",
          source: "Local canonical computation",
          applied: false,
          detail: "Computed with the repository canonical encoder from the demo recipient sets. No owner transaction was submitted.",
        });
      } catch (err) {
        json(res, 400, { error: "Policy values failed canonical validation", detail: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    if (path.startsWith("/api/")) { json(res, 404, { error: "Unknown API route" }); return; }
    if (SERVE_STATIC && (req.method === "GET" || req.method === "HEAD")) { serveStatic(path, res); return; }
    json(res, 404, { error: "Not found" });
  } catch (err) {
    json(res, 500, { error: "Operator request failed", detail: err instanceof Error ? err.message : String(err) });
  }
}

/** Exported so boundary tests can start the real API on an ephemeral port. */
export function createOperatorServer() {
  return createServer((req, res) => { void handle(req, res); });
}

const invokedDirectly = Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const server = createOperatorServer();
  server.listen(PORT, HOST, () => {
    console.log(`SpendFloor operator listening on http://${HOST}:${PORT} (mode=${DEMO_MODE}, demo=${DEMO_ENABLED ? "enabled" : "disabled"}, static=${SERVE_STATIC})`);
  });
}
