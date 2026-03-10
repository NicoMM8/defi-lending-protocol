// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title InterestRateModel
 * @author DeFi Lending Protocol
 * @notice Implements a kinked (two-slope) interest rate model inspired by Aave/Compound.
 * @dev All rates are annualised in WAD (1e18 = 100%). A per-second rate is derived
 *      by dividing by `SECONDS_PER_YEAR`.
 *
 * Rate curve:
 *   if U ≤ U_optimal:
 *       R = baseRate + (U / U_optimal) × slope1
 *   else:
 *       R = baseRate + slope1 + ((U − U_optimal) / (1 − U_optimal)) × slope2
 */
contract InterestRateModel {
    uint256 public constant WAD = 1e18;
    uint256 public constant SECONDS_PER_YEAR = 31_536_000;

    /// @notice Optimal utilization rate in WAD (e.g. 0.8e18 = 80%).
    uint256 public immutable OPTIMAL_UTILIZATION;

    /// @notice Base borrow rate in WAD (e.g. 0.02e18 = 2%).
    uint256 public immutable BASE_RATE;

    /// @notice Slope below the kink in WAD (e.g. 0.04e18 = 4%).
    uint256 public immutable SLOPE_1;

    /// @notice Slope above the kink in WAD (e.g. 0.75e18 = 75%).
    uint256 public immutable SLOPE_2;

    /**
     * @notice Deploy the interest rate model with the given parameters.
     * @param optimalUtilization Optimal utilization rate in WAD.
     * @param baseRate           Base annualised borrow rate in WAD.
     * @param slope1             Rate slope below the kink in WAD.
     * @param slope2             Rate slope above the kink in WAD.
     */
    constructor(
        uint256 optimalUtilization,
        uint256 baseRate,
        uint256 slope1,
        uint256 slope2
    ) {
        OPTIMAL_UTILIZATION = optimalUtilization;
        BASE_RATE = baseRate;
        SLOPE_1 = slope1;
        SLOPE_2 = slope2;
    }

    /**
     * @notice Calculate the utilization rate: U = totalBorrows / (totalLiquidity + totalBorrows).
     * @param totalLiquidity Available (un-borrowed) liquidity.
     * @param totalBorrows   Outstanding borrows.
     * @return U Utilization rate in WAD.
     */
    function utilizationRate(uint256 totalLiquidity, uint256 totalBorrows) public pure returns (uint256) {
        if (totalBorrows == 0) return 0;
        return (totalBorrows * WAD) / (totalLiquidity + totalBorrows);
    }

    /**
     * @notice Calculate the annualised borrow rate.
     * @param totalLiquidity Available liquidity.
     * @param totalBorrows   Outstanding borrows.
     * @return Annualised borrow rate in WAD.
     */
    function getBorrowRate(uint256 totalLiquidity, uint256 totalBorrows) public view returns (uint256) {
        uint256 u = utilizationRate(totalLiquidity, totalBorrows);

        if (u <= OPTIMAL_UTILIZATION) {
            uint256 rate1 = (u * SLOPE_1) / OPTIMAL_UTILIZATION;
            return BASE_RATE + rate1;
        } else {
            uint256 excessUtilization = u - OPTIMAL_UTILIZATION;
            uint256 remainingUtilization = WAD - OPTIMAL_UTILIZATION;
            uint256 rate2 = (excessUtilization * SLOPE_2) / remainingUtilization;
            return BASE_RATE + SLOPE_1 + rate2;
        }
    }

    /**
     * @notice Calculate the per-second borrow rate.
     * @param totalLiquidity Available liquidity.
     * @param totalBorrows   Outstanding borrows.
     * @return Per-second borrow rate in WAD.
     */
    function getBorrowRatePerSecond(uint256 totalLiquidity, uint256 totalBorrows) external view returns (uint256) {
        return getBorrowRate(totalLiquidity, totalBorrows) / SECONDS_PER_YEAR;
    }
}
