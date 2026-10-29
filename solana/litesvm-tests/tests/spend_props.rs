//! T13 Solana property tests: proptest + LiteSVM.
//!
//! Acceptance: 10,000 cases, 0 failures; token-account invariants hold
//! (delegate = None, authority = PDA, close authority = None).
//! Bypass coverage: S3 (delegate on the vault token account) and S4
//! (set-authority / close on the vault token account).
//!
//! Graphify: Stateful and Differential Fuzzing (sequences of spends,
//! invariants checked after EVERY step, not just at the end) + Core
//! Rule (the agent's key holds nothing; only the vault moves funds).
//!
//! Properties (checked for every random case):
//!   P1 (S3/S4): after every spend attempt, successful or failed, the
//!       vault token account still has delegate = None, owner = the
//!       policy PDA, close authority = None. The program never calls
//!       approve, set-authority, or close, so these must never change.
//!   P2 (caps): every successful spend moves at most perTxMax, and the
//!       total successful in a window never exceeds windowMax.
//!   P3 (allowlist): no successful spend ever credits the attacker
//!       token account (attacker balance stays 0).
//!   P4 (conservation): vault + merchant + attacker balances always
//!       sum to the initial vault funding (spends only move funds,
//!       failed spends move nothing).
//! A second property checks window rollover via the Clock sysvar warp:
//! after warping past the window, spent resets and a new window's
//! spends are allowed up to windowMax again.

#[path = "common.rs"]
mod common;

use common::*;
use litesvm::LiteSVM;
use proptest::prelude::*;
use solana_address::Address;
use solana_clock::Clock;
use solana_keypair::Keypair;
use std::sync::atomic::{AtomicUsize, Ordering};

/// Progress counter for the main property test: prints a line every
/// 1000 cases so the run can be followed (proptest is silent until it
/// finishes otherwise).
static CASE_COUNT: AtomicUsize = AtomicUsize::new(0);

/// spent_in_window offset for n recipients: frozen (185+32n) + 1 +
/// current_window (8) = 194+32n. (Same layout as spend.rs.)
fn spent_off(n: usize) -> usize {
    194 + 32 * n
}

/// Classic TokenAccount layout (165 bytes): mint 0..32, owner 32..64,
/// amount 64..72, delegate COption tag at 72 (0 = None), state 108,
/// is_native 109..121, delegated_amount 121..129, close_authority
/// COption tag at 129 (0 = None).
fn check_vault_invariants(svm: &LiteSVM, vault_token: &Address, policy: &Address) {
    let data = svm
        .get_account(vault_token)
        .expect("vault token account missing")
        .data;
    // S3: delegate must be None.
    assert_eq!(read_u32(&data, 72), 0, "S3: vault token account gained a delegate");
    // S4a: owner (authority) must be the policy PDA.
    assert_eq!(
        read_bytes(&data, 32, 32),
        policy.as_ref().to_vec(),
        "S4: vault token account authority is not the policy PDA"
    );
    // S4b: close authority must be None.
    assert_eq!(
        read_u32(&data, 129),
        0,
        "S4: vault token account gained a close authority"
    );
}

struct PropFixture {
    svm: LiteSVM,
    pid: Address,
    policy: Address,
    owner: Keypair,
    agent: Keypair,
    attacker: Keypair,
    mint: Address,
    vault_token: Address,
    merchant_token: Address,
    attacker_token: Address,
    vault_funding: u64,
}

fn setup_prop(
    per_tx: u64,
    window_max: u64,
    window_secs: u64,
    anchor: i64,
    expiry: i64,
    vault_funding: u64,
) -> PropFixture {
    let (mut svm, pid) = fresh_svm();
    let owner = funded(&mut svm);
    let agent = funded(&mut svm);
    let attacker = funded(&mut svm);
    let merchant = addr(&Keypair::new());
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
        per_tx,
        window_max,
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
    let ix = ix_token_mint_to(&mint, &vault_token, &addr(&owner), vault_funding);
    let res = send(&mut svm, &owner, &[&owner], ix);
    assert_ok(&res);
    let merchant_kp = Keypair::new();
    let merchant_token = create_token_account(&mut svm, &owner, &merchant_kp, &mint, &merchant);
    let attacker_kp = Keypair::new();
    let attacker_token = create_token_account(&mut svm, &owner, &attacker_kp, &mint, &addr(&attacker));
    PropFixture {
        svm,
        pid,
        policy,
        owner,
        agent,
        attacker,
        mint,
        vault_token,
        merchant_token,
        attacker_token,
        vault_funding,
    }
}

fn spend_attempt(
    svm: &mut LiteSVM,
    pid: &Address,
    policy: &Address,
    vault_token: &Address,
    signer: &Keypair,
    dest_token: &Address,
    amount: u64,
) -> bool {
    let ix = ix_spend(pid, policy, vault_token, dest_token, &addr(signer), amount);
    let res = send(svm, signer, &[signer], ix);
    res.is_ok()
}

/// Same as spend_attempt but with a separate fee payer. Needed when
/// two spends are otherwise identical (same signer, dest, amount):
/// LiteSVM dedupes identical messages, so the second spend must differ
/// in payer. The policy ignores the payer (it only checks the agent
/// signer), so owner-as-payer is valid. Same trick as conformance V15.
fn spend_attempt_with_payer(
    svm: &mut LiteSVM,
    pid: &Address,
    policy: &Address,
    vault_token: &Address,
    payer: &Keypair,
    signer: &Keypair,
    dest_token: &Address,
    amount: u64,
) -> bool {
    let ix = ix_spend(pid, policy, vault_token, dest_token, &addr(signer), amount);
    let res = send(svm, payer, &[payer, signer], ix);
    res.is_ok()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(10_000))]
    #[test]
    fn spend_properties(
        per_tx in 1u64..10_000_001,
        window_max in 1u64..50_000_001,
        window_secs in 60u64..86_401,
        // (amount, dest 0=merchant/1=attacker, signer 0=agent/1=attacker)
        attempts in prop::collection::vec((0u64..20_000_001, 0u8..2, 0u8..2), 1..9),
    ) {
        // Anchor far in the past so the window is already open and
        // expiry is 0 (no expiry) for the main property.
        let n = CASE_COUNT.fetch_add(1, Ordering::Relaxed) + 1;
        if n % 1000 == 0 {
            eprintln!("T13 progress: {n}/10000 cases done");
        }
        let mut f = setup_prop(per_tx, window_max, window_secs, 1000, 0, 100_000_000);
        let mut window_total: u64 = 0;
        for (amount, dest_idx, signer_idx) in attempts {
            let dest = if dest_idx == 0 { f.merchant_token } else { f.attacker_token };
            let signer = if signer_idx == 0 { &f.agent } else { &f.attacker };
            let ok = spend_attempt(
                &mut f.svm, &f.pid, &f.policy, &f.vault_token, signer, &dest, amount,
            );
            // P1 (S3/S4): invariants hold after EVERY attempt.
            check_vault_invariants(&f.svm, &f.vault_token, &f.policy);
            if ok {
                // A successful spend must be agent-signed, to the
                // allowlisted merchant, within per-tx and window caps.
                prop_assert_eq!(signer_idx, 0, "non-agent signer succeeded");
                prop_assert_eq!(dest_idx, 0, "spend to non-allowlisted dest succeeded");
                prop_assert!(amount <= per_tx, "successful spend exceeded perTxMax");
                prop_assert!(amount > 0, "zero-amount spend succeeded");
                window_total = window_total.saturating_add(amount);
                prop_assert!(window_total <= window_max, "window total exceeded windowMax");
                prop_assert_eq!(
                    read_u64(&policy_data(&f.svm, &f.policy), spent_off(1)),
                    window_total,
                    "on-chain spent does not match successful total"
                );
            }
        }
        // P3: attacker never credited.
        prop_assert_eq!(token_balance(&f.svm, &f.attacker_token), 0);
        // P4: conservation (vault + merchant + attacker == funding).
        let total = token_balance(&f.svm, &f.vault_token)
            + token_balance(&f.svm, &f.merchant_token)
            + token_balance(&f.svm, &f.attacker_token);
        prop_assert_eq!(total, f.vault_funding);
        // Spent on-chain matches the successful total.
        prop_assert_eq!(
            read_u64(&policy_data(&f.svm, &f.policy), spent_off(1)),
            window_total
        );
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(200))]
    #[test]
    fn window_rollover_resets_spent(
        per_tx in 1u64..5_000_001,
        window_max in 1u64..10_000_001,
    ) {
        // Small window (300s). The clock starts at LiteSVM's now, so
        // the first spend lands in the current window; warping 100,000s
        // ahead (>> 300s) forces a new window index, which must reset
        // spent.
        let mut f = setup_prop(per_tx, window_max, 300, 0, 0, 100_000_000);
        let now = f.svm.get_sysvar::<Clock>().unix_timestamp;
        // Spend once in the first window (if it fits the caps).
        let first = per_tx.min(window_max);
        if first > 0 {
            let ok = spend_attempt(
                &mut f.svm, &f.pid, &f.policy, &f.vault_token, &f.agent, &f.merchant_token, first,
            );
            prop_assert!(ok, "first-window spend should succeed");
            prop_assert_eq!(
                read_u64(&policy_data(&f.svm, &f.policy), spent_off(1)),
                first
            );
        }
        // Warp far past the window (100,000s >> 300s window) so the
        // window index changes and spent must reset.
        let mut clock = f.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = now + 100_000;
        f.svm.set_sysvar::<Clock>(&clock);
        // A spend in the new window should succeed up to the caps
        // again, and spent should reset (not old + new). Owner pays
        // so the message differs from the first spend (LiteSVM dedupes
        // identical messages); the policy ignores the payer.
        let second = per_tx.min(window_max);
        if second > 0 {
            let ok = spend_attempt_with_payer(
                &mut f.svm, &f.pid, &f.policy, &f.vault_token, &f.owner, &f.agent, &f.merchant_token, second,
            );
            prop_assert!(ok, "post-rollover spend should succeed");
            prop_assert_eq!(
                read_u64(&policy_data(&f.svm, &f.policy), spent_off(1)),
                second,
                "spent did not reset on rollover"
            );
        }
        // Invariants still hold after the warp + spends.
        check_vault_invariants(&f.svm, &f.vault_token, &f.policy);
    }
}
