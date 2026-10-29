// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

// T14 cross-language hash conformance: the EVM vault's on-chain
// policyHash must match all 5 T05 golden hashes
// (policy/test/golden-hashes.json). The golden preimage is the 122-byte
// T05 canonical encoding (tag + BE integers + both chains' set hashes),
// hashed with SHA-256. The vault receives the Solana set hash as a
// setPolicy parameter and computes the EVM set hash itself (sorted
// recipients), so this test proves the EVM side of the cross-chain
// hash. The Rust side is proven by solana/litesvm-tests/tests/
// hash_golden.rs against the same goldens. No forge-std by design:
// the minimal cheatcode interface below keeps evm/ dependency-free
// apart from the vendored OpenZeppelin contracts the vault uses.

import "../src/SpendFloorVault.sol";
import "../src/SFUSD.sol";

interface Vm {
    function addr(uint256) external returns (address);
}

Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

contract HashConformanceTest {
    SFUSD token;
    address agent;

    // Golden EVM recipients (from golden-hashes.json).
    address constant EVM_A = address(0x00000000000000000000000000000000000A11cE);
    address constant EVM_B = address(0x0000000000000000000000000000000000000B0b);

    // Golden Solana set hashes (the vault receives these as a parameter).
    bytes32 constant SOL_SET_G1 = 0x5bcd0ce1532604f98c543350c23a78e32babd79b839e565ebfdede3be3fdcbe2;
    bytes32 constant SOL_SET_G2 = 0xe2538abfab314136d5f3a337383cb353f8d59065062064ffc8244de64a9729cf;
    bytes32 constant SOL_SET_G3 = 0xd33c50959a25c19da210c768af233947b676e8a2f1cd15b905c6b7176c82cdba;

    // Golden policy hashes.
    bytes32 constant HASH_G1 = 0x83a5665cf4043632bb2804323fe11659ede2b59bfb6e4bb5014885f3254b1003;
    bytes32 constant HASH_G2 = 0x7017b1560851daf96bb76a4ae39110b6b6c70d99903b400142b9d67a466f47d8;
    bytes32 constant HASH_G3 = 0xfc105fd9615d88e17549f5a433c0ddee4b6d2fff233bd0988a15ffbeb1655a0e;
    bytes32 constant HASH_G4 = 0x037f68a2b85b10e20a29e2350de7731a591cb534e1e0fee4880dddec90917f98;

    function setUp() public {
        agent = vm.addr(0xC0FFEE);
        token = new SFUSD();
    }

    function deployWith(
        uint64 perTxMax_,
        uint64 windowMax_,
        uint64 windowSeconds_,
        int64 windowAnchor_,
        int64 expiresAt_,
        address[] memory evmRecipients_,
        bytes32 solSetHash_
    ) internal returns (SpendFloorVault) {
        return new SpendFloorVault(
            address(token),
            agent,
            1,
            6,
            perTxMax_,
            windowMax_,
            windowSeconds_,
            windowAnchor_,
            expiresAt_,
            evmRecipients_,
            solSetHash_
        );
    }

    function oneRecipient(address a) internal pure returns (address[] memory) {
        address[] memory r = new address[](1);
        r[0] = a;
        return r;
    }

    function twoRecipients(address a, address b) internal pure returns (address[] memory) {
        address[] memory r = new address[](2);
        r[0] = a;
        r[1] = b;
        return r;
    }

    // G1: P0, per-tx 2, window 5 per 86400 s, expiry +24 h, one recipient.
    function testHashGoldenG1() public {
        SpendFloorVault v = deployWith(
            2000000, 5000000, 86400, int64(1760000000), int64(1760086400),
            oneRecipient(EVM_A), SOL_SET_G1
        );
        require(v.policyHash() == HASH_G1, "G1 hash mismatch");
    }

    // G2: P1-style short window (300 s) with two recipients.
    function testHashGoldenG2() public {
        SpendFloorVault v = deployWith(
            1000000, 3000000, 300, int64(1760000000), int64(1760086400),
            twoRecipients(EVM_A, EVM_B), SOL_SET_G2
        );
        require(v.policyHash() == HASH_G2, "G2 hash mismatch");
    }

    // G3: P2-style short expiry (+180 s), minimum amounts, minimum window.
    function testHashGoldenG3() public {
        SpendFloorVault v = deployWith(
            1, 1, 60, int64(1760000000), int64(1760000180),
            oneRecipient(EVM_B), SOL_SET_G3
        );
        require(v.policyHash() == HASH_G3, "G3 hash mismatch");
    }

    // G4: u64-max window, >2^53 per-tx value, i64 times past u32 range.
    function testHashGoldenG4() public {
        SpendFloorVault v = deployWith(
            uint64(12345678901234567890), type(uint64).max, 31536000,
            int64(1893456000), int64(4102444800),
            oneRecipient(EVM_A), SOL_SET_G1
        );
        require(v.policyHash() == HASH_G4, "G4 hash mismatch");
    }

    // G5: same policy as G2 with recipient lists reversed. MUST produce
    // the identical policyHash as G2 (sets are sorted before hashing).
    function testHashGoldenG5OrderInvariance() public {
        SpendFloorVault v = deployWith(
            1000000, 3000000, 300, int64(1760000000), int64(1760086400),
            twoRecipients(EVM_B, EVM_A), SOL_SET_G2
        );
        require(v.policyHash() == HASH_G2, "G5 hash mismatch (order invariance broken)");
    }

    // Negative guard: a tampered field must NOT produce the golden hash.
    // Without this, a test that compared a constant to itself would pass.
    function testHashTamperedFieldDiffers() public {
        SpendFloorVault v = deployWith(
            2000001, 5000000, 86400, int64(1760000000), int64(1760086400),
            oneRecipient(EVM_A), SOL_SET_G1
        );
        require(v.policyHash() != HASH_G1, "tampered policy still matches G1");
    }
}
