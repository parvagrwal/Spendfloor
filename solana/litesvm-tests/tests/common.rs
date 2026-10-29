//! Shared helpers for the LiteSVM tests (admin + spend). Token helpers
//! build the classic Token program instructions by hand (no spl-token
//! dependency, so the test crate stays on the solana 3.x crates it
//! already uses). Token program id and Rent sysvar id are verified
//! against the cached crates (litesvm default programs, solana-sdk-ids).

use litesvm::types::TransactionResult;
use litesvm::LiteSVM;
use sha2::{Digest, Sha256};
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;

pub const PROGRAM_ID: &str = "BWVM3J3QfWoco8b1GUFCzX1T7vDhuKHQbN5FDShUXhbC";
pub const SYSTEM_PROGRAM_ID: &str = "11111111111111111111111111111111";
pub const TOKEN_PROGRAM_ID: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
pub const RENT_SYSVAR_ID: &str = "SysvarRent111111111111111111111111111111111";
pub const LAMPORTS_PER_SOL: u64 = 1_000_000_000;
/// TokenAccount data length (classic Token program).
pub const TOKEN_ACCOUNT_LEN: usize = 165;
/// Mint data length (classic Token program).
pub const MINT_LEN: usize = 82;

pub fn program_id() -> Address {
    PROGRAM_ID.parse().unwrap()
}

pub fn system_program_id() -> Address {
    SYSTEM_PROGRAM_ID.parse().unwrap()
}

pub fn token_program_id() -> Address {
    TOKEN_PROGRAM_ID.parse().unwrap()
}

pub fn rent_sysvar_id() -> Address {
    RENT_SYSVAR_ID.parse().unwrap()
}

pub fn addr(kp: &Keypair) -> Address {
    Address::new_from_array(kp.pubkey().to_bytes())
}

pub fn fresh_svm() -> (LiteSVM, Address) {
    let mut svm = LiteSVM::new();
    let pid = program_id();
    let so_path = format!(
        "{}/../target/deploy/spendfloor.so",
        env!("CARGO_MANIFEST_DIR")
    );
    svm.add_program_from_file(pid, &so_path).unwrap();
    (svm, pid)
}

pub fn funded(svm: &mut LiteSVM) -> Keypair {
    let kp = Keypair::new();
    let res = svm.airdrop(&addr(&kp), 10 * LAMPORTS_PER_SOL);
    assert!(res.is_ok(), "airdrop failed: {res:?}");
    kp
}

pub fn policy_pda(pid: &Address) -> (Address, u8) {
    Address::find_program_address(&[b"policy"], pid)
}

pub fn disc(name: &str) -> [u8; 8] {
    let mut input = b"global:".to_vec();
    input.extend_from_slice(name.as_bytes());
    let h = Sha256::digest(&input);
    h[0..8].try_into().unwrap()
}

pub fn u32le(v: u32) -> [u8; 4] {
    v.to_le_bytes()
}

pub fn u64le(v: u64) -> [u8; 8] {
    v.to_le_bytes()
}

pub fn i64le(v: i64) -> [u8; 8] {
    v.to_le_bytes()
}

pub fn policy_args(
    version: u32,
    decimals: u8,
    per_tx: u64,
    window_max: u64,
    window_secs: u64,
    anchor: i64,
    expiry: i64,
    recipients: &[Address],
    evm_hash: &[u8; 32],
) -> Vec<u8> {
    let mut d = Vec::new();
    d.extend_from_slice(&u32le(version));
    d.push(decimals);
    d.extend_from_slice(&u64le(per_tx));
    d.extend_from_slice(&u64le(window_max));
    d.extend_from_slice(&u64le(window_secs));
    d.extend_from_slice(&i64le(anchor));
    d.extend_from_slice(&i64le(expiry));
    d.extend_from_slice(&u32le(recipients.len() as u32));
    for r in recipients {
        d.extend_from_slice(r.as_ref());
    }
    d.extend_from_slice(evm_hash);
    d
}

pub fn ix_initialize(
    pid: &Address,
    owner: &Address,
    policy: &Address,
    version: u32,
    decimals: u8,
    agent: &Address,
    per_tx: u64,
    window_max: u64,
    window_secs: u64,
    anchor: i64,
    expiry: i64,
    recipients: &[Address],
    evm_hash: &[u8; 32],
    mint: &Address,
) -> Instruction {
    let mut data = disc("initialize").to_vec();
    data.extend_from_slice(&u32le(version));
    data.push(decimals);
    data.extend_from_slice(agent.as_ref());
    data.extend_from_slice(&u64le(per_tx));
    data.extend_from_slice(&u64le(window_max));
    data.extend_from_slice(&u64le(window_secs));
    data.extend_from_slice(&i64le(anchor));
    data.extend_from_slice(&i64le(expiry));
    data.extend_from_slice(&u32le(recipients.len() as u32));
    for r in recipients {
        data.extend_from_slice(r.as_ref());
    }
    data.extend_from_slice(evm_hash);
    data.extend_from_slice(mint.as_ref());
    Instruction {
        program_id: *pid,
        accounts: vec![
            AccountMeta::new(*owner, true),
            AccountMeta::new(*policy, false),
            AccountMeta::new_readonly(system_program_id(), false),
        ],
        data,
    }
}

pub fn ix_set_policy(
    pid: &Address,
    owner: &Address,
    policy: &Address,
    version: u32,
    decimals: u8,
    per_tx: u64,
    window_max: u64,
    window_secs: u64,
    anchor: i64,
    expiry: i64,
    recipients: &[Address],
    evm_hash: &[u8; 32],
) -> Instruction {
    let mut data = disc("set_policy").to_vec();
    data.extend_from_slice(&policy_args(
        version, decimals, per_tx, window_max, window_secs, anchor, expiry, recipients, evm_hash,
    ));
    Instruction {
        program_id: *pid,
        accounts: vec![
            AccountMeta::new(*owner, true),
            AccountMeta::new(*policy, false),
        ],
        data,
    }
}

pub fn ix_set_agent(pid: &Address, owner: &Address, policy: &Address, new_agent: &Address) -> Instruction {
    let mut data = disc("set_agent").to_vec();
    data.extend_from_slice(new_agent.as_ref());
    Instruction {
        program_id: *pid,
        accounts: vec![
            AccountMeta::new(*owner, true),
            AccountMeta::new(*policy, false),
        ],
        data,
    }
}

pub fn ix_set_frozen(pid: &Address, owner: &Address, policy: &Address, frozen: bool) -> Instruction {
    let mut data = disc("set_frozen").to_vec();
    data.push(if frozen { 1 } else { 0 });
    Instruction {
        program_id: *pid,
        accounts: vec![
            AccountMeta::new(*owner, true),
            AccountMeta::new(*policy, false),
        ],
        data,
    }
}

/// Withdraw accounts in program context order: owner, policy,
/// vault_token, dest_token, token_program.
pub fn ix_withdraw(
    pid: &Address,
    owner: &Address,
    policy: &Address,
    vault_token: &Address,
    dest_token: &Address,
    amount: u64,
) -> Instruction {
    let mut data = disc("withdraw").to_vec();
    data.extend_from_slice(&u64le(amount));
    Instruction {
        program_id: *pid,
        accounts: vec![
            AccountMeta::new(*owner, true),
            AccountMeta::new(*policy, false),
            AccountMeta::new(*vault_token, false),
            AccountMeta::new(*dest_token, false),
            AccountMeta::new_readonly(token_program_id(), false),
        ],
        data,
    }
}

/// Spend accounts in program context order: policy, vault_token,
/// dest_token, agent, token_program.
pub fn ix_spend(
    pid: &Address,
    policy: &Address,
    vault_token: &Address,
    dest_token: &Address,
    agent: &Address,
    amount: u64,
) -> Instruction {
    let mut data = disc("spend").to_vec();
    data.extend_from_slice(&u64le(amount));
    Instruction {
        program_id: *pid,
        accounts: vec![
            AccountMeta::new(*policy, false),
            AccountMeta::new(*vault_token, false),
            AccountMeta::new(*dest_token, false),
            AccountMeta::new(*agent, true),
            AccountMeta::new_readonly(token_program_id(), false),
        ],
        data,
    }
}

/// Same as ix_spend but with an overridable token program (for S7).
pub fn ix_spend_with_token_program(
    pid: &Address,
    policy: &Address,
    vault_token: &Address,
    dest_token: &Address,
    agent: &Address,
    token_program: &Address,
    amount: u64,
) -> Instruction {
    let mut ix = ix_spend(pid, policy, vault_token, dest_token, agent, amount);
    ix.accounts[4] = AccountMeta::new_readonly(*token_program, false);
    ix
}

pub fn send(svm: &mut LiteSVM, payer: &Keypair, signers: &[&Keypair], ix: Instruction) -> TransactionResult {
    send_ixs(svm, payer, signers, vec![ix])
}

pub fn send_ixs(
    svm: &mut LiteSVM,
    payer: &Keypair,
    signers: &[&Keypair],
    ixs: Vec<Instruction>,
) -> TransactionResult {
    let blockhash = svm.latest_blockhash();
    let tx = Transaction::new_signed_with_payer(&ixs, Some(&addr(payer)), signers, blockhash);
    svm.send_transaction(tx)
}

pub fn assert_ok(res: &TransactionResult) {
    assert!(res.is_ok(), "expected Ok, got: {res:?}");
}

pub fn assert_err(res: &TransactionResult) {
    assert!(res.is_err(), "expected Err, got Ok");
}

/// Extract an Anchor custom error code from a failed transaction result
/// via its debug text (avoids depending on the instruction-error crate
/// version across the solana 3.x split).
pub fn custom_code(res: &TransactionResult) -> Option<u32> {
    let s = format!("{res:?}");
    let idx = s.find("Custom(")?;
    let rest = &s[idx + 7..];
    let end = rest.find(')')?;
    rest[..end].parse().ok()
}

pub fn assert_custom(res: &TransactionResult, code: u32) {
    assert_err(res);
    assert_eq!(custom_code(res), Some(code), "expected Custom({code}), got: {res:?}");
}

pub fn policy_data(svm: &LiteSVM, policy: &Address) -> Vec<u8> {
    svm.get_account(policy).expect("policy account missing").data
}

pub fn read_u32(d: &[u8], off: usize) -> u32 {
    u32::from_le_bytes(d[off..off + 4].try_into().unwrap())
}

pub fn read_u64(d: &[u8], off: usize) -> u64 {
    u64::from_le_bytes(d[off..off + 8].try_into().unwrap())
}

pub fn read_bytes(d: &[u8], off: usize, len: usize) -> Vec<u8> {
    d[off..off + len].to_vec()
}

/// Offsets into the Borsh policy account (8-byte discriminator first).
/// Mint is appended last, so these are unchanged from T12a.
pub fn policy_hash_off(n_recipients: usize) -> usize {
    153 + 32 * n_recipients
}

pub fn policy_frozen_off(n_recipients: usize) -> usize {
    185 + 32 * n_recipients
}

/// Mint offset: it follows bump, so it depends on the actual recipient
/// count: 8 (disc) + 109 (fixed fields) + 4 + 32n (recipients) + 32
/// (evm hash) + 32 (policy hash) + 1 (frozen) + 8 (window) + 8 (spent)
/// + 1 (bump) = 203+32n.
pub fn policy_mint_off(n_recipients: usize) -> usize {
    203 + 32 * n_recipients
}

pub fn set_hash(recipients: &[Address]) -> [u8; 32] {
    let mut sorted: Vec<Address> = recipients.to_vec();
    sorted.sort_by(|a, b| a.as_ref().cmp(b.as_ref()));
    let mut bytes = Vec::new();
    for r in &sorted {
        bytes.extend_from_slice(r.as_ref());
    }
    Sha256::digest(&bytes).into()
}

pub fn canonical_hash(
    version: u32,
    decimals: u8,
    per_tx: u64,
    window_max: u64,
    window_secs: u64,
    anchor: i64,
    expiry: i64,
    evm_hash: &[u8; 32],
    sol_hash: &[u8; 32],
) -> [u8; 32] {
    let mut pre = Vec::with_capacity(122);
    pre.extend_from_slice(b"SPENDFLOOR/v1");
    pre.extend_from_slice(&version.to_be_bytes());
    pre.push(decimals);
    pre.extend_from_slice(&per_tx.to_be_bytes());
    pre.extend_from_slice(&window_max.to_be_bytes());
    pre.extend_from_slice(&window_secs.to_be_bytes());
    pre.extend_from_slice(&anchor.to_be_bytes());
    pre.extend_from_slice(&expiry.to_be_bytes());
    pre.extend_from_slice(evm_hash);
    pre.extend_from_slice(sol_hash);
    Sha256::digest(&pre).into()
}

// ---------- classic Token program instructions (by hand) ----------

/// System CreateAccount (instruction 0).
pub fn ix_system_create_account(
    from: &Address,
    new_account: &Address,
    lamports: u64,
    space: u64,
    owner_program: &Address,
) -> Instruction {
    let mut data = Vec::with_capacity(4 + 8 + 8 + 32);
    data.extend_from_slice(&0u32.to_le_bytes());
    data.extend_from_slice(&lamports.to_le_bytes());
    data.extend_from_slice(&space.to_le_bytes());
    data.extend_from_slice(owner_program.as_ref());
    Instruction {
        program_id: system_program_id(),
        accounts: vec![
            AccountMeta::new(*from, true),
            AccountMeta::new(*new_account, true),
        ],
        data,
    }
}

/// Token InitializeMint (instruction 0): decimals, mint authority,
/// freeze authority None.
pub fn ix_token_initialize_mint(mint: &Address, mint_authority: &Address, decimals: u8) -> Instruction {
    let mut data = Vec::with_capacity(1 + 1 + 32 + 1);
    data.push(0u8);
    data.push(decimals);
    data.extend_from_slice(mint_authority.as_ref());
    data.push(0u8);
    Instruction {
        program_id: token_program_id(),
        accounts: vec![
            AccountMeta::new(*mint, false),
            AccountMeta::new_readonly(rent_sysvar_id(), false),
        ],
        data,
    }
}

/// Token InitializeAccount (instruction 1).
pub fn ix_token_initialize_account(account: &Address, mint: &Address, owner: &Address) -> Instruction {
    Instruction {
        program_id: token_program_id(),
        accounts: vec![
            AccountMeta::new(*account, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(rent_sysvar_id(), false),
        ],
        data: vec![1u8],
    }
}

/// Token MintTo (instruction 7).
pub fn ix_token_mint_to(mint: &Address, dest: &Address, authority: &Address, amount: u64) -> Instruction {
    let mut data = Vec::with_capacity(1 + 8);
    data.push(7u8);
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: token_program_id(),
        accounts: vec![
            AccountMeta::new(*mint, false),
            AccountMeta::new(*dest, false),
            AccountMeta::new(*authority, true),
        ],
        data,
    }
}

/// Create a mint account (rent-exempt) and initialize it. Mint authority
/// is the payer (the OWNER per D4).
pub fn create_mint(svm: &mut LiteSVM, payer: &Keypair, mint_kp: &Keypair, decimals: u8) -> Address {
    let mint = addr(mint_kp);
    let rent = svm.minimum_balance_for_rent_exemption(MINT_LEN);
    let ixs = vec![
        ix_system_create_account(&addr(payer), &mint, rent, MINT_LEN as u64, &token_program_id()),
        ix_token_initialize_mint(&mint, &addr(payer), decimals),
    ];
    let res = send_ixs(svm, payer, &[payer, mint_kp], ixs);
    assert_ok(&res);
    mint
}

/// Create a token account (rent-exempt) and initialize it for
/// (mint, owner).
pub fn create_token_account(
    svm: &mut LiteSVM,
    payer: &Keypair,
    account_kp: &Keypair,
    mint: &Address,
    owner: &Address,
) -> Address {
    let account = addr(account_kp);
    let rent = svm.minimum_balance_for_rent_exemption(TOKEN_ACCOUNT_LEN);
    let ixs = vec![
        ix_system_create_account(&addr(payer), &account, rent, TOKEN_ACCOUNT_LEN as u64, &token_program_id()),
        ix_token_initialize_account(&account, mint, owner),
    ];
    let res = send_ixs(svm, payer, &[payer, account_kp], ixs);
    assert_ok(&res);
    account
}

/// Token balance of an account: amount is a u64 LE at offset 64 in the
/// classic TokenAccount layout (mint 0..32, owner 32..64, amount 64..72).
pub fn token_balance(svm: &LiteSVM, account: &Address) -> u64 {
    let data = svm.get_account(account).expect("token account missing").data;
    read_u64(&data, 64)
}

/// Token account owner: bytes 32..64.
pub fn token_owner(svm: &LiteSVM, account: &Address) -> Vec<u8> {
    let data = svm.get_account(account).expect("token account missing").data;
    read_bytes(&data, 32, 32)
}

/// Token account mint: bytes 0..32.
pub fn token_mint(svm: &LiteSVM, account: &Address) -> Vec<u8> {
    let data = svm.get_account(account).expect("token account missing").data;
    read_bytes(&data, 0, 32)
}
