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
import {LToken} from "./LToken.sol";

/**
 * @title LendingPool
 * @notice Core protocol contract. Manages deposits, borrows, repayments,
 *         liquidations, and ERC-3156 Flash Loans.
 *
 * @dev When a user deposits, they receive LTokens (interest-bearing deposit tokens,
 *      similar to Aave's aTokens). The exchange rate between LTokens and the underlying
 *      asset grows over time as borrowers pay interest:
 *
 *        exchangeRate = (totalLiquidity + totalBorrows) / lToken.totalSupply()
 *
 *      On withdrawal, LTokens are burned and the user receives underlying tokens
 *      at the current (higher) exchange rate, capturing their yield.
 */
contract LendingPool is ReentrancyGuard, Ownable, Pausable, IERC3156FlashLender {
    using SafeERC20 for IERC20;

    // --- Constants ---

    /// @notice 1e18 — standard WAD precision unit.
    uint256 public constant WAD = 1e18;

    /// @notice Flash Loan fee in basis points (9 = 0.09%).
    uint256 public constant FLASH_LOAN_FEE = 9;

    /// @notice Close Factor — max fraction of debt repayable per liquidation call (50%).
    uint256 public constant CLOSE_FACTOR = 5e17;

    /// @notice Reserve factor — fraction of interest retained as protocol reserves (10%).
    uint256 public constant RESERVE_FACTOR = 1e17;

    /// @notice Maximum number of listed markets (prevents gas exhaustion in HF loops).
    uint256 public constant MAX_MARKETS = 25;

    // --- State ---

    PriceOracleWrapper public oracle;
    InterestRateModel public interestModel;

    struct Market {
        bool isListed;
        uint256 totalLiquidity;   // Underlying tokens available to borrow
        uint256 totalBorrows;     // Outstanding borrows (grows with interest)
        uint256 totalReserves;    // Protocol reserves (10% of interest)
        uint256 borrowIndex;      // Cumulative borrow interest index (starts at WAD)
        uint256 lastUpdateTimestamp;
        uint256 ltv;              // Loan-to-Value in WAD (e.g. 0.75e18 = 75%)
        uint256 liquidationBonus; // Bonus in WAD (e.g. 1.08e18 = 8% bonus)
        address lToken;           // Address of the market's LToken contract
    }

    mapping(address => Market) public markets;
    mapping(address => mapping(address => uint256)) public accountCollateral;   // user → token → underlying amount
    mapping(address => mapping(address => uint256)) public accountBorrowsPrincipal;
    mapping(address => mapping(address => uint256)) public accountBorrowIndex;

    address[] public allMarkets;

    // --- Events ---

    event MarketAdded(address indexed token, address indexed lToken, uint256 ltv, uint256 liquidationBonus);
    event Deposit(address indexed user, address indexed token, uint256 underlyingAmount, uint256 lTokensMinted);
    event Withdraw(address indexed user, address indexed token, uint256 underlyingAmount, uint256 lTokensBurned);
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
    event MarketConfigurationUpdated(address indexed token, uint256 ltv, uint256 liquidationBonus);

    // --- Constructor ---

    /**
     * @param _oracle        Address of the PriceOracleWrapper contract.
     * @param _interestModel Address of the InterestRateModel contract.
     */
    constructor(address _oracle, address _interestModel) Ownable(msg.sender) {
        oracle = PriceOracleWrapper(_oracle);
        interestModel = InterestRateModel(_interestModel);
    }

    // --- Admin functions ---

    /**
     * @notice List a new asset and deploy its corresponding LToken.
     * @param token            Address of the ERC-20 underlying asset.
     * @param ltv              Loan-to-Value ratio in WAD.
     * @param liquidationBonus Liquidation bonus in WAD (e.g. 1.08e18).
     * @param lTokenName       Name for the LToken (e.g. "Lending USDC").
     * @param lTokenSymbol     Symbol for the LToken (e.g. "lUSDC").
     */
    function addMarket(
        address token,
        uint256 ltv,
        uint256 liquidationBonus,
        string calldata lTokenName,
        string calldata lTokenSymbol
    ) external onlyOwner {
        require(token != address(0), "LendingPool: token is address(0)");
        require(!markets[token].isListed, "LendingPool: market already exists");
        require(allMarkets.length < MAX_MARKETS, "LendingPool: maximum markets reached");
        require(ltv < WAD, "LendingPool: LTV must be < 100%");
        require(liquidationBonus > WAD, "LendingPool: Bonus must be > 100%");

        // Deploy a new LToken for this market. The pool is its exclusive minter/burner.
        LToken lToken = new LToken(lTokenName, lTokenSymbol, address(this), token);

        markets[token] = Market({
            isListed: true,
            totalLiquidity: 0,
            totalBorrows: 0,
            totalReserves: 0,
            borrowIndex: WAD,
            lastUpdateTimestamp: block.timestamp,
            ltv: ltv,
            liquidationBonus: liquidationBonus,
            lToken: address(lToken)
        });
        allMarkets.push(token);

        emit MarketAdded(token, address(lToken), ltv, liquidationBonus);
    }

    /**
     * @notice Update risk parameters for an existing market.
     * @param token            Address of the underlying asset.
     * @param ltv              New Loan-to-Value ratio.
     * @param liquidationBonus New liquidation bonus.
     */
    function setMarketConfiguration(
        address token,
        uint256 ltv,
        uint256 liquidationBonus
    ) external onlyOwner {
        require(markets[token].isListed, "LendingPool: market not listed");
        require(ltv < WAD, "LendingPool: LTV must be < 100%");
        require(liquidationBonus > WAD, "LendingPool: Bonus must be > 100%");

        markets[token].ltv = ltv;
        markets[token].liquidationBonus = liquidationBonus;

        emit MarketConfigurationUpdated(token, ltv, liquidationBonus);
    }

    /// @notice Pause all user-facing operations (emergency).
    function pause() external onlyOwner { _pause(); }

    /// @notice Unpause all operations.
    function unpause() external onlyOwner { _unpause(); }

    // --- Interest accrual ---

    /**
     * @notice Accrue interest for a market, updating borrowIndex, totalBorrows, and reserves.
     * @param token Market's underlying token address.
     */
    function updateState(address token) public {
        Market storage market = markets[token];
        if (!market.isListed) return;

        uint256 deltaTime = block.timestamp - market.lastUpdateTimestamp;

        if (deltaTime > 0 && market.totalBorrows > 0) {
            uint256 borrowRate = interestModel.getBorrowRatePerSecond(market.totalLiquidity, market.totalBorrows);
            uint256 interestFactor = borrowRate * deltaTime;
            uint256 interestAccumulated = (market.totalBorrows * interestFactor) / WAD;

            uint256 reserveShare = (interestAccumulated * RESERVE_FACTOR) / WAD;
            market.totalReserves += reserveShare;
            market.totalBorrows += interestAccumulated;
            market.borrowIndex += (market.borrowIndex * interestFactor) / WAD;

            emit InterestAccrued(token, interestAccumulated, market.borrowIndex);
        }

        market.lastUpdateTimestamp = block.timestamp;
    }

    /// @dev Sync a user's borrow balance with the latest borrow index.
    function _updateUserBorrows(address user, address token) internal {
        uint256 principal = accountBorrowsPrincipal[user][token];
        if (principal > 0) {
            uint256 oldIndex = accountBorrowIndex[user][token];
            uint256 newIndex = markets[token].borrowIndex;
            accountBorrowsPrincipal[user][token] = (principal * newIndex) / oldIndex;
        }
        accountBorrowIndex[user][token] = markets[token].borrowIndex;
    }

    // --- Exchange rate math ---

    /**
     * @notice Compute the current exchange rate: underlying per LToken (in WAD).
     * @dev rate = (totalLiquidity + totalBorrows - totalReserves) / lToken.totalSupply()
     *      When no LTokens exist yet, the rate is 1:1 (WAD).
     * @param token Underlying token address.
     * @return rate Exchange rate in WAD (1e18 = 1 underlying per LToken).
     */
    function exchangeRate(address token) public view returns (uint256 rate) {
        Market storage m = markets[token];
        require(m.isListed, "LendingPool: token not supported");

        uint256 lTokenSupply = IERC20(m.lToken).totalSupply();
        if (lTokenSupply == 0) return WAD;

        uint256 totalAssets = m.totalLiquidity + m.totalBorrows - m.totalReserves;
        return (totalAssets * WAD) / lTokenSupply;
    }

    /**
     * @notice Get how much underlying a user would receive by burning all their LTokens.
     * @param user  Address of the depositor.
     * @param token Underlying token address.
     * @return Underlying amount claimable.
     */
    function getUnderlyingBalance(address user, address token) external view returns (uint256) {
        Market storage m = markets[token];
        require(m.isListed, "LendingPool: token not supported");
        uint256 lBalance = IERC20(m.lToken).balanceOf(user);
        return (lBalance * exchangeRate(token)) / WAD;
    }

    // --- User actions ---

    /**
     * @notice Deposit underlying tokens and receive LTokens in return.
     * @dev LTokens minted = underlyingAmount / exchangeRate.
     *      The first deposit initialises the exchange rate at 1:1.
     * @param token  Underlying token address.
     * @param amount Amount of underlying to deposit.
     */
    function deposit(address token, uint256 amount) external nonReentrant whenNotPaused {
        require(markets[token].isListed, "Market not supported");
        updateState(token);

        Market storage market = markets[token];

        // Calculate LTokens to mint before updating state
        uint256 rate = exchangeRate(token);
        uint256 lTokensToMint = (amount * WAD) / rate;

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        accountCollateral[msg.sender][token] += amount;
        market.totalLiquidity += amount;

        LToken(market.lToken).mint(msg.sender, lTokensToMint);

        emit Deposit(msg.sender, token, amount, lTokensToMint);
    }

    /**
     * @notice Burn LTokens and withdraw the corresponding underlying amount (+ accrued yield).
     * @param token      Underlying token address.
     * @param lTokenAmount Amount of LTokens to burn.
     */
    function withdraw(address token, uint256 lTokenAmount) external nonReentrant whenNotPaused {
        updateState(token);
        _updateUserBorrows(msg.sender, token);

        Market storage market = markets[token];

        uint256 rate = exchangeRate(token);
        uint256 underlyingAmount = (lTokenAmount * rate) / WAD;

        require(accountCollateral[msg.sender][token] >= underlyingAmount, "Insufficient collateral for withdrawal");

        // Temporarily reduce collateral to check health factor
        accountCollateral[msg.sender][token] -= underlyingAmount;
        market.totalLiquidity -= underlyingAmount;

        require(getHealthFactor(msg.sender) >= WAD, "HF < 1.0: action not allowed");

        LToken(market.lToken).burn(msg.sender, lTokenAmount);
        IERC20(token).safeTransfer(msg.sender, underlyingAmount);

        emit Withdraw(msg.sender, token, underlyingAmount, lTokenAmount);
    }

    /**
     * @notice Borrow tokens against deposited collateral.
     * @param token  Underlying token to borrow.
     * @param amount Amount to borrow.
     */
    function borrow(address token, uint256 amount) external nonReentrant whenNotPaused {
        require(markets[token].isListed, "LendingPool: market not found");
        updateState(token);
        _updateUserBorrows(msg.sender, token);

        require(markets[token].totalLiquidity >= amount, "LendingPool: insufficient liquidity");

        accountBorrowsPrincipal[msg.sender][token] += amount;
        markets[token].totalBorrows += amount;
        markets[token].totalLiquidity -= amount;

        require(getHealthFactor(msg.sender) >= WAD, "HF < 1.0: action not allowed");

        IERC20(token).safeTransfer(msg.sender, amount);

        emit Borrow(msg.sender, token, amount);
    }

    /**
     * @notice Repay outstanding debt. Capped at current debt if amount exceeds it.
     * @param token  Underlying token to repay.
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

    // --- Liquidations ---

    /**
     * @notice Liquidate a sub-collateralised position.
     * @dev Liquidator repays up to CLOSE_FACTOR (50%) of the user's debt per call
     *      and receives the equivalent collateral plus the liquidation bonus.
     *      If collateral is insufficient, the amount is gracefully capped.
     * @param user            The borrower whose position is underwater (HF < 1).
     * @param collateralToken Token the liquidator will receive.
     * @param debtToken       Token the liquidator will repay.
     */
    function liquidate(
        address user,
        address collateralToken,
        address debtToken
    ) external nonReentrant whenNotPaused {
        updateState(collateralToken);
        updateState(debtToken);
        _updateUserBorrows(user, debtToken);

        require(getHealthFactor(user) < WAD, "Position is healthy: no liquidation needed");

        uint256 userDebt = accountBorrowsPrincipal[user][debtToken];
        require(userDebt > 0, "No debt to liquidate");

        uint256 maxRepayable = (userDebt * CLOSE_FACTOR) / WAD;
        uint256 debtToRepay = maxRepayable;

        uint256 debtPrice = oracle.getTokenPrice(debtToken);
        uint256 collateralPrice = oracle.getTokenPrice(collateralToken);
        uint256 debtValue = (debtToRepay * debtPrice) / WAD;
        uint256 bonus = markets[collateralToken].liquidationBonus;
        uint256 collateralToSeize = (debtValue * bonus) / collateralPrice;

        uint256 userCollateral = accountCollateral[user][collateralToken];
        if (collateralToSeize > userCollateral) {
            collateralToSeize = userCollateral;
            debtToRepay = (collateralToSeize * collateralPrice) / (debtPrice * bonus / WAD);
        }

        IERC20(debtToken).safeTransferFrom(msg.sender, address(this), debtToRepay);

        accountBorrowsPrincipal[user][debtToken] -= debtToRepay;
        markets[debtToken].totalBorrows -= debtToRepay;
        markets[debtToken].totalLiquidity += debtToRepay;

        accountCollateral[user][collateralToken] -= collateralToSeize;
        markets[collateralToken].totalLiquidity -= collateralToSeize;

        // Also burn the proportional LTokens from the borrower
        uint256 lTokensToBurn = (collateralToSeize * WAD) / exchangeRate(collateralToken);
        if (lTokensToBurn > 0) {
            uint256 lTokenBalance = IERC20(markets[collateralToken].lToken).balanceOf(user);
            if (lTokensToBurn > lTokenBalance) lTokensToBurn = lTokenBalance;
            LToken(markets[collateralToken].lToken).burn(user, lTokensToBurn);
        }

        IERC20(collateralToken).safeTransfer(msg.sender, collateralToSeize);

        emit Liquidate(msg.sender, user, collateralToken, debtToken, debtToRepay, collateralToSeize);
    }

    // --- View functions ---

    /**
     * @notice Compute the Health Factor for a user across all markets.
     * @param user Address of the user.
     * @return     Health Factor in WAD (values ≥ WAD are healthy).
     */
    function getHealthFactor(address user) public view returns (uint256) {
        uint256 totalCollateralValueLimit = 0;
        uint256 totalDebtValue = 0;

        for (uint i = 0; i < allMarkets.length; i++) {
            address token = allMarkets[i];

            uint256 collateral = accountCollateral[user][token];
            if (collateral > 0) {
                uint256 price = oracle.getTokenPrice(token);
                uint256 valueLTV = (((collateral * price) / WAD) * markets[token].ltv) / WAD;
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

    /**
     * @notice Annualised supply APY for a market.
     * @dev supplyRate = borrowRate × utilizationRate × (1 − reserveFactor)
     * @param token Underlying token address.
     * @return Annual supply rate in WAD.
     */
    function getSupplyRate(address token) external view returns (uint256) {
        Market storage m = markets[token];
        if (!m.isListed || m.totalBorrows == 0) return 0;
        uint256 borrowRate = interestModel.getBorrowRate(m.totalLiquidity, m.totalBorrows);
        uint256 utilRate = interestModel.utilizationRate(m.totalLiquidity, m.totalBorrows);
        return ((borrowRate * utilRate) / WAD * (WAD - RESERVE_FACTOR)) / WAD;
    }

    /**
     * @notice Get the LToken address for a given underlying market.
     * @param token Underlying token address.
     * @return lToken address.
     */
    function getLToken(address token) external view returns (address) {
        require(markets[token].isListed, "LToken: market unlisted");
        return markets[token].lToken;
    }

    // --- Flash Loans ---

    bytes32 private constant CALLBACK_SUCCESS = keccak256("ERC3156FlashBorrower.onFlashLoan");

    /// @inheritdoc IERC3156FlashLender
    function maxFlashLoan(address token) external view override returns (uint256) {
        return markets[token].isListed ? IERC20(token).balanceOf(address(this)) : 0;
    }

    /// @inheritdoc IERC3156FlashLender
    function flashFee(address token, uint256 amount) public view override returns (uint256) {
        require(markets[token].isListed, "FlashLoan: unsupported token");
        return (amount * FLASH_LOAN_FEE) / 10000;
    }

    /// @inheritdoc IERC3156FlashLender
    function flashLoan(
        IERC3156FlashBorrower receiver,
        address token,
        uint256 amount,
        bytes calldata data
    ) external override nonReentrant whenNotPaused returns (bool) {
        require(amount <= IERC20(token).balanceOf(address(this)), "LendingPool: insufficient liquidity");

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
