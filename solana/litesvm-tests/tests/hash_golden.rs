//! T14 cross-language hash conformance: the Solana program's on-chain
//! policyHash must match all 5 T05 golden hashes
//! (policy/test/golden-hashes.json). The program receives the EVM set
//! hash as an initialize/set-policy parameter and computes the Solana
//! set hash itself (sorted pubkeys), so this test proves the Solana
//! side of the cross-chain hash. The EVM side is proven by
//! evm/test/Hash.t.sol against the same goldens.

#[path = "common.rs"]
mod common;

use common::*;
use litesvm::LiteSVM;
use solana_address::Address;
use solana_keypair::Keypair;

const SOL_A: &str = "43vyqgsiRgahQt4RcDAzCbnncHkwHLy9fhZz8nMDHfv6";
const SOL_B: &str = "8ogq7P8jYVUorg5DJwYBGZqjz3WoL8DG9Bwgya3B2MHH";

struct Case {
    name: &'static str,
    per_tx: u64,
    window_max: u64,
    window_secs: u64,
    anchor: i64,
    expiry: i64,
    sol: &'static [&'static str],
    evm_hash_hex: &'static str,
    policy_hash_hex: &'static str,
}

// Golden cases G1-G5 from policy/test/golden-hashes.json. G5 is G2 with
// recipient lists reversed and MUST hash identically to G2.
const CASES: &[Case] = &[
    Case {
        name: "G1",
        per_tx: 2_000_000,
        window_max: 5_000_000,
        window_secs: 86400,
        anchor: 1760000000,
        expiry: 1760086400,
        sol: &[SOL_A],
        evm_hash_hex: "1cc952a3c98a04b13efa328e9b0541472dda8a86cc311620203f3c250de07185",
        policy_hash_hex: "83a5665cf4043632bb2804323fe11659ede2b59bfb6e4bb5014885f3254b1003",
    },
    Case {
        name: "G2",
        per_tx: 1_000_000,
        window_max: 3_000_000,
        window_secs: 300,
        anchor: 1760000000,
        expiry: 1760086400,
        sol: &[SOL_A, SOL_B],
        evm_hash_hex: "83a1ec2e75ef1ef460a4f05e5455f5e221776606851c6f229e4fe977ca32aa86",
        policy_hash_hex: "7017b1560851daf96bb76a4ae39110b6b6c70d99903b400142b9d67a466f47d8",
    },
    Case {
        name: "G3",
        per_tx: 1,
        window_max: 1,
        window_secs: 60,
        anchor: 1760000000,
        expiry: 1760000180,
        sol: &[SOL_B],
        evm_hash_hex: "e1ab8e2a690a1f722f2e2ed183a719e9b855bf26b57e5f079dad59080a6d1db9",
        policy_hash_hex: "fc105fd9615d88e17549f5a433c0ddee4b6d2fff233bd0988a15ffbeb1655a0e",
    },
    Case {
        name: "G4",
        per_tx: 12345678901234567890,
        window_max: u64::MAX,
        window_secs: 31536000,
        anchor: 1893456000,
        expiry: 4102444800,
        sol: &[SOL_A],
        evm_hash_hex: "1cc952a3c98a04b13efa328e9b0541472dda8a86cc311620203f3c250de07185",
        policy_hash_hex: "037f68a2b85b10e20a29e2350de7731a591cb534e1e0fee4880dddec90917f98",
    },
    Case {
        name: "G5",
        per_tx: 1_000_000,
        window_max: 3_000_000,
        window_secs: 300,
        anchor: 1760000000,
        expiry: 1760086400,
        sol: &[SOL_B, SOL_A],
        evm_hash_hex: "83a1ec2e75ef1ef460a4f05e5455f5e221776606851c6f229e4fe977ca32aa86",
        policy_hash_hex: "7017b1560851daf96bb76a4ae39110b6b6c70d99903b400142b9d67a466f47d8",
    },
];

fn hex_bytes(s: &str) -> [u8; 32] {
    let b = s.as_bytes();
    assert_eq!(b.len(), 64, "expected 64 hex chars");
    let mut out = [0u8; 32];
    for i in 0..32 {
        let hi = (b[2 * i] as char).to_digit(16).unwrap() as u8;
        let lo = (b[2 * i + 1] as char).to_digit(16).unwrap() as u8;
        out[i] = (hi << 4) | lo;
    }
    out
}

fn sol_addrs(list: &[&str]) -> Vec<Address> {
    list.iter().map(|s| s.parse().unwrap()).collect()
}

struct Fixture {
    svm: LiteSVM,
    pid: Address,
    policy: Address,
    owner: Keypair,
    agent: Keypair,
    mint: Address,
}

fn setup() -> Fixture {
    let (mut svm, pid) = fresh_svm();
    let owner = funded(&mut svm);
    let agent = funded(&mut svm);
    let (policy, _bump) = policy_pda(&pid);
    let mint_kp = Keypair::new();
    let mint = create_mint(&mut svm, &owner, &mint_kp, 6);
    Fixture { svm, pid, policy, owner, agent, mint }
}

fn init_case(f: &mut Fixture, c: &Case) {
    let ix = ix_initialize(
        &f.pid,
        &addr(&f.owner),
        &f.policy,
        1,
        6,
        &addr(&f.agent),
        c.per_tx,
        c.window_max,
        c.window_secs,
        c.anchor,
        c.expiry,
        &sol_addrs(c.sol),
        &hex_bytes(c.evm_hash_hex),
        &f.mint,
    );
    let res = send(&mut f.svm, &f.owner, &[&f.owner], ix);
    assert_ok(&res);
}

fn stored_hash(f: &Fixture, n_sol: usize) -> [u8; 32] {
    let data = policy_data(&f.svm, &f.policy);
    read_bytes(&data, policy_hash_off(n_sol), 32).try_into().unwrap()
}

#[test]
fn hash_golden_all_five() {
    let mut computed: Vec<[u8; 32]> = Vec::new();
    for c in CASES {
        let mut f = setup();
        init_case(&mut f, c);
        let got = stored_hash(&f, c.sol.len());
        assert_eq!(got, hex_bytes(c.policy_hash_hex), "{} hash mismatch", c.name);
        computed.push(got);
    }
    // G5 (reversed recipients) must hash identically to G2.
    assert_eq!(computed[4], computed[1], "G5 != G2 (order invariance broken)");
}

#[test]
fn hash_set_policy_updates_to_golden() {
    let mut f = setup();
    init_case(&mut f, &CASES[0]);
    assert_eq!(stored_hash(&f, 1), hex_bytes(CASES[0].policy_hash_hex));
    let g2 = &CASES[1];
    let ix = ix_set_policy(
        &f.pid,
        &addr(&f.owner),
        &f.policy,
        1,
        6,
        g2.per_tx,
        g2.window_max,
        g2.window_secs,
        g2.anchor,
        g2.expiry,
        &sol_addrs(g2.sol),
        &hex_bytes(g2.evm_hash_hex),
    );
    let res = send(&mut f.svm, &f.owner, &[&f.owner], ix);
    assert_ok(&res);
    assert_eq!(stored_hash(&f, 2), hex_bytes(g2.policy_hash_hex));
}

#[test]
fn hash_tampered_field_differs() {
    let mut f = setup();
    init_case(&mut f, &CASES[0]);
    assert_eq!(stored_hash(&f, 1), hex_bytes(CASES[0].policy_hash_hex));
    let g1 = &CASES[0];
    let ix = ix_set_policy(
        &f.pid,
        &addr(&f.owner),
        &f.policy,
        1,
        6,
        g1.per_tx + 1,
        g1.window_max,
        g1.window_secs,
        g1.anchor,
        g1.expiry,
        &sol_addrs(g1.sol),
        &hex_bytes(g1.evm_hash_hex),
    );
    let res = send(&mut f.svm, &f.owner, &[&f.owner], ix);
    assert_ok(&res);
    assert_ne!(stored_hash(&f, 1), hex_bytes(g1.policy_hash_hex));
}
