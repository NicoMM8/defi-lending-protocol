// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title LToken
 * @notice Interest-bearing deposit token. Each LToken represents a claim over
 *         the underlying asset deposited in the LendingPool, growing in value
 *         as borrowers pay interest — similar to Aave's aTokens or Compound's cTokens.
 *
 * @dev The exchange rate between LToken and the underlying asset increases over time:
 *
 *        exchangeRate = (totalLiquidity + totalBorrows) / totalSupply(LToken)
 *
 *      Minting and burning are restricted to the LendingPool via the `onlyPool` modifier.
 */
contract LToken is ERC20 {
    /// @notice The LendingPool contract authorised to mint and burn this token.
    address public immutable pool;

    /// @notice The underlying ERC-20 asset represented by this LToken.
    address public immutable underlying;

    error OnlyPool();

    modifier onlyPool() {
        if (msg.sender != pool) revert OnlyPool();
        _;
    }

    /**
     * @param name       Token name (e.g. "Lending USDC").
     * @param symbol     Token symbol (e.g. "lUSDC").
     * @param _pool      Address of the LendingPool (gets mint/burn rights).
     * @param _underlying Address of the underlying ERC-20 asset.
     */
    constructor(
        string memory name,
        string memory symbol,
        address _pool,
        address _underlying
    ) ERC20(name, symbol) {
        pool = _pool;
        underlying = _underlying;
    }

    /**
     * @notice Mint LTokens to a depositor. Called by LendingPool on `deposit()`.
     * @param to     Recipient of the newly minted LTokens.
     * @param amount Amount to mint (in underlying asset units, before exchange rate).
     */
    function mint(address to, uint256 amount) external onlyPool {
        _mint(to, amount);
    }

    /**
     * @notice Burn LTokens from a withdrawer. Called by LendingPool on `withdraw()`.
     * @param from   Address whose LTokens are burned.
     * @param amount Amount to burn.
     */
    function burn(address from, uint256 amount) external onlyPool {
        _burn(from, amount);
    }
}
