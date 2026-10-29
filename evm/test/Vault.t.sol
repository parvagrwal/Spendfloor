// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

// T06 spike tests. Attack-first: every rejection the plan's pass criteria
// name is tested before the happy path is trusted. No forge-std by design:
// the minimal cheatcode interface below keeps evm/ dependency-free, so the
// files transfer to the owner machine with no submodule or install step.

import "../src/Vault.sol";

interface Vm {
    function addr(uint256) external returns (address);
    function deal(address, uint256) external;
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function warp(uint256) external;
    function expectRevert(bytes4) external;
}

Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

contract VaultTest {
    Vault vault;

    uint256 internal agentKey = 0xA11CE;
    uint256 internal wrongKey = 0xBADD;
    address internal agent;
    address internal alice = address(0x1111);
    address internal bob = address(0x2222);
    address internal carol = address(0x3333);
    address internal submitter = address(0x4444);

    uint256 internal constant DAILY_CAP = 1000;
    uint256 internal constant PER_TX_CAP = 400;

    function setUp() public {
        agent = vm.addr(agentKey);
        address[] memory allowed = new address[](2);
        allowed[0] = alice;
        allowed[1] = bob;
        vault = new Vault(agent, allowed, DAILY_CAP, PER_TX_CAP);
        vm.deal(address(vault), 100000);
    }

    function _sign(address to, uint256 amount) internal returns (uint8 v, bytes32 r, bytes32 s) {
        (v, r, s) = vm.sign(agentKey, vault.intentDigest(to, amount));
    }

    function _spend(address caller, address to, uint256 amount) internal {
        (uint8 v, bytes32 r, bytes32 s) = _sign(to, amount);
        vm.prank(caller);
        vault.spend(to, amount, v, r, s);
    }

    function _spendReverting(
        address caller,
        address signTo,
        uint256 signAmount,
        address submitTo,
        uint256 submitAmount,
        bytes4 err
    ) internal {
        (uint8 v, bytes32 r, bytes32 s) = _sign(signTo, signAmount);
        vm.startPrank(caller);
        vm.expectRevert(err);
        vault.spend(submitTo, submitAmount, v, r, s);
        vm.stopPrank();
    }

    function test_ValidSpend() public {
        uint256 before = alice.balance;
        _spend(submitter, alice, 100);
        require(alice.balance == before + 100, "recipient credit");
        require(vault.spentOnDay(vault.dayNow()) == 100, "spent tracking");
        require(agent.balance == 0, "agent zero");
    }

    function test_Funding() public {
        vm.deal(address(this), 10000);
        (bool ok, ) = address(vault).call{value: 5000}("");
        require(ok, "fund call");
        require(address(vault).balance == 105000, "vault balance");
    }

    function test_OverDailyCap() public {
        _spend(submitter, alice, 400);
        _spend(submitter, alice, 400);
        _spend(submitter, alice, 100);
        _spendReverting(submitter, alice, 200, alice, 200, Vault.DailyCapExceeded.selector);
    }

    function test_OverPerTxCap() public {
        _spendReverting(submitter, alice, 500, alice, 500, Vault.PerTxCapExceeded.selector);
    }

    function test_NonAllowlisted() public {
        _spendReverting(submitter, carol, 100, carol, 100, Vault.RecipientNotAllowed.selector);
    }

    function test_Frozen() public {
        vault.setFrozen(true);
        _spendReverting(submitter, alice, 100, alice, 100, Vault.Frozen.selector);
        vault.setFrozen(false);
        _spend(submitter, alice, 100);
        require(alice.balance == 100, "spend after unfreeze");
    }

    function test_TamperedAmount() public {
        _spendReverting(submitter, alice, 100, alice, 200, Vault.Unauthorized.selector);
    }

    function test_TamperedRecipient() public {
        _spendReverting(submitter, alice, 100, bob, 100, Vault.Unauthorized.selector);
    }

    function test_WrongSigner() public {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wrongKey, vault.intentDigest(alice, 100));
        vm.startPrank(submitter);
        vm.expectRevert(Vault.Unauthorized.selector);
        vault.spend(alice, 100, v, r, s);
        vm.stopPrank();
    }

    function test_ZeroAmount() public {
        _spendReverting(submitter, alice, 0, alice, 0, Vault.ZeroAmount.selector);
    }

    function test_Precedence() public {
        // Frozen beats ZeroAmount.
        vault.setFrozen(true);
        _spendReverting(submitter, alice, 0, alice, 0, Vault.Frozen.selector);
        vault.setFrozen(false);
        // ZeroAmount beats RecipientNotAllowed.
        _spendReverting(submitter, carol, 0, carol, 0, Vault.ZeroAmount.selector);
        // RecipientNotAllowed beats both caps.
        _spendReverting(submitter, carol, 2000, carol, 2000, Vault.RecipientNotAllowed.selector);
        // DailyCapExceeded beats PerTxCapExceeded.
        _spend(submitter, alice, 400);
        _spend(submitter, alice, 400);
        _spend(submitter, alice, 100);
        _spendReverting(submitter, alice, 500, alice, 500, Vault.DailyCapExceeded.selector);
    }

    function test_DayRollover() public {
        _spend(submitter, alice, 400);
        _spend(submitter, alice, 400);
        _spend(submitter, alice, 200);
        require(vault.spentOnDay(vault.dayNow()) == 1000, "day full");
        vm.warp(block.timestamp + 1 days);
        _spend(submitter, alice, 100);
        require(vault.spentOnDay(vault.dayNow()) == 100, "new day spent");
    }

    function test_OwnerOnly() public {
        vm.startPrank(submitter);
        vm.expectRevert(Vault.NotOwner.selector);
        vault.setAllowed(carol, true);
        vm.expectRevert(Vault.NotOwner.selector);
        vault.setFrozen(true);
        vm.stopPrank();
    }

    function testFuzz_SpendInvariants(uint256 amountSeed, uint256 toSeed, uint256 callerSeed) public {
        uint256 amount = amountSeed % 1201;
        address to = (toSeed % 2 == 0) ? alice : carol;
        address caller = address(uint160(callerSeed));
        (uint8 v, bytes32 r, bytes32 s) = _sign(to, amount);

        bytes4 expected;
        if (amount == 0) {
            expected = Vault.ZeroAmount.selector;
        } else if (to == carol) {
            expected = Vault.RecipientNotAllowed.selector;
        } else if (amount > DAILY_CAP) {
            expected = Vault.DailyCapExceeded.selector;
        } else if (amount > PER_TX_CAP) {
            expected = Vault.PerTxCapExceeded.selector;
        } else {
            expected = bytes4(0);
        }

        if (expected != bytes4(0)) {
            vm.startPrank(caller);
            vm.expectRevert(expected);
            vault.spend(to, amount, v, r, s);
            vm.stopPrank();
        } else {
            uint256 balBefore = to.balance;
            uint256 vaultBefore = address(vault).balance;
            vm.prank(caller);
            vault.spend(to, amount, v, r, s);
            require(to.balance == balBefore + amount, "fuzz recipient credit");
            require(address(vault).balance == vaultBefore - amount, "fuzz vault debit");
            require(vault.spentOnDay(vault.dayNow()) == amount, "fuzz spent tracking");
            require(agent.balance == 0, "fuzz agent zero");
        }
    }
}
