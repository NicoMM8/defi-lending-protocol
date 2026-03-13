// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC3156FlashBorrower} from "@openzeppelin/contracts/interfaces/IERC3156FlashBorrower.sol";
import {IERC3156FlashLender} from "@openzeppelin/contracts/interfaces/IERC3156FlashLender.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title MaliciousFlashBorrower
 * @dev Test-only contract that deliberately fails to repay its flash loan.
 *      Used to verify the LendingPool correctly reverts on unpaid loans.
 */
contract MaliciousFlashBorrower is IERC3156FlashBorrower {
    IERC3156FlashLender public lender;

    constructor(address _lender) {
        lender = IERC3156FlashLender(_lender);
    }

    function stealFlashLoan(address token, uint256 amount) external {
        lender.flashLoan(this, token, amount, "");
    }

    /**
     * @dev Callback — intentionally does NOT approve repayment.
     *      Returns the correct hash so the revert happens at the transferFrom stage.
     */
    function onFlashLoan(
        address,
        address,
        uint256,
        uint256,
        bytes calldata
    ) external pure override returns (bytes32) {
        // Do nothing — don't approve, don't repay
        return keccak256("ERC3156FlashBorrower.onFlashLoan");
    }
}
