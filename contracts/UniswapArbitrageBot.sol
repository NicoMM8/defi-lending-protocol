// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC3156FlashBorrower} from "@openzeppelin/contracts/interfaces/IERC3156FlashBorrower.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @dev Minimal Uniswap V2 Router interface — only what we need.
interface IUniswapV2Router02 {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    function getAmountsOut(
        uint256 amountIn,
        address[] calldata path
    ) external view returns (uint256[] memory amounts);
}

/**
 * @title UniswapArbitrageBot
 * @notice Flash loan receiver that performs real arbitrage between Uniswap V2
 *         and Sushiswap. Borrows a token, performs an A → B swap on one DEX,
 *         then B → A on the other, and repays the flash loan — keeping the spread.
 *
 * @dev Flow:
 *   1. Call `executeArbitrage(tokenA, tokenB, flashLoanAmount)`
 *   2. Pool calls `onFlashLoan()` — bot has `flashLoanAmount` of tokenA
 *   3. Swap tokenA → tokenB on the cheaper DEX (routerA)
 *   4. Swap tokenB → tokenA on the more expensive DEX (routerB)
 *   5. Repay `flashLoanAmount + fee` to the pool
 *   6. Keep the difference as profit
 *
 * @dev This contract is designed for use on a mainnet fork for demonstration.
 *      In production: add MEV protection, slippage guards, and access control.
 */
contract UniswapArbitrageBot is IERC3156FlashBorrower, Ownable {
    using SafeERC20 for IERC20;

    bytes32 private constant CALLBACK_SUCCESS = keccak256("ERC3156FlashBorrower.onFlashLoan");

    /// @notice Our lending pool (flash loan source).
    address public immutable lendingPool;

    /// @notice Uniswap V2 Router.
    IUniswapV2Router02 public immutable uniswapRouter;

    /// @notice Sushiswap Router (same interface, different liquidity pools).
    IUniswapV2Router02 public immutable sushiswapRouter;

    struct ArbitrageParams {
        address tokenA;    // Flash-borrowed token (and final repayment token)
        address tokenB;    // Intermediate token (buy low, sell high)
        bool uniFirstBuy;  // If true: buy tokenB on Uniswap, sell on Sushi
        uint256 minProfit; // Minimum profit required in tokenA
    }

    // Transient storage — populated before calling flash loan, read inside callback
    ArbitrageParams private _pending;

    event ArbitrageExecuted(
        address indexed tokenA,
        address indexed tokenB,
        uint256 flashAmount,
        uint256 fee,
        int256  profit
    );

    /**
     * @param _lendingPool     Flash loan source.
     * @param _uniswapRouter   Uniswap V2 Router02 address.
     * @param _sushiswapRouter Sushiswap Router02 address.
     */
    constructor(
        address _lendingPool,
        address _uniswapRouter,
        address _sushiswapRouter
    ) Ownable(msg.sender) {
        lendingPool = _lendingPool;
        uniswapRouter = IUniswapV2Router02(_uniswapRouter);
        sushiswapRouter = IUniswapV2Router02(_sushiswapRouter);
    }

    /**
     * @notice Initiate a flash loan arbitrage between Uniswap V2 and Sushiswap.
     *
     * @dev Before calling, the owner should check on-chain prices to ensure
     *      a spread exists. The function reverts if the trade is unprofitable.
     *
     * @param tokenA       Token to flash-borrow (e.g. WETH).
     * @param tokenB       Intermediate token (e.g. USDC).
     * @param flashAmount  Amount of tokenA to borrow.
     * @param uniFirstBuy  If true, buy tokenB on Uniswap then sell on Sushi.
     *                     If false, buy on Sushi then sell on Uniswap.
     */
    function executeArbitrage(
        address tokenA,
        address tokenB,
        uint256 flashAmount,
        bool uniFirstBuy,
        uint256 minProfit
    ) external onlyOwner {
        _pending = ArbitrageParams(tokenA, tokenB, uniFirstBuy, minProfit);

        // Pull the flash loan — triggers onFlashLoan()
        (bool success,) = lendingPool.call(
            abi.encodeWithSignature(
                "flashLoan(address,address,uint256,bytes)",
                address(this),
                tokenA,
                flashAmount,
                bytes("")
            )
        );
        require(success, "Flash loan failed");
    }

    /// @inheritdoc IERC3156FlashBorrower
    function onFlashLoan(
        address initiator,
        address token,
        uint256 amount,
        uint256 fee,
        bytes calldata /*data*/
    ) external override returns (bytes32) {
        require(msg.sender == lendingPool, "Caller is not LendingPool");
        require(initiator == address(this), "Untrusted initiator");

        ArbitrageParams memory p = _pending;
        require(token == p.tokenA, "Unexpected flash token");

        address[] memory pathAB = new address[](2);
        pathAB[0] = p.tokenA;
        pathAB[1] = p.tokenB;

        address[] memory pathBA = new address[](2);
        pathBA[0] = p.tokenB;
        pathBA[1] = p.tokenA;

        uint256 deadline = block.timestamp + 60;

        // --- Step 1: Swap tokenA -> tokenB on the "buy" router ---
        IUniswapV2Router02 buyRouter  = p.uniFirstBuy ? uniswapRouter  : sushiswapRouter;
        IUniswapV2Router02 sellRouter = p.uniFirstBuy ? sushiswapRouter : uniswapRouter;

        IERC20(p.tokenA).forceApprove(address(buyRouter), amount);
        uint256[] memory amountsB = buyRouter.swapExactTokensForTokens(
            amount, 1, pathAB, address(this), deadline
        );
        uint256 tokenBReceived = amountsB[amountsB.length - 1];

        // --- Step 2: Swap tokenB -> tokenA on the "sell" router ---
        IERC20(p.tokenB).forceApprove(address(sellRouter), tokenBReceived);
        uint256[] memory amountsA = sellRouter.swapExactTokensForTokens(
            tokenBReceived, 1, pathBA, address(this), deadline
        );
        uint256 tokenAReturned = amountsA[amountsA.length - 1];

        // --- Step 3: Repay flash loan (amount + fee) ---
        uint256 repayment = amount + fee;
        IERC20(p.tokenA).forceApprove(lendingPool, repayment);

        int256 profit = int256(tokenAReturned) - int256(repayment);

        require(profit >= int256(p.minProfit), "Profit below minProfit");

        emit ArbitrageExecuted(p.tokenA, p.tokenB, amount, fee, profit);

        return CALLBACK_SUCCESS;
    }

    /**
     * @notice Preview the expected profit of an arbitrage op without executing it.
     * @param tokenA       Flash-borrowed token.
     * @param tokenB       Intermediate token.
     * @param flashAmount  Amount to borrow.
     * @param flashFee     Fee charged by the pool.
     * @param uniFirstBuy  Swap direction.
     * @return profit      Expected profit in tokenA (negative = loss).
     */
    function previewArbitrage(
        address tokenA,
        address tokenB,
        uint256 flashAmount,
        uint256 flashFee,
        bool uniFirstBuy
    ) external view returns (int256 profit) {
        address[] memory pathAB = new address[](2);
        pathAB[0] = tokenA; pathAB[1] = tokenB;

        address[] memory pathBA = new address[](2);
        pathBA[0] = tokenB; pathBA[1] = tokenA;

        IUniswapV2Router02 buyRouter  = uniFirstBuy ? uniswapRouter  : sushiswapRouter;
        IUniswapV2Router02 sellRouter = uniFirstBuy ? sushiswapRouter : uniswapRouter;

        uint256[] memory toBAmounts = buyRouter.getAmountsOut(flashAmount, pathAB);
        uint256 bReceived = toBAmounts[toBAmounts.length - 1];

        uint256[] memory toAAmounts = sellRouter.getAmountsOut(bReceived, pathBA);
        uint256 aReturned = toAAmounts[toAAmounts.length - 1];

        profit = int256(aReturned) - int256(flashAmount + flashFee);
    }

    /// @notice Withdraw any tokens held by this contract to the owner.
    function withdraw(address token) external onlyOwner {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) IERC20(token).safeTransfer(owner(), bal);
    }
}
