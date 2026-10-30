//! T34 per-field tamper + replay matrix (Solana side).
//! Policy-level cases on LiteSVM (release mode):
//!   cargo test --release --test t34 -- --nocapture
//! Cases (one fresh SVM + policy per case):
//!  1. Tamper signer (attacker signs) -> Unauthorized.
//!  2. Tamper recipient (dest = attacker, not in set) -> RecipientNotAllowed.
//!  3. Replay after agent rotation (old agent re-spends) -> Unauthorized.
//!  4. Replay on a frozen vault (agent re-spends) -> Frozen.
//! Note (honest chain difference): on Solana there is no EIP-712
//! hash over fields, so tampering a field post-sign breaks the
//! transaction signature itself (the tx never reaches the program)
//! rather than returning the policy's Unauthorized label. Amount
//! tamper and second-deployment replay are therefore signature
//! rejections, not policy labels; the EVM side of T34 proves the
//! Unauthorized label for those (EIP-712 binds every field +
//! the vault address in the domain).

#[path = "common.rs"]
mod common;

use common::*;
use solana_address::Address;
use solana_keypair::Keypair;
use solana_signer::Signer;

fn label_for(res: &litesvm::types::TransactionResult) -> String {
    if res.is_ok() {
        return "ACCEPT".to_string();
    }
    match custom_code(res) {
        Some(6000) => "Unauthorized".to_string(),
        Some(6001) => "Frozen".to_string(),
        Some(6002) => "ZeroAmount".to_string(),
        Some(6003) => "RecipientNotAllowed".to_string(),
        Some(6004) => "DailyCapExceeded".to_string(),
        Some(6005) => "PerTxCapExceeded".to_string(),
        Some(6010) => "SessionExpired".to_string(),
        Some(c) => format!("Other({c})"),
        None => "UnknownErr".to_string(),
    }
}

struct Setup {
    svm: litesvm::LiteSVM,
    pid: Address,
    owner: Keypair,
    agent: Keypair,
    attacker: Keypair,
    policy: Address,
    vault_token: Address,
    merchant_token: Address,
    attacker_token: Address,
}

fn setup() -> Setup {
    let (mut svm, pid) = fresh_svm();
    let owner = funded(&mut svm);
    let agent = funded(&mut svm);
    let merchant = addr(&Keypair::new());
    let attacker = funded(&mut svm);
    let (policy, _bump) = policy_pda(&pid);
    let mint_kp = Keypair::new();
    let mint = create_mint(&mut svm, &owner, &mint_kp, 6);
    let ix = ix_initialize(
        &pid,
        &addr(&owner),
        &policy,
        1,
        6,
        &addr(&agent),
        2_000_000,
        5_000_000,
        86_400,
        1_000,
        10_000_000,
        &[merchant],
        &[7u8; 32],
        &mint,
    );
    let res = send(&mut svm, &owner, &[&owner], ix);
    assert_ok(&res);
    let vault_kp = Keypair::new();
    let vault_token = create_token_account(&mut svm, &owner, &vault_kp, &mint, &policy);
    let ix = ix_token_mint_to(&mint, &vault_token, &addr(&owner), 1_000_000_000_000);
    let res = send(&mut svm, &owner, &[&owner], ix);
    assert_ok(&res);
    let merchant_kp = Keypair::new();
    let merchant_token = create_token_account(&mut svm, &owner, &merchant_kp, &mint, &merchant);
    let attacker_kp = Keypair::new();
    let attacker_token =
        create_token_account(&mut svm, &owner, &attacker_kp, &mint, &addr(&attacker));
    Setup {
        svm,
        pid,
        owner,
        agent,
        attacker,
        policy,
        vault_token,
        merchant_token,
        attacker_token,
    }
}

#[test]
fn t34_sol_tamper_replay() {
    // 1. Tamper signer -> Unauthorized.
    {
        let mut s = setup();
        s.svm.expire_blockhash();
        let ix = ix_spend(&s.pid, &s.policy, &s.vault_token, &s.merchant_token, &addr(&s.attacker), 1_000_000);
        let res = send(&mut s.svm, &s.attacker, &[&s.attacker], ix);
        let actual = label_for(&res);
        println!("tamper-signer: expected Unauthorized got {actual}");
        assert_eq!(actual, "Unauthorized");
    }
    // 2. Tamper recipient -> RecipientNotAllowed.
    {
        let mut s = setup();
        s.svm.expire_blockhash();
        let ix = ix_spend(&s.pid, &s.policy, &s.vault_token, &s.attacker_token, &addr(&s.agent), 1_000_000);
        let res = send(&mut s.svm, &s.agent, &[&s.agent], ix);
        let actual = label_for(&res);
        println!("tamper-recipient: expected RecipientNotAllowed got {actual}");
        assert_eq!(actual, "RecipientNotAllowed");
    }
    // 3. Replay after agent rotation -> Unauthorized.
    {
        let mut s = setup();
        // Baseline valid spend by the original agent.
        s.svm.expire_blockhash();
        let ix = ix_spend(&s.pid, &s.policy, &s.vault_token, &s.merchant_token, &addr(&s.agent), 1_000_000);
        let res = send(&mut s.svm, &s.agent, &[&s.agent], ix);
        assert_eq!(label_for(&res), "ACCEPT");
        // Owner rotates the agent.
        let new_agent = funded(&mut s.svm);
        let ix = ix_set_agent(&s.pid, &addr(&s.owner), &s.policy, &addr(&new_agent));
        let res = send(&mut s.svm, &s.owner, &[&s.owner], ix);
        assert_ok(&res);
        // Old agent re-spends the same intent -> Unauthorized.
        s.svm.expire_blockhash();
        let ix = ix_spend(&s.pid, &s.policy, &s.vault_token, &s.merchant_token, &addr(&s.agent), 1_000_000);
        let res = send(&mut s.svm, &s.agent, &[&s.agent], ix);
        let actual = label_for(&res);
        println!("replay-after-rotation: expected Unauthorized got {actual}");
        assert_eq!(actual, "Unauthorized");
    }
    // 4. Replay on a frozen vault -> Frozen.
    {
        let mut s = setup();
        // Baseline valid spend.
        s.svm.expire_blockhash();
        let ix = ix_spend(&s.pid, &s.policy, &s.vault_token, &s.merchant_token, &addr(&s.agent), 1_000_000);
        let res = send(&mut s.svm, &s.agent, &[&s.agent], ix);
        assert_eq!(label_for(&res), "ACCEPT");
        // Owner freezes.
        let ix = ix_set_frozen(&s.pid, &addr(&s.owner), &s.policy, true);
        let res = send(&mut s.svm, &s.owner, &[&s.owner], ix);
        assert_ok(&res);
        // Agent re-spends the same intent -> Frozen.
        s.svm.expire_blockhash();
        let ix = ix_spend(&s.pid, &s.policy, &s.vault_token, &s.merchant_token, &addr(&s.agent), 1_000_000);
        let res = send(&mut s.svm, &s.agent, &[&s.agent], ix);
        let actual = label_for(&res);
        println!("replay-on-frozen: expected Frozen got {actual}");
        assert_eq!(actual, "Frozen");
    }
    println!("T34 SOL: 4/4 policy cases pass");
}
