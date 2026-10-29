// submitter (T19 relay).
//
// The relay is the SUBMITTER service: it holds the submitter key (pays
// gas) and broadcasts spends the agent signed. It holds NO agent key,
// enforces NO policy (no caps, recipients, frozen, window checks — the
// vault does that on-chain), and forwards ONLY through the vault (never
// a direct token transfer, no shortcut around the vault).
//
// Its only guards are DoS guards: a rate limit + a float budget.
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
// (the SDK's SpendResult). A submit that never broadcasts returns
// SubmitFailed with no hash; a relay that is off throws before any
// broadcast (fails closed, no gas spent).

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
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
  SOL_ERROR_CODES,
  type SpendLabel,
  type SpendResult,
} from "../sdk/errors.js";
import {
  submitEvmSpend,
  type SignedEvmIntent,
} from "../sdk/evm.js";

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
  private perAgent = new Map<string, number[]>();
  private global: number[] = [];
  constructor(private cfg: RelayConfig) {}
  /** Throws if the agent or the global limit is hit. */
  check(agentId: string): void {
    const now = Date.now();
    const cutoff = now - 60_000;
    const recent = (this.perAgent.get(agentId) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.cfg.maxPerMinutePerAgent) {
      throw new Error(
        `rate limit: agent ${agentId} exceeded ${this.cfg.maxPerMinutePerAgent}/min`,
      );
    }
    const globalRecent = this.global.filter((t) => t > cutoff);
    if (globalRecent.length >= this.cfg.maxPerMinuteGlobal) {
      throw new Error(
        `rate limit: global ${this.cfg.maxPerMinuteGlobal}/min exceeded`,
      );
    }
    recent.push(now);
    this.perAgent.set(agentId, recent);
    globalRecent.push(now);
    this.global = globalRecent;
  }
}

function labelFromSolErr(err: unknown, logs: string[]): SpendLabel {
  const e = err as { InstructionError?: [number, { Custom?: number }] };
  const custom = e?.InstructionError?.[1]?.Custom;
  if (typeof custom === "number" && SOL_ERROR_CODES[custom]) {
    return SOL_ERROR_CODES[custom];
  }
  for (const line of logs) {
    const m = line.match(/Custom program error: 0x([0-9a-f]+)/);
    if (m) {
      const code = parseInt(m[1], 16);
      if (SOL_ERROR_CODES[code]) return SOL_ERROR_CODES[code];
    }
    const n = line.match(/Error Code: (\w+)/);
    if (n && (Object.values(SOL_ERROR_CODES) as string[]).includes(n[1])) {
      return n[1] as SpendLabel;
    }
  }
  return "SubmitFailed";
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
  ) {
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
  private requireRunning(): void {
    if (!this.started) throw new Error("relay is off (fails closed)");
  }
  private async checkEvmFloat(): Promise<void> {
    const addr = this.evmSubmitter.account?.address;
    if (!addr) throw new Error("relay submitter account missing");
    const bal = await this.evmPublic.getBalance({ address: addr });
    if (bal < this.cfg.minFloatWei) {
      throw new Error(
        `relay float exhausted: submitter balance ${bal} below minimum ${this.cfg.minFloatWei}`,
      );
    }
    const gasPrice = await this.evmPublic.getGasPrice();
    if (300_000n * gasPrice > this.cfg.maxGasPerSpendWei) {
      throw new Error("relay gas budget exceeded for this spend");
    }
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
    await this.checkEvmFloat();
    return submitEvmSpend(this.evmPublic, this.evmSubmitter, vault, signed);
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
    await this.checkSolFloat();
    const tx = Transaction.from(partialTx);
    tx.sign(this.solSubmitter);
    let signature: string;
    try {
      signature = await this.solConnection.sendRawTransaction(
        tx.serialize(),
        { skipPreflight: true },
      );
    } catch (err) {
      return {
        ok: false,
        label: "SubmitFailed",
        raw: err instanceof Error ? err.message : String(err),
      };
    }
    for (let i = 0; i < 60; i++) {
      const st = await this.solConnection.getSignatureStatus(signature);
      const s = st.value;
      if (s && s.err) {
        const logs = await this.solConnection
          .getTransaction(signature, { commitment: "confirmed" })
          .then((t) => t?.meta?.logMessages ?? [])
          .catch(() => []);
        return {
          ok: false,
          label: labelFromSolErr(s.err, logs),
          hash: signature,
        };
      }
      if (s && s.confirmationStatus && s.confirmationStatus !== "processed") {
        return { ok: true, hash: signature };
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return { ok: false, label: "Timeout", hash: signature };
  }
}

/** Convenience: build a Relay for Anvil (localnet) or Base Sepolia. */
export function createRelay(
  cfg: RelayConfig,
  evmSubmitter: WalletClient,
  solSubmitter: Keypair,
  opts: { localnet?: boolean; solRpc?: string } = {},
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
    opts.solRpc ?? "https://api.devnet.solana.com",
    "confirmed",
  );
  return new Relay(cfg, evmPublic, evmSubmitter, solConnection, solSubmitter);
}
