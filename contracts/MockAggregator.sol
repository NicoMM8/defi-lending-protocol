// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockAggregator {
    uint8 public decimals = 8;
    int256 public latestAnswer;

    constructor(int256 _initialAnswer) {
        latestAnswer = _initialAnswer;
    }

    function setLatestAnswer(int256 _answer) external {
        latestAnswer = _answer;
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
        return (0, latestAnswer, block.timestamp, block.timestamp, 0);
    }
}
