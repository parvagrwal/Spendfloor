import { useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AppShell } from "./components/layout";
import { AppStateProvider } from "./context/AppState";
import { CommandCenter } from "./pages/CommandCenter";
import { AttackPlayground } from "./pages/AttackPlayground";
import { Architecture } from "./pages/Architecture";
import { TransactionProof } from "./pages/TransactionProof";
import { PolicyControl } from "./pages/PolicyControl";

const TITLES: Record<string, string> = {
  "/command-center": "Command Center",
  "/attack-playground": "Attack Playground",
  "/architecture": "Architecture Explorer",
  "/transaction-proof": "Transaction Proof",
  "/policy-control": "Policy Control",
};

function RouteEffects() {
  const location = useLocation();
  useEffect(() => {
    document.title = `SpendFloor · ${TITLES[location.pathname] ?? "Command Center"}`;
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [location.pathname]);
  return null;
}

export function App() {
  return (
    <BrowserRouter>
      <AppStateProvider>
        <RouteEffects />
        <AppShell>
          <Routes>
            <Route path="/" element={<Navigate to="/command-center" replace />} />
            <Route path="/command-center" element={<CommandCenter />} />
            <Route path="/attack-playground" element={<AttackPlayground />} />
            <Route path="/architecture" element={<Architecture />} />
            <Route path="/transaction-proof" element={<TransactionProof />} />
            <Route path="/policy-control" element={<PolicyControl />} />
            <Route path="*" element={<Navigate to="/command-center" replace />} />
          </Routes>
        </AppShell>
      </AppStateProvider>
    </BrowserRouter>
  );
}
