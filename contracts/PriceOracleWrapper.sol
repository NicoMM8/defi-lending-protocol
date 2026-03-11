// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

/**
 * @title PriceOracleWrapper
 * @dev Wrapper over Chainlink AggregatorV3Interface. Normalizes all prices
 *      to 18-decimal (WAD) precision.
 */
contract PriceOracleWrapper {
    mapping(address => address) public priceFeeds;
    address public owner;

    event PriceFeedAdded(address indexed token, address indexed feed);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function setPriceFeed(address token, address feed) external onlyOwner {
        require(feed != address(0), "Invalid feed address");
        priceFeeds[token] = feed;
        emit PriceFeedAdded(token, feed);
    }

    function getTokenPrice(address token) external view returns (uint256) {
        address feedAddress = priceFeeds[token];
        require(feedAddress != address(0), "No price feed found");

        AggregatorV3Interface priceFeed = AggregatorV3Interface(feedAddress);
        (
            ,
            int256 price,
            ,
            ,

        ) = priceFeed.latestRoundData();

        require(price > 0, "Invalid price from oracle");
        uint8 decimals = priceFeed.decimals();

        if (decimals < 18) {
            return uint256(price) * (10 ** (18 - decimals));
        } else if (decimals > 18) {
            return uint256(price) / (10 ** (decimals - 18));
        }

        return uint256(price);
    }
}
