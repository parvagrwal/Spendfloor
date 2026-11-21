import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, explainError } from "../lib/api";
import type { DemoConfig, DemoRun, EvidenceResponse, SystemStatus } from "../lib/types";

export interface AppStateValue {
  status: SystemStatus | null;
  config: DemoConfig | null;
  evidence: EvidenceResponse | null;
  latestRun: DemoRun | null;
  running: boolean;
  loading: boolean;
  loadError: { title: string; detail: string } | null;
  refresh: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  setLatestRun: (run: DemoRun | null) => void;
}

export const AppStateContext = createContext<AppStateValue | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [config, setConfig] = useState<DemoConfig | null>(null);
  const [evidence, setEvidence] = useState<EvidenceResponse | null>(null);
  const [latestRun, setLatestRun] = useState<DemoRun | null>(null);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<{ title: string; detail: string } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    const results = await Promise.allSettled([api.status(), api.config(), api.evidence(), api.latest()]);
    if (results[0].status === "fulfilled") setStatus(results[0].value);
    if (results[1].status === "fulfilled") setConfig(results[1].value);
    if (results[2].status === "fulfilled") setEvidence(results[2].value);
    if (results[3].status === "fulfilled") {
      setLatestRun(results[3].value.run);
      setRunning(results[3].value.running);
    }
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length === results.length) {
      setLoadError(explainError((failed[0] as PromiseRejectedResult).reason));
    } else {
      setLoadError(null);
    }
    setLoading(false);
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await api.status(true);
      setStatus(next);
    } catch (err) {
      setLoadError(explainError(err));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const value = useMemo(() => ({
    status, config, evidence, latestRun, running, loading, loadError,
    refresh, refreshStatus, setLatestRun,
  }), [status, config, evidence, latestRun, running, loading, loadError, refresh, refreshStatus]);

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppStateValue {
  const value = useContext(AppStateContext);
  if (!value) throw new Error("useAppState must be used inside AppStateProvider");
  return value;
}
