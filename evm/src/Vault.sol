// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @title SpendFloor spike vault (T06)
/// @notice Minimal native-ETH vault proving the T06 hypothesis: an AGENT key
///  with 0 wei authorizes capped, allowlisted transfers that a SUBMITTER pays
///  for. Anyone may submit a spend; authorization is the agent's signature.
///  Checks run in D6 precedence order.
///  This is a SPIKE, not the final vault. Deliberately out of scope here,
///  documented as residual risk, landing in T10: no nonce (replay is bounded
///  by the daily cap only), no deadline/session, no withdraw, caps and agent
///  immutable after construction.
contract Vault {
    error Unauthorized();
    error NotOwner();
    error InvalidAgent();
    error Frozen();
    error ZeroAmount();
    error RecipientNotAllowed();
    error DailyCapExceeded();
    error PerTxCapExceeded();
    error TransferFailed();
    error Reentrant();

    event Spend(address indexed to, uint256 amount, uint256 day);
    event AllowedSet(address indexed to, bool allowed);
    event FrozenSet(bool frozen);

    address public immutable owner;
    address public immutable agent;
    uint256 public immutable dailyCap;
    uint256 public immutable perTxCap;

    mapping(address => bool) public allowed;
    mapping(uint256 => uint256) public spentOnDay;
    bool public frozen;
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

    constructor(address agent_, address[] memory allowed_, uint256 dailyCap_, uint256 perTxCap_) {
        if (agent_ == address(0)) revert InvalidAgent();
        owner = msg.sender;
        agent = agent_;
        dailyCap = dailyCap_;
        perTxCap = perTxCap_;
        for (uint256 i = 0; i < allowed_.length; i++) {
            allowed[allowed_[i]] = true;
        }
    }

    receive() external payable {}

    function setAllowed(address to, bool ok) external onlyOwner {
        allowed[to] = ok;
        emit AllowedSet(to, ok);
    }

    function setFrozen(bool f) external onlyOwner {
        frozen = f;
        emit FrozenSet(f);
    }

    function dayNow() public view returns (uint256) {
        return block.timestamp / 1 days;
    }

    /// @notice Digest the agent signs. Bound to this vault on this chain,
    ///  so a signature cannot replay on another vault or another chain.
    function intentDigest(address to, uint256 amount) public view returns (bytes32) {
        bytes32 inner = keccak256(abi.encodePacked(address(this), block.chainid, to, amount));
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", inner));
    }

    /// @notice Spend vault ETH to an allowlisted recipient.
    ///  D6 order: Unauthorized -> Frozen -> ZeroAmount -> RecipientNotAllowed
    ///  -> DailyCapExceeded -> PerTxCapExceeded.
    function spend(address to, uint256 amount, uint8 v, bytes32 r, bytes32 s) external nonReentrant {
        address signer = ecrecover(intentDigest(to, amount), v, r, s);
        if (signer != agent) revert Unauthorized();
        if (frozen) revert Frozen();
        if (amount == 0) revert ZeroAmount();
        if (!allowed[to]) revert RecipientNotAllowed();
        uint256 day = dayNow();
        if (spentOnDay[day] + amount > dailyCap) revert DailyCapExceeded();
        if (amount > perTxCap) revert PerTxCapExceeded();
        spentOnDay[day] += amount;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Spend(to, amount, day);
    }
}
