// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MockAggregator
 * @dev Simulates a Chainlink AggregatorV3Interface for local testing.
 *      Exposes `setLatestAnswer()` to manipulate the price, and
 *      `setUpdatedAt()` to test staleness checks.
 */
contract MockAggregator {
    uint8 public decimals = 8;
    int256 public latestAnswer;
    uint256 public mockUpdatedAt;

    constructor(int256 _initialAnswer) {
        latestAnswer = _initialAnswer;
        mockUpdatedAt = block.timestamp;
    }

    /// @notice Set a new price (does NOT update `updatedAt` automatically).
    function setLatestAnswer(int256 _answer) external {
        latestAnswer = _answer;
        mockUpdatedAt = block.timestamp;
    }

    /// @notice Manually override `updatedAt` to test staleness checks.
    function setUpdatedAt(uint256 _updatedAt) external {
        mockUpdatedAt = _updatedAt;
    }

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        return (0, latestAnswer, block.timestamp, mockUpdatedAt, 0);
    }
}
