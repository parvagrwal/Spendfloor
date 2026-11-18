// submitter (T19 relay).
//
// The relay is the SUBMITTER service: it holds the submitter key (pays
// gas) and broadcasts spends the agent signed. It holds NO agent key,
// enforces NO policy (no caps, recipients, frozen, window checks — the
// vault does that on-chain), and forwards ONLY through the vault (never
// a direct token transfer, no shortcut around the vault).
//
// Admission binds the intended vault and the scope of the fee signature.
// Rate and float checks limit abuse; they do not authorize token movement.
// Worst-case exposure, printed beside the limit: at the default rate
// limit (10 spends/minute per agent), a spammer can waste at most 10
// reverted-transaction gas fees per minute, and the relay stops entirely
// when its float budget is exhausted. The vault still rejects
// forged/over-policy spends, so no vault funds move.
// Residual risk (bypass vector G1, documented, not hidden): the relay
// can be griefed to drain its float (validly-signed but policy-rejected
// spends, or forged intents that revert on-chain). Bounded by the rate
// limit + the float cap. The relay is a liveness dependency, not a
// safety dependency: if it is off, the agent cannot spend (fails
// closed); if it is on, it cannot steal (it has no agent key, and the
// vault enforces policy).
//
// Every submit returns a machine-generated receipt: { ok, hash, label }
// (the SDK's SpendResult). An uncertain Solana broadcast keeps its signature;
// a relay that is off throws before any
// broadcast (fails closed, no gas spent).

import {
  Connection,
  Keypair,
  PublicKey,

} from "@solana/web3.js";
import {
  createPublicClient,
  http,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
} from "viem";
import { baseSepolia, foundry } from "viem/chains";
import {

  type SpendResult,
} from "../sdk/errors.js";
import {
  DEFAULT_GAS, submitEvmSpend,
  type SignedEvmIntent,
} from "../sdk/evm.js";

import { checkedEnvelope, type SponsoredSolVault } from "./envelope.js";
import { broadcastSignedSol } from "../sdk/sol.js";
import evmDeployment from "../deployments/base-sepolia.json" with { type: "json" };
import solDeployment from "../deployments/solana-devnet.json" with { type: "json" };

interface Targets { evmVaults?: readonly Address[]; solVault?: SponsoredSolVault }
export interface RelayConfig {
  /** Max submits per rolling 60 s window, per agent id. */
  maxPerMinutePerAgent: number;
  /** Max submits per rolling 60 s window, across all agents. */
  maxPerMinuteGlobal: number;
  /** EVM: refuse if the submitter balance is below this (wei). */
  minFloatWei: bigint;
  /** EVM: refuse if gas * gasPrice exceeds this (wei). */
  maxGasPerSpendWei: bigint;
  /** Solana: refuse if the submitter balance is below this (lamports). */
  minFloatLamports: bigint;
}

export const DEFAULT_RELAY_CONFIG: RelayConfig = {
  maxPerMinutePerAgent: 10,
  maxPerMinuteGlobal: 100,
  minFloatWei: 1_000_000_000_000_000n, // 0.001 ETH
  maxGasPerSpendWei: 50_000_000_000_000_000n, // 0.05 ETH (a vault spend is ~0.001 ETH at normal gas; the cap refuses absurd gas prices, not normal spends)
  minFloatLamports: 10_000_000n, // 0.01 SOL
};

/** Sliding-window rate limiter (in-memory; per-agent + global). */
export class RateLimiter {
  private recent: {id: string; time: number}[] = [];
  constructor(private cfg: RelayConfig, private now = () => performance.now()) {
    for (const limit of [cfg.maxPerMinuteGlobal, cfg.maxPerMinutePerAgent]) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("invalid rate limit");
    }
  }
  check(agentId: string): void {
    const time = this.now();
    this.recent = this.recent.filter(entry => entry.time > time - 60_000);
    if (this.recent.length >= this.cfg.maxPerMinuteGlobal) throw new Error("rate limit: global");
    if (this.recent.filter(entry => entry.id === agentId).length >= this.cfg.maxPerMinutePerAgent) throw new Error("rate limit: agent");
    this.recent.push({id: agentId, time});
  }
}

export class Relay {
  private started = false;
  private limiter: RateLimiter;
  constructor(
    private cfg: RelayConfig,
    private evmPublic: PublicClient,
    private evmSubmitter: WalletClient,
    private solConnection: Connection,
    private solSubmitter: Keypair,
    private targets: Targets = {},
  ) {
    if (cfg.minFloatLamports < 0n || cfg.minFloatWei < 0n || cfg.maxGasPerSpendWei <= 0n) throw new Error("invalid relay budget");
    this.limiter = new RateLimiter(cfg);
  }
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.started = false;
  }
  isRunning(): boolean {
    return this.started;
  }
  /** The submitter's EVM address (fee payer). */
  evmSubmitterAddress(): Address | undefined {
    return this.evmSubmitter.account?.address;
  }
  /** The submitter's Solana public key (fee payer). */
  solSubmitterAddress(): PublicKey {
    return this.solSubmitter.publicKey;
  }
  private requireRunning(): void {
    if (!this.started) throw new Error("relay is off (fails closed)");
  }
  private async checkEvmFloat(): Promise<bigint> {
    const addr = this.evmSubmitter.account?.address;
    if (!addr) throw new Error("relay submitter account missing");
    const bal = await this.evmPublic.getBalance({ address: addr });
    if (bal < this.cfg.minFloatWei) {
      throw new Error(
        `relay float exhausted: submitter balance ${bal} below minimum ${this.cfg.minFloatWei}`,
      );
    }
    const gasPrice = await this.evmPublic.getGasPrice();
    if (DEFAULT_GAS * gasPrice > this.cfg.maxGasPerSpendWei) {
      throw new Error("relay gas budget exceeded for this spend");
    }
    return gasPrice;
  }
  private async checkSolFloat(): Promise<void> {
    const bal = await this.solConnection.getBalance(this.solSubmitter.publicKey);
    if (BigInt(bal) < this.cfg.minFloatLamports) {
      throw new Error(
        `relay float exhausted: submitter balance ${bal} below minimum ${this.cfg.minFloatLamports}`,
      );
    }
  }

  /**
   * Broadcast an agent-signed EVM intent through the vault. The relay
   * does NOT check the policy; the vault returns the label + hash.
   */
  async submitEvm(
    agentId: string,
    vault: Address,
    signed: SignedEvmIntent,
  ): Promise<SpendResult> {
    this.requireRunning();
    this.limiter.check(agentId);
    if (!this.targets.evmVaults?.some(v => v.toLowerCase() === vault.toLowerCase())) throw new Error("unconfigured EVM vault");
    const gasPrice = await this.checkEvmFloat();
    this.requireRunning();
    return submitEvmSpend(this.evmPublic, this.evmSubmitter, vault, signed, {gasPrice});
  }

  /**
   * Broadcast an agent-signed Solana transaction through the vault.
   * The agent signs first (partial signature); the relay adds the
   * submitter (fee payer) signature and broadcasts. The relay does NOT
   * check the policy; the vault returns the label + signature.
   */
  async submitSol(
    agentId: string,
    partialTx: Uint8Array,
  ): Promise<SpendResult> {
    this.requireRunning();
    this.limiter.check(agentId);
    if (!this.targets.solVault) throw new Error("unconfigured Solana vault");
    const tx = checkedEnvelope(partialTx, this.solSubmitter.publicKey, this.targets.solVault, agentId);
    await this.checkSolFloat();
    this.requireRunning();
    tx.partialSign(this.solSubmitter);
    return broadcastSignedSol(this.solConnection, tx);
  }
}

/** Convenience: build a Relay for Anvil (localnet) or Base Sepolia. */
export function createRelay(
  cfg: RelayConfig,
  evmSubmitter: WalletClient,
  solSubmitter: Keypair,
  opts: { localnet?: boolean; solRpc?: string; targets?: Targets } = {},
): Relay {
  const chain = opts.localnet ? foundry : baseSepolia;
  const rpc = opts.localnet
    ? "http://127.0.0.1:8545"
    : "https://sepolia.base.org";
  const evmPublic = createPublicClient({
    chain,
    transport: http(rpc),
  }) as PublicClient;
  const solConnection = new Connection(
    opts.solRpc ?? (opts.localnet ? "http://127.0.0.1:8899" : "https://api.devnet.solana.com"),
    "confirmed",
  );
  return new Relay(cfg, evmPublic, evmSubmitter, solConnection, solSubmitter, opts.targets ?? (opts.localnet ? {} : {
    evmVaults: Object.values(evmDeployment.vaults).map(v => v.address as Address),
    solVault: {program: new PublicKey(solDeployment.program), agent: new PublicKey(solDeployment.agent), vaultToken: new PublicKey(solDeployment.vaultTokenAccount)},
  }));
}
