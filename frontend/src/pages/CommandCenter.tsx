import { Link } from "react-router-dom";
import {
  ArrowRight, ShieldCheck, ShieldAlert, RefreshCw, KeyRound, Bot, Send,
  Fingerprint, CircleSlash,
} from "lucide-react";
import { useAppState } from "../context/AppState";
import { formatTime, microToSfusd, statusLabel } from "../lib/format";
import { Alert, CopyButton, Metric, MonoId, PageHeader, SectionHeading, Skeleton, StatusBadge, VerificationBadge } from "../components/shared";
import type { ChainKey } from "../lib/types";

const ROLES = [
  {
    name: "OWNER", icon: KeyRound, tone: "lime",
    summary: "Creates and manages the spending policy.",
    points: ["Controls recipients and limits", "Manages expiry and freeze state", "Holds administrative authority"],
    boundary: "Owner keys stay on the owner machine.",
  },
  {
    name: "AGENT", icon: Bot, tone: "info",
    summary: "Processes instructions and signs spending intents.",
    points: ["Signs what the model requests", "Holds no vault funds", "Does not decide policy enforcement"],
    boundary: "A compromised agent cannot change the rules.",
  },
  {
    name: "SUBMITTER", icon: Send, tone: "amber",
    summary: "Pays transaction fees and relays signed intents.",
    points: ["Forwards through the vault only", "Pays gas for each submission", "Enforces no spending policy"],
    boundary: "Forwarding a transaction cannot bypass the vault.",
  },
] as const;

function ProtectionOverview() {
  const { status, loading } = useAppState();
  const protection = status?.protection ?? "unavailable";
  const verified = protection === "verified";
  const Icon = verified ? ShieldCheck : protection === "failed" ? ShieldAlert : CircleSlash;
  return (
    <section className={`panel hero-panel ${verified ? "hero-verified" : "hero-unverified"}`} aria-labelledby="protection-heading">
      <div className="hero-main">
        <div className="hero-icon"><Icon size={26} strokeWidth={1.8} aria-hidden="true" /></div>
        <div>
          <div className="eyebrow">PROTECTION OVERVIEW</div>
          <h2 id="protection-heading">{verified ? "On-chain policy enforcement is verified" : protection === "partial" ? "Partial chain verification" : "Live protection state could not be verified"}</h2>
          <p>
            SpendFloor separates the agent's spending decision from the vault's spending authority.
            Rules are enforced independently by the Solidity vault and the Anchor program — not by this interface, the agent, or the relay.
          </p>
          <div className="hero-actions">
            <VerificationBadge state={protection} />
            <span className="hero-note">{status?.note ?? "Reading chain state from the local operator…"}</span>
          </div>
        </div>
      </div>
      <div className="hero-facts">
        <div className="hero-fact"><span>Environment</span><strong>TESTNET DEMO</strong></div>
        {(["evm", "sol"] as ChainKey[]).map((chain) => (
          <div className="hero-fact" key={chain}>
            <span>{chain === "evm" ? "Base Sepolia" : "Solana Devnet"}</span>
            {loading && !status ? <Skeleton width={90} height={16} /> : <strong>{statusLabel(status?.chains[chain].state ?? "unavailable")}</strong>}
          </div>
        ))}
        <div className="hero-fact"><span>Last verification read</span><strong>{status?.generatedAt ? formatTime(status.generatedAt) : "Unavailable"}</strong></div>
      </div>
    </section>
  );
}

function PolicySummary() {
  const { status, loading } = useAppState();
  const policy = status?.policy;
  const expired = status?.chains.evm.expiryState === "expired" || status?.chains.sol.expiryState === "expired";
  return (
    <section className="panel" aria-labelledby="policy-summary-heading">
      <SectionHeading
        eyebrow="ACTIVE CONFIGURATION"
        title="Spending policy summary"
        description="Values below come from live chain reads where available. The demo deployment record is historical and is never substituted for a failed read."
        action={<FreshnessInfo source={status?.policySource ?? "Unavailable"} at={status?.generatedAt} />}
      />
      {loading && !status ? (
        <div className="metric-grid">{[0, 1, 2, 3].map((i) => <div className="metric" key={i}><Skeleton width={90} /><Skeleton width={130} height={30} /></div>)}</div>
      ) : !policy ? (
        <Alert tone="amber" title="Policy values unavailable">The operator could not read the enforced policy from the configured chains. No demonstration defaults are shown as current state.</Alert>
      ) : (
        <>
          <div className="metric-grid">
            <Metric label="Per-transaction cap" value={microToSfusd(policy.perTxMax)} unit="SFUSD" />
            <Metric label="Window cap" value={microToSfusd(policy.windowMax)} unit="SFUSD" />
            <Metric label="Window duration" value={Number(policy.windowSeconds) / 3600} unit="hours" hint={`${policy.windowSeconds} seconds`} />
            <Metric label="Expiry" value={policy.expiresAt === "0" ? "Never" : formatTime(new Date(Number(policy.expiresAt) * 1000).toISOString()).replace(" UTC", "")} hint={expired ? "Session expired on chain" : "On-chain expiry"} tone={expired ? "red" : undefined} />
            <Metric label="Allowed recipients" value={policy.recipientCount} unit="total" hint="Merchant-only demonstration set" />
            <Metric label="Freeze state" value={policy.frozen ? "FROZEN" : "UNFROZEN"} tone={policy.frozen ? "amber" : "green"} />
          </div>
          {expired && (
            <Alert tone="amber" title="Recorded policy session has expired">
              The expiry timestamp is in the past. Any new spend would be rejected with SessionExpired by the vault.
              An OWNER policy renewal is required before live payment execution; the UI does not present this policy as active.
            </Alert>
          )}
        </>
      )}
    </section>
  );
}

function FreshnessInfo({ source, at }: { source: string; at?: string }) {
  return <div className="freshness-info"><StatusBadge tone={source === "Live" ? "green" : "neutral"} dot={false}>{source}</StatusBadge>{at && <span className="mono tiny">{formatTime(at)}</span>}</div>;
}

function RoleCards() {
  return (
    <section aria-labelledby="roles-heading">
      <SectionHeading eyebrow="TRUST BOUNDARIES" title="Three roles, three different authorities" description="The demo keeps these keys on separate machines. No private key is ever available to the browser." />
      <div className="role-grid">
        {ROLES.map(({ name, icon: Icon, tone, summary, points, boundary }) => (
          <article className={`panel role-card role-${tone}`} key={name}>
            <div className="role-head"><span className="role-icon"><Icon size={19} strokeWidth={1.9} aria-hidden="true" /></span><h3>{name}</h3></div>
            <p className="role-summary">{summary}</p>
            <ul>{points.map((point) => <li key={point}>{point}</li>)}</ul>
            <div className="role-boundary">{boundary}</div>
          </article>
        ))}
      </div>
    </section>
  );
}

function NetworkCards() {
  const { status, config } = useAppState();
  return (
    <section aria-labelledby="networks-heading">
      <SectionHeading eyebrow="NETWORK CONTEXT" title="Separate chains, independent results" description="A confirmed result on one network never proves anything about the other network." />
      <div className="grid-2">
        {(["evm", "sol"] as ChainKey[]).map((chain) => {
          const view = status?.chains[chain];
          const meta = config?.networks[chain];
          const id = chain === "evm" ? meta?.vault : meta?.program;
          return (
            <article className="panel network-card" key={chain}>
              <div className="network-card-head">
                <span className={`network-glyph network-${chain}`}>{chain === "evm" ? "◇" : "◎"}</span>
                <div><h3>{chain === "evm" ? "Base Sepolia" : "Solana Devnet"}</h3><p>{chain === "evm" ? "EVM · Solidity vault" : "SVM · Anchor program"}</p></div>
                <VerificationBadge state={view?.state ?? "unavailable"} />
              </div>
              <dl className="definition-list">
                <div><dt>Identifier</dt><dd><MonoId value={id ?? null} short={id ? `${id.slice(0, 12)}…${id.slice(-6)}` : undefined} label={`Copy ${chain} identifier`} href={view?.explorerUrl} /></dd></div>
                <div><dt>Policy fingerprint</dt><dd><MonoId value={view?.computedFingerprint ? `0x${view.computedFingerprint}` : null} short={view?.computedFingerprint ? `0x${view.computedFingerprint.slice(0, 14)}…` : undefined} label="Copy fingerprint" /></dd></div>
                <div><dt>Expiry state</dt><dd><StatusBadge tone={view?.expiryState === "active" ? "green" : view?.expiryState === "expired" ? "red" : "neutral"} dot={false}>{view?.expiryState ?? "unknown"}</StatusBadge></dd></div>
              </dl>
              {view?.error && <p className="inline-error">{view.error}</p>}
              {meta && <div className="card-source">Source · <span className="mono">{meta.deploymentRecord}</span></div>}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function FingerprintPanel() {
  const { status } = useAppState();
  const canonical = status?.canonical;
  const fingerprint = canonical?.fingerprint ? `0x${canonical.fingerprint}` : null;
  return (
    <section className="panel fingerprint-panel" aria-labelledby="fingerprint-heading">
      <div className="fingerprint-heading">
        <span className="role-icon role-icon-lime"><Fingerprint size={19} aria-hidden="true" /></span>
        <div><div className="eyebrow">CANONICAL POLICY</div><h2 id="fingerprint-heading">One policy fingerprint, two chains</h2></div>
      </div>
      <p>SHA-256 over the canonical 122-byte policy encoding. Recomputed by the operator from live fields using the repository policy package — never copied from a stale dashboard.</p>
      <div className="fingerprint-value">
        <span className="mono">{fingerprint ?? "Unavailable — no complete chain read"}</span>
        {fingerprint && <CopyButton value={fingerprint} label="Copy fingerprint" />}
      </div>
      <div className="fingerprint-meta">
        <span><strong>Method</strong> {canonical?.method ?? "—"}</span>
        <span><strong>Source</strong> {canonical?.source ?? "Unavailable"}</span>
        <span><strong>Comparison</strong> {canonical?.comparison ?? "not-performed"}</span>
        {canonical?.comparedAt && <span><strong>Compared</strong> {formatTime(canonical.comparedAt)}</span>}
      </div>
      <p className="muted small">{canonical?.detail ?? "No verification comparison was performed."}</p>
    </section>
  );
}

export function CommandCenter() {
  const { status, refreshStatus } = useAppState();
  return (
    <div className="page-stack">
      <PageHeader
        title="Command Center"
        subtitle="Secure spending infrastructure for autonomous AI agents."
        badge={<StatusBadge tone="amber">TESTNET DEMO</StatusBadge>}
        actions={<button className="button button-secondary" onClick={() => void refreshStatus()}><RefreshCw size={15} aria-hidden="true" /> Refresh state</button>}
      />
      <ProtectionOverview />
      <PolicySummary />
      <RoleCards />
      <NetworkCards />
      <FingerprintPanel />
      <section className="cta-panel">
        <div><div className="eyebrow">NEXT IN THE DEMO</div><h2>See the vault refuse an unauthorized payment.</h2><p>Run the injected instruction through the real local demo adapter. Both chains return their own result.</p></div>
        <Link className="button button-primary button-large" to="/attack-playground">Run Security Demo <ArrowRight size={17} aria-hidden="true" /></Link>
      </section>
      {status?.mode === "local" && <Alert tone="info" title="Local development mode">The operator is configured for Anvil + Surfpool. Results are local, not Base Sepolia or devnet transactions.</Alert>}
    </div>
  );
}
