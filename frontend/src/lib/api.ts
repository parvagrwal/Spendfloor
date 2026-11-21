import type { DemoConfig, DemoRun, EvidenceResponse, SystemStatus } from "./types";

export class ApiError extends Error {
  constructor(message: string, public detail?: string, public status?: number) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: init?.body ? { "content-type": "application/json", ...init.headers } : init?.headers,
    });
  } catch {
    throw new ApiError("Operator unreachable", "The local SpendFloor operator is not running. Start it with npm run dev.");
  }
  const text = await response.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* handled below */ }
  if (!response.ok) {
    const err = body as { error?: string; detail?: string } | null;
    throw new ApiError(err?.error ?? `Request failed (${response.status})`, err?.detail, response.status);
  }
  return body as T;
}

export const api = {
  status: (refresh = false) => request<SystemStatus>(`/api/status${refresh ? "?refresh=1" : ""}`),
  config: () => request<DemoConfig>("/api/scenarios"),
  evidence: () => request<EvidenceResponse>("/api/evidence"),
  latest: () => request<{ run: DemoRun | null; running: boolean }>("/api/demo/latest"),
  execute: (scenario: "attack-recipient" | "legit-payment", instruction: string) =>
    request<DemoRun>("/api/demo/execute", {
      method: "POST",
      body: JSON.stringify({ scenario, instruction, confirm: "EXECUTE" }),
    }),
  policyPreview: (values: Record<string, string>) =>
    request<{ fingerprint: string; method: string; source: string; applied: boolean; detail: string }>(
      "/api/policy/preview", { method: "POST", body: JSON.stringify(values) },
    ),
};

export function explainError(err: unknown): { title: string; detail: string } {
  if (err instanceof ApiError) {
    return { title: err.message, detail: err.detail ?? "Check that the local operator is running and configured for this demo." };
  }
  return { title: "Something went wrong", detail: err instanceof Error ? err.message : String(err) };
}
