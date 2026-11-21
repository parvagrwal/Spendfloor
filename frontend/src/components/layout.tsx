import { NavLink, useLocation } from "react-router-dom";
import {
  Shield, LayoutDashboard, Crosshair, Network as NetworkIcon, ReceiptText, SlidersHorizontal,
  Radio, RefreshCw, ExternalLink,
} from "lucide-react";
import type { ReactNode } from "react";
import { useAppState } from "../context/AppState";
import { statusLabel } from "../lib/format";

const NAV = [
  { to: "/command-center", label: "Command Center", icon: LayoutDashboard },
  { to: "/attack-playground", label: "Attack Playground", icon: Crosshair },
  { to: "/architecture", label: "Architecture", icon: NetworkIcon },
  { to: "/transaction-proof", label: "Transaction Proof", icon: ReceiptText },
  { to: "/policy-control", label: "Policy Control", icon: SlidersHorizontal },
];

function Sidebar() {
  const { status, refreshStatus } = useAppState();
  const location = useLocation();
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark"><Shield size={20} strokeWidth={2.4} aria-hidden="true" /></span>
        <span className="brand-text">SpendFloor<span className="brand-sub">POLICY ENFORCEMENT</span></span>
      </div>

      <nav className="nav" aria-label="Primary navigation">
        <div className="nav-caption">WORKSPACE</div>
        {NAV.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) => `nav-item${isActive || location.pathname === "/" && to === "/command-center" ? " nav-item-active" : ""}`}
          >
            <Icon size={17} strokeWidth={1.9} aria-hidden="true" />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-bottom">
        <div className="environment-card">
          <div className="environment-top">
            <span className="environment-badge"><span className="environment-dot" aria-hidden="true" />TESTNET DEMO</span>
            <button className="icon-button" onClick={() => void refreshStatus()} title="Refresh live chain state" aria-label="Refresh live chain state"><RefreshCw size={13} aria-hidden="true" /></button>
          </div>
          <div className="environment-networks">
            {(["evm", "sol"] as const).map((chain) => {
              const view = status?.chains[chain];
              const state = view?.state ?? "unavailable";
              return (
                <div className="environment-network" key={chain}>
                  <span className={`state-dot state-${state}`} aria-hidden="true" />
                  <span>{chain === "evm" ? "Base Sepolia" : "Solana Devnet"}</span>
                  <span className="environment-state">{statusLabel(state)}</span>
                </div>
              );
            })}
          </div>
          {status?.generatedAt && <div className="environment-time">Read {new Date(status.generatedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC</div>}
        </div>
        <a className="sidebar-link" href="https://github.com/parvagrwal/SpendFloor" target="_blank" rel="noopener noreferrer">
          Source repository <ExternalLink size={12} aria-hidden="true" />
        </a>
      </div>
    </aside>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { status } = useAppState();
  return (
    <div className="app-shell">
      <Sidebar />
      <main className="main-content">
        <div className="topbar">
          <div className="topbar-context">
            <Radio size={14} aria-hidden="true" />
            <span>SpendFloor control plane</span>
            <span className="topbar-separator">/</span>
            <span className="mono">{status?.mode === "local" ? "development network" : "Base Sepolia + Solana Devnet"}</span>
          </div>
          <span className="topbar-testnet">TESTNET DEMO</span>
        </div>
        <div className="content-wrap">{children}</div>
        <footer className="app-footer">
          <span>Testnet software · unaudited contracts · not approved for real funds</span>
          <span>Enforcement happens at the vault, not in this interface</span>
        </footer>
      </main>
    </div>
  );
}
