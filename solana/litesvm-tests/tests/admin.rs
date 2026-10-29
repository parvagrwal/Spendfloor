//! T12a (reworked to plan D4) LiteSVM admin tests: init, set-policy,
//! set-agent, freeze, token withdraw, re-init negative (S12),
//! substitution negative (S8), and owner-only admin (V12). The spend
//! instruction is T12b's scope and is tested in spend.rs.

#[path = "common.rs"]
mod common;

use common::*;
use litesvm::LiteSVM;
use solana_address::Address;
use solana_keypair::Keypair;

struct Fixture {
    svm: LiteSVM,
    pid: Address,
    policy: Address,
    owner: Keypair,
    agent: Keypair,
    alice: Address,
    bob: Address,
    evm_hash: [u8; 32],
    mint: Address,
}

fn setup() -> Fixture {
    let (mut svm, pid) = fresh_svm();
    let owner = funded(&mut svm);
    let agent = funded(&mut svm);
    let alice = addr(&funded(&mut svm));
    let bob = addr(&funded(&mut svm));
    let (policy, _bump) = policy_pda(&pid);
    let mint_kp = Keypair::new();
    let mint = create_mint(&mut svm, &owner, &mint_kp, 6);
    Fixture {
        svm,
        pid,
        policy,
        owner,
        agent,
        alice,
        bob,
        evm_hash: [7u8; 32],
        mint,
    }
}

fn init_ok(f: &mut Fixture) {
    let ix = ix_initialize(
        &f.pid,
        &addr(&f.owner),
        &f.policy,
        1,
        6,
        &addr(&f.agent),
        2_000_000,
        5_000_000,
        86400,
        1000,
        0,
        &[f.alice, f.bob],
        &f.evm_hash,
        &f.mint,
    );
    let res = send(&mut f.svm, &f.owner, &[&f.owner], ix);
    assert_ok(&res);
}

#[test]
fn initialize_valid_and_hash_matches_canonical() {
    let mut f = setup();
    init_ok(&mut f);
    let data = policy_data(&f.svm, &f.policy);
    assert_eq!(read_bytes(&data, 8, 32), addr(&f.owner).as_ref());
    assert_eq!(read_bytes(&data, 40, 32), addr(&f.agent).as_ref());
    assert_eq!(read_u32(&data, 72), 1);
    assert_eq!(data[76], 6);
    assert_eq!(read_u64(&data, 77), 2_000_000);
    assert_eq!(read_u64(&data, 85), 5_000_000);
    assert_eq!(read_bytes(&data, policy_mint_off(2), 32), f.mint.as_ref());
    let expected = canonical_hash(
        1,
        6,
        2_000_000,
        5_000_000,
        86400,
        1000,
        0,
        &f.evm_hash,
        &set_hash(&[f.alice, f.bob]),
    );
    assert_eq!(read_bytes(&data, policy_hash_off(2), 32), expected.to_vec());
}

#[test]
fn initialize_invalid_rejected() {
    let mut f = setup();
    // Bad version.
    let ix = ix_initialize(
        &f.pid,
        &addr(&f.owner),
        &f.policy,
        2,
        6,
        &addr(&f.agent),
        2_000_000,
        5_000_000,
        86400,
        1000,
        0,
        &[f.alice, f.bob],
        &f.evm_hash,
        &f.mint,
    );
    let res = send(&mut f.svm, &f.owner, &[&f.owner], ix);
    assert_custom(&res, 6007);
    // Zero recipients.
    let ix = ix_initialize(
        &f.pid,
        &addr(&f.owner),
        &f.policy,
        1,
        6,
        &addr(&f.agent),
        2_000_000,
        5_000_000,
        86400,
        1000,
        0,
        &[],
        &f.evm_hash,
        &f.mint,
    );
    let res = send(&mut f.svm, &f.owner, &[&f.owner], ix);
    assert_custom(&res, 6007);
    // Agent as recipient.
    let agent_addr = addr(&f.agent);
    let ix = ix_initialize(
        &f.pid,
        &addr(&f.owner),
        &f.policy,
        1,
        6,
        &agent_addr,
        2_000_000,
        5_000_000,
        86400,
        1000,
        0,
        &[agent_addr],
        &f.evm_hash,
        &f.mint,
    );
    let res = send(&mut f.svm, &f.owner, &[&f.owner], ix);
    assert_custom(&res, 6007);
    assert!(f.svm.get_account(&f.policy).is_none(), "failed init must not create the policy");
    // Zero mint.
    let zero = Address::default();
    let ix = ix_initialize(
        &f.pid,
        &addr(&f.owner),
        &f.policy,
        1,
        6,
        &addr(&f.agent),
        2_000_000,
        5_000_000,
        86400,
        1000,
        0,
        &[f.alice, f.bob],
        &f.evm_hash,
        &zero,
    );
    let res = send(&mut f.svm, &f.owner, &[&f.owner], ix);
    assert_custom(&res, 6007);
}

#[test]
fn set_policy_owner_updates_hash() {
    let mut f = setup();
    init_ok(&mut f);
    let carol = addr(&funded(&mut f.svm));
    let ix = ix_set_policy(
        &f.pid,
        &addr(&f.owner),
        &f.policy,
        1,
        6,
        3_000_000,
        9_000_000,
        3600,
        2000,
        0,
        &[f.alice, carol],
        &f.evm_hash,
    );
    let res = send(&mut f.svm, &f.owner, &[&f.owner], ix);
    assert_ok(&res);
    let data = policy_data(&f.svm, &f.policy);
    assert_eq!(read_u64(&data, 77), 3_000_000);
    assert_eq!(read_u64(&data, 85), 9_000_000);
    // Mint is pinned: a policy update must not change it.
    assert_eq!(read_bytes(&data, policy_mint_off(2), 32), f.mint.as_ref());
    let expected = canonical_hash(
        1,
        6,
        3_000_000,
        9_000_000,
        3600,
        2000,
        0,
        &f.evm_hash,
        &set_hash(&[f.alice, carol]),
    );
    assert_eq!(read_bytes(&data, policy_hash_off(2), 32), expected.to_vec());
}

#[test]
fn set_policy_non_owner_rejected_v12() {
    let mut f = setup();
    init_ok(&mut f);
    let before = policy_data(&f.svm, &f.policy);
    let attacker = funded(&mut f.svm);
    let ix = ix_set_policy(
        &f.pid,
        &addr(&attacker),
        &f.policy,
        1,
        6,
        3_000_000,
        9_000_000,
        3600,
        2000,
        0,
        &[f.alice, f.bob],
        &f.evm_hash,
    );
    let res = send(&mut f.svm, &attacker, &[&attacker], ix);
    assert_custom(&res, 6008);
    assert_eq!(policy_data(&f.svm, &f.policy), before, "failed admin must not change state");
}

#[test]
fn set_policy_invalid_rejected() {
    let mut f = setup();
    init_ok(&mut f);
    let before = policy_data(&f.svm, &f.policy);
    let ix = ix_set_policy(
        &f.pid,
        &addr(&f.owner),
        &f.policy,
        2,
        6,
        3_000_000,
        9_000_000,
        3600,
        2000,
        0,
        &[f.alice, f.bob],
        &f.evm_hash,
    );
    let res = send(&mut f.svm, &f.owner, &[&f.owner], ix);
    assert_custom(&res, 6007);
    assert_eq!(policy_data(&f.svm, &f.policy), before);
}

#[test]
fn set_agent_owner_and_non_owner() {
    let mut f = setup();
    init_ok(&mut f);
    let new_agent = funded(&mut f.svm);
    let ix = ix_set_agent(&f.pid, &addr(&f.owner), &f.policy, &addr(&new_agent));
    let res = send(&mut f.svm, &f.owner, &[&f.owner], ix);
    assert_ok(&res);
    let data = policy_data(&f.svm, &f.policy);
    assert_eq!(read_bytes(&data, 40, 32), addr(&new_agent).as_ref());
    // Non-owner (V12).
    let attacker = funded(&mut f.svm);
    let other = funded(&mut f.svm);
    let ix = ix_set_agent(&f.pid, &addr(&attacker), &f.policy, &addr(&other));
    let res = send(&mut f.svm, &attacker, &[&attacker], ix);
    assert_custom(&res, 6008);
    let data = policy_data(&f.svm, &f.policy);
    assert_eq!(read_bytes(&data, 40, 32), addr(&new_agent).as_ref());
    // Zero agent.
    let zero = Address::default();
    let ix = ix_set_agent(&f.pid, &addr(&f.owner), &f.policy, &zero);
    let res = send(&mut f.svm, &f.owner, &[&f.owner], ix);
    assert_custom(&res, 6006);
}

#[test]
fn set_frozen_owner_and_non_owner() {
    let mut f = setup();
    init_ok(&mut f);
    let ix = ix_set_frozen(&f.pid, &addr(&f.owner), &f.policy, true);
    let res = send(&mut f.svm, &f.owner, &[&f.owner], ix);
    assert_ok(&res);
    assert_eq!(policy_data(&f.svm, &f.policy)[policy_frozen_off(2)], 1);
    let ix = ix_set_frozen(&f.pid, &addr(&f.owner), &f.policy, false);
    let res = send(&mut f.svm, &f.owner, &[&f.owner], ix);
    assert_ok(&res);
    assert_eq!(policy_data(&f.svm, &f.policy)[policy_frozen_off(2)], 0);
    // Non-owner (V12).
    let attacker = funded(&mut f.svm);
    let ix = ix_set_frozen(&f.pid, &addr(&attacker), &f.policy, true);
    let res = send(&mut f.svm, &attacker, &[&attacker], ix);
    assert_custom(&res, 6008);
    assert_eq!(policy_data(&f.svm, &f.policy)[policy_frozen_off(2)], 0);
}

#[test]
fn withdraw_owner_token_and_non_owner_rejected() {
    let mut f = setup();
    init_ok(&mut f);
    // Vault token account (PDA-owned) funded with 5,000,000 SFUSD.
    let vault_kp = Keypair::new();
    let vault_token = create_token_account(&mut f.svm, &f.owner, &vault_kp, &f.mint, &f.policy);
    let ix = ix_token_mint_to(&f.mint, &vault_token, &addr(&f.owner), 5_000_000);
    let res = send(&mut f.svm, &f.owner, &[&f.owner], ix);
    assert_ok(&res);
    assert_eq!(token_balance(&f.svm, &vault_token), 5_000_000);
    // Owner's destination token account.
    let dest_kp = Keypair::new();
    let dest_token = create_token_account(&mut f.svm, &f.owner, &dest_kp, &f.mint, &addr(&f.owner));
    let hash_before = read_bytes(&policy_data(&f.svm, &f.policy), policy_hash_off(2), 32);
    // Over-withdraw fails (my InsufficientFunds pre-check, 6009).
    let ix = ix_withdraw(&f.pid, &addr(&f.owner), &f.policy, &vault_token, &dest_token, 5_000_001);
    let res = send(&mut f.svm, &f.owner, &[&f.owner], ix);
    assert_custom(&res, 6009);
    // Valid withdraw moves tokens and leaves policy state intact.
    let ix = ix_withdraw(&f.pid, &addr(&f.owner), &f.policy, &vault_token, &dest_token, 2_000_000);
    let res = send(&mut f.svm, &f.owner, &[&f.owner], ix);
    assert_ok(&res);
    assert_eq!(token_balance(&f.svm, &vault_token), 3_000_000);
    assert_eq!(token_balance(&f.svm, &dest_token), 2_000_000);
    assert_eq!(read_bytes(&policy_data(&f.svm, &f.policy), policy_hash_off(2), 32), hash_before);
    // Non-owner (V12) fails.
    let attacker = funded(&mut f.svm);
    let ix = ix_withdraw(&f.pid, &addr(&attacker), &f.policy, &vault_token, &dest_token, 1000);
    let res = send(&mut f.svm, &attacker, &[&attacker], ix);
    assert_custom(&res, 6008);
    // Wrong mint (S6): a PDA-owned token account for a different mint.
    let wrong_mint_kp = Keypair::new();
    let wrong_mint = create_mint(&mut f.svm, &f.owner, &wrong_mint_kp, 6);
    let wrong_kp = Keypair::new();
    let wrong_vault = create_token_account(&mut f.svm, &f.owner, &wrong_kp, &wrong_mint, &f.policy);
    let ix = ix_token_mint_to(&wrong_mint, &wrong_vault, &addr(&f.owner), 1_000_000);
    let res = send(&mut f.svm, &f.owner, &[&f.owner], ix);
    assert_ok(&res);
    let ix = ix_withdraw(&f.pid, &addr(&f.owner), &f.policy, &wrong_vault, &dest_token, 1000);
    let res = send(&mut f.svm, &f.owner, &[&f.owner], ix);
    assert_custom(&res, 6007);
}

#[test]
fn reinit_fails_s12() {
    let mut f = setup();
    init_ok(&mut f);
    let ix = ix_initialize(
        &f.pid,
        &addr(&f.owner),
        &f.policy,
        1,
        6,
        &addr(&f.agent),
        2_000_000,
        5_000_000,
        86400,
        1000,
        0,
        &[f.alice, f.bob],
        &f.evm_hash,
        &f.mint,
    );
    let res = send(&mut f.svm, &f.owner, &[&f.owner], ix);
    assert_err(&res);
}

#[test]
fn substitution_fails_s8() {
    let mut f = setup();
    init_ok(&mut f);
    let fake = funded(&mut f.svm);
    let fake_addr = addr(&fake);
    // A non-PDA account in place of the policy must fail the seeds check.
    let ix = ix_set_policy(
        &f.pid,
        &addr(&f.owner),
        &fake_addr,
        1,
        6,
        3_000_000,
        9_000_000,
        3600,
        2000,
        0,
        &[f.alice, f.bob],
        &f.evm_hash,
    );
    let res = send(&mut f.svm, &f.owner, &[&f.owner], ix);
    assert_err(&res);
}
