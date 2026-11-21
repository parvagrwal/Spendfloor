import { useState } from "react";
import {
  KeyRound, Bot, Send, Shield, LockKeyhole, Ban, Server, Cpu, ArrowRight, CheckCircle2,
} from "lucide-react";
import { PageHeader, SectionHeading, StatusBadge } from "../components/shared";
import { useAppState } from "../context/AppState";
import { microToSfusd, shortId } from "../lib/format";

type NodeKey = "owner" | "agent" | "submitter" | "vault" | "evm" | "sol";

const DETAILS: Record<NodeKey, { eyebrow: string; title: string; body: string; bullets: string[]; tone: "lime" | "info" | "amber" | "green" }> = {
  owner: {
    eyebrow: "ROLE · ADMINISTRATIVE AUTHORITY", title: "OWNER",
    body: "The OWNER defines the spending boundary and keeps its keys on a separate machine. It never signs agent payments.",
    bullets: ["Defines policy and configures recipients", "Sets per-transaction and window limits", "Can freeze spending and set expiry"], tone: "lime",
  },
  agent: {
    eyebrow: "ROLE · DECISION ONLY", title: "AGENT",
    body: "The AGENT receives natural-language instructions, may sign a spending intent, and holds no vault funds.",
    bullets: ["Signs intents with its own key", "Has zero native balance and zero tokens", "Cannot change the policy it must obey"], tone: "info",
  },
  submitter: {
    eyebrow: "ROLE · LIVENESS ONLY", title: "SUBMITTER",
    body: "The SUBMITTER pays fees and relays the signed intent to the vault. It holds no agent key.",
    bullets: ["Pays transaction fees", "Forwards only through the vault", "Does not enforce spending rules"], tone: "amber",
  },
  vault: {
    eyebrow: "ENFORCEMENT BOUNDARY", title: "SPENDFLOOR VAULT",
    body: "Every spend is validated independently on-chain. The result does not depend on the agent's intentions or the relay's behaviour.",
    bullets: ["Recipient allowlist", "Per-transaction cap", "Window cap and expiry", "Freeze state and signer authorization"], tone: "green",
  },
  evm: {
    eyebrow: "CHAIN IMPLEMENTATION", title: "BASE SEPOLIA · EVM",
    body: "A Solidity vault holds the SFUSD test token. Spends use an EIP-712 intent signed by the AGENT and submitted through the relay.",
    bullets: ["Solidity vault contract", "Two-RPC state verification in the CLI", "Reverts mine on-chain and decode to a named reason"], tone: "info",
  },
  sol: {
    eyebrow: "CHAIN IMPLEMENTATION", title: "SOLANA DEVNET · SVM",
    body: "An Anchor program owns a singleton policy PDA and vault token account. The AGENT signs a spend instruction; the SUBMITTER pays rent and fees.",
    bullets: ["Anchor program with policy PDA", "Program error codes map to named reasons", "Separate confirmation path from EVM"], tone: "info",
  },
};

export function Architecture() {
  const [selected, setSelected] = useState<NodeKey>("vault");
  const { status, config } = useAppState();
  const detail = DETAILS[selected];
  const cap = status?.policy ? microToSfusd(status.policy.perTxMax) : "2";
  const windowCap = status?.policy ? microToSfusd(status.policy.windowMax) : "5";
  return (
    <div className="page-stack">
      <PageHeader title="Architecture Explorer" subtitle="Spending decisions and spending authority are separated." badge={<StatusBadge tone="amber">TESTNET DEMO</StatusBadge>} />
      <div className="thesis-banner">
        <LockKeyhole size={22} aria-hidden="true" />
        <div><span>POLICY ENFORCEMENT HAPPENS ON-CHAIN.</span><p>The agent can be manipulated. The vault cannot be persuaded.</p></div>
      </div>
      <SectionHeading eyebrow="INTERACTIVE DIAGRAM" title="Where authority actually lives" description="Select a role, the vault, or a chain implementation to inspect its responsibilities." />

      <div className="architecture-layout">
        <div className="arch-diagram panel">
          <div className="arch-roles">
            <button className={`arch-node arch-role${selected === "owner" ? " arch-selected" : ""}`} onClick={() => setSelected("owner")} aria-pressed={selected === "owner"}>
              <span className="arch-icon"><KeyRound size={18} aria-hidden="true" /></span><strong>OWNER</strong><small>Defines policy</small>
            </button>
            <button className={`arch-node arch-role${selected === "agent" ? " arch-selected" : ""}`} onClick={() => setSelected("agent")} aria-pressed={selected === "agent"}>
              <span className="arch-icon"><Bot size={18} aria-hidden="true" /></span><strong>AGENT</strong><small>Signs spending intent</small>
            </button>
            <button className={`arch-node arch-role${selected === "submitter" ? " arch-selected" : ""}`} onClick={() => setSelected("submitter")} aria-pressed={selected === "submitter"}>
              <span className="arch-icon"><Send size={18} aria-hidden="true" /></span><strong>SUBMITTER</strong><small>Relays · pays fees</small>
            </button>
          </div>
          <div className="arch-connector-row" aria-hidden="true">
            <span>policy configuration</span><span>signed intent</span><span>transaction relay</span>
          </div>
          <div className="arch-vault-wrap">
            <button className={`arch-vault${selected === "vault" ? " arch-selected" : ""}`} onClick={() => setSelected("vault")} aria-pressed={selected === "vault"}>
              <span className="arch-vault-icon"><Shield size={26} aria-hidden="true" /></span>
              <span className="arch-vault-text"><small>ENFORCEMENT BOUNDARY</small><strong>SpendFloor Vault</strong><span>The only component that authorizes movement of funds</span></span>
              <span className="arch-rule-tags"><em>Allowlist</em><em>Tx cap</em><em>Window cap</em><em>Expiry</em><em>Freeze</em></span>
            </button>
          </div>
          <div className="arch-connector-row arch-connector-bottom" aria-hidden="true"><span>independent deployments · shared canonical policy</span></div>
          <div className="arch-chains">
            <button className={`arch-node arch-chain${selected === "evm" ? " arch-selected" : ""}`} onClick={() => setSelected("evm")} aria-pressed={selected === "evm"}>
              <Server size={18} aria-hidden="true" /><span><strong>Base Sepolia</strong><small>Solidity / EVM vault</small><span className="mono tiny">{shortId(config?.networks.evm.vault, 12, 6)}</span></span>
            </button>
            <button className={`arch-node arch-chain${selected === "sol" ? " arch-selected" : ""}`} onClick={() => setSelected("sol")} aria-pressed={selected === "sol"}>
              <Cpu size={18} aria-hidden="true" /><span><strong>Solana Devnet</strong><small>Anchor / SVM program</small><span className="mono tiny">{shortId(config?.networks.sol.program, 12, 6)}</span></span>
            </button>
          </div>
          <div className="arch-blocked">
            <span className="arch-blocked-title"><Ban size={15} aria-hidden="true" /> BLOCKED PATH</span>
            <div className="arch-blocked-flow"><span>Manipulated agent</span><ArrowRight size={14} aria-hidden="true" /><span>Unauthorized recipient</span><ArrowRight size={14} aria-hidden="true" /><strong>Vault → Rejected</strong></div>
          </div>
        </div>

        <aside className="arch-detail panel" aria-live="polite">
          <div className="eyebrow">{detail.eyebrow}</div>
          <h3>{detail.title}</h3>
          <p>{detail.body}</p>
          <ul className="detail-list">{detail.bullets.map((bullet) => <li key={bullet}><CheckCircle2 size={15} aria-hidden="true" />{bullet}</li>)}</ul>
          {selected === "vault" && (
            <div className="detail-values">
              <div><span>Live per-tx cap</span><strong>{status?.policy ? `${cap} SFUSD` : "Unavailable"}</strong></div>
              <div><span>Live window cap</span><strong>{status?.policy ? `${windowCap} SFUSD` : "Unavailable"}</strong></div>
            </div>
          )}
          {selected === "owner" && <div className="detail-note">Owner commands run on the owner machine: <span className="mono">npx tsx cli/spendfloor.ts owner …</span></div>}
        </aside>
      </div>

      <section className="panel callout-panel">
        <div className="callout-mark"><Shield size={22} aria-hidden="true" /></div>
        <div><h2>The relay is not the security boundary. The vault is.</h2><p>The relay forwards signed intents and pays transaction fees. It does not replace the on-chain policy checks. The vault independently validates each spending intent against its enforced policy — recipient, caps, expiry and freeze state — on the chain where funds move.</p></div>
      </section>
      <p className="muted small">The two chains have separate implementations and separate allowances. A confirmed transaction on one chain is not evidence about the other chain.</p>
    </div>
  );
}
