import { expect } from "chai";
import pkg from "hardhat";
const { ethers } = pkg;

describe("Protocol Security & Limits", function () {
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

  describe("Validation Checks", function () {
    it("Should fail on zero address inputs", async function () {
      await expect(
        lendingPool.connect(owner).addMarket(ethers.ZeroAddress, 0, 0, "X", "X")
      ).to.be.revertedWith("LendingPool: token is address(0)");
    });

    it("Should fail on invalid LTV/Bonus boundaries", async function () {
      await expect(
        lendingPool.addMarket(await usdc.getAddress(), WAD, WAD, "X", "X")
      ).to.be.revertedWith("LendingPool: LTV must be < 100%");
    });
  });

  describe("System Limits", function () {
    it("Should enforce MAX_MARKETS limit", async function () {
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      for (let i = 0; i < 25; i++) {
        const m = await MockERC20.deploy(`M${i}`, `M${i}`);
        await lendingPool.addMarket(await m.getAddress(), 0, ethers.parseUnits("1.05", 18), "L", "L");
      }
      const m26 = await MockERC20.deploy("M26", "M26");
      await expect(
        lendingPool.addMarket(await m26.getAddress(), 0, 0, "L", "L")
      ).to.be.revertedWith("LendingPool: maximum markets reached");
    });
  });

  describe("Math Precision", function () {
    it("Should handle rounding correctly in yield updates", async function () {
      const MockAggregator = await ethers.getContractFactory("MockAggregator");
      const usdcAgg = await MockAggregator.deploy(1_0000_0000n);
      await oracle.setPriceFeed(await usdc.getAddress(), await usdcAgg.getAddress());

      await lendingPool.addMarket(await usdc.getAddress(), ethers.parseUnits("0.8", 18), ethers.parseUnits("1.05", 18), "L", "L");
      
      const dep = ethers.parseUnits("1000", 18);
      await usdc.mint(owner.address, dep);
      await usdc.approve(await lendingPool.getAddress(), dep);
      await lendingPool.deposit(await usdc.getAddress(), dep);
      await lendingPool.borrow(await usdc.getAddress(), ethers.parseUnits("100", 18));

      await pkg.network.provider.send("evm_increaseTime", [60]); // 1 minute
      await pkg.network.provider.send("evm_mine");

      const before = await lendingPool.markets(await usdc.getAddress());
      await lendingPool.updateState(await usdc.getAddress());
      const after = await lendingPool.markets(await usdc.getAddress());

      expect(after.totalBorrows).to.be.gte(before.totalBorrows);
    });
  });
});
