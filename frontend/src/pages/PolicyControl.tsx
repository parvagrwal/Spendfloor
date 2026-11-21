import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  KeyRound, Snowflake, ArrowRight, LockKeyhole, Calculator,
} from "lucide-react";
import { useAppState } from "../context/AppState";
import { api, explainError } from "../lib/api";
import { formatTime, microToSfusd, shortId } from "../lib/format";
import type { ChainKey } from "../lib/types";
import { Alert, CopyButton, Metric, MonoId, PageHeader, SectionHeading, StatusBadge } from "../components/shared";

interface DraftValues {
  perTxMax: string;
  windowMax: string;
  windowSeconds: string;
  windowAnchor: string;
  expiresAt: string;
}

function freezeCommand(freeze: boolean): string {
  return `npx tsx cli/spendfloor.ts owner ${freeze ? "freeze" : "unfreeze"}`;
}

function CurrentPolicy() {
  const { status } = useAppState();
  const policy = status?.policy;
  return (
    <section className="panel">
      <SectionHeading eyebrow="CURRENT POLICY" title="Enforced spending boundaries" description="Values come from live chain reads. Nothing here is edited by this interface." action={<StatusBadge tone={policy ? "green" : "neutral"} dot={false}>{status?.policySource ?? "Unavailable"}</StatusBadge>} />
      {!policy ? (
        <Alert tone="amber" title="Live policy unavailable">The operator could not read the enforced policy. Demo defaults are documented (2 SFUSD per tx, 5 SFUSD per 24 h window, merchant-only), but are not displayed as the current state.</Alert>
      ) : (
        <>
          <div className="metric-grid">
            <Metric label="Per-transaction limit" value={microToSfusd(policy.perTxMax)} unit="SFUSD" />
            <Metric label="Spending window limit" value={microToSfusd(policy.windowMax)} unit="SFUSD" />
            <Metric label="Window duration" value={Number(policy.windowSeconds) / 3600} unit="hours" />
            <Metric label="Freeze state" value={policy.frozen ? "FROZEN" : "UNFROZEN"} tone={policy.frozen ? "amber" : "green"} />
          </div>
          <div className="fingerprint-meta policy-meta">
            <span><strong>Version</strong> {policy.version}</span><span><strong>Decimals</strong> {policy.decimals}</span>
            <span><strong>Expiry</strong> {policy.expiresAt === "0" ? "Never" : formatTime(new Date(Number(policy.expiresAt) * 1000).toISOString())}</span>
            <span><strong>Window anchor</strong> <span className="mono">{policy.windowAnchor}</span></span>
          </div>
          {status?.chains.evm.expiryState === "expired" && <Alert tone="amber" title="Policy expiry is in the past">New spends would be rejected with SessionExpired until the OWNER renews the policy on both chains.</Alert>}
        </>
      )}
    </section>
  );
}

function Allowlist() {
  const { config, status } = useAppState();
  return (
    <section className="panel">
      <SectionHeading eyebrow="RECIPIENT ALLOWLIST" title="Who the agent is allowed to pay" description="Authorization is read from the vault contract and the Anchor policy account where available." />
      <div className="allowlist">
        {(["evm", "sol"] as ChainKey[]).map((chain) => {
          const record = status?.recipientAuthorization.find((r) => r.scenario === "legit-payment" && r.chain === chain);
          const address = config?.networks[chain].merchant;
          return (
            <details className="allowlist-row" key={chain}>
              <summary>
                <span className={`network-chip network-${chain}`}>{chain === "evm" ? "BASE" : "SOL"}</span>
                <span className="allowlist-name"><strong>Approved merchant</strong><span className="mono tiny">{shortId(address, 14, 10)}</span></span>
                <StatusBadge tone={record?.authorized === true ? "green" : "neutral"} dot={false}>{record?.authorized === true ? "Authorized" : "Unverified"}</StatusBadge>
              </summary>
              <div className="allowlist-detail">
                <div><span>Address</span><MonoId value={address ?? null} label="Copy recipient address" /></div>
                <div><span>Network applicability</span><strong>{chain === "evm" ? "Base Sepolia vault only" : "Solana devnet policy PDA only"}</strong></div>
                <div><span>Basis</span><span className="muted">{record?.basis ?? "Live check unavailable."}</span></div>
              </div>
            </details>
          );
        })}
        <div className="allowlist-row allowlist-static">
          <span className="network-chip network-neutral">BOTH</span>
          <span className="allowlist-name"><strong>Attacker / non-recipient address</strong><span className="mono tiny">{shortId(config?.networks.evm.attacker, 14, 10)}</span></span>
          <StatusBadge tone="red" dot={false}>Not authorized</StatusBadge>
        </div>
      </div>
    </section>
  );
}

function FreezeControl() {
  const { status } = useAppState();
  const frozen = status?.policy?.frozen;
  return (
    <section className="panel freeze-panel">
      <div className="freeze-head">
        <span className="freeze-icon"><Snowflake size={21} aria-hidden="true" /></span>
        <div><div className="eyebrow">EMERGENCY CONTROL · OWNER ONLY</div><h2>Freeze spending</h2><p>Freezing blocks new spends on both chains until the OWNER unfreezes them. It does not reverse completed transfers and it is not atomic across chains.</p></div>
      </div>
      <div className="freeze-state">
        <div><span>Current on-chain state</span><strong className={frozen ? "text-warning" : "text-success"}>{frozen === undefined ? "UNAVAILABLE" : frozen ? "FROZEN" : "NOT FROZEN"}</strong></div>
        <div><span>Executable from this browser</span><strong className="text-danger">NO</strong></div>
      </div>
      <Alert tone="amber" title="Read-only by design">
        Owner private keys are never placed in the browser or in the local operator. Freeze and unfreeze are executed on the owner machine with the existing CLI. There is no frontend toggle claiming to change on-chain state.
      </Alert>
      <div className="command-block">
        <span className="mono">{freezeCommand(!frozen)}</span>
        <CopyButton value={freezeCommand(!frozen)} label="Copy owner command" />
      </div>
      <p className="muted small">Cross-chain admin commands are two transactions. Reconcile each chain separately; see DEPLOYMENT.md for recovery guidance.</p>
    </section>
  );
}

function PolicyDraft() {
  const { status } = useAppState();
  const [draft, setDraft] = useState<DraftValues | null>(null);
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [error, setError] = useState<{ title: string; detail: string } | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const policy = status?.policy;
  const isLive = Boolean(policy);

  useEffect(() => {
    if (policy) {
      setDraft({
        perTxMax: policy.perTxMax,
        windowMax: policy.windowMax,
        windowSeconds: policy.windowSeconds,
        windowAnchor: policy.windowAnchor,
        expiresAt: policy.expiresAt,
      });
    } else {
      setDraft({ perTxMax: "", windowMax: "", windowSeconds: "", windowAnchor: "", expiresAt: "" });
    }
  }, [policy]);

  async function preview() {
    if (!draft) return;
    setBusy(true); setError(null); setFingerprint(null);
    try {
      const result = await api.policyPreview({ ...draft });
      setFingerprint(result.fingerprint);
    } catch (err) {
      setError(explainError(err));
    } finally { setBusy(false); }
  }

  const command = draft
    ? `npx tsx cli/spendfloor.ts owner set-policy --per-tx ${draft.perTxMax} --window ${draft.windowMax} --window-secs ${draft.windowSeconds} --expiry-secs ${Math.max(0, Number(draft.expiresAt) - Math.floor(Date.now() / 1000))}`
    : "";

  const fields: { key: keyof DraftValues; label: string; unit: string }[] = [
    { key: "perTxMax", label: "Per-transaction limit", unit: "micro SFUSD" },
    { key: "windowMax", label: "Window limit", unit: "micro SFUSD" },
    { key: "windowSeconds", label: "Window duration", unit: "seconds" },
    { key: "expiresAt", label: "Policy expiry", unit: "unix seconds" },
  ];

  return (
    <section className="panel">
      <SectionHeading eyebrow="OWNER WORKFLOW · PREVIEW ONLY" title="Prepare a policy change" description="The draft is validated by the existing canonical policy encoder. Nothing in this form submits a transaction or changes the vault." />
      {!isLive && <Alert tone="amber" title="Draft is not based on a live policy read">Fill every field yourself. The canonical preview will still validate structure and compute a fingerprint, but it cannot prove the draft matches the deployed policy.</Alert>}
      {!draft ? <p className="muted">Waiting for policy values…</p> : (
        <>
          <div className="draft-grid">
            {fields.map(({ key, label, unit }) => (
              <label className="draft-field" key={key}>
                <span>{label}</span>
                <input value={draft[key]} inputMode="numeric" onChange={(e) => { setDraft({ ...draft, [key]: e.target.value }); setFingerprint(null); }} />
                <small>{unit}</small>
              </label>
            ))}
          </div>
          <p className="field-hint"><LockKeyhole size={13} aria-hidden="true" /> Window anchor is fixed at <span className="mono">{draft.windowAnchor}</span> for this preview. Recipient sets stay merchant-only; the operator does not accept arbitrary recipients from the browser.</p>
          <div className="draft-actions">
            <button className="button button-secondary" onClick={() => void preview()} disabled={busy}><Calculator size={15} aria-hidden="true" /> Calculate canonical fingerprint</button>
            {fingerprint && <div className="draft-fingerprint"><span className="mono">{fingerprint}</span><CopyButton value={fingerprint} label="Copy draft fingerprint" /></div>}
          </div>
          {error && <Alert tone="red" title={error.title}>{error.detail}</Alert>}
          {fingerprint && <Alert tone="info" title="Local preview — not applied">The fingerprint was computed from the draft using the repository policy package. No owner transaction has been submitted; the on-chain policy is unchanged.</Alert>}
          <div className="confirmation-block">
            <label htmlFor="owner-confirm">Type <span className="mono">I AM THE OWNER</span> to reveal the exact owner CLI command for a separate, secure machine</label>
            <input id="owner-confirm" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} placeholder="I AM THE OWNER" autoComplete="off" />
            {confirmation === "I AM THE OWNER" && (
              <>
                <div className="command-block"><span className="mono">{command}</span><CopyButton value={command} label="Copy owner command" /></div>
                <p className="muted small">Run this only on the owner machine after reviewing values. The command updates both chains in two transactions and then re-runs verify; partial results require manual reconciliation.</p>
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}

export function PolicyControl() {
  const { status } = useAppState();
  const fingerprint = status?.canonical.fingerprint ? `0x${status.canonical.fingerprint}` : null;
  return (
    <div className="page-stack">
      <PageHeader title="Policy Control" subtitle="Define the boundaries of what your AI agent can spend." badge={<StatusBadge tone="amber">TESTNET DEMO</StatusBadge>} />
      <div className="policy-intro">
        <KeyRound size={19} aria-hidden="true" />
        <div><strong>The OWNER sets the rules. The AGENT operates inside them.</strong><span>Policy administration and agent execution require different keys on different machines. This screen is an inspection and preview surface.</span></div>
      </div>
      <CurrentPolicy />
      <Allowlist />
      <FreezeControl />
      <PolicyDraft />
      <section className="panel">
        <SectionHeading eyebrow="CANONICAL POLICY" title="Fingerprint and verification" description="The same canonical representation is used on both chains; chain-specific recipient commitments are part of the preimage." />
        <div className="verification-grid">
          <div className="verification-hash"><div className="eyebrow">CURRENT FINGERPRINT</div><div className="mono fingerprint-inline">{fingerprint ?? "Unavailable — chain reads incomplete"}</div>{fingerprint && <CopyButton value={fingerprint} label="Copy fingerprint" />}</div>
          <dl className="definition-list">
            <div><dt>Method</dt><dd>SHA-256</dd></div>
            <div><dt>Source</dt><dd>{status?.canonical.source ?? "Unavailable"} · {status?.canonical.observation ?? "unavailable"}</dd></div>
            <div><dt>Comparison</dt><dd>{status?.canonical.comparison ?? "not-performed"}</dd></div>
            <div><dt>Verified at</dt><dd>{formatTime(status?.canonical.comparedAt)}</dd></div>
          </dl>
        </div>
        <p className="muted small">Frozen state and roles are checked separately and are not part of the hash. A locally computed draft fingerprint is a preview, never a policy update.</p>
      </section>
      <section className="cta-panel">
        <div><div className="eyebrow">VERIFY THE ENFORCEMENT</div><h2>See the vault refuse an unauthorized payment.</h2><p>The policy matters because the on-chain vault applies it to every spend, regardless of what the agent was told.</p></div>
        <Link className="button button-primary" to="/attack-playground">Run Security Demo <ArrowRight size={16} aria-hidden="true" /></Link>
      </section>
    </div>
  );
}
