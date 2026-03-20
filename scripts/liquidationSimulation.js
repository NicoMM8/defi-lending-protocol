import pkg from "hardhat";
const { ethers } = pkg;

async function main() {
  const [deployer, borrower, liquidator] = await ethers.getSigners();
  const WAD = ethers.parseUnits("1", 18);
  console.log("--------------------------------------------");
  console.log("  LIQUIDATION SIMULATION (with Close Factor)");
  console.log("--------------------------------------------");
  console.log(`  Deployer:    ${deployer.address}`);
  console.log(`  Borrower:    ${borrower.address}`);
  console.log(`  Liquidator:  ${liquidator.address}\n`);

  // --- 1. Deploy ---
  console.log("Deploying contracts...");

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const usdc = await MockERC20.deploy("Mock USDC", "USDC");
  const weth = await MockERC20.deploy("Mock WETH", "WETH");

  const MockAggregator = await ethers.getContractFactory("MockAggregator");
  const usdcAgg = await MockAggregator.deploy(1_0000_0000n);
  const wethAgg = await MockAggregator.deploy(3000_0000_0000n);

  const PriceOracleWrapper = await ethers.getContractFactory("PriceOracleWrapper");
  const oracle = await PriceOracleWrapper.deploy();
  await oracle.setPriceFeed(await usdc.getAddress(), await usdcAgg.getAddress());
  await oracle.setPriceFeed(await weth.getAddress(), await wethAgg.getAddress());

  const InterestRateModel = await ethers.getContractFactory("InterestRateModel");
  const model = await InterestRateModel.deploy(
    ethers.parseUnits("0.8", 18),
    ethers.parseUnits("0.02", 18),
    ethers.parseUnits("0.04", 18),
    ethers.parseUnits("0.75", 18)
  );

  const LendingPool = await ethers.getContractFactory("LendingPool");
  const pool = await LendingPool.deploy(await oracle.getAddress(), await model.getAddress());
  console.log(`   LendingPool: ${await pool.getAddress()}\n`);

  await pool.addMarket(await usdc.getAddress(), ethers.parseUnits("0.8", 18), ethers.parseUnits("1.05", 18), "Lending USDC", "lUSDC");
  await pool.addMarket(await weth.getAddress(), ethers.parseUnits("0.75", 18), ethers.parseUnits("1.08", 18), "Lending WETH", "lWETH");

  // --- 2. Setup positions ---
  console.log("Setting up positions...");

  await usdc.mint(deployer.address, ethers.parseUnits("500000", 18));
  await usdc.approve(await pool.getAddress(), ethers.parseUnits("200000", 18));
  await pool.deposit(await usdc.getAddress(), ethers.parseUnits("200000", 18));
  console.log("   Deployer deposited 200,000 USDC as pool liquidity");

  await weth.mint(borrower.address, ethers.parseUnits("20", 18));
  await weth.connect(borrower).approve(await pool.getAddress(), ethers.parseUnits("20", 18));
  await pool.connect(borrower).deposit(await weth.getAddress(), ethers.parseUnits("20", 18));
  console.log("   Borrower deposited 20 WETH ($60,000 at $3000/ETH)");

  await pool.connect(borrower).borrow(await usdc.getAddress(), ethers.parseUnits("30000", 18));
  console.log("   Borrower took a 30,000 USDC loan");

  const hfHealthy = await pool.getHealthFactor(borrower.address);
  console.log(`\n   Health Factor (healthy): ${ethers.formatUnits(hfHealthy, 18)}`);

  const supplyRate = await pool.getSupplyRate(await usdc.getAddress());
  console.log(`   Supply APY: ${ethers.formatUnits(supplyRate, 16)}%`);

  // --- 3. Market crash ---
  console.log("\nMarket crash - WETH price drops to $1,800...");
  await wethAgg.setLatestAnswer(1800_0000_0000n);

  const hfUnderwater = await pool.getHealthFactor(borrower.address);
  console.log(`   Health Factor (underwater): ${ethers.formatUnits(hfUnderwater, 18)}`);
  console.log(`   Position is ${hfUnderwater < WAD ? "LIQUIDATABLE" : "safe"}`);

  // --- 4. First Liquidation ---
  console.log("\nLiquidator sweeps in (1st call - Close Factor 50%)...");

  await usdc.mint(liquidator.address, ethers.parseUnits("100000", 18));
  await usdc.connect(liquidator).approve(await pool.getAddress(), ethers.parseUnits("100000", 18));

  const debtBefore = await pool.accountBorrowsPrincipal(borrower.address, await usdc.getAddress());

  const tx1 = await pool.connect(liquidator).liquidate(
    borrower.address, await weth.getAddress(), await usdc.getAddress()
  );
  await tx1.wait();

  const debtAfter1 = await pool.accountBorrowsPrincipal(borrower.address, await usdc.getAddress());
  const debtRepaid1 = debtBefore - debtAfter1;
  console.log(`   1st liquidation complete`);
  console.log(`   Debt repaid: ${ethers.formatUnits(debtRepaid1, 18)} USDC`);
  console.log(`   Remaining debt: ${ethers.formatUnits(debtAfter1, 18)} USDC`);

  const hfAfter1 = await pool.getHealthFactor(borrower.address);
  console.log(`   HF after 1st liquidation: ${ethers.formatUnits(hfAfter1, 18)}`);

  // --- 5. Second Liquidation ---
  if (hfAfter1 < WAD) {
    console.log("\nLiquidator calls again (2nd call)...");
    const tx2 = await pool.connect(liquidator).liquidate(
      borrower.address, await weth.getAddress(), await usdc.getAddress()
    );
    await tx2.wait();

    const debtAfter2 = await pool.accountBorrowsPrincipal(borrower.address, await usdc.getAddress());
    const debtRepaid2 = debtAfter1 - debtAfter2;
    console.log(`   2nd liquidation complete`);
    console.log(`   Debt repaid: ${ethers.formatUnits(debtRepaid2, 18)} USDC`);
    console.log(`   Remaining debt: ${ethers.formatUnits(debtAfter2, 18)} USDC`);
  }

  // --- Summary ---
  const wethBal = await weth.balanceOf(liquidator.address);
  const collateral = await pool.accountCollateral(borrower.address, await weth.getAddress());
  const finalDebt = await pool.accountBorrowsPrincipal(borrower.address, await usdc.getAddress());
  const hfFinal = await pool.getHealthFactor(borrower.address);

  console.log(`\n---- FINAL STATE ----`);
  console.log(`   Liquidator WETH earned:    ${ethers.formatUnits(wethBal, 18)}`);
  console.log(`   Borrower collateral left:  ${ethers.formatUnits(collateral, 18)} WETH`);
  console.log(`   Borrower debt left:        ${ethers.formatUnits(finalDebt, 18)} USDC`);
  console.log(`   Borrower final HF:         ${ethers.formatUnits(hfFinal, 18)}`);

  console.log("\n--------------------------------------------");
  console.log("  Liquidation simulation complete");
  console.log("--------------------------------------------");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
