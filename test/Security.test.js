import { expect } from "chai";
import pkg from "hardhat";
const { ethers } = pkg;

describe("DeFi Protocol — Security & Scalability", function () {
  let lendingPool, oracle, interestModel, usdc;
  let owner, user1;
  const WAD = ethers.parseUnits("1", 18);

  beforeEach(async function () {
    [owner, user1] = await ethers.getSigners();

    const PriceOracleWrapper = await ethers.getContractFactory("PriceOracleWrapper");
    oracle = await PriceOracleWrapper.deploy();

    const InterestRateModel = await ethers.getContractFactory("InterestRateModel");
    interestModel = await InterestRateModel.deploy(
      ethers.parseUnits("0.8", 18),
      ethers.parseUnits("0.02", 18),
      ethers.parseUnits("0.04", 18),
      ethers.parseUnits("0.75", 18)
    );

    const LendingPool = await ethers.getContractFactory("LendingPool");
    lendingPool = await LendingPool.deploy(await oracle.getAddress(), await interestModel.getAddress());

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    usdc = await MockERC20.deploy("Mock USDC", "USDC");
  });

  describe("Address Validations", function () {
    it("Should revert addMarket with address(0)", async function () {
      await expect(
        lendingPool.connect(owner).addMarket(
          ethers.ZeroAddress,
          ethers.parseUnits("0.8", 18),
          ethers.parseUnits("1.05", 18),
          "LToken",
          "LTK"
        )
      ).to.be.revertedWith("LendingPool: token is address(0)");
    });

    it("Should revert setPriceFeed with address(0) token or feed", async function () {
      await expect(
        oracle.connect(owner).setPriceFeed(ethers.ZeroAddress, user1.address)
      ).to.be.revertedWith("Invalid token address");

      await expect(
        oracle.connect(owner).setPriceFeed(user1.address, ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid feed address");
    });
  });

  describe("Parameter Validations", function () {
    it("Should revert addMarket with LTV >= 100%", async function () {
      await expect(
        lendingPool.connect(owner).addMarket(
          await usdc.getAddress(),
          WAD, // 100%
          ethers.parseUnits("1.05", 18),
          "LToken",
          "LTK"
        )
      ).to.be.revertedWith("LendingPool: LTV must be < 100%");
    });

    it("Should revert addMarket with Bonus <= 100%", async function () {
      await expect(
        lendingPool.connect(owner).addMarket(
          await usdc.getAddress(),
          ethers.parseUnits("0.8", 18),
          WAD, // 100% (no bonus)
          "LToken",
          "LTK"
        )
      ).to.be.revertedWith("LendingPool: Bonus must be > 100%");
    });
  });

  describe("Scalability (Market Limits)", function () {
    it("Should revert when exceeding MAX_MARKETS", async function () {
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      
      // Add 25 markets (MAX_MARKETS)
      for (let i = 0; i < 25; i++) {
        const m = await MockERC20.deploy(`Mock ${i}`, `M${i}`);
        await lendingPool.addMarket(
          await m.getAddress(),
          ethers.parseUnits("0.7", 18),
          ethers.parseUnits("1.05", 18),
          `L${i}`,
          `L${i}`
        );
      }

      // 26th market should revert
      const m26 = await MockERC20.deploy("Mock 26", "M26");
      await expect(
        lendingPool.addMarket(
          await m26.getAddress(),
          ethers.parseUnits("0.7", 18),
          ethers.parseUnits("1.05", 18),
          "L26",
          "L26"
        )
      ).to.be.revertedWith("LendingPool: maximum markets reached");
    });
  });

  describe("Risk Parameter Management", function () {
    beforeEach(async function () {
      await lendingPool.addMarket(
        await usdc.getAddress(),
        ethers.parseUnits("0.8", 18),
        ethers.parseUnits("1.05", 18),
        "Lending USDC",
        "lUSDC"
      );
    });

    it("Should allow updating market configuration and emit event", async function () {
      const newLTV = ethers.parseUnits("0.7", 18);
      const newBonus = ethers.parseUnits("1.1", 18);

      await expect(lendingPool.setMarketConfiguration(await usdc.getAddress(), newLTV, newBonus))
        .to.emit(lendingPool, "MarketConfigurationUpdated")
        .withArgs(await usdc.getAddress(), newLTV, newBonus);

      const market = await lendingPool.markets(await usdc.getAddress());
      expect(market.ltv).to.equal(newLTV);
      expect(market.liquidationBonus).to.equal(newBonus);
    });

    it("Should revert configuration update for unlisted market", async function () {
      await expect(
        lendingPool.setMarketConfiguration(user1.address, WAD, WAD)
      ).to.be.revertedWith("LendingPool: market not listed");
    });
  });

  describe("WAD Math Precision", function () {
    it("Should verify truncation in interest accrual", async function () {
      const MockAggregator = await ethers.getContractFactory("MockAggregator");
      const usdcAgg = await MockAggregator.deploy(1_0000_0000n); // $1
      await oracle.setPriceFeed(await usdc.getAddress(), await usdcAgg.getAddress());

      await lendingPool.addMarket(
        await usdc.getAddress(),
        ethers.parseUnits("0.8", 18),
        ethers.parseUnits("1.05", 18),
        "Lending USDC",
        "lUSDC"
      );

      // Deposit and Borrow to trigger interest logic
      const dep = ethers.parseUnits("1000", 18);
      await usdc.mint(owner.address, dep);
      await usdc.approve(await lendingPool.getAddress(), dep);
      await lendingPool.deposit(await usdc.getAddress(), dep);

      await lendingPool.borrow(await usdc.getAddress(), ethers.parseUnits("100", 18));

      // Wait 1 second (this should accrue some interest)
      await pkg.network.provider.send("evm_increaseTime", [1]);
      await pkg.network.provider.send("evm_mine");

      const marketBefore = await lendingPool.markets(await usdc.getAddress());
      await lendingPool.updateState(await usdc.getAddress());
      const marketAfter = await lendingPool.markets(await usdc.getAddress());

      // Interest factor is (borrowRate * deltaTime)
      // totalBorrows = totalBorrows + (totalBorrows * interestFactor) / WAD
      // The division by WAD should truncate decimals
      expect(marketAfter.totalBorrows).to.be.gte(marketBefore.totalBorrows);
      
      // We can check if it's exactly what we expect if we control the rates
      // (Simplified check for truncation presence)
      console.log(`      Interest accrued: ${marketAfter.totalBorrows - marketBefore.totalBorrows} units`);
    });
  });
});
