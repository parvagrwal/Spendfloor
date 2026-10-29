// T15 SDK tests: run against Anvil (EVM) and solana-test-validator
// (Solana). The plan names Surfpool for the Solana side; it is not
// installed here, so solana-test-validator stands in: it is the
// standard local Solana chain and proves the same thing (the SDK
// talks to a local Solana RPC, deploys, spends, reads state).
//
// Run: npx tsx --test sdk/test/sdk.test.ts
// The test spawns Anvil + the validator when their ports are free and
// kills them afterwards; if a chain is already running on the port it
// is reused and left alone. The Solana tests skip when the program .so
// is missing (build it with cargo build-sbf first).

import assert from "node:assert/strict";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import {
  TOKEN_PROGRAM_ID,
  SOL_ERROR_CODES,
  buildSpendInstruction,
  discriminator,
  parsePolicyAccount,
  policyPda,
  readEvmPolicy,
  readSolPolicy,
  signEvmIntent,
  submitEvmSpend,
  submitSolSpend,
  type EvmPolicyState,
} from "../index.js";

const EVM_RPC = "http://127.0.0.1:8545";
const SOL_RPC = "http://127.0.0.1:8899";
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
const RENT_SYSVAR = new PublicKey("SysvarRent111111111111111111111111111111111");
const MINT_LEN = 82;
const TOKEN_ACCOUNT_LEN = 165;
const DUMMY_SOL_SET_HASH = ("0x" + "11".repeat(32)) as Hash;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function homeBin(name: string, homePath: string): string {
  return existsSync(homePath) ? homePath : name;
}

async function rpcUp(url: string, body: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForRpc(url: string, body: Record<string, unknown>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await rpcUp(url, body)) return;
    await sleep(1000);
  }
  throw new Error(`RPC did not come up: ${url}`);
}

// --- Shared state ---
let anvilProc: ChildProcess | null = null;
let validatorProc: ChildProcess | null = null;
let validatorLedger = "";
let evmReady = false;
let solReady = false;

// EVM
let evmPublic: PublicClient;
let evmOwner: WalletClient;
let evmAgent: ReturnType<typeof mnemonicToAccount>;
let evmSubmitter: WalletClient;
let evmMerchant: Address;
let evmAttacker: Address;
let evmVault: Address;
let evmToken: Address;

// Solana
let solConnection: Connection;
let solProgramId: PublicKey;
let solOwner: Keypair;
let solAgent: Keypair;
let solSubmitter: Keypair;
let solMerchant: Keypair;
let solAttacker: Keypair;
let solPolicy: PublicKey;
let solMint: PublicKey;
let solVaultToken: PublicKey;
let solMerchantToken: PublicKey;
let solAttackerToken: PublicKey;

before(async () => {
  // --- Start chains (reuse if already running). A chain that fails to
  // start does not abort the whole run: its tests fail/skip on their
  // own flag, so the other chain's tests still run. (solana-test-
  // validator cannot run on this VM: it panics on io_uring, which the
  // VM does not support. Surfpool is the plan's local Solana chain.)
  const anvilBin = homeBin("anvil", `${process.env.HOME}/.foundry/bin/anvil`);
  try {
    if (!(await rpcUp(EVM_RPC, { method: "eth_chainId", params: [] }))) {
      anvilProc = spawn(anvilBin, ["--port", "8545"], { stdio: "ignore" });
      await waitForRpc(EVM_RPC, { method: "eth_chainId", params: [] }, 30_000);
    }
    evmReady = true;
  } catch (err) {
    console.log(`Anvil unavailable, EVM tests will fail: ${err instanceof Error ? err.message : String(err)}`);
  }
  const validatorBin = homeBin(
    "solana-test-validator",
    `${process.env.HOME}/.local/share/solana/install/active_release/bin/solana-test-validator`,
  );
  try {
    if (!(await rpcUp(SOL_RPC, { method: "getHealth", params: [] }))) {
      validatorLedger = mkdtempSync(join(tmpdir(), "spendfloor-validator-"));
      validatorProc = spawn(
        validatorBin,
        ["--rpc-port", "8899", "--ledger", join(validatorLedger, "ledger"), "--reset", "--quiet"],
        { stdio: "ignore" },
      );
      await waitForRpc(SOL_RPC, { method: "getHealth", params: [] }, 30_000);
    }
    solReady = true;
  } catch (err) {
    console.log(`Solana validator unavailable, Solana tests will skip: ${err instanceof Error ? err.message : String(err)}`);
    solReady = false;
  }
  if (!evmReady) return;

  // --- EVM setup: build, deploy SFUSD + vault, mint to vault ---
  const evmDir = new URL("../../evm/", import.meta.url).pathname;
  const forgeBin = homeBin("forge", `${process.env.HOME}/.foundry/bin/forge`);
  execSync(`${forgeBin} build`, { cwd: evmDir, stdio: "ignore" });
  const vaultArtifact = JSON.parse(
    readFileSync(join(evmDir, "out/SpendFloorVault.sol/SpendFloorVault.json"), "utf8"),
  );
  const tokenArtifact = JSON.parse(readFileSync(join(evmDir, "out/SFUSD.sol/SFUSD.json"), "utf8"));
  evmPublic = createPublicClient({ chain: foundry, transport: http(EVM_RPC) });
  const ownerAcc = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 0 });
  evmAgent = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 1 });
  const submitterAcc = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 2 });
  evmMerchant = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 3 }).address;
  evmAttacker = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 4 }).address;
  evmOwner = createWalletClient({ account: ownerAcc, chain: foundry, transport: http(EVM_RPC) });
  evmSubmitter = createWalletClient({ account: submitterAcc, chain: foundry, transport: http(EVM_RPC) });
  const chainId = await evmPublic.getChainId();
  assert.equal(chainId, 31337, "Anvil chain id must be 31337");
  evmToken = await evmOwner.deployContract({
    account: ownerAcc,
    chain: foundry,
    abi: tokenArtifact.abi as Abi,
    bytecode: tokenArtifact.bytecode.object as Hash,
  });
  const tokenReceipt = await evmPublic.waitForTransactionReceipt({ hash: evmToken });
  evmToken = tokenReceipt.contractAddress!;
  const anchor = 0n;
  const expiry = 0n;
  const vaultHash = await evmOwner.deployContract({
    account: ownerAcc,
    chain: foundry,
    abi: vaultArtifact.abi as Abi,
    bytecode: vaultArtifact.bytecode.object as Hash,
    args: [
      evmToken,
      evmAgent.address,
      1,
      6,
      2_000_000n,
      5_000_000n,
      86400n,
      anchor,
      expiry,
      [evmMerchant],
      DUMMY_SOL_SET_HASH,
    ],
  });
  const vaultReceipt = await evmPublic.waitForTransactionReceipt({ hash: vaultHash });
  evmVault = vaultReceipt.contractAddress!;
  // Owner mints 10 SFUSD (6 decimals) to the vault.
  const mintHash = await evmOwner.writeContract({
    account: ownerAcc,
    chain: foundry,
    address: evmToken,
    abi: tokenArtifact.abi as Abi,
    functionName: "mint",
    args: [evmVault, 10_000_000n],
  });
  await evmPublic.waitForTransactionReceipt({ hash: mintHash });

  // --- Solana setup (skip when the chain or the .so is missing) ---
  if (!solReady) {
    console.log("Solana tests skipped: local validator unavailable.");
    return;
  }
  const soPath = new URL("../../solana/target/deploy/spendfloor.so", import.meta.url).pathname;
  if (!existsSync(soPath)) {
    console.log("Solana tests skipped: program .so missing, run cargo build-sbf first.");
    solReady = false;
    return;
  }
  solConnection = new Connection(SOL_RPC, "confirmed");
  solOwner = Keypair.generate();
  solAgent = Keypair.generate();
  solSubmitter = Keypair.generate();
  solMerchant = Keypair.generate();
  solAttacker = Keypair.generate();
  const solanaBin = homeBin(
    "solana",
    `${process.env.HOME}/.local/share/solana/install/active_release/bin/solana`,
  );
  const tmp = mkdtempSync(join(tmpdir(), "spendfloor-sol-"));
  const payerFile = join(tmp, "payer.json");
  const progFile = join(tmp, "prog.json");
  writeFileSync(payerFile, JSON.stringify(Array.from(solOwner.secretKey)));
  const progKp = Keypair.generate();
  writeFileSync(progFile, JSON.stringify(Array.from(progKp.secretKey)));
  solProgramId = progKp.publicKey;
  // Fund the payer via the local faucet, then deploy with the CLI.
  await solConnection.requestAirdrop(solOwner.publicKey, 10 * LAMPORTS_PER_SOL);
  for (let i = 0; i < 30; i++) {
    const bal = await solConnection.getBalance(solOwner.publicKey);
    if (bal >= 10 * LAMPORTS_PER_SOL) break;
    await sleep(1000);
  }
  execSync(
    `${solanaBin} program deploy --url ${SOL_RPC} --keypair ${payerFile} --program-id ${progFile} ${soPath}`,
    { stdio: "ignore" },
  );
  const progInfo = await solConnection.getAccountInfo(solProgramId);
  assert.ok(progInfo, "program deploy failed");
  [solPolicy] = policyPda(solProgramId);

  // Create mint (authority = owner, decimals 6).
  const mintKp = Keypair.generate();
  solMint = mintKp.publicKey;
  const mintRent = await solConnection.getMinimumBalanceForRentExemption(MINT_LEN);
  const mintTx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: solOwner.publicKey,
      newAccountPubkey: solMint,
      lamports: mintRent,
      space: MINT_LEN,
      programId: TOKEN_PROGRAM_ID,
    }),
    new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: solMint, isSigner: false, isWritable: true },
        { pubkey: RENT_SYSVAR, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([Buffer.from([0, 6]), solOwner.publicKey.toBuffer(), Buffer.from([0])]),
    }),
  );
  await solConnection.sendTransaction(mintTx, [solOwner, mintKp]);

  // Init policy now that the mint exists.
  const u32le = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v, 0);
    return b;
  };
  const u64le = (v: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(v, 0);
    return b;
  };
  const i64le = (v: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(v, 0);
    return b;
  };
  const initIx = new TransactionInstruction({
    programId: solProgramId,
    keys: [
      { pubkey: solOwner.publicKey, isSigner: true, isWritable: true },
      { pubkey: solPolicy, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      discriminator("initialize"),
      u32le(1),
      Buffer.from([6]),
      solAgent.publicKey.toBuffer(),
      u64le(2_000_000n),
      u64le(5_000_000n),
      u64le(86400n),
      i64le(0n),
      i64le(0n),
      u32le(1),
      solMerchant.publicKey.toBuffer(),
      Buffer.alloc(32, 0x22),
      solMint.toBuffer(),
    ]),
  });
  await solConnection.sendTransaction(new Transaction().add(initIx), [solOwner]);

  // Token accounts: vault (owner = policy PDA), merchant, attacker.
  async function createTokenAccount(owner: PublicKey): Promise<PublicKey> {
    const kp = Keypair.generate();
    const rent = await solConnection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_LEN);
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: solOwner.publicKey,
        newAccountPubkey: kp.publicKey,
        lamports: rent,
        space: TOKEN_ACCOUNT_LEN,
        programId: TOKEN_PROGRAM_ID,
      }),
      new TransactionInstruction({
        programId: TOKEN_PROGRAM_ID,
        keys: [
          { pubkey: kp.publicKey, isSigner: false, isWritable: true },
          { pubkey: solMint, isSigner: false, isWritable: false },
          { pubkey: owner, isSigner: false, isWritable: false },
          { pubkey: RENT_SYSVAR, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([1]),
      }),
    );
    await solConnection.sendTransaction(tx, [solOwner, kp]);
    return kp.publicKey;
  }
  solVaultToken = await createTokenAccount(solPolicy);
  solMerchantToken = await createTokenAccount(solMerchant.publicKey);
  solAttackerToken = await createTokenAccount(solAttacker.publicKey);
  // Mint 10 SFUSD to the vault token account.
  const mintAmount = Buffer.alloc(8);
  mintAmount.writeBigUInt64LE(10_000_000n, 0);
  const mintToTx = new Transaction().add(
    new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: solMint, isSigner: false, isWritable: true },
        { pubkey: solVaultToken, isSigner: false, isWritable: true },
        { pubkey: solOwner.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.concat([Buffer.from([7]), mintAmount]),
    }),
  );
  await solConnection.sendTransaction(mintToTx, [solOwner]);
  // Fund the submitter for fees.
  await solConnection.requestAirdrop(solSubmitter.publicKey, 2 * LAMPORTS_PER_SOL);
  for (let i = 0; i < 30; i++) {
    const bal = await solConnection.getBalance(solSubmitter.publicKey);
    if (bal >= LAMPORTS_PER_SOL) break;
    await sleep(1000);
  }
});

after(() => {
  anvilProc?.kill();
  validatorProc?.kill();
});

test("evm: valid spend lands and updates state", async () => {
  assert.equal(evmReady, true, "Anvil not available");
  const state: EvmPolicyState = await readEvmPolicy(evmPublic, evmVault);
  const block = await evmPublic.getBlock({ blockTag: "latest" });
  const signed = await signEvmIntent(evmAgent, 31337, evmVault, {
    to: evmMerchant,
    amount: 1_000_000n,
    nonce: state.nonce,
    deadline: block.timestamp + 300n,
  });
  const res = await submitEvmSpend(evmPublic, evmSubmitter, evmVault, signed);
  assert.equal(res.ok, true, `valid spend failed: ${res.label} ${res.raw ?? ""}`);
  assert.ok(res.hash, "valid spend must return a hash");
  const afterState = await readEvmPolicy(evmPublic, evmVault);
  assert.equal(afterState.spentInWindow, 1_000_000n);
  assert.equal(afterState.nonce, state.nonce + 1n);
});

test("evm: non-recipient spend lands as RecipientNotAllowed with a hash", async () => {
  assert.equal(evmReady, true, "Anvil not available");
  const state = await readEvmPolicy(evmPublic, evmVault);
  const block = await evmPublic.getBlock({ blockTag: "latest" });
  const signed = await signEvmIntent(evmAgent, 31337, evmVault, {
    to: evmAttacker,
    amount: 1_000_000n,
    nonce: state.nonce,
    deadline: block.timestamp + 300n,
  });
  const res = await submitEvmSpend(evmPublic, evmSubmitter, evmVault, signed);
  assert.equal(res.ok, false);
  assert.equal(res.label, "RecipientNotAllowed");
  assert.ok(res.hash, "failed spend must return a hash");
  const afterState = await readEvmPolicy(evmPublic, evmVault);
  assert.equal(afterState.spentInWindow, state.spentInWindow, "rejected spend must not change spent");
  assert.equal(afterState.nonce, state.nonce, "rejected spend must not change nonce");
});

test("evm: read state matches the deployed policy", async () => {
  assert.equal(evmReady, true, "Anvil not available");
  const state = await readEvmPolicy(evmPublic, evmVault);
  assert.equal(state.perTxMax, 2_000_000n);
  assert.equal(state.windowMax, 5_000_000n);
  assert.equal(state.agent, evmAgent.address);
  assert.equal(state.frozen, false);
  assert.notEqual(state.policyHash, "0x" + "00".repeat(32));
});

test("sol: valid spend lands and updates state", async (t) => {
  if (!solReady) {
    t.skip("program .so missing");
    return;
  }
  const beforeState = await readSolPolicy(solConnection, solProgramId);
  const res = await submitSolSpend(
    solConnection, solProgramId, solPolicy, solVaultToken, solMerchantToken,
    solAgent, solSubmitter, 1_000_000n,
  );
  assert.equal(res.ok, true, `valid spend failed: ${res.label} ${res.raw ?? ""}`);
  assert.ok(res.hash, "valid spend must return a signature");
  const afterState = await readSolPolicy(solConnection, solProgramId);
  assert.equal(afterState.spent, beforeState.spent + 1_000_000n);
  const vaultBal = await solConnection.getTokenAccountBalance(solVaultToken);
  assert.equal(vaultBal.value.amount, "9000000");
});

test("sol: non-recipient spend lands as RecipientNotAllowed with a signature", async (t) => {
  if (!solReady) {
    t.skip("program .so missing");
    return;
  }
  const beforeState = await readSolPolicy(solConnection, solProgramId);
  const res = await submitSolSpend(
    solConnection, solProgramId, solPolicy, solVaultToken, solAttackerToken,
    solAgent, solSubmitter, 1_000_000n,
  );
  assert.equal(res.ok, false);
  assert.equal(res.label, "RecipientNotAllowed");
  assert.ok(res.hash, "failed spend must return a signature");
  const afterState = await readSolPolicy(solConnection, solProgramId);
  assert.equal(afterState.spent, beforeState.spent, "rejected spend must not change spent");
});

test("sol: read state matches the initialized policy", async (t) => {
  if (!solReady) {
    t.skip("program .so missing");
    return;
  }
  const state = await readSolPolicy(solConnection, solProgramId);
  assert.equal(state.perTxMax, 2_000_000n);
  assert.equal(state.windowMax, 5_000_000n);
  assert.equal(state.agent.toBase58(), solAgent.publicKey.toBase58());
  assert.equal(state.frozen, false);
  assert.equal(state.mint.toBase58(), solMint.toBase58());
  assert.equal(state.recipients.length, 1);
  assert.equal(state.recipients[0].toBase58(), solMerchant.publicKey.toBase58());
});

// --- Solana SDK unit tests (no chain needed) ---

test("sol: discriminators match the program's Anchor discriminators", () => {
  assert.equal(discriminator("initialize").toString("hex"), "afaf6d1f0d989bed");
  assert.equal(discriminator("set_policy").toString("hex"), "28850c9debca0284");
  assert.equal(discriminator("set_agent").toString("hex"), "9a4a795b891365a6");
  assert.equal(discriminator("set_frozen").toString("hex"), "3e576360ce2fcc12");
  assert.equal(discriminator("withdraw").toString("hex"), "b712469c946da122");
  assert.equal(discriminator("spend").toString("hex"), "f2cdff5765d9f539");
});

test("sol: spend instruction has the right data and account order", () => {
  const programId = Keypair.generate().publicKey;
  const policy = Keypair.generate().publicKey;
  const vaultToken = Keypair.generate().publicKey;
  const destToken = Keypair.generate().publicKey;
  const agent = Keypair.generate().publicKey;
  const ix = buildSpendInstruction(programId, policy, vaultToken, destToken, agent, 1_000_000n);
  assert.equal(ix.programId.toBase58(), programId.toBase58());
  assert.equal(ix.data.length, 16);
  assert.equal(ix.data.subarray(0, 8).toString("hex"), "f2cdff5765d9f539");
  assert.equal(ix.data.readBigUInt64LE(8), 1_000_000n);
  const keys = ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]);
  assert.deepEqual(keys, [
    [policy.toBase58(), false, true],
    [vaultToken.toBase58(), false, true],
    [destToken.toBase58(), false, true],
    [agent.toBase58(), true, false],
    [TOKEN_PROGRAM_ID.toBase58(), false, false],
  ]);
});

test("sol: policy account parses from the Borsh layout", () => {
  const owner = Keypair.generate().publicKey;
  const agent = Keypair.generate().publicKey;
  const r1 = Keypair.generate().publicKey;
  const r2 = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const parts: Buffer[] = [Buffer.alloc(8)];
  const u32le = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v, 0);
    return b;
  };
  const u64le = (v: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(v, 0);
    return b;
  };
  const i64le = (v: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(v, 0);
    return b;
  };
  parts.push(
    owner.toBuffer(), agent.toBuffer(), u32le(1), Buffer.from([6]),
    u64le(2_000_000n), u64le(5_000_000n), u64le(86400n), i64le(1000n), i64le(0n),
    u32le(2), r1.toBuffer(), r2.toBuffer(),
    Buffer.alloc(32, 0xaa), Buffer.alloc(32, 0xbb), Buffer.from([1]),
    u64le(3n), u64le(1_500_000n), Buffer.from([7]), mint.toBuffer(),
  );
  const state = parsePolicyAccount(Buffer.concat(parts));
  assert.equal(state.owner.toBase58(), owner.toBase58());
  assert.equal(state.agent.toBase58(), agent.toBase58());
  assert.equal(state.version, 1);
  assert.equal(state.decimals, 6);
  assert.equal(state.perTxMax, 2_000_000n);
  assert.equal(state.windowMax, 5_000_000n);
  assert.equal(state.windowSeconds, 86400n);
  assert.equal(state.windowAnchor, 1000n);
  assert.equal(state.expiresAt, 0n);
  assert.deepEqual(state.recipients.map((r) => r.toBase58()), [r1.toBase58(), r2.toBase58()]);
  assert.equal(Buffer.from(state.evmSetHash).toString("hex"), "aa".repeat(32));
  assert.equal(Buffer.from(state.policyHash).toString("hex"), "bb".repeat(32));
  assert.equal(state.frozen, true);
  assert.equal(state.window, 3n);
  assert.equal(state.spent, 1_500_000n);
  assert.equal(state.bump, 7);
  assert.equal(state.mint.toBase58(), mint.toBase58());
});

test("sol: program error codes map to labels", () => {
  assert.equal(SOL_ERROR_CODES[6000], "Unauthorized");
  assert.equal(SOL_ERROR_CODES[6001], "Frozen");
  assert.equal(SOL_ERROR_CODES[6002], "ZeroAmount");
  assert.equal(SOL_ERROR_CODES[6003], "RecipientNotAllowed");
  assert.equal(SOL_ERROR_CODES[6004], "DailyCapExceeded");
  assert.equal(SOL_ERROR_CODES[6005], "PerTxCapExceeded");
  assert.equal(SOL_ERROR_CODES[6006], "InvalidAgent");
  assert.equal(SOL_ERROR_CODES[6007], "InvalidPolicy");
  assert.equal(SOL_ERROR_CODES[6008], "NotOwner");
  assert.equal(SOL_ERROR_CODES[6009], "InsufficientFunds");
  assert.equal(SOL_ERROR_CODES[6010], "SessionExpired");
  assert.equal(SOL_ERROR_CODES[6011], "InvalidAccounts");
  assert.equal(SOL_ERROR_CODES[2040], "DuplicateAccounts");
});
