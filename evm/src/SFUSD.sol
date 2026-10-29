// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title SFUSD (T10)
/// @notice 6-decimal test token for SpendFloor. Mint authority is OWNER
///  (the deployer). The vault holds SFUSD; the agent never holds any.
contract SFUSD is ERC20, Ownable {
    constructor() ERC20("SpendFloor USD", "SFUSD") Ownable(msg.sender) {}

    function decimals() public view virtual override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
