// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

/**
 * @title PriceOracleWrapper
 * @author DeFi Lending Protocol
 * @notice Secure wrapper over Chainlink Price Feeds with staleness protection.
 * @dev Normalises all prices to 18-decimal (WAD) precision.
 */
contract PriceOracleWrapper is Ownable {
    /// @notice Maximum acceptable age for a price data point (seconds).
    uint256 public maxStaleness = 3600; // 1 hour default

    /// @notice Token address → Chainlink Aggregator address.
    mapping(address => address) public priceFeeds;

    event PriceFeedSet(address indexed token, address indexed feed);
    event MaxStalenessUpdated(uint256 oldValue, uint256 newValue);

    constructor() Ownable(msg.sender) {}

    /**
     * @notice Register or update the Chainlink price feed for a token.
     * @param token Address of the ERC-20 token.
     * @param feed  Address of the Chainlink AggregatorV3 (e.g. TOKEN/USD).
     */
    function setPriceFeed(address token, address feed) external onlyOwner {
        require(feed != address(0), "Invalid feed address");
        priceFeeds[token] = feed;
        emit PriceFeedSet(token, feed);
    }

    /**
     * @notice Update the staleness threshold.
     * @param _maxStaleness New maximum staleness in seconds.
     */
    function setMaxStaleness(uint256 _maxStaleness) external onlyOwner {
        require(_maxStaleness > 0, "Staleness must be > 0");
        emit MaxStalenessUpdated(maxStaleness, _maxStaleness);
        maxStaleness = _maxStaleness;
    }

    /**
     * @notice Get the latest price of a token scaled to 18 decimals (WAD).
     * @param token Address of the ERC-20 token.
     * @return price Price of the token in WAD (1e18 = $1).
     */
    function getTokenPrice(address token) external view returns (uint256 price) {
        address feedAddress = priceFeeds[token];
        require(feedAddress != address(0), "No price feed found");

        AggregatorV3Interface priceFeed = AggregatorV3Interface(feedAddress);
        (
            ,
            int256 answer,
            ,
            uint256 updatedAt,

        ) = priceFeed.latestRoundData();

        require(answer > 0, "Invalid price from oracle");
        require(block.timestamp - updatedAt <= maxStaleness, "Stale price data");

        uint8 decimals = priceFeed.decimals();

        // Scale to 18 decimals (WAD)
        if (decimals < 18) {
            return uint256(answer) * (10 ** (18 - decimals));
        } else if (decimals > 18) {
            return uint256(answer) / (10 ** (decimals - 18));
        }

        return uint256(answer);
    }
}
