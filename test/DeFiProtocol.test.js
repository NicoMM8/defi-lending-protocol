import { expect } from "chai";
import pkg from "hardhat";
const { ethers } = pkg;

describe("DeFi Lending Protocol", function () {
  const WAD = ethers.parseUnits("1", 18);
  let owner, user1, user2, liquidator;
  let usdc, weth;
  let usdcAggregator, wethAggregator;
  let oracle, interestModel, lendingPool, arbitrageBot;
  let lUSDC, lWETH;

  beforeEach(async function () {
    [owner, user1, user2, liquidator] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    usdc = await MockERC20.deploy("Mock USDC", "USDC");
    weth = await MockERC20.deploy("Mock WETH", "WETH");

    const MockAggregator = await ethers.getContractFactory("MockAggregator");
    usdcAggregator = await MockAggregator.deploy(1_0000_0000n);      // $1
    wethAggregator = await MockAggregator.deploy(3000_0000_0000n);    // $3000

    const PriceOracleWrapper = await ethers.getContractFactory("PriceOracleWrapper");
    oracle = await PriceOracleWrapper.deploy();
    await oracle.setPriceFeed(await usdc.getAddress(), await usdcAggregator.getAddress());
    await oracle.setPriceFeed(await weth.getAddress(), await wethAggregator.getAddress());

    const InterestRateModel = await ethers.getContractFactory("InterestRateModel");
    interestModel = await InterestRateModel.deploy(
      ethers.parseUnits("0.8", 18),
      ethers.parseUnits("0.02", 18),
      ethers.parseUnits("0.04", 18),
      ethers.parseUnits("0.75", 18)
    );

    const LendingPool = await ethers.getContractFactory("LendingPool");
    lendingPool = await LendingPool.deploy(
      await oracle.getAddress(),
      await interestModel.getAddress()
    );

    const ArbitrageBot = await ethers.getContractFactory("ArbitrageBot");
    arbitrageBot = await ArbitrageBot.deploy(await lendingPool.getAddress());

    await lendingPool.addMarket(
      await usdc.getAddress(),
      ethers.parseUnits("0.8", 18),
      ethers.parseUnits("1.05", 18),
      "Lending USDC",
      "lUSDC"
    );
    await lendingPool.addMarket(
      await weth.getAddress(),
      ethers.parseUnits("0.75", 18),
      ethers.parseUnits("1.08", 18),
      "Lending WETH",
      "lWETH"
    );

    const LToken = await ethers.getContractFactory("LToken");
    lUSDC = LToken.attach(await lendingPool.getLToken(await usdc.getAddress()));
    lWETH = LToken.attach(await lendingPool.getLToken(await weth.getAddress()));

    await usdc.mint(owner.address, ethers.parseUnits("1000000", 18));
    await usdc.mint(user1.address, ethers.parseUnits("50000", 18));
    await weth.mint(user2.address, ethers.parseUnits("100", 18));
    await usdc.mint(liquidator.address, ethers.parseUnits("500000", 18));
  });

  describe("Core Functions", function () {
    it("Should list markets correctly and deploy LTokens", async function () {
      const lTokenAddr = await lendingPool.getLToken(await usdc.getAddress());
      expect(lTokenAddr).to.not.equal(ethers.ZeroAddress);
    });

    it("Should revert when adding a duplicate market", async function () {
      await expect(
        lendingPool.addMarket(await usdc.getAddress(), WAD, WAD, "X", "X")
      ).to.be.revertedWith("LendingPool: market already exists");
    });

    it("Oracle should return correct prices", async function () {
      expect(await oracle.getTokenPrice(await usdc.getAddress())).to.equal(ethers.parseUnits("1", 18));
      expect(await oracle.getTokenPrice(await weth.getAddress())).to.equal(ethers.parseUnits("3000", 18));
    });
  });

  describe("Safety Features", function () {
    it("Owner can pause and unpause", async function () {
      await lendingPool.pause();
      expect(await lendingPool.paused()).to.be.true;

      const amount = ethers.parseUnits("1000", 18);
      await usdc.connect(user1).approve(await lendingPool.getAddress(), amount);
      await expect(
        lendingPool.connect(user1).deposit(await usdc.getAddress(), amount)
      ).to.be.revertedWithCustomError(lendingPool, "EnforcedPause");

      await lendingPool.unpause();
      await expect(lendingPool.connect(user1).deposit(await usdc.getAddress(), amount)).to.not.be.reverted;
    });

    it("Should revert on stale price data", async function () {
      const staleTime = (await ethers.provider.getBlock("latest")).timestamp - 7200;
      await usdcAggregator.setUpdatedAt(staleTime);
      await expect(oracle.getTokenPrice(await usdc.getAddress()))
        .to.be.revertedWith("Stale price data");
    });
  });

  describe("Market Operations", function () {
    it("Should mint LTokens on deposit", async function () {
      const amount = ethers.parseUnits("5000", 18);
      await usdc.connect(user1).approve(await lendingPool.getAddress(), amount);
      await lendingPool.connect(user1).deposit(await usdc.getAddress(), amount);
      const lTokenBal = await lUSDC.balanceOf(user1.address);
      expect(lTokenBal).to.equal(amount);
    });

    it("Exchange rate should grow over time", async function () {
      const liq = ethers.parseUnits("100000", 18);
      await usdc.connect(owner).approve(await lendingPool.getAddress(), liq);
      await lendingPool.connect(owner).deposit(await usdc.getAddress(), liq);

      const col = ethers.parseUnits("10", 18);
      await weth.connect(user2).approve(await lendingPool.getAddress(), col);
      await lendingPool.connect(user2).deposit(await weth.getAddress(), col);
      await lendingPool.connect(user2).borrow(await usdc.getAddress(), ethers.parseUnits("10000", 18));

      const rateBefore = await lendingPool.exchangeRate(await usdc.getAddress());
      await ethers.provider.send("evm_increaseTime", [365 * 24 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);
      await lendingPool.updateState(await usdc.getAddress());

      const rateAfter = await lendingPool.exchangeRate(await usdc.getAddress());
      expect(rateAfter).to.be.gt(rateBefore);
    });
  });

  describe("Borrow & Repay", function () {
    beforeEach(async function () {
      const liq = ethers.parseUnits("100000", 18);
      await usdc.connect(owner).approve(await lendingPool.getAddress(), liq);
      await lendingPool.connect(owner).deposit(await usdc.getAddress(), liq);

      const col = ethers.parseUnits("10", 18);
      await weth.connect(user2).approve(await lendingPool.getAddress(), col);
      await lendingPool.connect(user2).deposit(await weth.getAddress(), col);
    });

    it("Should allow borrowing within limits", async function () {
      await expect(lendingPool.connect(user2).borrow(await usdc.getAddress(), ethers.parseUnits("20000", 18)))
        .to.emit(lendingPool, "Borrow");
    });

    it("Should allow full repayment", async function () {
      await lendingPool.connect(user2).borrow(await usdc.getAddress(), ethers.parseUnits("10000", 18));
      await usdc.mint(user2.address, ethers.parseUnits("1000", 18));
      await usdc.connect(user2).approve(await lendingPool.getAddress(), ethers.parseUnits("11000", 18));
      await lendingPool.connect(user2).repay(await usdc.getAddress(), ethers.parseUnits("11000", 18));
      expect(await lendingPool.accountBorrowsPrincipal(user2.address, await usdc.getAddress())).to.equal(0n);
    });
  });

  describe("Liquidations", function () {
    it("Should liquidate unhealthy positions", async function () {
      const liq = ethers.parseUnits("200000", 18);
      await usdc.connect(owner).approve(await lendingPool.getAddress(), liq);
      await lendingPool.connect(owner).deposit(await usdc.getAddress(), liq);

      const col = ethers.parseUnits("10", 18);
      await weth.connect(user2).approve(await lendingPool.getAddress(), col);
      await lendingPool.connect(user2).deposit(await weth.getAddress(), col);
      await lendingPool.connect(user2).borrow(await usdc.getAddress(), ethers.parseUnits("15000", 18));

      await wethAggregator.setLatestAnswer(1800_0000_0000n); // Price drops

      await usdc.connect(liquidator).approve(await lendingPool.getAddress(), ethers.parseUnits("50000", 18));
      await expect(
        lendingPool.connect(liquidator).liquidate(user2.address, await weth.getAddress(), await usdc.getAddress())
      ).to.emit(lendingPool, "Liquidate");
    });
  });

  describe("Flash Loans", function () {
    it("Should execute a flash loan", async function () {
      const flashAmt = ethers.parseUnits("10000", 18);
      const liq = ethers.parseUnits("100000", 18);
      await usdc.connect(owner).approve(await lendingPool.getAddress(), liq);
      await lendingPool.connect(owner).deposit(await usdc.getAddress(), liq);

      const fee = await lendingPool.flashFee(await usdc.getAddress(), flashAmt);
      await usdc.connect(owner).approve(await arbitrageBot.getAddress(), fee + ethers.parseUnits("10", 18));
      await expect(arbitrageBot.connect(owner).executeArbitrage(await usdc.getAddress(), flashAmt, 0))
        .to.emit(lendingPool, "FlashLoanExecuted");
    });
  });
});
