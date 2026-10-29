// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title SpendFloorVault (T10)
/// @notice Complete EVM vault. Holds SFUSD. A spend is an EIP-712 intent
///  signed by AGENT; anyone may submit it, and the SUBMITTER pays gas.
///  The agent holds no SFUSD, no native balance, and no authority beyond
///  signing intents. Only OWNER can change anything: set policy, rotate
///  the agent, freeze/unfreeze, withdraw. Withdraw works while frozen.
///  There is no receive/fallback: ETH sent to the vault reverts (E14).
///  This contract supersedes the T06 spike vault (native ETH, EIP-191,
///  no nonce, no deadline, no withdraw), which is deleted.
///
///  EIP-712 domain is hand-rolled (not OpenZeppelin's EIP712 contract):
///  OZ's EIP712 pulls MessageHashUtils -> Strings -> Math, and OZ's
///  Math uses the CLZ opcode, which needs evm_version Osaka. Our pin is
///  Cancun (Base Sepolia, T01/T06), so OZ's EIP712 cannot compile here.
///  The domain below is the standard EIP-712 construction: name
///  "SpendFloorVault", version "1", chainId, verifyingContract. The SDK
///  (T15) must use exactly this domain and the Spend type below.
///
///  Precedence (plan section 2 D6 + transport; first failing check wins):
///    Unauthorized -> BadNonce -> IntentExpired -> DeadlineTooFar
///    -> Frozen -> SessionExpired -> ZeroAmount -> RecipientNotAllowed
///    -> DailyCapExceeded -> PerTxCapExceeded.
///  Transport errors sit after signature validation (a tampered field
///  must not be trusted) and before policy (a replayed or expired
///  intent is a transport failure, not a policy decision). Documented
///  here so T30's reference model can match it exactly.
///
///  Policy hash (T05 canonical form, computed on-chain, never trusted
///  from off-chain): SHA-256 of "SPENDFLOOR/v1" + version u32 +
///  decimals u8 + perTxMax u64 + windowMax u64 + windowSeconds u64 +
///  windowAnchor i64 + expiresAt i64 + evmSetHash + solSetHash, all
///  fixed-width big-endian (122-byte preimage). Each set hash is the
///  SHA-256 of that chain's recipient addresses, sorted ascending by
///  bytes. The EVM vault computes its own set hash from storage and
///  receives the Solana set hash as a setPolicy parameter. Frozen and
///  the roles are excluded from the hash; verify checks them separately.
contract SpendFloorVault {
    using SafeERC20 for IERC20;

    error Unauthorized();
    error BadNonce();
    error IntentExpired();
    error DeadlineTooFar();
    error Frozen();
    error SessionExpired();
    error ZeroAmount();
    error RecipientNotAllowed();
    error DailyCapExceeded();
    error PerTxCapExceeded();
    error NotOwner();
    error InvalidAgent();
    error InvalidPolicy();
    error Reentrant();

    event Spend(address indexed to, uint256 amount, uint256 windowIndex);
    event PolicySet(bytes32 indexed policyHash);
    event AgentSet(address indexed agent);
    event FrozenSet(bool frozen);
    event Withdraw(address indexed to, uint256 amount);

    struct Policy {
        uint32 version;
        uint8 decimals;
        uint64 perTxMax;
        uint64 windowMax;
        uint64 windowSeconds;
        int64 windowAnchor;
        int64 expiresAt;
        bytes32 solSetHash;
    }

    bytes32 public constant SPEND_TYPEHASH =
        keccak256("Spend(address to,uint256 amount,uint256 nonce,uint256 deadline)");

    bytes32 public constant EIP712DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 public immutable DOMAIN_SEPARATOR;

    uint256 public constant DEADLINE_CAP = 300;
    uint256 public constant MIN_WINDOW_SECONDS = 60;
    uint256 public constant MAX_WINDOW_SECONDS = 31536000;
    uint256 public constant MAX_RECIPIENTS = 8;

    address public immutable owner;
    IERC20 public immutable token;

    Policy public policy;
    address public agent;
    bytes32 public policyHash;
    address[] public evmRecipients;
    mapping(address => bool) public isRecipient;
    bool public frozen;
    uint256 public nonce;
    uint256 public currentWindow;
    uint256 public spentInWindow;
    bool private locked;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (locked) revert Reentrant();
        locked = true;
        _;
        locked = false;
    }

    constructor(
        address token_,
        address agent_,
        uint32 version_,
        uint8 decimals_,
        uint64 perTxMax_,
        uint64 windowMax_,
        uint64 windowSeconds_,
        int64 windowAnchor_,
        int64 expiresAt_,
        address[] memory evmRecipients_,
        bytes32 solSetHash_
    ) {
        if (token_ == address(0)) revert InvalidPolicy();
        owner = msg.sender;
        token = IERC20(token_);
        if (agent_ == address(0)) revert InvalidAgent();
        agent = agent_;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                EIP712DOMAIN_TYPEHASH,
                keccak256(bytes("SpendFloorVault")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
        _setPolicy(
            version_,
            decimals_,
            perTxMax_,
            windowMax_,
            windowSeconds_,
            windowAnchor_,
            expiresAt_,
            evmRecipients_,
            solSetHash_
        );
    }

    /// @notice Validate a policy and store it, recomputing the on-chain hash.
    ///  Recipients: 1..8, no zero address, no duplicates, never the vault
    ///  itself (V11) and never the agent (core rule: the agent is never a
    ///  recipient). Changing the policy does not reset spent; the window
    ///  index recomputes from the new anchor and window on the next spend.
    function _setPolicy(
        uint32 version_,
        uint8 decimals_,
        uint64 perTxMax_,
        uint64 windowMax_,
        uint64 windowSeconds_,
        int64 windowAnchor_,
        int64 expiresAt_,
        address[] memory evmRecipients_,
        bytes32 solSetHash_
    ) internal {
        if (version_ != 1) revert InvalidPolicy();
        if (decimals_ != 6) revert InvalidPolicy();
        if (windowSeconds_ < MIN_WINDOW_SECONDS || windowSeconds_ > MAX_WINDOW_SECONDS) {
            revert InvalidPolicy();
        }
        if (windowAnchor_ < 0) revert InvalidPolicy();
        if (expiresAt_ < 0) revert InvalidPolicy();
        if (evmRecipients_.length < 1 || evmRecipients_.length > MAX_RECIPIENTS) {
            revert InvalidPolicy();
        }
        for (uint256 i = 0; i < evmRecipients_.length; i++) {
            address r = evmRecipients_[i];
            if (r == address(0) || r == address(this) || r == agent) revert InvalidPolicy();
            for (uint256 j = 0; j < i; j++) {
                if (evmRecipients_[j] == r) revert InvalidPolicy();
            }
        }
        // Clear the previous set, then set the new one. Duplicates are
        // checked within the new list only, so a recipient that stays
        // across a policy change does not false-trigger.
        for (uint256 i = 0; i < evmRecipients.length; i++) {
            isRecipient[evmRecipients[i]] = false;
        }
        for (uint256 i = 0; i < evmRecipients_.length; i++) {
            isRecipient[evmRecipients_[i]] = true;
        }
        evmRecipients = evmRecipients_;

        policy = Policy({
            version: version_,
            decimals: decimals_,
            perTxMax: perTxMax_,
            windowMax: windowMax_,
            windowSeconds: windowSeconds_,
            windowAnchor: windowAnchor_,
            expiresAt: expiresAt_,
            solSetHash: solSetHash_
        });
        policyHash = _computePolicyHash(evmRecipients_, solSetHash_);
        emit PolicySet(policyHash);
    }

    function setPolicy(
        uint32 version_,
        uint8 decimals_,
        uint64 perTxMax_,
        uint64 windowMax_,
        uint64 windowSeconds_,
        int64 windowAnchor_,
        int64 expiresAt_,
        address[] memory evmRecipients_,
        bytes32 solSetHash_
    ) external onlyOwner {
        _setPolicy(
            version_,
            decimals_,
            perTxMax_,
            windowMax_,
            windowSeconds_,
            windowAnchor_,
            expiresAt_,
            evmRecipients_,
            solSetHash_
        );
    }

    function setAgent(address newAgent) external onlyOwner {
        if (newAgent == address(0)) revert InvalidAgent();
        agent = newAgent;
        emit AgentSet(newAgent);
    }

    function setFrozen(bool f) external onlyOwner {
        frozen = f;
        emit FrozenSet(f);
    }

    /// @notice Owner escape hatch. Bypasses the policy by design and works
    ///  while frozen. The recipient is the owner's choice.
    function withdraw(address to, uint256 amount) external onlyOwner {
        token.safeTransfer(to, amount);
        emit Withdraw(to, amount);
    }

    /// @notice EIP-712 digest the agent signs. Exposed so tests and the SDK
    ///  sign exactly what the vault verifies.
    function intentDigest(
        address to,
        uint256 amount,
        uint256 nonce_,
        uint256 deadline
    ) public view returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(
                    "\x19\x01",
                    DOMAIN_SEPARATOR,
                    keccak256(abi.encode(SPEND_TYPEHASH, to, amount, nonce_, deadline))
                )
            );
    }

    /// @notice Window index for a timestamp, per plan section 2:
    ///  floor((now - anchor) / windowSeconds). Before the anchor, window 0.
    function windowIndexAt(uint256 timestamp) public view returns (uint256) {
        if (int256(timestamp) < policy.windowAnchor) return 0;
        return (timestamp - uint256(uint64(policy.windowAnchor))) / policy.windowSeconds;
    }

    function _evmSetHash(address[] memory recipients_) internal pure returns (bytes32) {
        // Insertion sort ascending by bytes (addresses compare as bytes).
        for (uint256 i = 1; i < recipients_.length; i++) {
            address key = recipients_[i];
            uint256 j = i;
            while (j > 0 && recipients_[j - 1] > key) {
                recipients_[j] = recipients_[j - 1];
                j--;
            }
            recipients_[j] = key;
        }
        // Pack each address as its 20 bytes. abi.encodePacked on an
        // address array pads each element to 32 bytes, which does NOT
        // match the T05 canonical set hash (SHA-256 over concatenated
        // 20-byte addresses), so pack explicitly. Found by T14: the
        // padded version produced a different set hash for every golden.
        bytes memory packed = new bytes(recipients_.length * 20);
        for (uint256 i = 0; i < recipients_.length; i++) {
            bytes20 b = bytes20(recipients_[i]);
            for (uint256 j = 0; j < 20; j++) {
                packed[i * 20 + j] = b[j];
            }
        }
        return sha256(packed);
    }

    function _computePolicyHash(
        address[] memory evmRecipients_,
        bytes32 solSetHash_
    ) internal view returns (bytes32) {
        bytes32 evmSetHash = _evmSetHash(evmRecipients_);
        return
            sha256(
                abi.encodePacked(
                    "SPENDFLOOR/v1",
                    policy.version,
                    policy.decimals,
                    policy.perTxMax,
                    policy.windowMax,
                    policy.windowSeconds,
                    policy.windowAnchor,
                    policy.expiresAt,
                    evmSetHash,
                    solSetHash_
                )
            );
    }

    /// @notice Spend SFUSD to an allowlisted recipient, authorized by the
    ///  agent's EIP-712 signature. Anyone may submit. Precedence is the
    ///  documented order above; a rejected spend changes no state.
    function spendWithSig(
        address to,
        uint256 amount,
        uint256 nonce_,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        (address signer, ECDSA.RecoverError err, ) = ECDSA.tryRecover(
            intentDigest(to, amount, nonce_, deadline),
            v,
            r,
            s
        );
        if (err != ECDSA.RecoverError.NoError || signer != agent) revert Unauthorized();
        if (nonce_ != nonce) revert BadNonce();
        if (block.timestamp > deadline) revert IntentExpired();
        if (deadline > block.timestamp + DEADLINE_CAP) revert DeadlineTooFar();
        if (frozen) revert Frozen();
        if (policy.expiresAt != 0 && int256(block.timestamp) >= policy.expiresAt) {
            revert SessionExpired();
        }
        if (amount == 0) revert ZeroAmount();
        // The agent is never a recipient, even if a rotation made it one:
        // setPolicy rejects the agent at set time, but setAgent can rotate
        // onto an address the policy already lists. The spend check closes
        // that gap (T11 finding).
        if (to == agent || !isRecipient[to]) revert RecipientNotAllowed();

        uint256 windowIndex = windowIndexAt(block.timestamp);
        if (windowIndex != currentWindow) {
            currentWindow = windowIndex;
            spentInWindow = 0;
        }
        // Saturating cap check (T11): if spent already meets the window
        // cap, for example after setPolicy lowered it below spent, every
        // further amount exceeds the remaining allowance. Written this
        // way the check never underflows: the old form
        // (amount > windowMax - spentInWindow) panicked when spent
        // exceeded windowMax instead of reporting DailyCapExceeded.
        if (spentInWindow >= policy.windowMax || amount > policy.windowMax - spentInWindow) {
            revert DailyCapExceeded();
        }
        if (amount > policy.perTxMax) revert PerTxCapExceeded();

        nonce++;
        spentInWindow += amount;
        token.safeTransfer(to, amount);
        emit Spend(to, amount, windowIndex);
    }
}
