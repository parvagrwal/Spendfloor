// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

// T11 invariants + stateful fuzz. No forge-std by design: each fuzz run
// executes a pseudo-random sequence of actions (spends, policy changes,
// agent rotations, freezes, withdraws, time warps) and asserts the
// invariants after every step. A rejected action must change no state
// and must revert with a named error, never a panic.
//
// Invariants:
//  I1  A successful spend never leaves spentInWindow above windowMax.
//  I2  Every successful spend's recipient was in the recipient set.
//  I3  allowance(vault, anyone) == 0 always (E3: no approve path, so the
//      vault cannot be drained through transferFrom).
//  I4  Only the owner can run admin calls (non-owner admin reverts).
//  I5  Conservation: vault SFUSD balance + total out == initial funding.
//  I6  Agent SFUSD balance == 0 always.
//  I7  Nonce == number of successful spends (monotonic, +1 per success).
//  I8  No panic (0x4e487b71) in any revert; all reverts are named errors.
//
// Note on I1: setPolicy may lower windowMax below the current spent
// counter. That state is allowed; the vault must then report
// DailyCapExceeded (not panic) for further spends until rollover. So I1
// is asserted after successful spends, not unconditionally after
// setPolicy. The vault's cap check is saturating for exactly this reason.

import "../src/SpendFloorVault.sol";
import "../src/SFUSD.sol";

interface Vm {
    function addr(uint256) external returns (address);
    function prank(address) external;
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function warp(uint256) external;
}

Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

contract InvariantsTest {
    SpendFloorVault vault;
    SFUSD token;

    uint256 internal agentKey = 0xA11CE;
    uint256 internal wrongKey = 0xBADD;
    address internal agent;
    address internal alice = address(0x1111);
    address internal bob = address(0x2222);
    address internal carol = address(0x3333);
    address internal dave = address(0x5555);
    address internal submitter = address(0x4444);

    uint256 internal constant FUNDING = 1000000000;
    bytes32 internal constant SOL_SET_HASH = keccak256("sol-recipients");
    bytes4 internal constant PANIC = 0x4e487b71;

    // Mirrors, updated only on successful owner actions.
    address[] internal recipients;
    uint64 internal perTxMax;
    uint64 internal windowMax;
    uint64 internal windowSeconds;
    int64 internal windowAnchor;
    int64 internal expiresAt;
    address internal agentMirror;
    bool internal frozenMirror;
    uint256 internal totalOut;
    uint256 internal successCount;

    function setUp() public {
        agent = vm.addr(agentKey);
        agentMirror = agent;
        token = new SFUSD();
        recipients = new address[](2);
        recipients[0] = alice;
        recipients[1] = bob;
        perTxMax = 2000000;
        windowMax = 5000000;
        windowSeconds = 86400;
        windowAnchor = int64(int256(block.timestamp));
        expiresAt = 0;
        vault = new SpendFloorVault(
            address(token),
            agent,
            1,
            6,
            perTxMax,
            windowMax,
            windowSeconds,
            windowAnchor,
            expiresAt,
            recipients,
            SOL_SET_HASH
        );
        token.mint(address(vault), FUNDING);
    }

    function _r(uint256 seed, uint256 i, uint256 mod) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed, i))) % mod;
    }

    function _selector(bytes memory ret) internal pure returns (bytes4 sel) {
        if (ret.length < 4) return bytes4(0);
        assembly {
            sel := mload(add(ret, 32))
        }
    }

    function _isNamedError(bytes4 sel) internal pure returns (bool) {
        if (sel == PANIC) return false;
        if (sel == SpendFloorVault.Unauthorized.selector) return true;
        if (sel == SpendFloorVault.BadNonce.selector) return true;
        if (sel == SpendFloorVault.IntentExpired.selector) return true;
        if (sel == SpendFloorVault.DeadlineTooFar.selector) return true;
        if (sel == SpendFloorVault.Frozen.selector) return true;
        if (sel == SpendFloorVault.SessionExpired.selector) return true;
        if (sel == SpendFloorVault.ZeroAmount.selector) return true;
        if (sel == SpendFloorVault.RecipientNotAllowed.selector) return true;
        if (sel == SpendFloorVault.DailyCapExceeded.selector) return true;
        if (sel == SpendFloorVault.PerTxCapExceeded.selector) return true;
        if (sel == SpendFloorVault.NotOwner.selector) return true;
        if (sel == SpendFloorVault.InvalidAgent.selector) return true;
        if (sel == SpendFloorVault.InvalidPolicy.selector) return true;
        if (sel == bytes4(keccak256("ERC20InsufficientBalance(address,uint256,uint256)"))) return true;
        return false;
    }

    function _isRecipient(address a) internal view returns (bool) {
        for (uint256 i = 0; i < recipients.length; i++) {
            if (recipients[i] == a) return true;
        }
        return false;
    }

    function _checkInvariants() internal view {
        // I3: no allowance from the vault to anyone.
        require(token.allowance(address(vault), agent) == 0, "I3 agent allowance");
        require(token.allowance(address(vault), submitter) == 0, "I3 submitter allowance");
        require(token.allowance(address(vault), alice) == 0, "I3 alice allowance");
        require(token.allowance(address(vault), bob) == 0, "I3 bob allowance");
        require(token.allowance(address(vault), carol) == 0, "I3 carol allowance");
        require(token.allowance(address(vault), dave) == 0, "I3 dave allowance");
        require(token.allowance(address(vault), address(this)) == 0, "I3 owner allowance");
        // I5: conservation.
        require(
            token.balanceOf(address(vault)) + totalOut == FUNDING,
            "I5 conservation"
        );
        // I6: the current agent holds nothing. A former agent may
        // legitimately be a recipient after rotation, so only the current
        // agent is checked here.
        require(token.balanceOf(agentMirror) == 0, "I6 agent SFUSD");
        // I7: nonce tracks successful spends.
        require(vault.nonce() == successCount, "I7 nonce");
    }

    struct SpendAttempt {
        address to;
        uint256 amount;
        uint256 nonce_;
        uint256 deadline;
        uint256 signNonce;
        uint256 signDeadline;
        uint256 key;
        address caller;
    }

    function _deriveSpend(uint256 seed, uint256 i) internal view returns (SpendAttempt memory a) {
        address[] memory pool = new address[](6);
        pool[0] = alice;
        pool[1] = bob;
        pool[2] = carol;
        pool[3] = dave;
        pool[4] = address(vault);
        pool[5] = agentMirror;
        a.to = pool[_r(seed, i, 6)];
        a.amount = _r(seed, i + 1000, 8000001);
        uint256 nonceMode = _r(seed, i + 2000, 3);
        uint256 deadlineMode = _r(seed, i + 3000, 4);
        uint256 signerMode = _r(seed, i + 4000, 2);
        a.caller = (_r(seed, i + 5000, 2) == 0) ? submitter : address(uint160(_r(seed, i + 6000, 100000)));
        a.nonce_ = vault.nonce();
        a.deadline = block.timestamp + 100;
        a.signNonce = a.nonce_;
        a.signDeadline = a.deadline;
        if (nonceMode == 1) {
            a.signNonce = a.nonce_ + 1;
            a.nonce_ = a.nonce_ + 1;
        } else if (nonceMode == 2) {
            // Sign the correct nonce, submit a different one -> Unauthorized.
            a.nonce_ = a.nonce_ + 1;
        }
        if (deadlineMode == 1) {
            a.signDeadline = block.timestamp - 1;
            a.deadline = block.timestamp - 1;
        } else if (deadlineMode == 2) {
            a.signDeadline = block.timestamp + 301;
            a.deadline = block.timestamp + 301;
        } else if (deadlineMode == 3) {
            a.deadline = block.timestamp + 101;
        }
        a.key = (signerMode == 0) ? agentKey : wrongKey;
        // If the agent was rotated, the agent key no longer signs. The
        // vault checks against its stored agent, so signing with agentKey
        // after a rotation correctly produces Unauthorized.
    }

    function _callSpend(SpendAttempt memory a, uint8 v, bytes32 r, bytes32 s)
        internal
        returns (bool ok, bytes memory ret)
    {
        vm.prank(a.caller);
        (ok, ret) = address(vault).call(
            abi.encodeWithSelector(
                SpendFloorVault.spendWithSig.selector,
                a.to,
                a.amount,
                a.nonce_,
                a.deadline,
                v,
                r,
                s
            )
        );
    }

    function _spendAttempt(uint256 seed, uint256 i) internal {
        SpendAttempt memory a = _deriveSpend(seed, i);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            a.key,
            vault.intentDigest(a.to, a.amount, a.signNonce, a.signDeadline)
        );
        uint256 spentBefore = vault.spentInWindow();
        uint256 nonceBefore = vault.nonce();
        uint256 vaultBefore = token.balanceOf(address(vault));
        uint256 toBefore = token.balanceOf(a.to);
        (bool ok, bytes memory ret) = _callSpend(a, v, r, s);
        if (ok) {
            // I2: the recipient was in the set. I1: spent stays within cap.
            require(_isRecipient(a.to), "I2 recipient");
            require(vault.spentInWindow() <= windowMax, "I1 spent within cap");
            totalOut += a.amount;
            successCount++;
        } else {
            // Fail closed: no state change, and a named error, never panic.
            require(vault.spentInWindow() == spentBefore, "fail-closed spent");
            require(vault.nonce() == nonceBefore, "fail-closed nonce");
            require(token.balanceOf(address(vault)) == vaultBefore, "fail-closed vault");
            require(token.balanceOf(a.to) == toBefore, "fail-closed recipient");
            require(_isNamedError(_selector(ret)), "I8 named error");
        }
        _checkInvariants();
    }

    struct PolicyAttempt {
        uint32 version_;
        uint8 decimals_;
        uint64 perTx;
        uint64 window;
        uint64 windowSecs;
        int64 anchor;
        int64 expiry;
        address[] recips;
    }

    function _derivePolicy(uint256 seed, uint256 i) internal view returns (PolicyAttempt memory p) {
        // Derive params: sometimes valid, sometimes invalid.
        uint256 countMode = _r(seed, i, 4);
        uint256 count = countMode == 0 ? 0 : countMode == 1 ? 9 : countMode == 2 ? 1 : 2;
        p.recips = new address[](count);
        address[] memory pool = new address[](7);
        pool[0] = alice;
        pool[1] = bob;
        pool[2] = carol;
        pool[3] = dave;
        pool[4] = address(0);
        pool[5] = address(vault);
        pool[6] = agentMirror;
        for (uint256 j = 0; j < count; j++) {
            p.recips[j] = pool[_r(seed, i + 100 + j, 7)];
        }
        p.version_ = (_r(seed, i + 200, 5) == 0) ? 2 : 1;
        p.decimals_ = (_r(seed, i + 300, 5) == 0) ? 18 : 6;
        p.perTx = uint64(_r(seed, i + 400, 6000001));
        p.window = uint64(_r(seed, i + 500, 8000001));
        p.windowSecs = uint64(_r(seed, i + 600, 3) == 0 ? 59 : _r(seed, i + 700, 2) == 0 ? 31536001 : 86400);
        p.anchor = int64(int256(block.timestamp));
        p.expiry = (_r(seed, i + 800, 3) == 0) ? int64(int256(block.timestamp)) + 1000 : int64(0);
    }

    function _callSetPolicy(PolicyAttempt memory p) internal returns (bool ok, bytes memory ret) {
        (ok, ret) = address(vault).call(
            abi.encodeWithSelector(
                SpendFloorVault.setPolicy.selector,
                p.version_,
                p.decimals_,
                p.perTx,
                p.window,
                p.windowSecs,
                p.anchor,
                p.expiry,
                p.recips,
                SOL_SET_HASH
            )
        );
    }

    function _setPolicyAttempt(uint256 seed, uint256 i, bool asOwner) internal {
        PolicyAttempt memory p = _derivePolicy(seed, i);
        bytes32 hashBefore = vault.policyHash();
        if (asOwner) {
            (bool ok, bytes memory ret) = _callSetPolicy(p);
            if (ok) {
                recipients = p.recips;
                perTxMax = p.perTx;
                windowMax = p.window;
                windowSeconds = p.windowSecs;
                windowAnchor = p.anchor;
                expiresAt = p.expiry;
            } else {
                require(vault.policyHash() == hashBefore, "fail-closed policy");
                require(_isNamedError(_selector(ret)), "I8 named error");
            }
        } else {
            vm.prank(submitter);
            (bool ok, bytes memory ret) = _callSetPolicy(p);
            require(!ok, "I4 non-owner setPolicy must fail");
            require(_selector(ret) == SpendFloorVault.NotOwner.selector, "I4 NotOwner");
            require(vault.policyHash() == hashBefore, "fail-closed policy");
        }
        _checkInvariants();
    }

    function _setAgentAttempt(uint256 seed, uint256 i, bool asOwner) internal {
        address newAgent = (_r(seed, i, 3) == 0) ? address(0) : address(uint160(_r(seed, i + 100, 100000)));
        address agentBefore = vault.agent();
        if (asOwner) {
            (bool ok, bytes memory ret) = address(vault).call(
                abi.encodeWithSelector(SpendFloorVault.setAgent.selector, newAgent)
            );
            if (ok) {
                agentMirror = newAgent;
            } else {
                require(vault.agent() == agentBefore, "fail-closed agent");
                require(_isNamedError(_selector(ret)), "I8 named error");
            }
        } else {
            vm.prank(submitter);
            (bool ok, bytes memory ret) = address(vault).call(
                abi.encodeWithSelector(SpendFloorVault.setAgent.selector, newAgent)
            );
            require(!ok, "I4 non-owner setAgent must fail");
            require(_selector(ret) == SpendFloorVault.NotOwner.selector, "I4 NotOwner");
            require(vault.agent() == agentBefore, "fail-closed agent");
        }
        _checkInvariants();
    }

    function _setFrozenAttempt(uint256 seed, uint256 i, bool asOwner) internal {
        bool f = _r(seed, i, 2) == 0;
        bool frozenBefore = vault.frozen();
        if (asOwner) {
            (bool ok, ) = address(vault).call(
                abi.encodeWithSelector(SpendFloorVault.setFrozen.selector, f)
            );
            require(ok, "owner setFrozen must succeed");
            frozenMirror = f;
        } else {
            vm.prank(submitter);
            (bool ok, bytes memory ret) = address(vault).call(
                abi.encodeWithSelector(SpendFloorVault.setFrozen.selector, f)
            );
            require(!ok, "I4 non-owner setFrozen must fail");
            require(_selector(ret) == SpendFloorVault.NotOwner.selector, "I4 NotOwner");
            require(vault.frozen() == frozenBefore, "fail-closed frozen");
        }
        _checkInvariants();
    }

    function _withdrawAttempt(uint256 seed, uint256 i, bool asOwner) internal {
        address to = (_r(seed, i, 3) == 0) ? alice : (_r(seed, i, 3) == 1) ? bob : carol;
        uint256 amount = _r(seed, i + 100, 2000001);
        uint256 vaultBefore = token.balanceOf(address(vault));
        uint256 toBefore = token.balanceOf(to);
        if (asOwner) {
            (bool ok, bytes memory ret) = address(vault).call(
                abi.encodeWithSelector(SpendFloorVault.withdraw.selector, to, amount)
            );
            if (ok) {
                totalOut += amount;
            } else {
                require(token.balanceOf(address(vault)) == vaultBefore, "fail-closed vault");
                require(token.balanceOf(to) == toBefore, "fail-closed recipient");
                require(_isNamedError(_selector(ret)), "I8 named error");
            }
        } else {
            vm.prank(submitter);
            (bool ok, bytes memory ret) = address(vault).call(
                abi.encodeWithSelector(SpendFloorVault.withdraw.selector, to, amount)
            );
            require(!ok, "I4 non-owner withdraw must fail");
            require(_selector(ret) == SpendFloorVault.NotOwner.selector, "I4 NotOwner");
            require(token.balanceOf(address(vault)) == vaultBefore, "fail-closed vault");
            require(token.balanceOf(to) == toBefore, "fail-closed recipient");
        }
        _checkInvariants();
    }

    function _warpAction(uint256 seed, uint256 i) internal {
        uint256 secs = windowSeconds;
        vm.warp(block.timestamp + _r(seed, i, 2 * secs + 1));
        _checkInvariants();
    }

    function testFuzz_Invariants(uint256 seed) public {
        for (uint256 i = 0; i < 25; i++) {
            uint256 action = _r(seed, i + 9000, 10);
            if (action == 0) {
                _spendAttempt(seed, i);
            } else if (action == 1) {
                _setPolicyAttempt(seed, i, true);
            } else if (action == 2) {
                _setPolicyAttempt(seed, i, false);
            } else if (action == 3) {
                _setAgentAttempt(seed, i, true);
            } else if (action == 4) {
                _setAgentAttempt(seed, i, false);
            } else if (action == 5) {
                _setFrozenAttempt(seed, i, true);
            } else if (action == 6) {
                _setFrozenAttempt(seed, i, false);
            } else if (action == 7) {
                _withdrawAttempt(seed, i, true);
            } else if (action == 8) {
                _withdrawAttempt(seed, i, false);
            } else {
                _warpAction(seed, i);
            }
        }
    }

    function test_LoweredCapNoPanic() public {
        // Regression for the T11 fix: lowering windowMax below the current
        // spent counter must report DailyCapExceeded, never a panic, and
        // spends work again after the window rolls over.
        _spendDirect(alice, 2000000);
        _spendDirect(alice, 2000000);
        _spendDirect(alice, 1000000);
        require(vault.spentInWindow() == 5000000, "window full");
        address[] memory recips = new address[](2);
        recips[0] = alice;
        recips[1] = bob;
        vault.setPolicy(1, 6, 2000000, 1000000, 86400, int64(int256(block.timestamp)), 0, recips, SOL_SET_HASH);
        uint256 nonce_ = vault.nonce();
        uint256 deadline = block.timestamp + 100;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentKey, vault.intentDigest(alice, 1000000, nonce_, deadline));
        vm.prank(submitter);
        (bool ok, bytes memory ret) = address(vault).call(
            abi.encodeWithSelector(
                SpendFloorVault.spendWithSig.selector,
                alice,
                1000000,
                nonce_,
                deadline,
                v,
                r,
                s
            )
        );
        require(!ok, "lowered cap must reject");
        require(_selector(ret) == SpendFloorVault.DailyCapExceeded.selector, "DailyCapExceeded not panic");
        vm.warp(block.timestamp + 86400);
        _spendDirect(alice, 1000000);
        require(vault.spentInWindow() == 1000000, "new window spent");
    }

    function _spendDirect(address to, uint256 amount) internal {
        uint256 nonce_ = vault.nonce();
        uint256 deadline = block.timestamp + 100;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentKey, vault.intentDigest(to, amount, nonce_, deadline));
        vm.prank(submitter);
        vault.spendWithSig(to, amount, nonce_, deadline, v, r, s);
        totalOut += amount;
        successCount++;
    }
}
