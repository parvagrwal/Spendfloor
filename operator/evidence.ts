// Historical evidence adapter. Every record here is read from committed
// evidence files and is labelled with its own date and source. Nothing in
// this module is presented as a live transaction or current verification.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, SCENARIOS, txUrl } from "./config.js";
import type { ChainExecution, ChainKey, HistoricalRecord } from "./types.js";

interface T27File {
  date: string;
  runs: {
    run: number;
    seconds: number;
    evm: { ok: boolean; label: string; hash: string; digest: string };
    sol: { ok: boolean; label: string; sig: string; digest: string };
    fidelityMatch: boolean;
  }[];
  legit: {
    seconds: number;
    evm: { ok: boolean; label: string; hash: string; digest: string };
    sol: unknown;
    note: string;
  };
}

function historicalChain(chain: ChainKey, ok: boolean, label: string, id: string, digest: string): ChainExecution {
  const hashed = id || null;
  return {
    state: ok ? "confirmed" : label ? "rejected" : "unknown",
    label: label || null,
    hash: hashed,
    digest: digest || null,
    signedAmountMicro: null,
    observedAt: null,
    explorerUrl: hashed ? txUrl(chain, hashed) : null,
    raw: null,
    note: ok ? "Recorded successful receipt" : `Recorded on-chain revert: ${label}`,
  };
}

function t27Records(): HistoricalRecord[] {
  const path = "evidence/T27/rehearsal-2026-10-30.json";
  const data = JSON.parse(readFileSync(join(REPO_ROOT, path), "utf8")) as T27File;
  return data.runs.map((run) => ({
    id: `t27-attack-${run.run}`,
    scenario: "attack-recipient" as const,
    title: `Attack attempt · Rejected · rehearsal run ${run.run}`,
    date: data.date,
    networkLabel: "Testnet · Base Sepolia + Solana devnet",
    freshness: "Historical" as const,
    source: `${path} (run ${run.run})`,
    amountSfusd: 50,
    target: "Unauthorized attacker address",
    chains: {
      evm: historicalChain("evm", run.evm.ok, run.evm.label, run.evm.hash, run.evm.digest),
      sol: historicalChain("sol", run.sol.ok, run.sol.label, run.sol.sig, run.sol.digest),
    },
    note: `Recorded duration ${run.seconds}s; amount fidelity match: ${run.fidelityMatch}. Historical evidence only.`,
  }));
}

function t26LegitRecords(): HistoricalRecord[] {
  const path = "evidence/T26/demo-localnet-merchant-2026-10-30-r2.txt";
  const text = readFileSync(join(REPO_ROOT, path), "utf8");
  const evmLine = text.split("\n").find((l) => l.startsWith("EVM pay: ok=")) ?? "";
  const solLine = text.split("\n").find((l) => l.startsWith("SOL pay: ok=")) ?? "";
  const evm = /ok=(\w+) label=(\S*) hash=(\S*) digest=(\S*)/.exec(evmLine);
  const sol = /ok=(\w+) label=(\S*) sig=(\S*) digest=(\S*)/.exec(solLine);
  const date = /2026-\d\d-\d\d/.exec(path)?.[0] ?? "2026-10-30";
  if (!evm || !sol) return [];
  return [{
    id: "t26-legit-localnet-r2",
    scenario: "legit-payment",
    title: "Legitimate payment · Accepted · localnet control",
    date,
    networkLabel: "Localnet · Anvil + Surfpool (NOT testnet)",
    freshness: "Historical",
    source: path,
    amountSfusd: 1,
    target: "Approved local merchant",
    chains: {
      evm: historicalChain("evm", evm[1] === "true", evm[2], evm[3], evm[4]),
      sol: historicalChain("sol", sol[1] === "true", sol[2], sol[3], sol[4]),
    },
    note: "Recorded from a disposable localnet run. Local addresses differ from the testnet deployment; this is not a Base Sepolia or devnet payment.",
  }];
}

export function getHistoricalRecords(): HistoricalRecord[] {
  return [...t27Records(), ...t26LegitRecords()];
}

export const HISTORICAL_PROVENANCE = {
  policyHash: "0xf36d290ed7e1cc23af0ea7f08ae4f3ee0b1bcfead65e4a4744c76c70a7f5b820",
  policyHashDate: "2026-10-30",
  policyHashSource: "docs/HONEST_MATRIX.md (T25 final verify snapshot)",
  verify: "Historical VERIFY GREEN 15/15 on 2026-10-30 (evidence/T18, T25)",
  verifyCaveat: "That run had SOL RPC2 == RPC1, so Solana reads were not independently re-provider checked. It is not a current attestation.",
  rejections: "Five recorded testnet injection runs, all RecipientNotAllowed on both chains (evidence/T27, 2026-10-30).",
  demoDefaults: "2 SFUSD per tx / 5 SFUSD per 24 h window / merchant-only recipients (deployments/*.json, 2026-10-30)",
  scenarioLabels: {
    "attack-recipient": SCENARIOS["attack-recipient"].label,
    "legit-payment": SCENARIOS["legit-payment"].label,
  },
};
