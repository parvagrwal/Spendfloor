//! T17 local Solana conformance: V1-V18 in order on LiteSVM, mirroring
//! the EVM runner (conformance/run-local-evm.ts). Writes results JSON
//! to evidence/T17/sol-local.json (for the compare step). V15/V16 use
//! the Clock sysvar warp (LiteSVM set_sysvar); V17 is the documented
//! evidence difference (Solana duplicate does not land, vs EVM BadNonce
//! which lands). V12 expects NotOwner (6008) on both chains; the plan's
//! "Unauthorized" is the generic term for the owner-check error.

#[path = "common.rs"]
mod common;

use common::*;
use litesvm::types::TransactionResult;
use litesvm::LiteSVM;
use solana_address::Address;
use solana_clock::Clock;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;

fn spent_off(n: usize) -> usize {
    194 + 32 * n
}

struct Fixture {
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

fn setup_policy(window_secs: u64, expiry: i64) -> Fixture {
    let (mut svm, pid) = fresh_svm();
    let owner = funded(&mut svm);
    let agent = funded(&mut svm);
    let merchant = addr(&Keypair::new());
    let attacker = funded(&mut svm);
    let (policy, _bump) = policy_pda(&pid);
    let mint_kp = Keypair::new();
    let mint = create_mint(&mut svm, &owner, &mint_kp, 6);
    let now = svm.get_sysvar::<Clock>().unix_timestamp;
    let anchor = now;
    let ix = ix_initialize(
        &pid,
        &addr(&owner),
        &policy,
        1,
        6,
        &addr(&agent),
        2_000_000,
        5_000_000,
        window_secs,
        anchor,
        expiry,
        &[merchant],
        &[7u8; 32],
        &mint,
    );
    let res = send(&mut svm, &owner, &[&owner], ix);
    assert_ok(&res);
    let vault_kp = Keypair::new();
    let vault_token = create_token_account(&mut svm, &owner, &vault_kp, &mint, &policy);
    let ix = ix_token_mint_to(&mint, &vault_token, &addr(&owner), 10_000_000);
    let res = send(&mut svm, &owner, &[&owner], ix);
    assert_ok(&res);
    let merchant_kp = Keypair::new();
    let merchant_token = create_token_account(&mut svm, &owner, &merchant_kp, &mint, &merchant);
    let attacker_kp = Keypair::new();
    let attacker_token = create_token_account(&mut svm, &owner, &attacker_kp, &mint, &addr(&attacker));
    Fixture { svm, pid, policy, owner, agent, merchant, attacker, mint, vault_token, merchant_token, attacker_token }
}

fn spend_as(
    svm: &mut LiteSVM,
    pid: &Address,
    policy: &Address,
    vault_token: &Address,
    signer: &Keypair,
    dest_token: &Address,
    amount: u64,
) -> TransactionResult {
    let ix = ix_spend(pid, policy, vault_token, dest_token, &addr(signer), amount);
    send(svm, signer, &[signer], ix)
}

fn spent(f: &Fixture) -> u64 {
    read_u64(&policy_data(&f.svm, &f.policy), spent_off(1))
}

fn label_of(res: &TransactionResult) -> String {
    match res {
        Ok(_) => "ACCEPT".to_string(),
        Err(e) => {
            if let Some(code) = custom_code(res) {
                match code {
                    6000 => "Unauthorized".to_string(),
                    6001 => "Frozen".to_string(),
                    6002 => "ZeroAmount".to_string(),
                    6003 => "RecipientNotAllowed".to_string(),
                    6004 => "DailyCapExceeded".to_string(),
                    6005 => "PerTxCapExceeded".to_string(),
                    6008 => "NotOwner".to_string(),
                    6010 => "SessionExpired".to_string(),
                    _ => format!("Custom{code}"),
                }
            } else {
                format!("Err:{e:?}")
            }
        }
    }
}

fn warp_clock(svm: &mut LiteSVM, target_unix: i64) {
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = target_unix;
    svm.set_sysvar::<Clock>(&clock);
}

struct Rec {
    vector: &'static str,
    expected: &'static str,
    actual: String,
    pass: bool,
}

#[test]
fn conformance_v1_to_v18() {
    let mut out: Vec<Rec> = Vec::new();
    let mut rec = |vector: &'static str, expected: &'static str, actual: String| {
        let pass = actual == expected;
        println!("{vector}: expected={expected} actual={actual} {}", if pass { "PASS" } else { "FAIL" });
        out.push(Rec { vector, expected, actual, pass });
    };

    // --- P0: V1-V14 + V17 + V18 ---
    let mut f = setup_policy(86400, 0);
    // V1 via manual tx (saved for V17 replay).
    let v1_ix = ix_spend(&f.pid, &f.policy, &f.vault_token, &f.merchant_token, &addr(&f.agent), 1_000_000);
    let blockhash = f.svm.latest_blockhash();
    let v1_tx = Transaction::new_signed_with_payer(
        &[v1_ix],
        Some(&addr(&f.agent)),
        &[&f.agent],
        blockhash,
    );
    let v1_res = f.svm.send_transaction(v1_tx.clone());
    rec("V1", "ACCEPT", label_of(&v1_res));
    assert_eq!(spent(&f), 1_000_000);
    // V2: attacker 0.000001 -> RecipientNotAllowed (6003).
    let res = spend_as(&mut f.svm, &f.pid, &f.policy, &f.vault_token, &f.agent, &f.attacker_token, 1);
    rec("V2", "RecipientNotAllowed", label_of(&res));
    // V3: attacker, full balance -> RecipientNotAllowed.
    let res = spend_as(&mut f.svm, &f.pid, &f.policy, &f.vault_token, &f.agent, &f.attacker_token, 10_000_000);
    rec("V3", "RecipientNotAllowed", label_of(&res));
    // V4: merchant 0 -> ZeroAmount (6002).
    let res = spend_as(&mut f.svm, &f.pid, &f.policy, &f.vault_token, &f.agent, &f.merchant_token, 0);
    rec("V4", "ZeroAmount", label_of(&res));
    // V5: merchant 2.000001 (spent 1) -> PerTxCapExceeded (6005).
    let res = spend_as(&mut f.svm, &f.pid, &f.policy, &f.vault_token, &f.agent, &f.merchant_token, 2_000_001);
    rec("V5", "PerTxCapExceeded", label_of(&res));
    assert_eq!(spent(&f), 1_000_000);
    // V6: merchant 2.0 -> ACCEPT (spent 3).
    let res = spend_as(&mut f.svm, &f.pid, &f.policy, &f.vault_token, &f.agent, &f.merchant_token, 2_000_000);
    rec("V6", "ACCEPT", label_of(&res));
    assert_eq!(spent(&f), 3_000_000);
    // V7: merchant 6.0 -> DailyCapExceeded (6004).
    let res = spend_as(&mut f.svm, &f.pid, &f.policy, &f.vault_token, &f.agent, &f.merchant_token, 6_000_000);
    rec("V7", "DailyCapExceeded", label_of(&res));
    // V8: merchant u64::MAX -> DailyCapExceeded, no overflow.
    let res = spend_as(&mut f.svm, &f.pid, &f.policy, &f.vault_token, &f.agent, &f.merchant_token, u64::MAX);
    rec("V8", "DailyCapExceeded", label_of(&res));
    assert_eq!(spent(&f), 3_000_000);
    // V9: merchant 2.0 -> ACCEPT (spent 5). Owner pays so the message
    // differs from V6's identical agent-payer spend (LiteSVM dedupes).
    let ix = ix_spend(&f.pid, &f.policy, &f.vault_token, &f.merchant_token, &addr(&f.agent), 2_000_000);
    let res = send(&mut f.svm, &f.owner, &[&f.owner, &f.agent], ix);
    rec("V9", "ACCEPT", label_of(&res));
    assert_eq!(spent(&f), 5_000_000);
    // V10: merchant 0.000001 (spent 5) -> DailyCapExceeded.
    let res = spend_as(&mut f.svm, &f.pid, &f.policy, &f.vault_token, &f.agent, &f.merchant_token, 1);
    rec("V10", "DailyCapExceeded", label_of(&res));
    // V11: recipient = the vault itself (a token account owned by the
    // policy PDA, NOT the vault token account itself — using the vault
    // token account as dest triggers Anchor's duplicate-account check
    // 2040 before the program's recipient check, as in S13).
    let pda_kp = Keypair::new();
    let pda_token = create_token_account(&mut f.svm, &f.owner, &pda_kp, &f.mint, &f.policy);
    let res = spend_as(&mut f.svm, &f.pid, &f.policy, &f.vault_token, &f.agent, &pda_token, 1);
    rec("V11", "RecipientNotAllowed", label_of(&res));
    // V12: agent attempts all four owner functions -> NotOwner (6008).
    let mut all_not_owner = true;
    let agent_dest_kp = Keypair::new();
    let agent_dest = create_token_account(&mut f.svm, &f.owner, &agent_dest_kp, &f.mint, &addr(&f.agent));
    let attempts = [
        ix_set_policy(&f.pid, &addr(&f.agent), &f.policy, 1, 6, 2_000_000, 5_000_000, 86400, 1000, 0, &[f.merchant], &[7u8; 32]),
        ix_set_agent(&f.pid, &addr(&f.agent), &f.policy, &f.merchant),
        ix_set_frozen(&f.pid, &addr(&f.agent), &f.policy, true),
        ix_withdraw(&f.pid, &addr(&f.agent), &f.policy, &f.vault_token, &agent_dest, 1000),
    ];
    for ix in attempts {
        let res = send(&mut f.svm, &f.agent, &[&f.agent], ix);
        if custom_code(&res) != Some(6008) {
            all_not_owner = false;
        }
    }
    rec("V12", "NotOwner", if all_not_owner { "NotOwner".to_string() } else { "other".to_string() });
    // V13: owner freezes -> merchant spend -> Frozen (6001).
    let ix = ix_set_frozen(&f.pid, &addr(&f.owner), &f.policy, true);
    let res = send(&mut f.svm, &f.owner, &[&f.owner], ix);
    assert_ok(&res);
    let ix = ix_spend(&f.pid, &f.policy, &f.vault_token, &f.merchant_token, &addr(&f.agent), 1);
    let res = send(&mut f.svm, &f.owner, &[&f.owner, &f.agent], ix);
    rec("V13", "Frozen", label_of(&res));
    // V14: owner unfreezes -> merchant spend -> DailyCapExceeded (spent 5).
    let ix = ix_set_frozen(&f.pid, &addr(&f.owner), &f.policy, false);
    let res = send(&mut f.svm, &f.owner, &[&f.owner], ix);
    assert_ok(&res);
    let submitter = funded(&mut f.svm);
    let ix = ix_spend(&f.pid, &f.policy, &f.vault_token, &f.merchant_token, &addr(&f.agent), 1);
    let res = send(&mut f.svm, &submitter, &[&submitter, &f.agent], ix);
    rec("V14", "DailyCapExceeded", label_of(&res));
    assert_eq!(spent(&f), 5_000_000);
    // V17: resubmit V1's exact tx -> duplicate, does not land (spent unchanged).
    let spent_before = spent(&f);
    let res = f.svm.send_transaction(v1_tx);
    let duplicate = res.is_err();
    let spent_after = spent(&f);
    let actual = if duplicate && spent_after == spent_before { "duplicate (does not land)".to_string() } else { format!("landed or spent changed (err={duplicate}, before={spent_before}, after={spent_after})") };
    rec("V17", "duplicate (does not land)", actual);
    // V18: attacker-signed spend -> Unauthorized (6000).
    let res = spend_as(&mut f.svm, &f.pid, &f.policy, &f.vault_token, &f.attacker, &f.merchant_token, 1_000_000);
    rec("V18", "Unauthorized", label_of(&res));

    // --- P1: V15 rollover via Clock warp ---
    {
        let mut p = setup_policy(300, 0);
        let anchor = p.svm.get_sysvar::<Clock>().unix_timestamp;
        // Spend 1 (window [anchor, anchor+300)), then warp past it.
        let res = spend_as(&mut p.svm, &p.pid, &p.policy, &p.vault_token, &p.agent, &p.merchant_token, 1_000_000);
        assert_ok(&res);
        assert_eq!(spent(&p), 1_000_000);
        warp_clock(&mut p.svm, anchor + 301);
        // Owner pays so the message differs from the setup spend
        // (LiteSVM dedupes identical messages); the policy ignores payer.
        let ix = ix_spend(&p.pid, &p.policy, &p.vault_token, &p.merchant_token, &addr(&p.agent), 1_000_000);
        let res = send(&mut p.svm, &p.owner, &[&p.owner, &p.agent], ix);
        rec("V15", "ACCEPT", label_of(&res));
    }
    // --- P2: V16 expiry via Clock warp ---
    {
        let mut p = setup_policy(86400, 0);
        // Re-init a P2 policy with expiry = now + 180 via set_policy
        // (owner). setup_policy gives expiry 0; set it to now+180.
        let now = p.svm.get_sysvar::<Clock>().unix_timestamp;
        let ix = ix_set_policy(&p.pid, &addr(&p.owner), &p.policy, 1, 6, 2_000_000, 5_000_000, 86400, now, now + 180, &[p.merchant], &[7u8; 32]);
        let res = send(&mut p.svm, &p.owner, &[&p.owner], ix);
        assert_ok(&res);
        warp_clock(&mut p.svm, now + 181);
        let res = spend_as(&mut p.svm, &p.pid, &p.policy, &p.vault_token, &p.agent, &p.merchant_token, 1);
        rec("V16", "SessionExpired", label_of(&res));
    }

    let passed = out.iter().filter(|r| r.pass).count();
    println!("SOL local: {passed}/{} pass", out.len());
    let mut json = String::from("{\"chain\":\"sol\",\"net\":\"local\",\"results\":[");
    for (i, r) in out.iter().enumerate() {
        if i > 0 {
            json.push(',');
        }
        json.push_str(&format!(
            "{{\"vector\":\"{}\",\"expected\":\"{}\",\"actual\":\"{}\",\"pass\":{}}}",
            r.vector, r.expected, r.actual.replace('"', "'"), r.pass
        ));
    }
    json.push_str("]}");
    let dir = format!("{}/../../evidence/T17", env!("CARGO_MANIFEST_DIR"));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(format!("{dir}/sol-local.json"), json).unwrap();
    assert_eq!(passed, out.len(), "SOL local conformance failed");
}
