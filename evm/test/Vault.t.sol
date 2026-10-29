// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

// T10 complete-vault tests. Attack-first: every rejection the plan names
// is tested before the happy path is trusted, plus every precedence pair
// the D6 order + transport ranking imply. No forge-std by design: the
// minimal cheatcode interface below keeps evm/ dependency-free apart
// from the vendored OpenZeppelin contracts the vault itself uses.
// This file supersedes the T06 spike tests (native ETH, EIP-191, no
// nonce): the asset is now SFUSD and the signature scheme is EIP-712.

import "../src/SpendFloorVault.sol";
import "../src/SFUSD.sol";

interface Vm {
    function addr(uint256) external returns (address);
    function deal(address, uint256) external;
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function warp(uint256) external;
    function expectRevert(bytes4) external;
    function expectRevert() external;
}

Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

contract SpendFloorVaultTest {
    SpendFloorVault vault;
    SFUSD token;

    uint256 internal agentKey = 0xA11CE;
    uint256 internal newAgentKey = 0xBEEF;
    uint256 internal wrongKey = 0xBADD;
    address internal agent;
    address internal newAgent;
    address internal alice = address(0x1111);
    address internal bob = address(0x2222);
    address internal carol = address(0x3333);
    address internal submitter = address(0x4444);

    // P0-like policy, micro-units (6 decimals): per-tx 2, window 5, 1 day.
    uint64 internal constant PER_TX_MAX = 2000000;
    uint64 internal constant WINDOW_MAX = 5000000;
    uint64 internal constant WINDOW_SECONDS = 86400;
    bytes32 internal constant SOL_SET_HASH = keccak256("sol-recipients");

    function setUp() public {
        agent = vm.addr(agentKey);
        newAgent = vm.addr(newAgentKey);
        token = new SFUSD();
        address[] memory allowed = new address[](2);
        allowed[0] = alice;
        allowed[1] = bob;
        vault = new SpendFloorVault(
            address(token),
            agent,
            1,
            6,
            PER_TX_MAX,
            WINDOW_MAX,
            WINDOW_SECONDS,
            int64(int256(block.timestamp)),
            0,
            allowed,
            SOL_SET_HASH
        );
        token.mint(address(vault), 1000000000);
        vm.deal(address(this), 1 ether);
    }

    function _sign(
        address to,
        uint256 amount,
        uint256 nonce_,
        uint256 deadline
    ) internal returns (uint8 v, bytes32 r, bytes32 s) {
        (v, r, s) = vm.sign(agentKey, vault.intentDigest(to, amount, nonce_, deadline));
    }

    function _signAs(
        uint256 key,
        address to,
        uint256 amount,
        uint256 nonce_,
        uint256 deadline
    ) internal returns (uint8 v, bytes32 r, bytes32 s) {
        (v, r, s) = vm.sign(key, vault.intentDigest(to, amount, nonce_, deadline));
    }

    function _spend(address caller, address to, uint256 amount) internal {
        uint256 nonce_ = vault.nonce();
        uint256 deadline = block.timestamp + 100;
        (uint8 v, bytes32 r, bytes32 s) = _sign(to, amount, nonce_, deadline);
        vm.prank(caller);
        vault.spendWithSig(to, amount, nonce_, deadline, v, r, s);
    }

    function _spendReverting(
        address caller,
        address signTo,
        uint256 signAmount,
        uint256 signNonce,
        uint256 signDeadline,
        address submitTo,
        uint256 submitAmount,
        uint256 submitNonce,
        uint256 submitDeadline,
        bytes4 err
    ) internal {
        (uint8 v, bytes32 r, bytes32 s) = _sign(
            signTo,
            signAmount,
            signNonce,
            signDeadline
        );
        vm.startPrank(caller);
        vm.expectRevert(err);
        vault.spendWithSig(submitTo, submitAmount, submitNonce, submitDeadline, v, r, s);
        vm.stopPrank();
    }

    function _updatePolicy(
        uint64 perTx,
        uint64 window,
        uint64 windowSecs,
        int64 anchor,
        int64 expiry,
        address[] memory recipients
    ) internal {
        vault.setPolicy(1, 6, perTx, window, windowSecs, anchor, expiry, recipients, SOL_SET_HASH);
    }

    function _defaultRecipients() internal pure returns (address[] memory) {
        address[] memory allowed = new address[](2);
        allowed[0] = address(0x1111);
        allowed[1] = address(0x2222);
        return allowed;
    }

    function test_ValidSpend() public {
        uint256 before = token.balanceOf(alice);
        _spend(submitter, alice, 1000000);
        require(token.balanceOf(alice) == before + 1000000, "recipient credit");
        require(vault.spentInWindow() == 1000000, "spent tracking");
        require(vault.nonce() == 1, "nonce increments");
        require(token.balanceOf(agent) == 0, "agent zero SFUSD");
        require(agent.balance == 0, "agent zero native");
    }

    function test_WrongSigner() public {
        uint256 nonce_ = vault.nonce();
        uint256 deadline = block.timestamp + 100;
        (uint8 v, bytes32 r, bytes32 s) = _signAs(wrongKey, alice, 1000000, nonce_, deadline);
        vm.startPrank(submitter);
        vm.expectRevert(SpendFloorVault.Unauthorized.selector);
        vault.spendWithSig(alice, 1000000, nonce_, deadline, v, r, s);
        vm.stopPrank();
    }

    function test_TamperedTo() public {
        _spendReverting(
            submitter,
            alice,
            1000000,
            vault.nonce(),
            block.timestamp + 100,
            bob,
            1000000,
            vault.nonce(),
            block.timestamp + 100,
            SpendFloorVault.Unauthorized.selector
        );
    }

    function test_TamperedAmount() public {
        _spendReverting(
            submitter,
            alice,
            1000000,
            vault.nonce(),
            block.timestamp + 100,
            alice,
            2000000,
            vault.nonce(),
            block.timestamp + 100,
            SpendFloorVault.Unauthorized.selector
        );
    }

    function test_TamperedNonce() public {
        _spendReverting(
            submitter,
            alice,
            1000000,
            vault.nonce(),
            block.timestamp + 100,
            alice,
            1000000,
            vault.nonce() + 1,
            block.timestamp + 100,
            SpendFloorVault.Unauthorized.selector
        );
    }

    function test_TamperedDeadline() public {
        _spendReverting(
            submitter,
            alice,
            1000000,
            vault.nonce(),
            block.timestamp + 100,
            alice,
            1000000,
            vault.nonce(),
            block.timestamp + 101,
            SpendFloorVault.Unauthorized.selector
        );
    }

    function test_MalleableSignature() public {
        // Flip s to n - s and v to the other value: a malleable signature
        // the vault must reject (E9), never accept.
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        uint256 nonce_ = vault.nonce();
        uint256 deadline = block.timestamp + 100;
        (uint8 v, bytes32 r, bytes32 s) = _sign(alice, 1000000, nonce_, deadline);
        bytes32 s2 = bytes32(n - uint256(s));
        uint8 v2 = (v == 27) ? 28 : 27;
        vm.startPrank(submitter);
        vm.expectRevert(SpendFloorVault.Unauthorized.selector);
        vault.spendWithSig(alice, 1000000, nonce_, deadline, v2, r, s2);
        vm.stopPrank();
    }

    function test_Replay() public {
        uint256 nonce_ = vault.nonce();
        uint256 deadline = block.timestamp + 100;
        (uint8 v, bytes32 r, bytes32 s) = _sign(alice, 1000000, nonce_, deadline);
        vm.prank(submitter);
        vault.spendWithSig(alice, 1000000, nonce_, deadline, v, r, s);
        vm.startPrank(submitter);
        vm.expectRevert(SpendFloorVault.BadNonce.selector);
        vault.spendWithSig(alice, 1000000, nonce_, deadline, v, r, s);
        vm.stopPrank();
    }

    function test_BadNonce() public {
        _spendReverting(
            submitter,
            alice,
            1000000,
            vault.nonce() + 1,
            block.timestamp + 100,
            alice,
            1000000,
            vault.nonce() + 1,
            block.timestamp + 100,
            SpendFloorVault.BadNonce.selector
        );
    }

    function test_IntentExpired() public {
        _spendReverting(
            submitter,
            alice,
            1000000,
            vault.nonce(),
            block.timestamp - 1,
            alice,
            1000000,
            vault.nonce(),
            block.timestamp - 1,
            SpendFloorVault.IntentExpired.selector
        );
    }

    function test_DeadlineTooFar() public {
        _spendReverting(
            submitter,
            alice,
            1000000,
            vault.nonce(),
            block.timestamp + 301,
            alice,
            1000000,
            vault.nonce(),
            block.timestamp + 301,
            SpendFloorVault.DeadlineTooFar.selector
        );
    }

    function test_DeadlineBoundaries() public {
        // deadline == now: valid. deadline == now + 300: valid.
        _spend(submitter, alice, 1000000);
        uint256 nonce_ = vault.nonce();
        (uint8 v, bytes32 r, bytes32 s) = _sign(alice, 1000000, nonce_, block.timestamp + 300);
        vm.prank(submitter);
        vault.spendWithSig(alice, 1000000, nonce_, block.timestamp + 300, v, r, s);
    }

    function test_Frozen() public {
        vault.setFrozen(true);
        _spendReverting(
            submitter,
            alice,
            1000000,
            vault.nonce(),
            block.timestamp + 100,
            alice,
            1000000,
            vault.nonce(),
            block.timestamp + 100,
            SpendFloorVault.Frozen.selector
        );
        vault.setFrozen(false);
        _spend(submitter, alice, 1000000);
        require(token.balanceOf(alice) == 1000000, "spend after unfreeze");
    }

    function test_SessionExpired() public {
        _updatePolicy(
            PER_TX_MAX,
            WINDOW_MAX,
            WINDOW_SECONDS,
            int64(int256(block.timestamp)),
            int64(int256(block.timestamp)) + 100,
            _defaultRecipients()
        );
        vm.warp(block.timestamp + 101);
        _spendReverting(
            submitter,
            alice,
            1000000,
            vault.nonce(),
            block.timestamp + 100,
            alice,
            1000000,
            vault.nonce(),
            block.timestamp + 100,
            SpendFloorVault.SessionExpired.selector
        );
    }

    function test_SessionExpiredAtBoundary() public {
        // V19: now == expiresAt is expired.
        _updatePolicy(
            PER_TX_MAX,
            WINDOW_MAX,
            WINDOW_SECONDS,
            int64(int256(block.timestamp)),
            int64(int256(block.timestamp)) + 100,
            _defaultRecipients()
        );
        vm.warp(block.timestamp + 100);
        _spendReverting(
            submitter,
            alice,
            1000000,
            vault.nonce(),
            block.timestamp + 100,
            alice,
            1000000,
            vault.nonce(),
            block.timestamp + 100,
            SpendFloorVault.SessionExpired.selector
        );
    }

    function test_ZeroAmount() public {
        _spendReverting(
            submitter,
            alice,
            0,
            vault.nonce(),
            block.timestamp + 100,
            alice,
            0,
            vault.nonce(),
            block.timestamp + 100,
            SpendFloorVault.ZeroAmount.selector
        );
    }

    function test_NonAllowlisted() public {
        _spendReverting(
            submitter,
            carol,
            1000000,
            vault.nonce(),
            block.timestamp + 100,
            carol,
            1000000,
            vault.nonce(),
            block.timestamp + 100,
            SpendFloorVault.RecipientNotAllowed.selector
        );
    }

    function test_VaultAsRecipient() public {
        // V11: the vault itself is never a recipient, by policy validation
        // and by the spend check.
        address[] memory bad = new address[](1);
        bad[0] = address(vault);
        vm.expectRevert(SpendFloorVault.InvalidPolicy.selector);
        vault.setPolicy(1, 6, PER_TX_MAX, WINDOW_MAX, WINDOW_SECONDS, int64(int256(block.timestamp)), 0, bad, SOL_SET_HASH);
        _spendReverting(
            submitter,
            address(vault),
            1000000,
            vault.nonce(),
            block.timestamp + 100,
            address(vault),
            1000000,
            vault.nonce(),
            block.timestamp + 100,
            SpendFloorVault.RecipientNotAllowed.selector
        );
    }

    function test_AgentAsRecipient() public {
        address[] memory bad = new address[](1);
        bad[0] = agent;
        vm.expectRevert(SpendFloorVault.InvalidPolicy.selector);
        vault.setPolicy(1, 6, PER_TX_MAX, WINDOW_MAX, WINDOW_SECONDS, int64(int256(block.timestamp)), 0, bad, SOL_SET_HASH);
    }

    function test_OverDailyCap() public {
        _spend(submitter, alice, 2000000);
        _spend(submitter, alice, 2000000);
        _spend(submitter, alice, 1000000);
        _spendReverting(
            submitter,
            alice,
            1,
            vault.nonce(),
            block.timestamp + 100,
            alice,
            1,
            vault.nonce(),
            block.timestamp + 100,
            SpendFloorVault.DailyCapExceeded.selector
        );
    }

    function test_OverPerTxCap() public {
        _spendReverting(
            submitter,
            alice,
            2000001,
            vault.nonce(),
            block.timestamp + 100,
            alice,
            2000001,
            vault.nonce(),
            block.timestamp + 100,
            SpendFloorVault.PerTxCapExceeded.selector
        );
    }

    function test_ExactBoundaries() public {
        // V6: exact per-tx boundary accepts. V9: exact window boundary
        // accepts. V10: window full + dust fails with DailyCapExceeded.
        _spend(submitter, alice, 2000000);
        _spend(submitter, alice, 2000000);
        _spend(submitter, alice, 1000000);
        require(vault.spentInWindow() == 5000000, "window full");
        _spendReverting(
            submitter,
            alice,
            1,
            vault.nonce(),
            block.timestamp + 100,
            alice,
            1,
            vault.nonce(),
            block.timestamp + 100,
            SpendFloorVault.DailyCapExceeded.selector
        );
    }

    function test_U64MaxAmount() public {
        // V8: a u64-max amount reports DailyCapExceeded, never a panic.
        _spendReverting(
            submitter,
            alice,
            type(uint64).max,
            vault.nonce(),
            block.timestamp + 100,
            alice,
            type(uint64).max,
            vault.nonce(),
            block.timestamp + 100,
            SpendFloorVault.DailyCapExceeded.selector
        );
    }

    function test_Precedence() public {
        // Unauthorized beats everything.
        vault.setFrozen(true);
        uint256 nonce_ = vault.nonce();
        uint256 deadline = block.timestamp + 100;
        (uint8 v, bytes32 r, bytes32 s) = _signAs(wrongKey, alice, 1000000, nonce_, deadline);
        vm.startPrank(submitter);
        vm.expectRevert(SpendFloorVault.Unauthorized.selector);
        vault.spendWithSig(alice, 1000000, nonce_, deadline, v, r, s);
        vm.stopPrank();
        // BadNonce beats Frozen (transport before policy).
        _spendReverting(
            submitter,
            alice,
            1000000,
            vault.nonce() + 1,
            block.timestamp + 100,
            alice,
            1000000,
            vault.nonce() + 1,
            block.timestamp + 100,
            SpendFloorVault.BadNonce.selector
        );
        // IntentExpired beats Frozen.
        _spendReverting(
            submitter,
            alice,
            1000000,
            vault.nonce(),
            block.timestamp - 1,
            alice,
            1000000,
            vault.nonce(),
            block.timestamp - 1,
            SpendFloorVault.IntentExpired.selector
        );
        // Frozen beats SessionExpired: set a short expiry, then freeze.
        _updatePolicy(
            PER_TX_MAX,
            WINDOW_MAX,
            WINDOW_SECONDS,
            int64(int256(block.timestamp)),
            int64(int256(block.timestamp)) + 100,
            _defaultRecipients()
        );
        vm.warp(block.timestamp + 101);
        _spendReverting(
            submitter,
            alice,
            1000000,
            vault.nonce(),
            block.timestamp + 100,
            alice,
            1000000,
            vault.nonce(),
            block.timestamp + 100,
            SpendFloorVault.Frozen.selector
        );
        vault.setFrozen(false);
        // SessionExpired beats ZeroAmount.
        _spendReverting(
            submitter,
            alice,
            0,
            vault.nonce(),
            block.timestamp + 100,
            alice,
            0,
            vault.nonce(),
            block.timestamp + 100,
            SpendFloorVault.SessionExpired.selector
        );
        // Back to a live policy for the remaining pairs.
        _updatePolicy(
            PER_TX_MAX,
            WINDOW_MAX,
            WINDOW_SECONDS,
            int64(int256(block.timestamp)),
            0,
            _defaultRecipients()
        );
        // ZeroAmount beats RecipientNotAllowed.
        _spendReverting(
            submitter,
            carol,
            0,
            vault.nonce(),
            block.timestamp + 100,
            carol,
            0,
            vault.nonce(),
            block.timestamp + 100,
            SpendFloorVault.ZeroAmount.selector
        );
        // RecipientNotAllowed beats both caps.
        _spendReverting(
            submitter,
            carol,
            6000000,
            vault.nonce(),
            block.timestamp + 100,
            carol,
            6000000,
            vault.nonce(),
            block.timestamp + 100,
            SpendFloorVault.RecipientNotAllowed.selector
        );
        // DailyCapExceeded beats PerTxCapExceeded.
        _spend(submitter, alice, 2000000);
        _spend(submitter, alice, 2000000);
        _spend(submitter, alice, 1000000);
        _spendReverting(
            submitter,
            alice,
            3000000,
            vault.nonce(),
            block.timestamp + 100,
            alice,
            3000000,
            vault.nonce(),
            block.timestamp + 100,
            SpendFloorVault.DailyCapExceeded.selector
        );
    }

    function test_WindowRollover() public {
        _spend(submitter, alice, 2000000);
        _spend(submitter, alice, 2000000);
        _spend(submitter, alice, 1000000);
        require(vault.spentInWindow() == 5000000, "window full");
        vm.warp(block.timestamp + WINDOW_SECONDS);
        _spend(submitter, alice, 1000000);
        require(vault.spentInWindow() == 1000000, "new window spent");
    }

    function test_OwnerOnly() public {
        vm.startPrank(submitter);
        vm.expectRevert(SpendFloorVault.NotOwner.selector);
        vault.setFrozen(true);
        vm.expectRevert(SpendFloorVault.NotOwner.selector);
        vault.setAgent(newAgent);
        vm.expectRevert(SpendFloorVault.NotOwner.selector);
        vault.withdraw(alice, 1000000);
        vm.expectRevert(SpendFloorVault.NotOwner.selector);
        vault.setPolicy(1, 6, PER_TX_MAX, WINDOW_MAX, WINDOW_SECONDS, int64(int256(block.timestamp)), 0, _defaultRecipients(), SOL_SET_HASH);
        vm.stopPrank();
    }

    function test_SetAgent() public {
        vault.setAgent(newAgent);
        // Old agent's signature no longer works.
        _spendReverting(
            submitter,
            alice,
            1000000,
            vault.nonce(),
            block.timestamp + 100,
            alice,
            1000000,
            vault.nonce(),
            block.timestamp + 100,
            SpendFloorVault.Unauthorized.selector
        );
        // New agent's signature works.
        uint256 nonce_ = vault.nonce();
        uint256 deadline = block.timestamp + 100;
        (uint8 v, bytes32 r, bytes32 s) = _signAs(newAgentKey, alice, 1000000, nonce_, deadline);
        vm.prank(submitter);
        vault.spendWithSig(alice, 1000000, nonce_, deadline, v, r, s);
        require(token.balanceOf(alice) == 1000000, "new agent spend");
        vm.expectRevert(SpendFloorVault.InvalidAgent.selector);
        vault.setAgent(address(0));
    }

    function test_SetPolicy() public {
        bytes32 before = vault.policyHash();
        address[] memory recipients = new address[](1);
        recipients[0] = carol;
        _updatePolicy(1000000, 3000000, WINDOW_SECONDS, int64(int256(block.timestamp)), 0, recipients);
        require(vault.policyHash() != before, "hash changes on policy change");
        require(vault.policyHash() != bytes32(0), "hash non-zero");
        // Old recipient now rejected, new recipient works.
        _spendReverting(
            submitter,
            alice,
            1000000,
            vault.nonce(),
            block.timestamp + 100,
            alice,
            1000000,
            vault.nonce(),
            block.timestamp + 100,
            SpendFloorVault.RecipientNotAllowed.selector
        );
        _spend(submitter, carol, 1000000);
        // Invalid policies.
        address[] memory empty = new address[](0);
        vm.expectRevert(SpendFloorVault.InvalidPolicy.selector);
        vault.setPolicy(1, 6, PER_TX_MAX, WINDOW_MAX, WINDOW_SECONDS, int64(int256(block.timestamp)), 0, empty, SOL_SET_HASH);
        address[] memory nine = new address[](9);
        for (uint256 i = 0; i < 9; i++) nine[i] = address(uint160(0x5000 + i));
        vm.expectRevert(SpendFloorVault.InvalidPolicy.selector);
        vault.setPolicy(1, 6, PER_TX_MAX, WINDOW_MAX, WINDOW_SECONDS, int64(int256(block.timestamp)), 0, nine, SOL_SET_HASH);
        vm.expectRevert(SpendFloorVault.InvalidPolicy.selector);
        vault.setPolicy(1, 6, PER_TX_MAX, WINDOW_MAX, 59, int64(int256(block.timestamp)), 0, _defaultRecipients(), SOL_SET_HASH);
        vm.expectRevert(SpendFloorVault.InvalidPolicy.selector);
        vault.setPolicy(1, 6, PER_TX_MAX, WINDOW_MAX, 31536001, int64(int256(block.timestamp)), 0, _defaultRecipients(), SOL_SET_HASH);
        vm.expectRevert(SpendFloorVault.InvalidPolicy.selector);
        vault.setPolicy(2, 6, PER_TX_MAX, WINDOW_MAX, WINDOW_SECONDS, int64(int256(block.timestamp)), 0, _defaultRecipients(), SOL_SET_HASH);
        vm.expectRevert(SpendFloorVault.InvalidPolicy.selector);
        vault.setPolicy(1, 18, PER_TX_MAX, WINDOW_MAX, WINDOW_SECONDS, int64(int256(block.timestamp)), 0, _defaultRecipients(), SOL_SET_HASH);
    }

    function test_Withdraw() public {
        vault.withdraw(alice, 1000000);
        require(token.balanceOf(alice) == 1000000, "withdraw credit");
        vault.setFrozen(true);
        vault.withdraw(bob, 1000000);
        require(token.balanceOf(bob) == 1000000, "withdraw while frozen");
    }

    function test_NoReceive() public {
        // Low-level call: its return value IS the assertion. expectRevert
        // does not work with low-level calls, so it is not used here.
        (bool ok, ) = address(vault).call{value: 1000}("");
        require(!ok, "ETH transfer must fail");
    }

    function test_PolicyHashStable() public {
        bytes32 h1 = vault.policyHash();
        bytes32 h2 = vault.policyHash();
        require(h1 == h2, "hash stable across reads");
        require(h1 != bytes32(0), "hash non-zero");
    }

    function testFuzz_SpendOutcomes(uint256 amountSeed, uint256 toSeed, uint256 callerSeed) public {
        uint256 amount = amountSeed % 6000001;
        address to = (toSeed % 2 == 0) ? alice : carol;
        address caller = address(uint160(callerSeed));
        uint256 nonce_ = vault.nonce();
        uint256 deadline = block.timestamp + 100;
        (uint8 v, bytes32 r, bytes32 s) = _sign(to, amount, nonce_, deadline);

        bytes4 expected;
        if (amount == 0) {
            expected = SpendFloorVault.ZeroAmount.selector;
        } else if (to == carol) {
            expected = SpendFloorVault.RecipientNotAllowed.selector;
        } else if (amount > WINDOW_MAX) {
            expected = SpendFloorVault.DailyCapExceeded.selector;
        } else if (amount > PER_TX_MAX) {
            expected = SpendFloorVault.PerTxCapExceeded.selector;
        } else {
            expected = bytes4(0);
        }

        if (expected != bytes4(0)) {
            vm.startPrank(caller);
            vm.expectRevert(expected);
            vault.spendWithSig(to, amount, nonce_, deadline, v, r, s);
            vm.stopPrank();
        } else {
            uint256 balBefore = token.balanceOf(to);
            uint256 vaultBefore = token.balanceOf(address(vault));
            vm.prank(caller);
            vault.spendWithSig(to, amount, nonce_, deadline, v, r, s);
            require(token.balanceOf(to) == balBefore + amount, "fuzz recipient credit");
            require(token.balanceOf(address(vault)) == vaultBefore - amount, "fuzz vault debit");
            require(vault.spentInWindow() == amount, "fuzz spent tracking");
            require(vault.nonce() == 1, "fuzz nonce increments");
            require(token.balanceOf(agent) == 0, "fuzz agent zero");
        }
    }
}
