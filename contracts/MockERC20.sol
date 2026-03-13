// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockERC20
 * @dev Minimal ERC-20 with public `mint` for testing purposes.
 */
contract MockERC20 is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}

    /// @notice Mint any amount to any address (test-only).
    function mint(address to, uint256 amount) public {
        _mint(to, amount);
    }
}
