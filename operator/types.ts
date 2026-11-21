// Shared operator/UI contract. These are transport types only: no policy
// enforcement logic lives in the frontend or in this file.

export type Freshness = "Live" | "Historical" | "Local" | "Simulated" | "Unavailable";
export type ChainKey = "evm" | "sol";
export type VerificationState = "verified" | "partial" | "unavailable" | "failed";

export interface PolicyValues {
  version: number;
  decimals: number;
  perTxMax: string; // micro-units, decimal string
  windowMax: string;
  windowSeconds: string;
  windowAnchor: string;
  expiresAt: string;
  frozen: boolean;
  recipientCount: number;
  recipients: string[];
}

export interface ChainPolicyView {
  chain: ChainKey;
  name: string;
  state: VerificationState;
  source: Freshness;
  observedAt: string;
  identifier: string;
  identifierLabel: string;
  explorerUrl: string;
  policy: PolicyValues | null;
  computedFingerprint: string | null;
  storedFingerprint: string | null;
  fingerprintMatchesStored: boolean | null;
  expiryState: "active" | "expired" | "never" | "unknown";
  error: string | null;
}

export interface SystemStatus {
  generatedAt: string;
  environment: "TESTNET DEMO";
  mode: "testnet" | "local";
  protection: VerificationState;
  demoEnabled: boolean;
  prerequisites: {
    agentKeys: boolean;
    submitterKeys: boolean;
    ownerKeysHere: boolean;
    ollama: boolean;
    foundry: boolean;
    ollamaCheckedAt: string;
  };
  chains: Record<ChainKey, ChainPolicyView>;
  canonical: {
    fingerprint: string | null;
    method: "SHA-256";
    source: Freshness;
    observation: "freshly computed from live chain reads" | "unavailable";
    comparison: "matched" | "mismatched" | "not-performed";
    comparedAt: string | null;
    detail: string;
  };
  policy: PolicyValues | null;
  policySource: Freshness;
  recipientAuthorization: {
    scenario: "attack-recipient" | "legit-payment";
    chain: ChainKey;
    address: string;
    authorized: boolean | null;
    basis: string;
  }[];
  note: string;
}

export type ExecutionState =
  | "not_started"
  | "processing"
  | "signed"
  | "submitted"
  | "confirmed"
  | "rejected"
  | "failed"
  | "timed_out"
  | "unknown";

export interface ChainExecution {
  state: ExecutionState;
  label: string | null;
  hash: string | null;
  digest: string | null;
  signedAmountMicro: string | null;
  observedAt: string | null;
  explorerUrl: string | null;
  raw: string | null;
  note: string | null;
}

export interface FlowStep {
  key: "agent" | "sign" | "relay" | "result";
  state: ExecutionState;
  at: string | null;
  detail: string;
}

export interface DemoRun {
  id: string;
  scenario: "attack-recipient" | "legit-payment";
  mode: "testnet" | "local";
  instruction: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: "rejected" | "accepted" | "no_action" | "unknown" | "failed" | "timed_out";
  freshness: Freshness;
  steps: FlowStep[];
  chains: Record<ChainKey, ChainExecution>;
  securityOutcome: "attack_blocked" | "inconclusive" | "not_applicable";
  agentRaw: string | null;
  events: { type: string; at: string; [key: string]: unknown }[];
  error: string | null;
}

export interface HistoricalRecord {
  id: string;
  scenario: "attack-recipient" | "legit-payment";
  title: string;
  date: string;
  networkLabel: string;
  freshness: "Historical";
  source: string;
  amountSfusd: number;
  target: string;
  chains: Partial<Record<ChainKey, ChainExecution>>;
  note: string;
}
