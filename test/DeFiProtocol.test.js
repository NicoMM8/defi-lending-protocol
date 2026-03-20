import { expect } from "chai";
import pkg from "hardhat";
const { ethers } = pkg;

describe("DeFi Lending Protocol", function () {
  const WAD = ethers.parseUnits("1", 18);
  let owner, user1, user2, liquidator;
  let usdc, weth;
  let usdcAggregator, wethAggregator;
  let oracle, interestModel, lendingPool, arbitrageBot;
  let lUSDC, lWETH; // LToken contract instances

  beforeEach(async function () {
    [owner, user1, user2, liquidator] = await ethers.getSigners();

    // ── Mock Tokens ──
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    usdc = await MockERC20.deploy("Mock USDC", "USDC");
    weth = await MockERC20.deploy("Mock WETH", "WETH");

    // ── Mock Aggregators ──
    const MockAggregator = await ethers.getContractFactory("MockAggregator");
    usdcAggregator = await MockAggregator.deploy(1_0000_0000n);      // $1
    wethAggregator = await MockAggregator.deploy(3000_0000_0000n);    // $3000

    // ── Oracle ──
    const PriceOracleWrapper = await ethers.getContractFactory("PriceOracleWrapper");
    oracle = await PriceOracleWrapper.deploy();
    await oracle.setPriceFeed(await usdc.getAddress(), await usdcAggregator.getAddress());
    await oracle.setPriceFeed(await weth.getAddress(), await wethAggregator.getAddress());

    // ── InterestRateModel (Optimal 80%, Base 2%, S1 4%, S2 75%) ──
    const InterestRateModel = await ethers.getContractFactory("InterestRateModel");
    interestModel = await InterestRateModel.deploy(
      ethers.parseUnits("0.8", 18),
      ethers.parseUnits("0.02", 18),
      ethers.parseUnits("0.04", 18),
      ethers.parseUnits("0.75", 18)
    );

    // ── LendingPool ──
    const LendingPool = await ethers.getContractFactory("LendingPool");
    lendingPool = await LendingPool.deploy(
      await oracle.getAddress(),
      await interestModel.getAddress()
    );

    // ── ArbitrageBot ──
    const ArbitrageBot = await ethers.getContractFactory("ArbitrageBot");
    arbitrageBot = await ArbitrageBot.deploy(await lendingPool.getAddress());

    // ── Add Markets (now requires lTokenName + lTokenSymbol) ──
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

    // ── Resolve LToken addresses ──
    const LToken = await ethers.getContractFactory("LToken");
    lUSDC = LToken.attach(await lendingPool.getLToken(await usdc.getAddress()));
    lWETH = LToken.attach(await lendingPool.getLToken(await weth.getAddress()));

    // ── Mint tokens ──
    await usdc.mint(owner.address, ethers.parseUnits("1000000", 18));
    await usdc.mint(user1.address, ethers.parseUnits("50000", 18));
    await weth.mint(user2.address, ethers.parseUnits("100", 18));
    await usdc.mint(liquidator.address, ethers.parseUnits("500000", 18));
  });

  // --- 1. SETUP & ACCESS CONTROL ---
  describe("Setup & Access Control", function () {
    it("Should list markets correctly and deploy LTokens", async function () {
      const lTokenAddr = await lendingPool.getLToken(await usdc.getAddress());
      expect(lTokenAddr).to.not.equal(ethers.ZeroAddress);
      const usdcMarket = await lendingPool.markets(await usdc.getAddress());
      expect(usdcMarket[0]).to.be.true; // isListed
    });

    it("Should revert when adding a duplicate market", async function () {
      await expect(
        lendingPool.addMarket(await usdc.getAddress(), WAD, WAD, "X", "X")
      ).to.be.revertedWith("LendingPool: market already exists");
    });

    it("Oracle should return correct WAD-scaled prices", async function () {
      expect(await oracle.getTokenPrice(await usdc.getAddress())).to.equal(ethers.parseUnits("1", 18));
      expect(await oracle.getTokenPrice(await weth.getAddress())).to.equal(ethers.parseUnits("3000", 18));
    });

    it("Only owner can add markets", async function () {
      const fakeToken = await (await ethers.getContractFactory("MockERC20")).deploy("F", "F");
      await expect(
        lendingPool.connect(user1).addMarket(await fakeToken.getAddress(), WAD, WAD, "F", "F")
      ).to.be.revertedWithCustomError(lendingPool, "OwnableUnauthorizedAccount");
    });

    it("Only owner can set price feeds", async function () {
      await expect(
        oracle.connect(user1).setPriceFeed(await usdc.getAddress(), await usdcAggregator.getAddress())
      ).to.be.revertedWithCustomError(oracle, "OwnableUnauthorizedAccount");
    });
  });

  // --- 2. PAUSABLE ---
  describe("Pausable", function () {
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

    it("Non-owner cannot pause", async function () {
      await expect(lendingPool.connect(user1).pause())
        .to.be.revertedWithCustomError(lendingPool, "OwnableUnauthorizedAccount");
    });
  });

  // --- 3. ORACLE STALENESS ---
  describe("Oracle Staleness", function () {
    it("Should revert on stale price data", async function () {
      const staleTime = (await ethers.provider.getBlock("latest")).timestamp - 7200;
      await usdcAggregator.setUpdatedAt(staleTime);
      await expect(oracle.getTokenPrice(await usdc.getAddress()))
        .to.be.revertedWith("Stale price data");
    });

    it("Owner can adjust max staleness", async function () {
      await oracle.setMaxStaleness(86400);
      expect(await oracle.maxStaleness()).to.equal(86400);
    });
  });

  // --- 4. DEPOSITS & LTOKENS ---
  describe("Deposits & LTokens", function () {
    it("Should mint LTokens 1:1 on first deposit (exchangeRate = 1.0)", async function () {
      const amount = ethers.parseUnits("5000", 18);
      await usdc.connect(user1).approve(await lendingPool.getAddress(), amount);

      const rate = await lendingPool.exchangeRate(await usdc.getAddress());
      expect(rate).to.equal(WAD); // 1:1

      await expect(lendingPool.connect(user1).deposit(await usdc.getAddress(), amount))
        .to.emit(lendingPool, "Deposit");

      const lTokenBal = await lUSDC.balanceOf(user1.address);
      expect(lTokenBal).to.equal(amount); // 1:1 mint
    });

    it("LToken name and symbol should be set correctly", async function () {
      expect(await lUSDC.name()).to.equal("Lending USDC");
      expect(await lUSDC.symbol()).to.equal("lUSDC");
      expect(await lWETH.name()).to.equal("Lending WETH");
    });

    it("Should revert deposit on unlisted market", async function () {
      const fakeToken = await (await ethers.getContractFactory("MockERC20")).deploy("F", "F");
      await fakeToken.mint(user1.address, ethers.parseUnits("100", 18));
      await fakeToken.connect(user1).approve(await lendingPool.getAddress(), ethers.parseUnits("100", 18));
      await expect(
        lendingPool.connect(user1).deposit(await fakeToken.getAddress(), ethers.parseUnits("100", 18))
      ).to.be.revertedWith("Market not supported");
    });

    it("Exchange rate should grow after interest accrual", async function () {
      // Seed pool and borrow to generate interest
      const liq = ethers.parseUnits("100000", 18);
      await usdc.connect(owner).approve(await lendingPool.getAddress(), liq);
      await lendingPool.connect(owner).deposit(await usdc.getAddress(), liq);

      const col = ethers.parseUnits("10", 18);
      await weth.connect(user2).approve(await lendingPool.getAddress(), col);
      await lendingPool.connect(user2).deposit(await weth.getAddress(), col);
      await lendingPool.connect(user2).borrow(await usdc.getAddress(), ethers.parseUnits("10000", 18));

      const rateBefore = await lendingPool.exchangeRate(await usdc.getAddress());

      // Fast-forward 1 year
      await ethers.provider.send("evm_increaseTime", [365 * 24 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);
      await lendingPool.updateState(await usdc.getAddress());

      const rateAfter = await lendingPool.exchangeRate(await usdc.getAddress());
      expect(rateAfter).to.be.gt(rateBefore);
      console.log(`    Exchange rate: ${ethers.formatUnits(rateBefore, 18)} → ${ethers.formatUnits(rateAfter, 18)}`);
    });

    it("getUnderlyingBalance should reflect accrued yield", async function () {
      const liq = ethers.parseUnits("100000", 18);
      await usdc.connect(owner).approve(await lendingPool.getAddress(), liq);
      await lendingPool.connect(owner).deposit(await usdc.getAddress(), liq);

      const col = ethers.parseUnits("10", 18);
      await weth.connect(user2).approve(await lendingPool.getAddress(), col);
      await lendingPool.connect(user2).deposit(await weth.getAddress(), col);
      await lendingPool.connect(user2).borrow(await usdc.getAddress(), ethers.parseUnits("15000", 18));

      await ethers.provider.send("evm_increaseTime", [365 * 24 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);
      await lendingPool.updateState(await usdc.getAddress());

      const underlying = await lendingPool.getUnderlyingBalance(owner.address, await usdc.getAddress());
      expect(underlying).to.be.gt(liq); // depositor earned yield
      console.log(`    Deposited 100k USDC, now worth: ${ethers.formatUnits(underlying, 18)} USDC`);
    });
  });

  // --- 5. BORROW ---
  describe("Borrow", function () {
    beforeEach(async function () {
      const liq = ethers.parseUnits("100000", 18);
      await usdc.connect(owner).approve(await lendingPool.getAddress(), liq);
      await lendingPool.connect(owner).deposit(await usdc.getAddress(), liq);

      const col = ethers.parseUnits("10", 18);
      await weth.connect(user2).approve(await lendingPool.getAddress(), col);
      await lendingPool.connect(user2).deposit(await weth.getAddress(), col);
    });

    it("Should allow borrowing within health factor", async function () {
      await expect(lendingPool.connect(user2).borrow(await usdc.getAddress(), ethers.parseUnits("20000", 18)))
        .to.emit(lendingPool, "Borrow");
    });

    it("Should revert when exceeding health factor", async function () {
      await expect(
        lendingPool.connect(user2).borrow(await usdc.getAddress(), ethers.parseUnits("25000", 18))
      ).to.be.revertedWith("HF < 1.0: action not allowed");
    });

    it("Should revert when liquidity insufficient", async function () {
      await expect(
        lendingPool.connect(user2).borrow(await usdc.getAddress(), ethers.parseUnits("200000", 18))
      ).to.be.revertedWith("LendingPool: insufficient liquidity");
    });
  });

  // --- 6. REPAY ---
  describe("Repay", function () {
    beforeEach(async function () {
      const liq = ethers.parseUnits("100000", 18);
      await usdc.connect(owner).approve(await lendingPool.getAddress(), liq);
      await lendingPool.connect(owner).deposit(await usdc.getAddress(), liq);

      const col = ethers.parseUnits("10", 18);
      await weth.connect(user2).approve(await lendingPool.getAddress(), col);
      await lendingPool.connect(user2).deposit(await weth.getAddress(), col);
      await lendingPool.connect(user2).borrow(await usdc.getAddress(), ethers.parseUnits("10000", 18));
    });

    it("Should allow full repayment", async function () {
      await usdc.mint(user2.address, ethers.parseUnits("1000", 18));
      await usdc.connect(user2).approve(await lendingPool.getAddress(), ethers.parseUnits("11000", 18));
      await expect(lendingPool.connect(user2).repay(await usdc.getAddress(), ethers.parseUnits("11000", 18)))
        .to.emit(lendingPool, "Repay");
      expect(await lendingPool.accountBorrowsPrincipal(user2.address, await usdc.getAddress())).to.equal(0n);
    });

    it("Should cap overpayment to outstanding debt", async function () {
      await usdc.mint(user2.address, ethers.parseUnits("40000", 18));
      const balBefore = await usdc.balanceOf(user2.address);
      await usdc.connect(user2).approve(await lendingPool.getAddress(), ethers.parseUnits("50000", 18));
      await lendingPool.connect(user2).repay(await usdc.getAddress(), ethers.parseUnits("50000", 18));
      const balAfter = await usdc.balanceOf(user2.address);
      expect(balBefore - balAfter).to.be.lte(ethers.parseUnits("10001", 18));
    });
  });

  // --- 7. WITHDRAW ---
  describe("Withdraw", function () {
    beforeEach(async function () {
      const liq = ethers.parseUnits("100000", 18);
      await usdc.connect(owner).approve(await lendingPool.getAddress(), liq);
      await lendingPool.connect(owner).deposit(await usdc.getAddress(), liq);

      const col = ethers.parseUnits("10", 18);
      await weth.connect(user2).approve(await lendingPool.getAddress(), col);
      await lendingPool.connect(user2).deposit(await weth.getAddress(), col);
    });

    it("Should burn LTokens on withdrawal and return underlying", async function () {
      const lTokenBefore = await lWETH.balanceOf(user2.address);
      const wethBefore = await weth.balanceOf(user2.address);

      await lendingPool.connect(user2).withdraw(await weth.getAddress(), ethers.parseUnits("5", 18));

      const lTokenAfter = await lWETH.balanceOf(user2.address);
      const wethAfter = await weth.balanceOf(user2.address);

      expect(lTokenAfter).to.be.lt(lTokenBefore);
      expect(wethAfter).to.be.gt(wethBefore);
    });

    it("Should revert withdrawal that would break health factor", async function () {
      await lendingPool.connect(user2).borrow(await usdc.getAddress(), ethers.parseUnits("20000", 18));
      await expect(
        lendingPool.connect(user2).withdraw(await weth.getAddress(), ethers.parseUnits("5", 18))
      ).to.be.revertedWith("HF < 1.0: action not allowed");
    });
  });

  // --- 8. INTEREST ACCRUAL & SUPPLY RATE ---
  describe("Interest Accrual & Supply Rate", function () {
    it("Should increase borrow index and emit InterestAccrued", async function () {
      const liq = ethers.parseUnits("100000", 18);
      await usdc.connect(owner).approve(await lendingPool.getAddress(), liq);
      await lendingPool.connect(owner).deposit(await usdc.getAddress(), liq);

      const col = ethers.parseUnits("10", 18);
      await weth.connect(user2).approve(await lendingPool.getAddress(), col);
      await lendingPool.connect(user2).deposit(await weth.getAddress(), col);
      await lendingPool.connect(user2).borrow(await usdc.getAddress(), ethers.parseUnits("10000", 18));

      await ethers.provider.send("evm_increaseTime", [365 * 24 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);

      await expect(lendingPool.updateState(await usdc.getAddress()))
        .to.emit(lendingPool, "InterestAccrued");
    });

    it("InterestRateModel should return higher rates above optimal utilization", async function () {
      const lowUtil = await interestModel.getBorrowRate(
        ethers.parseUnits("90", 18), ethers.parseUnits("10", 18)
      );
      const highUtil = await interestModel.getBorrowRate(
        ethers.parseUnits("10", 18), ethers.parseUnits("90", 18)
      );
      expect(highUtil).to.be.gt(lowUtil);
    });

    it("getSupplyRate should return non-zero when there are borrows", async function () {
      const liq = ethers.parseUnits("100000", 18);
      await usdc.connect(owner).approve(await lendingPool.getAddress(), liq);
      await lendingPool.connect(owner).deposit(await usdc.getAddress(), liq);

      const col = ethers.parseUnits("10", 18);
      await weth.connect(user2).approve(await lendingPool.getAddress(), col);
      await lendingPool.connect(user2).deposit(await weth.getAddress(), col);
      await lendingPool.connect(user2).borrow(await usdc.getAddress(), ethers.parseUnits("10000", 18));

      const supplyRate = await lendingPool.getSupplyRate(await usdc.getAddress());
      expect(supplyRate).to.be.gt(0n);
      console.log(`    Supply APY: ${ethers.formatUnits(supplyRate, 16)}%`);
    });
  });

  // --- 9. LIQUIDATION ---
  describe("Liquidation (Close Factor)", function () {
    beforeEach(async function () {
      const liq = ethers.parseUnits("200000", 18);
      await usdc.connect(owner).approve(await lendingPool.getAddress(), liq);
      await lendingPool.connect(owner).deposit(await usdc.getAddress(), liq);

      const col = ethers.parseUnits("10", 18);
      await weth.connect(user2).approve(await lendingPool.getAddress(), col);
      await lendingPool.connect(user2).deposit(await weth.getAddress(), col);
      await lendingPool.connect(user2).borrow(await usdc.getAddress(), ethers.parseUnits("15000", 18));
    });

    it("Should revert liquidation on a healthy position", async function () {
      await usdc.connect(liquidator).approve(await lendingPool.getAddress(), ethers.parseUnits("15000", 18));
      await expect(
        lendingPool.connect(liquidator).liquidate(user2.address, await weth.getAddress(), await usdc.getAddress())
      ).to.be.revertedWith("Position is healthy: no liquidation needed");
    });

    it("Should liquidate 50% of debt and burn borrower LTokens", async function () {
      await wethAggregator.setLatestAnswer(1800_0000_0000n);

      const hf = await lendingPool.getHealthFactor(user2.address);
      expect(hf).to.be.lt(WAD);

      const debtBefore = await lendingPool.accountBorrowsPrincipal(user2.address, await usdc.getAddress());
      const lTokensBefore = await lWETH.balanceOf(user2.address);

      await usdc.connect(liquidator).approve(await lendingPool.getAddress(), ethers.parseUnits("50000", 18));
      await expect(
        lendingPool.connect(liquidator).liquidate(user2.address, await weth.getAddress(), await usdc.getAddress())
      ).to.emit(lendingPool, "Liquidate");

      const debtAfter = await lendingPool.accountBorrowsPrincipal(user2.address, await usdc.getAddress());
      const lTokensAfter = await lWETH.balanceOf(user2.address);

      expect(debtAfter).to.be.gt(0n);   // only 50% repaid
      expect(lTokensAfter).to.be.lt(lTokensBefore); // LTokens burned
      console.log(`    Debt: ${ethers.formatUnits(debtBefore, 18)} → ${ethers.formatUnits(debtAfter, 18)}`);
    });
  });

  // --- 10. FLASH LOANS ---
  describe("Flash Loans", function () {
    beforeEach(async function () {
      const liq = ethers.parseUnits("100000", 18);
      await usdc.connect(owner).approve(await lendingPool.getAddress(), liq);
      await lendingPool.connect(owner).deposit(await usdc.getAddress(), liq);
    });

    it("Should execute a flash loan and emit FlashLoanExecuted", async function () {
      const flashAmt = ethers.parseUnits("10000", 18);
      const fee = await lendingPool.flashFee(await usdc.getAddress(), flashAmt);
      await usdc.connect(owner).approve(await arbitrageBot.getAddress(), fee + ethers.parseUnits("10", 18));
      await expect(arbitrageBot.connect(owner).executeArbitrage(await usdc.getAddress(), flashAmt, 0))
        .to.emit(lendingPool, "FlashLoanExecuted");
    });

    it("Should revert when MaliciousFlashBorrower does not repay", async function () {
      const MaliciousBorrower = await ethers.getContractFactory("MaliciousFlashBorrower");
      const malicious = await MaliciousBorrower.deploy(await lendingPool.getAddress());
      await expect(
        malicious.stealFlashLoan(await usdc.getAddress(), ethers.parseUnits("1000", 18))
      ).to.be.reverted;
    });

    it("maxFlashLoan should reflect pool balance", async function () {
      expect(await lendingPool.maxFlashLoan(await usdc.getAddress()))
        .to.equal(ethers.parseUnits("100000", 18));
    });
  });

  // --- 11. HEALTH FACTOR EDGE CASES ---
  describe("Health Factor Edge Cases", function () {
    it("Should return max uint when user has no debt", async function () {
      expect(await lendingPool.getHealthFactor(user1.address)).to.equal(ethers.MaxUint256);
    });

    it("Should compute correctly right at the borrow limit", async function () {
      const liq = ethers.parseUnits("100000", 18);
      await usdc.connect(owner).approve(await lendingPool.getAddress(), liq);
      await lendingPool.connect(owner).deposit(await usdc.getAddress(), liq);

      const col = ethers.parseUnits("10", 18);
      await weth.connect(user2).approve(await lendingPool.getAddress(), col);
      await lendingPool.connect(user2).deposit(await weth.getAddress(), col);

      // 10 WETH × $3000 × 0.75 LTV = $22500
      await lendingPool.connect(user2).borrow(await usdc.getAddress(), ethers.parseUnits("22500", 18));
      expect(await lendingPool.getHealthFactor(user2.address)).to.be.gte(WAD);
    });
  });
});
