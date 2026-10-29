//! T12b LiteSVM spend tests: conformance vectors V1-V14 in order,
//! V18 (attacker-signed intent), and bypass negatives S6 (wrong mint),
//! S7 (fake token program), S13 (duplicate accounts), S15 (submitter
//! alters a payload). V15/V16 (rollover/expiry via clock warp) and V17
//! (replay) belong to T17/T34, not T12b.

#[path = "common.rs"]
mod common;

use common::*;
use litesvm::LiteSVM;
use solana_address::Address;
use solana_keypair::Keypair;
use solana_signer::Signer;

/// spent_in_window offset for n recipients: frozen (185+32n) + 1 +
/// current_window (8) = 194+32n.
fn spent_off(n: usize) -> usize {
    194 + 32 * n
}

struct SpendFixture {
    svm: LiteSVM,
    pid: Address,
    policy: Address,
    owner: Keypair,
    agent: Keypair,
    merchant: Address,
    attacker: Keypair,
    mint: Address,
    vault_token: Address,
    merchant_token: Address,
    attacker_token: Address,
}

fn setup_spend() -> SpendFixture {
    let (mut svm, pid) = fresh_svm();
    let owner = funded(&mut svm);
    let agent = funded(&mut svm);
    let merchant = addr(&Keypair::new());
    let attacker = funded(&mut svm);
    let (policy, _bump) = policy_pda(&pid);
    let mint_kp = Keypair::new();
    let mint = create_mint(&mut svm, &owner, &mint_kp, 6);
    // Policy: per-tx 2 SFUSD, window 5 SFUSD, recipients = [merchant].
    let ix = ix_initialize(
        &pid,
        &addr(&owner),
        &policy,
        1,
        6,
        &addr(&agent),
        2_000_000,
        5_000_000,
        86400,
        1000,
        0,
        &[merchant],
        &[7u8; 32],
        &mint,
    );
    let res = send(&mut svm, &owner, &[&owner], ix);
    assert_ok(&res);
    // Vault token account (PDA-owned) funded with 10,000,000 SFUSD.
    let vault_kp = Keypair::new();
    let vault_token = create_token_account(&mut svm, &owner, &vault_kp, &mint, &policy);
    let ix = ix_token_mint_to(&mint, &vault_token, &addr(&owner), 10_000_000);
    let res = send(&mut svm, &owner, &[&owner], ix);
    assert_ok(&res);
    // Merchant + attacker token accounts.
    let merchant_kp = Keypair::new();
    let merchant_token = create_token_account(&mut svm, &owner, &merchant_kp, &mint, &merchant);
    let attacker_kp = Keypair::new();
    let attacker_token =
        create_token_account(&mut svm, &owner, &attacker_kp, &mint, &addr(&attacker));
    SpendFixture {
        svm,
        pid,
        policy,
        owner,
        agent,
        merchant,
        attacker,
        mint,
        vault_token,
        merchant_token,
        attacker_token,
    }
}

fn spend_as(
    svm: &mut LiteSVM,
    pid: &Address,
    policy: &Address,
    vault_token: &Address,
    signer: &Keypair,
    dest_token: &Address,
    amount: u64,
) -> litesvm::types::TransactionResult {
    let ix = ix_spend(pid, policy, vault_token, dest_token, &addr(signer), amount);
    send(svm, signer, &[signer], ix)
}

fn spent(f: &SpendFixture) -> u64 {
    read_u64(&policy_data(&f.svm, &f.policy), spent_off(1))
}

#[test]
fn spend_vectors_v1_to_v14_in_order() {
    let mut f = setup_spend();
    // V1: merchant 1.000000 ACCEPT (spent 1).
    let res = spend_as(&mut f.svm, &f.pid, &f.policy, &f.vault_token, &f.agent, &f.merchant_token, 1_000_000);
    assert_ok(&res);
    assert_eq!(spent(&f), 1_000_000);
    assert_eq!(token_balance(&f.svm, &f.vault_token), 9_000_000);
    assert_eq!(token_balance(&f.svm, &f.merchant_token), 1_000_000);
    // V2: attacker 0.000001 -> RecipientNotAllowed.
    let res = spend_as(&mut f.svm, &f.pid, &f.policy, &f.vault_token, &f.agent, &f.attacker_token, 1);
    assert_custom(&res, 6003);
    // V3: attacker, full vault balance (Bankrbot drain) -> RecipientNotAllowed.
    let res = spend_as(&mut f.svm, &f.pid, &f.policy, &f.vault_token, &f.agent, &f.attacker_token, 10_000_000);
    assert_custom(&res, 6003);
    // V4: merchant 0 -> ZeroAmount.
    let res = spend_as(&mut f.svm, &f.pid, &f.policy, &f.vault_token, &f.agent, &f.merchant_token, 0);
    assert_custom(&res, 6002);
    // V5: merchant 2.000001 -> PerTxCapExceeded.
    let res = spend_as(&mut f.svm, &f.pid, &f.policy, &f.vault_token, &f.agent, &f.merchant_token, 2_000_001);
    assert_custom(&res, 6005);
    assert_eq!(spent(&f), 1_000_000);
    // V6: merchant 2.000000 ACCEPT, exact per-tx boundary (spent 3).
    let res = spend_as(&mut f.svm, &f.pid, &f.policy, &f.vault_token, &f.agent, &f.merchant_token, 2_000_000);
    assert_ok(&res);
    assert_eq!(spent(&f), 3_000_000);
    assert_eq!(token_balance(&f.svm, &f.vault_token), 7_000_000);
    assert_eq!(token_balance(&f.svm, &f.merchant_token), 3_000_000);
    // V7: merchant 6.000000 -> DailyCapExceeded.
    let res = spend_as(&mut f.svm, &f.pid, &f.policy, &f.vault_token, &f.agent, &f.merchant_token, 6_000_000);
    assert_custom(&res, 6004);
    // V8: merchant 2^64-1 -> DailyCapExceeded, no overflow (u128 math).
    let res = spend_as(&mut f.svm, &f.pid, &f.policy, &f.vault_token, &f.agent, &f.merchant_token, u64::MAX);
    assert_custom(&res, 6004);
    assert_eq!(spent(&f), 3_000_000);
    // V9: merchant 2.000000 ACCEPT, exact window boundary (spent 5).
    // Owner pays the fee here: V6 already used this exact spend with
    // the agent as payer, and LiteSVM rejects identical messages as
    // duplicates, so a different payer keeps the signature distinct.
    // The policy does not depend on the payer.
    let ix = ix_spend(&f.pid, &f.policy, &f.vault_token, &f.merchant_token, &addr(&f.agent), 2_000_000);
    let res = send(&mut f.svm, &f.owner, &[&f.owner, &f.agent], ix);
    assert_ok(&res);
    assert_eq!(spent(&f), 5_000_000);
    assert_eq!(token_balance(&f.svm, &f.vault_token), 5_000_000);
    assert_eq!(token_balance(&f.svm, &f.merchant_token), 5_000_000);
    // V10: merchant 0.000001 -> DailyCapExceeded (window full).
    let res = spend_as(&mut f.svm, &f.pid, &f.policy, &f.vault_token, &f.agent, &f.merchant_token, 1);
    assert_custom(&res, 6004);
    // V11: recipient = the vault itself (a PDA-owned token account, not
    // the vault account) -> RecipientNotAllowed.
    let pda_kp = Keypair::new();
    let pda_token = create_token_account(&mut f.svm, &f.owner, &pda_kp, &f.mint, &f.policy);
    let res = spend_as(&mut f.svm, &f.pid, &f.policy, &f.vault_token, &f.agent, &pda_token, 1);
    assert_custom(&res, 6003);
    // V12: AGENT attempts withdraw -> NotOwner (owner-only admin).
    let agent_dest_kp = Keypair::new();
    let agent_dest =
        create_token_account(&mut f.svm, &f.owner, &agent_dest_kp, &f.mint, &addr(&f.agent));
    let ix = ix_withdraw(&f.pid, &addr(&f.agent), &f.policy, &f.vault_token, &agent_dest, 1000);
    let res = send(&mut f.svm, &f.agent, &[&f.agent], ix);
    assert_custom(&res, 6008);
    // V13: owner freezes, merchant 0.000001 -> Frozen. Owner pays the
    // fee so this spend differs from V10's identical agent-payer spend.
    let ix = ix_set_frozen(&f.pid, &addr(&f.owner), &f.policy, true);
    let res = send(&mut f.svm, &f.owner, &[&f.owner], ix);
    assert_ok(&res);
    let ix = ix_spend(&f.pid, &f.policy, &f.vault_token, &f.merchant_token, &addr(&f.agent), 1);
    let res = send(&mut f.svm, &f.owner, &[&f.owner, &f.agent], ix);
    assert_custom(&res, 6001);
    // V14: owner unfreezes, merchant 0.000001 -> DailyCapExceeded
    // (freeze did not reset spent). A fresh submitter pays the fee so
    // this spend differs from both V10 (agent payer) and V13 (owner
    // payer) with the same amount.
    let ix = ix_set_frozen(&f.pid, &addr(&f.owner), &f.policy, false);
    let res = send(&mut f.svm, &f.owner, &[&f.owner], ix);
    assert_ok(&res);
    let submitter = funded(&mut f.svm);
    let ix = ix_spend(&f.pid, &f.policy, &f.vault_token, &f.merchant_token, &addr(&f.agent), 1);
    let res = send(&mut f.svm, &submitter, &[&submitter, &f.agent], ix);
    assert_custom(&res, 6004);
    assert_eq!(spent(&f), 5_000_000);
}

#[test]
fn spend_v18_attacker_signed_intent_rejected() {
    let mut f = setup_spend();
    // The attacker signs a spend to a valid recipient for a valid
    // amount, but the attacker is not the policy agent.
    let res = spend_as(&mut f.svm, &f.pid, &f.policy, &f.vault_token, &f.attacker, &f.merchant_token, 1_000_000);
    assert_custom(&res, 6000);
    assert_eq!(spent(&f), 0);
    assert_eq!(token_balance(&f.svm, &f.vault_token), 10_000_000);
}

#[test]
fn spend_s6_wrong_mint_rejected() {
    let mut f = setup_spend();
    // (a) Vault token account for a different mint (PDA-owned).
    let wrong_mint_kp = Keypair::new();
    let wrong_mint = create_mint(&mut f.svm, &f.owner, &wrong_mint_kp, 6);
    let wrong_kp = Keypair::new();
    let wrong_vault = create_token_account(&mut f.svm, &f.owner, &wrong_kp, &wrong_mint, &f.policy);
    let ix = ix_token_mint_to(&wrong_mint, &wrong_vault, &addr(&f.owner), 1_000_000);
    let res = send(&mut f.svm, &f.owner, &[&f.owner], ix);
    assert_ok(&res);
    let ix = ix_spend(&f.pid, &f.policy, &wrong_vault, &f.merchant_token, &addr(&f.agent), 1000);
    let res = send(&mut f.svm, &f.agent, &[&f.agent], ix);
    assert_custom(&res, 6007);
    // (b) Destination token account for a different mint (owner is a
    // valid recipient, so only the mint check can fail).
    let wrong_dest_kp = Keypair::new();
    let wrong_dest =
        create_token_account(&mut f.svm, &f.owner, &wrong_dest_kp, &wrong_mint, &f.merchant);
    let ix = ix_spend(&f.pid, &f.policy, &f.vault_token, &wrong_dest, &addr(&f.agent), 1000);
    let res = send(&mut f.svm, &f.agent, &[&f.agent], ix);
    assert_custom(&res, 6007);
    // (c) A non-token account as the vault account fails deserialization.
    let plain = funded(&mut f.svm);
    let ix = ix_spend(&f.pid, &f.policy, &addr(&plain), &f.merchant_token, &addr(&f.agent), 1000);
    let res = send(&mut f.svm, &f.agent, &[&f.agent], ix);
    assert_err(&res);
}

#[test]
fn spend_s7_fake_token_program_rejected() {
    let mut f = setup_spend();
    // The token program account is the System program, not the classic
    // Token program: Anchor's Program<Token> check fails.
    let ix = ix_spend_with_token_program(
        &f.pid,
        &f.policy,
        &f.vault_token,
        &f.merchant_token,
        &addr(&f.agent),
        &system_program_id(),
        1000,
    );
    let res = send(&mut f.svm, &f.agent, &[&f.agent], ix);
    assert_err(&res);
}

#[test]
fn spend_s13_duplicate_accounts_rejected() {
    let mut f = setup_spend();
    // Source and destination are the same token account. Anchor's
    // default duplicate-mutable-account check (2040) fires during
    // account validation, before the program's own InvalidAccounts
    // check (6011) can run; the plan names Anchor's default as the
    // S13 closure, so 2040 is the expected code here.
    let ix = ix_spend(&f.pid, &f.policy, &f.vault_token, &f.vault_token, &addr(&f.agent), 1000);
    let res = send(&mut f.svm, &f.agent, &[&f.agent], ix);
    assert_custom(&res, 2040);
}

#[test]
fn spend_s15_submitter_cannot_alter_payload() {
    let mut f = setup_spend();
    // (a) The submitter (owner, as fee payer) sends a spend without the
    // agent's signature: build the transaction unsigned, sign only as
    // the payer, and let the runtime reject the missing agent signature.
    let ix = ix_spend(&f.pid, &f.policy, &f.vault_token, &f.merchant_token, &addr(&f.agent), 1000);
    let blockhash = f.svm.latest_blockhash();
    let msg = solana_message::Message::new(&[ix], Some(&addr(&f.owner)));
    let mut tx = solana_transaction::Transaction::new_unsigned(msg);
    tx.partial_sign(&[&f.owner], blockhash);
    let res = f.svm.send_transaction(tx);
    assert_err(&res);
    // (b) A valid agent-signed spend whose instruction data is tampered
    // (amount changed) after signing: the stale signature must fail.
    let ix = ix_spend(&f.pid, &f.policy, &f.vault_token, &f.merchant_token, &addr(&f.agent), 1000);
    let blockhash = f.svm.latest_blockhash();
    let mut tx = solana_transaction::Transaction::new_signed_with_payer(
        &[ix],
        Some(&addr(&f.agent)),
        &[&f.agent],
        blockhash,
    );
    // Tamper: rewrite the amount (last 8 bytes of the instruction data).
    let len = tx.message.instructions[0].data.len();
    tx.message.instructions[0].data[len - 8..].copy_from_slice(&999_999u64.to_le_bytes());
    let res = f.svm.send_transaction(tx);
    assert_err(&res);
    assert_eq!(spent(&f), 0);
}
