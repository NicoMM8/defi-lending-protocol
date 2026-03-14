// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC3156FlashLender} from "@openzeppelin/contracts/interfaces/IERC3156FlashLender.sol";
import {IERC3156FlashBorrower} from "@openzeppelin/contracts/interfaces/IERC3156FlashBorrower.sol";
import {PriceOracleWrapper} from "./PriceOracleWrapper.sol";
import {InterestRateModel} from "./InterestRateModel.sol";

/**
 * @title LendingPool
 * @author DeFi Lending Protocol
 * @notice Core protocol contract. Manages deposits, borrows, repayments,
 *         liquidations, and ERC-3156 Flash Loans.
 * @dev Inherits Ownable for admin functions, Pausable for emergency stops,
 *      and ReentrancyGuard for reentrancy protection.
 */
contract LendingPool is ReentrancyGuard, Ownable, Pausable, IERC3156FlashLender {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════
    //  CONSTANTS
    // ═══════════════════════════════════════════════════

    /// @notice 1e18 — standard precision unit.
    uint256 public constant WAD = 1e18;

    /// @notice Flash Loan fee in basis points (9 = 0.09%).
    uint256 public constant FLASH_LOAN_FEE = 9;

    /// @notice Close Factor — max fraction of debt repayable in one liquidation (50%).
    uint256 public constant CLOSE_FACTOR = 5e17; // 0.5 * 1e18

    /// @notice Reserve factor — fraction of interest kept as protocol reserves (10%).
    uint256 public constant RESERVE_FACTOR = 1e17; // 0.1 * 1e18

    // ═══════════════════════════════════════════════════
    //  STATE
    // ═══════════════════════════════════════════════════

    PriceOracleWrapper public oracle;
    InterestRateModel public interestModel;

    struct Market {
        bool isListed;
        uint256 totalLiquidity;
        uint256 totalBorrows;
        uint256 totalReserves;
        uint256 borrowIndex;
        uint256 lastUpdateTimestamp;
        uint256 ltv;              // Loan-to-Value in WAD (e.g. 0.8e18 = 80%)
        uint256 liquidationBonus; // In WAD (e.g. 1.05e18 = 5% bonus)
    }

    mapping(address => Market) public markets;
    mapping(address => mapping(address => uint256)) public accountCollateral;
    mapping(address => mapping(address => uint256)) public accountBorrowsPrincipal;
    mapping(address => mapping(address => uint256)) public accountBorrowIndex;

    address[] public allMarkets;

    // ═══════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════

    event MarketAdded(address indexed token, uint256 ltv, uint256 liquidationBonus);
    event Deposit(address indexed user, address indexed token, uint256 amount);
    event Withdraw(address indexed user, address indexed token, uint256 amount);
    event Borrow(address indexed user, address indexed token, uint256 amount);
    event Repay(address indexed user, address indexed token, uint256 amount);
    event Liquidate(
        address indexed liquidator,
        address indexed user,
        address collateralToken,
        address debtToken,
        uint256 debtRepaid,
        uint256 collateralSeized
    );
    event InterestAccrued(address indexed token, uint256 interestAccumulated, uint256 newBorrowIndex);
    event FlashLoanExecuted(address indexed receiver, address indexed token, uint256 amount, uint256 fee);

    // ═══════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════

    /**
     * @notice Deploy the LendingPool with the given oracle and interest model.
     * @param _oracle        Address of the PriceOracleWrapper contract.
     * @param _interestModel Address of the InterestRateModel contract.
     */
    constructor(address _oracle, address _interestModel) Ownable(msg.sender) {
        oracle = PriceOracleWrapper(_oracle);
        interestModel = InterestRateModel(_interestModel);
    }

    // ═══════════════════════════════════════════════════
    //  ADMIN
    // ═══════════════════════════════════════════════════

    /**
     * @notice Add a new lending market for the given token.
     * @param token            Address of the ERC-20 token.
     * @param ltv              Loan-to-Value ratio in WAD.
     * @param liquidationBonus Liquidation bonus in WAD.
     */
    function addMarket(address token, uint256 ltv, uint256 liquidationBonus) external onlyOwner {
        require(!markets[token].isListed, "Market already listed");
        markets[token] = Market({
            isListed: true,
            totalLiquidity: 0,
            totalBorrows: 0,
            totalReserves: 0,
            borrowIndex: WAD,
            lastUpdateTimestamp: block.timestamp,
            ltv: ltv,
            liquidationBonus: liquidationBonus
        });
        allMarkets.push(token);
        emit MarketAdded(token, ltv, liquidationBonus);
    }

    /**
     * @notice Pause all user-facing operations (emergency).
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpause all operations.
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    // ═══════════════════════════════════════════════════
    //  INTEREST ACCRUAL
    // ═══════════════════════════════════════════════════

    /**
     * @notice Accrue interest for a market, updating borrowIndex, totalBorrows, and reserves.
     * @param token Address of the market token.
     */
    function updateState(address token) public {
        Market storage market = markets[token];
        if (!market.isListed) return;

        uint256 currentTimestamp = block.timestamp;
        uint256 deltaTime = currentTimestamp - market.lastUpdateTimestamp;

        if (deltaTime > 0 && market.totalBorrows > 0) {
            uint256 borrowRate = interestModel.getBorrowRatePerSecond(market.totalLiquidity, market.totalBorrows);
            uint256 interestFactor = borrowRate * deltaTime;
            uint256 interestAccumulated = (market.totalBorrows * interestFactor) / WAD;

            // Split interest: reserves vs depositors
            uint256 reserveShare = (interestAccumulated * RESERVE_FACTOR) / WAD;
            market.totalReserves += reserveShare;

            market.totalBorrows += interestAccumulated;
            market.borrowIndex += (market.borrowIndex * interestFactor) / WAD;

            emit InterestAccrued(token, interestAccumulated, market.borrowIndex);
        }

        market.lastUpdateTimestamp = currentTimestamp;
    }

    /**
     * @dev Synchronise a user's recorded borrow balance with the latest borrow index.
     */
    function _updateUserBorrows(address user, address token) internal {
        uint256 principal = accountBorrowsPrincipal[user][token];
        if (principal > 0) {
            uint256 oldIndex = accountBorrowIndex[user][token];
            uint256 newIndex = markets[token].borrowIndex;
            accountBorrowsPrincipal[user][token] = (principal * newIndex) / oldIndex;
        }
        accountBorrowIndex[user][token] = markets[token].borrowIndex;
    }

    // ═══════════════════════════════════════════════════
    //  USER OPERATIONS
    // ═══════════════════════════════════════════════════

    /**
     * @notice Deposit tokens as collateral.
     * @param token  Address of the ERC-20 token.
     * @param amount Amount to deposit.
     */
    function deposit(address token, uint256 amount) external nonReentrant whenNotPaused {
        require(markets[token].isListed, "Market not listed");
        updateState(token);

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        accountCollateral[msg.sender][token] += amount;
        markets[token].totalLiquidity += amount;

        emit Deposit(msg.sender, token, amount);
    }

    /**
     * @notice Withdraw collateral, if doing so keeps the Health Factor ≥ 1.
     * @param token  Address of the ERC-20 token.
     * @param amount Amount to withdraw.
     */
    function withdraw(address token, uint256 amount) external nonReentrant whenNotPaused {
        updateState(token);
        _updateUserBorrows(msg.sender, token);

        require(accountCollateral[msg.sender][token] >= amount, "Not enough collateral");

        accountCollateral[msg.sender][token] -= amount;
        markets[token].totalLiquidity -= amount;

        require(getHealthFactor(msg.sender) >= WAD, "Health factor too low");

        IERC20(token).safeTransfer(msg.sender, amount);

        emit Withdraw(msg.sender, token, amount);
    }

    /**
     * @notice Borrow tokens against deposited collateral.
     * @param token  Address of the ERC-20 token to borrow.
     * @param amount Amount to borrow.
     */
    function borrow(address token, uint256 amount) external nonReentrant whenNotPaused {
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

    /**
     * @notice Repay outstanding debt. Capped at the current debt if amount exceeds it.
     * @param token  Address of the ERC-20 token.
     * @param amount Maximum amount the caller is willing to repay.
     */
    function repay(address token, uint256 amount) external nonReentrant whenNotPaused {
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

    // ═══════════════════════════════════════════════════
    //  LIQUIDATION (with Close Factor)
    // ═══════════════════════════════════════════════════

    /**
     * @notice Liquidate a sub-collateralised position.
     * @dev The liquidator can repay at most CLOSE_FACTOR (50%) of the user's debt
     *      per call, and receives the equivalent collateral plus the liquidation bonus.
     * @param user            The borrower whose position is underwater.
     * @param collateralToken Token the liquidator will receive (with bonus).
     * @param debtToken       Token the liquidator will repay.
     */
    function liquidate(address user, address collateralToken, address debtToken) external nonReentrant whenNotPaused {
        updateState(collateralToken);
        updateState(debtToken);
        _updateUserBorrows(user, debtToken);

        uint256 hf = getHealthFactor(user);
        require(hf < WAD, "Position is healthy");

        uint256 userDebt = accountBorrowsPrincipal[user][debtToken];
        require(userDebt > 0, "No debt to liquidate");

        // Close Factor: liquidator repays up to 50% of total debt
        uint256 maxRepayable = (userDebt * CLOSE_FACTOR) / WAD;
        uint256 debtToRepay = maxRepayable;

        // Calculate equivalent collateral + bonus
        uint256 debtPrice = oracle.getTokenPrice(debtToken);
        uint256 collateralPrice = oracle.getTokenPrice(collateralToken);

        uint256 debtValue = (debtToRepay * debtPrice) / WAD;
        uint256 bonus = markets[collateralToken].liquidationBonus;
        uint256 collateralToSeize = (debtValue * bonus) / collateralPrice;

        uint256 userCollateral = accountCollateral[user][collateralToken];
        // If collateral is insufficient, cap to what is available
        if (collateralToSeize > userCollateral) {
            collateralToSeize = userCollateral;
            // Back-calculate the actual debt to repay from capped collateral
            debtToRepay = (collateralToSeize * collateralPrice) / (debtPrice * bonus / WAD);
        }

        // Perform transfers
        IERC20(debtToken).safeTransferFrom(msg.sender, address(this), debtToRepay);

        accountBorrowsPrincipal[user][debtToken] -= debtToRepay;
        markets[debtToken].totalBorrows -= debtToRepay;
        markets[debtToken].totalLiquidity += debtToRepay;

        accountCollateral[user][collateralToken] -= collateralToSeize;
        markets[collateralToken].totalLiquidity -= collateralToSeize;

        IERC20(collateralToken).safeTransfer(msg.sender, collateralToSeize);

        emit Liquidate(msg.sender, user, collateralToken, debtToken, debtToRepay, collateralToSeize);
    }

    // ═══════════════════════════════════════════════════
    //  VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════

    /**
     * @notice Compute the Health Factor for a user across all markets.
     * @param user Address of the user.
     * @return hf  Health Factor in WAD (1e18 = healthy threshold).
     */
    function getHealthFactor(address user) public view returns (uint256) {
        uint256 totalCollateralValueLimit = 0;
        uint256 totalDebtValue = 0;

        for (uint i = 0; i < allMarkets.length; i++) {
            address token = allMarkets[i];

            // Collateral Value
            uint256 collateral = accountCollateral[user][token];
            if (collateral > 0) {
                uint256 price = oracle.getTokenPrice(token);
                uint256 value = (collateral * price) / WAD;
                uint256 valueLTV = (value * markets[token].ltv) / WAD;
                totalCollateralValueLimit += valueLTV;
            }

            // Debt Value
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

    /**
     * @notice Get the current annualised supply APY for a market.
     * @dev supplyRate = borrowRate × utilizationRate × (1 − reserveFactor)
     * @param token Address of the market token.
     * @return Annual supply rate in WAD.
     */
    function getSupplyRate(address token) external view returns (uint256) {
        Market storage m = markets[token];
        if (!m.isListed || m.totalBorrows == 0) return 0;

        uint256 borrowRate = interestModel.getBorrowRate(m.totalLiquidity, m.totalBorrows);
        uint256 utilRate = interestModel.utilizationRate(m.totalLiquidity, m.totalBorrows);
        uint256 grossSupply = (borrowRate * utilRate) / WAD;
        return (grossSupply * (WAD - RESERVE_FACTOR)) / WAD;
    }

    // ═══════════════════════════════════════════════════
    //  ERC-3156 FLASH LOAN
    // ═══════════════════════════════════════════════════

    bytes32 private constant CALLBACK_SUCCESS = keccak256("ERC3156FlashBorrower.onFlashLoan");

    /// @inheritdoc IERC3156FlashLender
    function maxFlashLoan(address token) external view override returns (uint256) {
        return markets[token].isListed ? IERC20(token).balanceOf(address(this)) : 0;
    }

    /// @inheritdoc IERC3156FlashLender
    function flashFee(address token, uint256 amount) public view override returns (uint256) {
        require(markets[token].isListed, "Market not listed");
        return (amount * FLASH_LOAN_FEE) / 10000;
    }

    /// @inheritdoc IERC3156FlashLender
    function flashLoan(
        IERC3156FlashBorrower receiver,
        address token,
        uint256 amount,
        bytes calldata data
    ) external override nonReentrant whenNotPaused returns (bool) {
        require(amount <= IERC20(token).balanceOf(address(this)), "Not enough liquidity");

        uint256 fee = flashFee(token, amount);

        IERC20(token).safeTransfer(address(receiver), amount);

        require(
            receiver.onFlashLoan(msg.sender, token, amount, fee, data) == CALLBACK_SUCCESS,
            "FlashLender: Callback failed"
        );

        IERC20(token).safeTransferFrom(address(receiver), address(this), amount + fee);

        markets[token].totalLiquidity += fee;

        emit FlashLoanExecuted(address(receiver), token, amount, fee);

        return true;
    }
}
