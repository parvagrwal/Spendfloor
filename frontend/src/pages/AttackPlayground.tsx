import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Crosshair, ArrowRight, RotateCcw, Play, ShieldCheck, CircleHelp,
  CircleAlert, Terminal, ExternalLink, ArrowLeft, LoaderCircle, Radio, LockKeyhole,
} from "lucide-react";
import { useAppState } from "../context/AppState";
import { api, explainError } from "../lib/api";
import { executionLabel, formatTime, microToSfusd, shortId } from "../lib/format";
import type { ChainKey, DemoRun, ExecutionState, FlowStep } from "../lib/types";
import { Alert, CopyButton, ExecutionBadge, MonoId, PageHeader, SectionHeading, StatusBadge } from "../components/shared";

const WAITING_STEPS: FlowStep[] = [
  { key: "agent", state: "not_started", at: null, detail: "Waiting for instruction" },
  { key: "sign", state: "not_started", at: null, detail: "Waiting for signed intent" },
  { key: "relay", state: "not_started", at: null, detail: "Waiting for submitter" },
  { key: "result", state: "not_started", at: null, detail: "Waiting for on-chain results" },
];

const STEP_LABELS: Record<FlowStep["key"], string> = {
  agent: "AGENT SIGNS INTENT",
  sign: "SIGNED INTENT",
  relay: "SUBMITTER RELAYS",
  result: "TRANSACTION RESULT",
};

function ExecutionFlow({ steps, busy }: { steps: FlowStep[]; busy: boolean }) {
  return (
    <div className="flow" aria-label="Execution lifecycle">
      {steps.map((step, index) => (
        <div className="flow-segment" key={step.key}>
          <div className={`flow-node flow-${step.state}${busy && step.state === "not_started" && index < 3 ? " flow-pending" : ""}`}>
            <div className="flow-node-top">
              <span className="flow-index">{String(index + 1).padStart(2, "0")}</span>
              <ExecutionBadge state={step.state} />
            </div>
            <strong>{STEP_LABELS[step.key]}</strong>
            <span className="flow-detail">{step.detail}</span>
            {step.at && <span className="flow-time mono">{formatTime(step.at)}</span>}
          </div>
          {index < steps.length - 1 && <ArrowRight className="flow-arrow" size={18} aria-hidden="true" />}
        </div>
      ))}
    </div>
  );
}

function RequestFacts({ scenarioId, instruction, onInstructionChange }: { scenarioId: "attack-recipient" | "legit-payment"; instruction: string; onInstructionChange: (value: string) => void }) {
  const { config, status } = useAppState();
  const scenario = config?.scenarios[scenarioId];
  const cap = status?.policy?.perTxMax;
  const match = /(\d+(?:\.\d+)?)\s*SFUSD/i.exec(instruction);
  const requested = match ? match[1] : scenario ? String(scenario.amountSfusd) : "—";
  const authorization = (chain: ChainKey) => status?.recipientAuthorization.find((r) => r.scenario === scenarioId && r.chain === chain);
  return (
    <div className="panel request-panel">
      <SectionHeading eyebrow="REQUEST UNDER TEST" title="What the agent is being asked to do" />
      <label className="field-label" htmlFor="instruction">Instruction</label>
      <textarea
        id="instruction"
        className="instruction-input"
        value={instruction}
        rows={3}
        spellCheck={false}
        onChange={(event) => onInstructionChange(event.target.value)}
      />
      <p className="field-hint"><LockKeyhole size={13} aria-hidden="true" /> Live execution accepts only the exact approved scenario instruction shown here. Editing a scenario invalidates execution until it is restored; nothing is simulated.</p>
      <div className="fact-grid">
        <div className="fact"><span>Requested amount</span><strong>{requested} <small>SFUSD</small></strong></div>
        <div className="fact"><span>Current per-tx cap</span><strong>{status?.policy ? microToSfusd(cap) : "—"} <small>SFUSD</small></strong></div>
        <div className="fact"><span>Networks</span><strong>Base + Solana</strong></div>
        <div className="fact"><span>Recipient state</span>{authorization("evm")?.authorized === false || authorization("sol")?.authorized === false
          ? <strong className="text-danger">UNAUTHORIZED</strong>
          : authorization("evm")?.authorized === true && authorization("sol")?.authorized === true
            ? <strong className="text-success">AUTHORIZED</strong> : <strong>UNKNOWN</strong>}</div>
      </div>
      <div className="address-list">
        {(["evm", "sol"] as ChainKey[]).map((chain) => {
          const auth = authorization(chain);
          return (
            <div className="address-row" key={chain}>
              <span className={`network-chip network-${chain}`}>{chain === "evm" ? "BASE" : "SOL"}</span>
              <span className="mono address-value" title={scenario?.recipient[chain]}>{shortId(scenario?.recipient[chain], 14, 10)}</span>
              <CopyButton value={scenario?.recipient[chain] ?? null} label="Copy recipient" compact />
              <StatusBadge tone={auth?.authorized === true ? "green" : auth?.authorized === false ? "red" : "neutral"} dot={false}>
                {auth?.authorized === true ? "Allowed" : auth?.authorized === false ? "Not allowed" : "Unverified"}
              </StatusBadge>
            </div>
          );
        })}
        {status && <p className="tiny muted">{status.recipientAuthorization.find((r) => r.scenario === scenarioId)?.basis}</p>}
      </div>
    </div>
  );
}

function ChainResult({ chain, run }: { chain: ChainKey; run: DemoRun | null }) {
  const result = run?.chains[chain];
  const { config } = useAppState();
  const network = config?.networks[chain];
  return (
    <article className="panel chain-result-panel">
      <div className="chain-result-head">
        <span className={`network-glyph network-${chain}`}>{chain === "evm" ? "◇" : "◎"}</span>
        <div><h3>{chain === "evm" ? "Base Sepolia" : "Solana Devnet"}</h3><p>{chain === "evm" ? "Solidity vault · EVM" : "Anchor program · SVM"}</p></div>
        {result ? <ExecutionBadge state={result.state} /> : <StatusBadge tone="neutral">No run selected</StatusBadge>}
      </div>
      {!result || result.state === "not_started" ? (
        <div className="chain-result-empty">No result returned for this chain yet.</div>
      ) : (
        <dl className="definition-list result-list">
          <div><dt>Execution state</dt><dd>{executionLabel(result.state)}</dd></div>
          <div><dt>Vault response</dt><dd className={result.label ? "mono text-danger" : "mono"}>{result.label ?? "No rejection reason returned"}</dd></div>
          <div><dt>{chain === "evm" ? "Transaction hash" : "Signature"}</dt><dd><MonoId value={result.hash} short={shortId(result.hash, 14, 10)} label="Copy transaction identifier" href={result.explorerUrl} /></dd></div>
          <div><dt>Timestamp</dt><dd>{formatTime(result.observedAt)}</dd></div>
          <div><dt>Signed amount</dt><dd className="mono">{result.signedAmountMicro ? `${microToSfusd(result.signedAmountMicro)} SFUSD` : "—"}</dd></div>
          {result.digest && <div><dt>Payload digest</dt><dd><MonoId value={result.digest} short={shortId(result.digest, 12, 8)} label="Copy payload digest" /></dd></div>}
        </dl>
      )}
      {result?.note && <p className="result-note">{result.note}</p>}
      {network && <div className="card-source">Target · <span className="mono">{shortId(chain === "evm" ? network.vault : network.program, 14, 8)}</span></div>}
    </article>
  );
}

function SecurityOutcome({ run }: { run: DemoRun | null }) {
  if (!run) return null;
  if (run.securityOutcome === "attack_blocked") {
    return (
      <section className="outcome-panel outcome-blocked" role="status">
        <ShieldCheck size={26} aria-hidden="true" />
        <div>
          <div className="outcome-title">THE ATTACK FAILED.</div>
          <p>The vault rejected the unauthorized payment on both chains. No unauthorized transfer was completed.</p>
          <div className="outcome-tags"><StatusBadge tone="red">Transaction rejected</StatusBadge><StatusBadge tone="green">Security outcome: protected</StatusBadge></div>
        </div>
      </section>
    );
  }
  if (run.outcome === "accepted") {
    return (
      <section className="outcome-panel outcome-accepted" role="status">
        <ShieldCheck size={26} aria-hidden="true" />
        <div><div className="outcome-title">PAYMENT CONFIRMED ON BOTH CHAINS.</div><p>The approved merchant payment landed with receipts on Base Sepolia and Solana devnet.</p></div>
      </section>
    );
  }
  if (run.outcome === "no_action") {
    return <Alert tone="amber" title="No payment was signed">The agent did not produce a pay action, so no transaction was submitted. This is not a vault rejection.</Alert>;
  }
  return (
    <Alert tone={run.outcome === "failed" ? "red" : "amber"} title="Outcome not confirmed">
      {run.error ?? "The execution did not return confirmed results on both chains. Do not interpret this as a successful rejection or a successful payment."}
    </Alert>
  );
}

export function AttackPlayground() {
  const { config, status, latestRun, setLatestRun } = useAppState();
  const [scenario, setScenario] = useState<"attack-recipient" | "legit-payment">("attack-recipient");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ title: string; detail: string } | null>(null);
  const [justCompleted, setJustCompleted] = useState(false);

  useEffect(() => {
    if (config) setInstruction(config.instructions[scenario]);
  }, [config, scenario]);

  async function execute() {
    setBusy(true);
    setError(null);
    setJustCompleted(false);
    try {
      const run = await api.execute(scenario, instruction);
      setLatestRun(run);
      setJustCompleted(true);
    } catch (err) {
      setError(explainError(err));
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setInstruction(config?.instructions[scenario] ?? "");
    setLatestRun(null);
    setError(null);
    setJustCompleted(false);
  }

  const run = latestRun;
  const steps = busy && !run
    ? WAITING_STEPS.map((s, i) => i === 0 ? { ...s, state: "processing" as ExecutionState, detail: "Agent is processing the instruction" } : s)
    : run?.steps ?? WAITING_STEPS;
  const modeLabel = status?.mode === "local" ? "LOCAL DEVELOPMENT" : "LIVE TESTNET";
  const enabled = config?.demoEnabled ?? false;

  return (
    <div className="page-stack">
      <PageHeader
        title="Attack Playground"
        subtitle="Test how SpendFloor handles malicious and legitimate AI payment instructions."
        badge={<StatusBadge tone="amber">TESTNET DEMO</StatusBadge>}
        actions={<Link className="button button-ghost" to="/command-center"><ArrowLeft size={15} aria-hidden="true" /> Command Center</Link>}
      />

      <div className={`mode-banner ${enabled ? "mode-live" : "mode-disabled"}`} role="status">
        <Radio size={16} aria-hidden="true" />
        <div><strong>Execution mode: {enabled ? modeLabel : "live execution disabled"}</strong><span>{enabled
          ? "The local operator will run agent/demo-injection.ts against the configured network. Results are returned from the actual SDK receipts."
          : "The operator has not been enabled for submissions. No transaction will be sent. You can still inspect recorded evidence."}</span></div>
        {!enabled && <Link className="button button-secondary button-small" to="/transaction-proof?view=historical">View recorded evidence <ExternalLink size={13} aria-hidden="true" /></Link>}
      </div>

      <div className="scenario-switch" role="tablist" aria-label="Demo scenario">
        {(["attack-recipient", "legit-payment"] as const).map((id) => {
          const data = config?.scenarios[id];
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={scenario === id}
              className={`scenario-option${scenario === id ? " scenario-active" : ""}`}
              onClick={() => { setScenario(id); setError(null); setJustCompleted(false); }}
            >
              {id === "attack-recipient" ? <Crosshair size={18} aria-hidden="true" /> : <ShieldCheck size={18} aria-hidden="true" />}
              <span><strong>{data?.label ?? (id === "attack-recipient" ? "Attack scenario" : "Legitimate payment")}</strong><small>{id === "attack-recipient" ? "Unauthorized recipient · 50 SFUSD" : "Approved merchant · 1 SFUSD"}</small></span>
            </button>
          );
        })}
      </div>

      <div className="attack-grid">
        <RequestFacts scenarioId={scenario} instruction={instruction} onInstructionChange={setInstruction} />
        <section className="panel execution-panel">
          <SectionHeading eyebrow="EXECUTION LIFECYCLE" title="Agent → Submitter → Vault → Result" description="Each state is derived from an event emitted by the running demo process." />
          <ExecutionFlow steps={steps} busy={busy} />
          <div className="execute-bar">
            <button className="button button-primary button-execute" onClick={() => void execute()} disabled={busy || !instruction || !config}>
              {busy ? <><LoaderCircle className="spin" size={18} aria-hidden="true" /> EXECUTING…</> : <><Play size={17} aria-hidden="true" /> {scenario === "attack-recipient" ? "EXECUTE ATTACK" : "EXECUTE PAYMENT"}</>}
            </button>
            <button className="button button-secondary" onClick={reset} disabled={busy}><RotateCcw size={15} aria-hidden="true" /> Reset</button>
          </div>
          <p className="execute-hint"><CircleAlert size={13} aria-hidden="true" /> The agent signs what it is told. The relay only forwards. The vault independently enforces the OWNER's policy.</p>
        </section>
      </div>

      {error && <Alert tone="red" title={error.title}>{error.detail} <Link to="/transaction-proof?view=historical">Inspect recorded evidence instead</Link>.</Alert>}

      <section aria-labelledby="results-heading">
        <SectionHeading
          eyebrow="ON-CHAIN RESULTS"
          title="Independent results per network"
          description={run ? `Run ${shortId(run.id, 8, 4)} · ${run.freshness} · ${formatTime(run.finishedAt)}` : "No execution has been run yet in this session."}
          action={run && !justCompleted ? <StatusBadge tone="neutral" dot={false}>Previous run</StatusBadge> : undefined}
        />
        <div className="grid-2"><ChainResult chain="evm" run={run} /><ChainResult chain="sol" run={run} /></div>
      </section>

      <SecurityOutcome run={run} />

      {run && (
        <details className="panel event-log">
          <summary><Terminal size={16} aria-hidden="true" /> Execution events <span className="muted">({run.events.length})</span></summary>
          <ol>
            {run.events.length === 0 && <li>No structured events returned.</li>}
            {run.events.map((event, i) => (
              <li key={`${event.type}-${i}`}>
                <span className="mono tiny">{formatTime(event.at)}</span>
                <span className="mono event-type">{event.type}</span>
                <span>{event.label ? String(event.label) : event.chain ? String(event.chain) : event.reason ? String(event.reason) : ""}</span>
              </li>
            ))}
          </ol>
        </details>
      )}

      <div className="help-row"><CircleHelp size={14} aria-hidden="true" /> Need the underlying commands? <Link to="/architecture">See where enforcement happens</Link>.</div>
    </div>
  );
}
