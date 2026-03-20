// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC3156FlashBorrower} from "@openzeppelin/contracts/interfaces/IERC3156FlashBorrower.sol";
import {IERC3156FlashLender} from "@openzeppelin/contracts/interfaces/IERC3156FlashLender.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title ArbitrageBot
 * @notice Example flash loan receiver for arbitrage trades.
 *         Demonstrates interacting with the LendingPool via ERC-3156.
 */
contract ArbitrageBot is IERC3156FlashBorrower {
    using SafeERC20 for IERC20;

    /// @notice The Flash Loan lender (LendingPool).
    IERC3156FlashLender public lender;

    /// @notice The owner who funds the bot and withdraws profits.
    address public owner;

    event ArbitrageExecuted(address indexed token, uint256 amount, uint256 profit);

    /**
     * @notice Deploy the bot with a reference to the flash lender.
     * @param _lender Address of the ERC-3156 flash lender (LendingPool).
     */
    constructor(address _lender) {
        lender = IERC3156FlashLender(_lender);
        owner = msg.sender;
    }

    // State used to pass minProfit to the callback
    uint256 private _minProfit;

    /**
     * @notice Initiate a flash loan for arbitrage.
     * @param token      Token to borrow.
     * @param amount     Amount to borrow.
     * @param minProfit  Minimum required profit (after fees) to not revert.
     */
    function executeArbitrage(address token, uint256 amount, uint256 minProfit) external {
        uint256 maxBorrow = lender.maxFlashLoan(token);
        require(maxBorrow >= amount, "Not enough liquidity in pool");

        _minProfit = minProfit;
        bytes memory data = abi.encode(msg.sender);
        lender.flashLoan(this, token, amount, data);
    }

    /**
     * @notice ERC-3156 callback — executes the arbitrage logic.
     * @dev Simulated arbitrage for testing purposes.
     */
    function onFlashLoan(
        address initiator,
        address token,
        uint256 amount,
        uint256 fee,
        bytes calldata /* data */
    ) external override returns (bytes32) {
        require(msg.sender == address(lender), "Untrusted lender");
        require(initiator == address(this), "Untrusted initiator");

        // --- Simulated Arbitrage ---
        // Pull "profit" from owner to simulate a successful trade.
        uint256 simulatedProfit = fee + 10e18;
        IERC20(token).safeTransferFrom(owner, address(this), simulatedProfit);

        uint256 currentBalance = IERC20(token).balanceOf(address(this));
        uint256 amountToRepay = amount + fee;
        require(currentBalance >= amountToRepay, "Arbitrage failed, not enough to repay");

        uint256 profit = currentBalance - amountToRepay;
        require(profit >= _minProfit, "Profit below minProfit check");

        IERC20(token).forceApprove(address(lender), amountToRepay);

        emit ArbitrageExecuted(token, amount, profit);

        return keccak256("ERC3156FlashBorrower.onFlashLoan");
    }

    /**
     * @notice Withdraw residual profits to the owner.
     * @param token Token to withdraw.
     */
    function withdrawProfits(address token) external {
        require(msg.sender == owner, "Not owner");
        uint256 balance = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(owner, balance);
    }
}
