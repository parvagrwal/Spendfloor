import { Link, useSearchParams } from "react-router-dom";
import {
  ReceiptText, ShieldX, ShieldCheck, History, ExternalLink, Fingerprint,
  ChevronDown, AlertTriangle, RefreshCw, ArrowRight,
} from "lucide-react";
import { useAppState } from "../context/AppState";
import { formatDate, formatTime, microToSfusd, shortId } from "../lib/format";
import type { ChainExecution, ChainKey, HistoricalRecord } from "../lib/types";
import { Alert, CopyButton, ExecutionBadge, MonoId, PageHeader, SectionHeading, StatusBadge } from "../components/shared";

function ChainDetails({ chain, execution, recordDate }: { chain: ChainKey; execution: ChainExecution | undefined; recordDate?: string }) {
  return (
    <div className="proof-chain">
      <div className="proof-chain-head">
        <span className={`network-chip network-${chain}`}>{chain === "evm" ? "BASE SEPOLIA" : "SOLANA DEVNET"}</span>
        {execution ? <ExecutionBadge state={execution.state} /> : <StatusBadge tone="neutral">Not recorded</StatusBadge>}
      </div>
      {!execution ? <p className="muted">No result was recorded for this chain in this run.</p> : (
        <dl className="definition-list">
          <div><dt>Status</dt><dd>{execution.state === "rejected" ? "REJECTED" : execution.state.toUpperCase()}</dd></div>
          <div><dt>Vault returned</dt><dd className="mono">{execution.label ?? "—"}</dd></div>
          <div><dt>{chain === "evm" ? "Transaction hash" : "Signature"}</dt><dd><MonoId value={execution.hash} short={shortId(execution.hash, 16, 12)} label="Copy transaction identifier" href={execution.explorerUrl} /></dd></div>
          <div><dt>Recorded time</dt><dd>{execution.observedAt ? formatTime(execution.observedAt) : recordDate ? formatDate(recordDate) : "—"}</dd></div>
          {execution.digest && <div><dt>Payload digest</dt><dd><MonoId value={execution.digest} short={shortId(execution.digest, 14, 10)} label="Copy payload digest" /></dd></div>}
          {execution.signedAmountMicro && <div><dt>Signed amount</dt><dd className="mono">{microToSfusd(execution.signedAmountMicro)} SFUSD</dd></div>}
        </dl>
      )}
    </div>
  );
}

function HistoricalGroup({ title, tone, records }: { title: string; tone: "red" | "green"; records: HistoricalRecord[] }) {
  if (!records.length) return null;
  return (
    <section className="proof-group">
      <SectionHeading title={title} description={`${records.length} recorded ${records.length === 1 ? "run" : "runs"} · all entries labelled with their own date and source`} action={<StatusBadge tone={tone} dot={false}>{tone === "red" ? "Rejected" : "Accepted"}</StatusBadge>} />
      <div className="proof-records">
        {records.map((record) => (
          <details className="panel proof-record" key={record.id}>
            <summary>
              <span className="proof-record-main"><strong>{record.title}</strong><span className="muted">{record.networkLabel}</span></span>
              <span className="proof-record-meta"><StatusBadge tone="info" dot={false}>Historical</StatusBadge><span className="mono tiny">{formatDate(record.date)}</span><ChevronDown size={15} aria-hidden="true" /></span>
            </summary>
            <div className="proof-record-body">
              <p><strong>Attempt:</strong> {record.amountSfusd} SFUSD to {record.target}.</p>
              <div className="grid-2"><ChainDetails chain="evm" execution={record.chains.evm} recordDate={record.date} /><ChainDetails chain="sol" execution={record.chains.sol} recordDate={record.date} /></div>
              <p className="muted small">{record.note}</p>
              <div className="card-source">Evidence source · <span className="mono">{record.source}</span></div>
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}

export function TransactionProof() {
  const { status, latestRun, evidence, refreshStatus } = useAppState();
  const [params, setParams] = useSearchParams();
  const view = params.get("view") === "historical" ? "historical" : "latest";
  const canonical = status?.canonical;
  const fingerprint = canonical?.fingerprint ? `0x${canonical.fingerprint}` : null;
  const attack = evidence?.records.filter((r) => r.scenario === "attack-recipient") ?? [];
  const legit = evidence?.records.filter((r) => r.scenario === "legit-payment") ?? [];

  return (
    <div className="page-stack">
      <PageHeader
        title="Transaction Proof"
        subtitle="Inspect the on-chain results behind each demonstration."
        badge={<StatusBadge tone="amber">TESTNET DEMO</StatusBadge>}
        actions={<button className="button button-secondary" onClick={() => void refreshStatus()}><RefreshCw size={15} aria-hidden="true" /> Refresh chain reads</button>}
      />

      <div className="proof-tabs" role="tablist" aria-label="Evidence view">
        <button role="tab" aria-selected={view === "latest"} className={view === "latest" ? "proof-tab active" : "proof-tab"} onClick={() => setParams({ view: "latest" })}><ReceiptText size={16} aria-hidden="true" /> Latest Run</button>
        <button role="tab" aria-selected={view === "historical"} className={view === "historical" ? "proof-tab active" : "proof-tab"} onClick={() => setParams({ view: "historical" })}><History size={16} aria-hidden="true" /> Historical Runs</button>
      </div>

      {view === "latest" ? (
        !latestRun ? (
          <div className="panel">
            <SectionHeading title="No latest run available" description="The operator has not returned an execution in this process yet." />
            <Alert tone="info" title="Proof starts with a real execution">Run a scenario in the Attack Playground. Its structured SDK receipts appear here immediately, split by chain.</Alert>
            <Link className="button button-primary" to="/attack-playground">Go to Attack Playground <ArrowRight size={16} aria-hidden="true" /></Link>
          </div>
        ) : (
          <div className="page-stack">
            <section className="panel latest-summary">
              <div className="latest-summary-head">
                <div><div className="eyebrow">MOST RECENT EXECUTION</div><h2>{latestRun.scenario === "attack-recipient" ? "Attack attempt" : "Legitimate payment"}</h2></div>
                <div className="latest-tags"><StatusBadge tone="info" dot={false}>{latestRun.freshness}</StatusBadge><StatusBadge tone={latestRun.outcome === "rejected" ? "red" : latestRun.outcome === "accepted" ? "green" : "amber"} dot={false}>{latestRun.outcome}</StatusBadge></div>
              </div>
              <p className="instruction-quote">“{latestRun.instruction}”</p>
              <div className="fingerprint-meta"><span><strong>Started</strong> {formatTime(latestRun.startedAt)}</span><span><strong>Finished</strong> {formatTime(latestRun.finishedAt)}</span><span><strong>Network</strong> {latestRun.mode}</span><span><strong>Run ID</strong> <MonoId value={latestRun.id} short={shortId(latestRun.id, 8, 4)} label="Copy run ID" /></span></div>
              {latestRun.error && <Alert tone="red" title="Execution error">{latestRun.error}</Alert>}
              {latestRun.securityOutcome === "attack_blocked" && <Alert tone="green" title="Confirmed rejection on both chains">The SDK returned RecipientNotAllowed with a transaction identifier on each chain. Verify the identifiers below in the independent explorers.</Alert>}
            </section>
            <SectionHeading title="Results by chain" description="Each chain is recorded separately; no combined success is inferred." />
            <div className="grid-2"><div className="panel"><ChainDetails chain="evm" execution={latestRun.chains.evm} /></div><div className="panel"><ChainDetails chain="sol" execution={latestRun.chains.sol} /></div></div>
            <details className="panel event-log"><summary><ReceiptText size={16} aria-hidden="true" /> Structured execution events ({latestRun.events.length})</summary>
              <ol>{latestRun.events.map((event, i) => <li key={`${event.type}-${i}`}><span className="mono tiny">{formatTime(event.at)}</span><span className="mono event-type">{event.type}</span></li>)}</ol>
            </details>
          </div>
        )
      ) : (
        <div className="page-stack">
          <Alert tone="info" title="Historical evidence only">These records were captured on 2026-10-30 and are not live activity. Their timestamps and evidence sources are shown with each record.</Alert>
          <HistoricalGroup title="Attack attempt — rejected" tone="red" records={attack} />
          <HistoricalGroup title="Legitimate payment — accepted" tone="green" records={legit} />
        </div>
      )}

      <section className="panel" aria-labelledby="policy-verification-heading">
        <SectionHeading eyebrow="POLICY VERIFICATION" title="Canonical policy fingerprint" description="Computed from live chain fields using the repository canonical encoder. A comparison is only reported when it was actually performed." />
        <div className="verification-grid">
          <div className="verification-hash"><div className="eyebrow">SHA-256 FINGERPRINT</div><div className="mono fingerprint-inline">{fingerprint ?? "Unavailable — chain reads incomplete"}</div>{fingerprint && <CopyButton value={fingerprint} label="Copy fingerprint" />}</div>
          <dl className="definition-list">
            <div><dt>Hashing method</dt><dd>SHA-256 · canonical 122-byte encoding</dd></div>
            <div><dt>Freshness</dt><dd>{canonical?.source ?? "Unavailable"} · {canonical?.observation ?? "unavailable"}</dd></div>
            <div><dt>Comparison result</dt><dd>{canonical?.comparison ?? "not-performed"}</dd></div>
            <div><dt>Verification time</dt><dd>{formatTime(canonical?.comparedAt)}</dd></div>
            <div><dt>Chain representation</dt><dd>One canonical hash; separate EVM and Solana recipient commitments</dd></div>
          </dl>
        </div>
        <p className="muted small">{canonical?.detail ?? "No comparison was performed; no verification claim is made."}</p>
      </section>

      <section className="panel" aria-labelledby="integrity-heading">
        <SectionHeading eyebrow="EVIDENCE INTEGRITY" title="How to read this proof" />
        <ul className="integrity-list">
          <li><ShieldX size={15} aria-hidden="true" /><span><strong>{evidence?.provenance.rejections ?? "Historical rejection records are labelled with source and date."}</strong></span></li>
          <li><ShieldCheck size={15} aria-hidden="true" /><span><strong>{evidence?.provenance.verify ?? "Historical verification record"}</strong> — {evidence?.provenance.verifyCaveat ?? "Source not available."}</span></li>
          <li><Fingerprint size={15} aria-hidden="true" /><span>Historical fingerprint <span className="mono">{evidence?.provenance.policyHash ?? "—"}</span> recorded {formatDate(evidence?.provenance.policyHashDate)} ({evidence?.provenance.policyHashSource ?? "source unavailable"}). It is not shown as the current value.</span></li>
          <li><AlertTriangle size={15} aria-hidden="true" /><span>No 15/15 score, transaction count or network state on this screen is presented as a current attestation. Explorer links point to the recorded identifiers only.</span></li>
        </ul>
        <div className="integrity-links"><CopyButton value={evidence?.provenance.policyHash ?? null} label="Copy historical fingerprint" /><a className="button button-ghost button-small" href="https://github.com/parvagrwal/SpendFloor/tree/main/docs" target="_blank" rel="noopener noreferrer">Evidence documents <ExternalLink size={13} aria-hidden="true" /></a></div>
      </section>
    </div>
  );
}
