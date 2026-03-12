// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC3156FlashLender} from "@openzeppelin/contracts/interfaces/IERC3156FlashLender.sol";
import {IERC3156FlashBorrower} from "@openzeppelin/contracts/interfaces/IERC3156FlashBorrower.sol";
import {PriceOracleWrapper} from "./PriceOracleWrapper.sol";
import {InterestRateModel} from "./InterestRateModel.sol";

/**
 * @title LendingPool
 * @dev Core protocol contract. Manages deposits, borrows, repayments,
 *      withdrawals, liquidations, and ERC-3156 Flash Loans.
 */
contract LendingPool is ReentrancyGuard, IERC3156FlashLender {
    using SafeERC20 for IERC20;

    uint256 public constant WAD = 1e18;
    uint256 public constant FLASH_LOAN_FEE = 9; // 0.09% = 9 basis points

    PriceOracleWrapper public oracle;
    InterestRateModel public interestModel;

    struct Market {
        bool isListed;
        uint256 totalLiquidity;
        uint256 totalBorrows;
        uint256 borrowIndex;
        uint256 lastUpdateTimestamp;
        uint256 ltv;
        uint256 liquidationBonus;
    }

    mapping(address => Market) public markets;
    mapping(address => mapping(address => uint256)) public accountCollateral;
    mapping(address => mapping(address => uint256)) public accountBorrowsPrincipal;
    mapping(address => mapping(address => uint256)) public accountBorrowIndex;

    address[] public allMarkets;

    event Deposit(address indexed user, address indexed token, uint256 amount);
    event Withdraw(address indexed user, address indexed token, uint256 amount);
    event Borrow(address indexed user, address indexed token, uint256 amount);
    event Repay(address indexed user, address indexed token, uint256 amount);
    event Liquidate(address indexed liquidator, address indexed user, address collateralToken, address debtToken, uint256 debtRepaid, uint256 collateralLiquidated);

    constructor(address _oracle, address _interestModel) {
        oracle = PriceOracleWrapper(_oracle);
        interestModel = InterestRateModel(_interestModel);
    }

    function addMarket(address token, uint256 ltv, uint256 liquidationBonus) external {
        require(!markets[token].isListed, "Market already listed");
        markets[token] = Market({
            isListed: true,
            totalLiquidity: 0,
            totalBorrows: 0,
            borrowIndex: WAD,
            lastUpdateTimestamp: block.timestamp,
            ltv: ltv,
            liquidationBonus: liquidationBonus
        });
        allMarkets.push(token);
    }

    function updateState(address token) public {
        Market storage market = markets[token];
        if (!market.isListed) return;

        uint256 currentTimestamp = block.timestamp;
        uint256 deltaTime = currentTimestamp - market.lastUpdateTimestamp;

        if (deltaTime > 0 && market.totalBorrows > 0) {
            uint256 borrowRate = interestModel.getBorrowRatePerSecond(market.totalLiquidity, market.totalBorrows);
            uint256 interestFactor = (borrowRate * deltaTime);
            uint256 interestAccumulated = (market.totalBorrows * interestFactor) / WAD;

            market.totalBorrows += interestAccumulated;
            market.borrowIndex += (market.borrowIndex * interestFactor) / WAD;
        }

        market.lastUpdateTimestamp = currentTimestamp;
    }

    function _updateUserBorrows(address user, address token) internal {
        uint256 principal = accountBorrowsPrincipal[user][token];
        if (principal > 0) {
            uint256 oldIndex = accountBorrowIndex[user][token];
            uint256 newIndex = markets[token].borrowIndex;
            uint256 currentDebt = (principal * newIndex) / oldIndex;
            accountBorrowsPrincipal[user][token] = currentDebt;
        }
        accountBorrowIndex[user][token] = markets[token].borrowIndex;
    }

    function deposit(address token, uint256 amount) external nonReentrant {
        require(markets[token].isListed, "Market not listed");
        updateState(token);
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        accountCollateral[msg.sender][token] += amount;
        markets[token].totalLiquidity += amount;
        emit Deposit(msg.sender, token, amount);
    }

    function withdraw(address token, uint256 amount) external nonReentrant {
        updateState(token);
        _updateUserBorrows(msg.sender, token);
        require(accountCollateral[msg.sender][token] >= amount, "Not enough collateral");
        accountCollateral[msg.sender][token] -= amount;
        markets[token].totalLiquidity -= amount;
        require(getHealthFactor(msg.sender) >= WAD, "Health factor too low");
        IERC20(token).safeTransfer(msg.sender, amount);
        emit Withdraw(msg.sender, token, amount);
    }

    function borrow(address token, uint256 amount) external nonReentrant {
        require(markets[token].isListed, "Market not listed");
        updateState(token);
        _updateUserBorrows(msg.sender, token);
        require(markets[token].totalLiquidity >= amount, "Not enough liquidity");
        accountBorrowsPrincipal[msg.sender][token] += amount;
        markets[token].totalBorrows += amount;
        markets[token].totalLiquidity -= amount;
        require(getHealthFactor(msg.sender) >= WAD, "Health factor too low");
        IERC20(token).safeTransfer(msg.sender, amount);
        emit Borrow(msg.sender, token, amount);
    }

    function repay(address token, uint256 amount) external nonReentrant {
        updateState(token);
        _updateUserBorrows(msg.sender, token);
        uint256 currentDebt = accountBorrowsPrincipal[msg.sender][token];
        uint256 repayAmount = amount > currentDebt ? currentDebt : amount;
        IERC20(token).safeTransferFrom(msg.sender, address(this), repayAmount);
        accountBorrowsPrincipal[msg.sender][token] -= repayAmount;
        markets[token].totalBorrows -= repayAmount;
        markets[token].totalLiquidity += repayAmount;
        emit Repay(msg.sender, token, repayAmount);
    }

    function liquidate(address user, address collateralToken, address debtToken) external nonReentrant {
        updateState(collateralToken);
        updateState(debtToken);
        _updateUserBorrows(user, debtToken);

        uint256 hf = getHealthFactor(user);
        require(hf < WAD, "Position is healthy");

        uint256 userDebt = accountBorrowsPrincipal[user][debtToken];
        require(userDebt > 0, "No debt to liquidate");

        uint256 debtToRepay = userDebt;

        uint256 debtPrice = oracle.getTokenPrice(debtToken);
        uint256 collateralPrice = oracle.getTokenPrice(collateralToken);
        uint256 debtValue = (debtToRepay * debtPrice) / WAD;
        uint256 bonus = markets[collateralToken].liquidationBonus;
        uint256 collateralToLiquidate = (debtValue * WAD * bonus) / (collateralPrice * WAD);

        uint256 userCollateral = accountCollateral[user][collateralToken];
        require(userCollateral >= collateralToLiquidate, "Not enough collateral to liquidate");

        IERC20(debtToken).safeTransferFrom(msg.sender, address(this), debtToRepay);

        accountBorrowsPrincipal[user][debtToken] = 0;
        markets[debtToken].totalBorrows -= debtToRepay;
        markets[debtToken].totalLiquidity += debtToRepay;

        accountCollateral[user][collateralToken] -= collateralToLiquidate;
        markets[collateralToken].totalLiquidity -= collateralToLiquidate;

        IERC20(collateralToken).safeTransfer(msg.sender, collateralToLiquidate);

        emit Liquidate(msg.sender, user, collateralToken, debtToken, debtToRepay, collateralToLiquidate);
    }

    function getHealthFactor(address user) public view returns (uint256) {
        uint256 totalCollateralValueLimit = 0;
        uint256 totalDebtValue = 0;

        for (uint i = 0; i < allMarkets.length; i++) {
            address token = allMarkets[i];

            uint256 collateral = accountCollateral[user][token];
            if (collateral > 0) {
                uint256 price = oracle.getTokenPrice(token);
                uint256 value = (collateral * price) / WAD;
                uint256 valueLTV = (value * markets[token].ltv) / WAD;
                totalCollateralValueLimit += valueLTV;
            }

            uint256 principal = accountBorrowsPrincipal[user][token];
            if (principal > 0) {
                uint256 oldIndex = accountBorrowIndex[user][token];
                uint256 newIndex = markets[token].borrowIndex;
                uint256 currentDebt = (principal * newIndex) / oldIndex;
                uint256 price = oracle.getTokenPrice(token);
                totalDebtValue += (currentDebt * price) / WAD;
            }
        }

        if (totalDebtValue == 0) return type(uint256).max;
        return (totalCollateralValueLimit * WAD) / totalDebtValue;
    }

    // --- ERC-3156 Flash Loan Implementation ---
    bytes32 private constant CALLBACK_SUCCESS = keccak256("ERC3156FlashBorrower.onFlashLoan");

    function maxFlashLoan(address token) external view override returns (uint256) {
        return markets[token].isListed ? IERC20(token).balanceOf(address(this)) : 0;
    }

    function flashFee(address token, uint256 amount) public view override returns (uint256) {
        require(markets[token].isListed, "Market not listed");
        return (amount * FLASH_LOAN_FEE) / 10000;
    }

    function flashLoan(
        IERC3156FlashBorrower receiver,
        address token,
        uint256 amount,
        bytes calldata data
    ) external override nonReentrant returns (bool) {
        require(amount <= IERC20(token).balanceOf(address(this)), "Not enough liquidity");

        uint256 fee = flashFee(token, amount);

        IERC20(token).safeTransfer(address(receiver), amount);

        require(
            receiver.onFlashLoan(msg.sender, token, amount, fee, data) == CALLBACK_SUCCESS,
            "FlashLender: Callback failed"
        );

        IERC20(token).safeTransferFrom(address(receiver), address(this), amount + fee);

        markets[token].totalLiquidity += fee;

        return true;
    }
}
