//! T33 precedence matrix runner (Solana side): replays the 80
//! feasible simultaneous-violation combinations from
//! precedence-matrix.txt on LiteSVM and compares every outcome
//! label to the expected winner (first label in precedence
//! order present in the combination). Run (release mode):
//!   cargo test --release --test precedence -- --nocapture
//! One fresh SVM + policy per case (so spent/window start clean).
//! Buildup spends (only when Unauthorized/Frozen/SessionExpired
//! are all absent, i.e. when spent matters to the winner) bring
//! spent to the case's value before the test spend.
//! expire_blockhash() is called before every spend so identical
//! consecutive spends are not deduped by LiteSVM (T13 lesson).

#[path = "common.rs"]
mod common;

use common::*;
use litesvm::LiteSVM;
use solana_address::Address;
use solana_clock::Clock;
use solana_keypair::Keypair;
use solana_signer::Signer;

fn warp_clock(svm: &mut LiteSVM, target_unix: i64) {
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = target_unix;
    svm.set_sysvar::<Clock>(&clock);
}

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

#[test]
fn precedence_sol_vs_matrix() {
    let path = format!(
        "{}/../../evidence/T33/precedence-matrix.txt",
        env!("CARGO_MANIFEST_DIR")
    );
    let text = std::fs::read_to_string(&path)
        .expect("precedence-matrix.txt missing; run precedence-matrix-gen.ts first");
    let mut cases = 0usize;
    let mut fails = 0usize;
    let mut fail_list: Vec<String> = Vec::new();
    for line in text.lines() {
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split(',').collect();
        assert_eq!(parts[0], "CASE", "bad line: {line}");
        let idx: usize = parts[1].parse().unwrap();
        let subset = parts[2];
        let sk = parts[3];
        let frozen: bool = parts[4] == "1";
        let now: i64 = parts[5].parse().unwrap();
        let expiry: i64 = parts[6].parse().unwrap();
        let amount: u64 = parts[7].parse().unwrap();
        let spent_target: u64 = parts[8].parse().unwrap();
        let rk = parts[9];
        let expected = parts[10];

        // --- fresh SVM + policy per case ---
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
            expiry,
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
        let attacker_token = create_token_account(&mut svm, &owner, &attacker_kp, &mint, &addr(&attacker));
        if frozen {
            let ix = ix_set_frozen(&pid, &addr(&owner), &policy, true);
            let res = send(&mut svm, &owner, &[&owner], ix);
            assert_ok(&res);
        }
        warp_clock(&mut svm, now);

        // --- buildup (only when U/F/E absent, i.e. spent matters) ---
        let needs_buildup = !subset.contains("Unauthorized")
            && !subset.contains("Frozen")
            && !subset.contains("SessionExpired");
        if needs_buildup {
            let mut remaining = spent_target;
            while remaining > 0 {
                let chunk = remaining.min(2_000_000);
                svm.expire_blockhash();
                let ix = ix_spend(&pid, &policy, &vault_token, &merchant_token, &addr(&agent), chunk);
                let res = send(&mut svm, &agent, &[&agent], ix);
                assert_ok(&res);
                remaining -= chunk;
            }
        }

        // --- test spend ---
        let signer = if sk == "G" { &agent } else { &attacker };
        let dest = if rk == "M" { &merchant_token } else { &attacker_token };
        svm.expire_blockhash();
        let ix = ix_spend(&pid, &policy, &vault_token, dest, &addr(signer), amount);
        let res = send(&mut svm, signer, &[signer], ix);
        let actual = label_for(&res);
        cases += 1;
        if actual != expected {
            fails += 1;
            let f = format!("CASE {idx} [{subset}] expected {expected} got {actual}");
            println!("MISMATCH: {f}");
            fail_list.push(f);
        }
    }
    println!("SOL precedence: {cases} cases, {fails} mismatches");
    for f in &fail_list {
        println!("MISMATCH: {f}");
    }
    assert_eq!(fails, 0, "SOL precedence matrix diverged on {fails} cases");
}
