import pkg from "hardhat";
const { ethers } = pkg;

async function main() {
  const [deployer] = await ethers.getSigners();
  const WAD = ethers.parseUnits("1", 18);
  const SEP = "═".repeat(60);

  console.log(SEP);
  console.log("  ⚡ FLASH LOAN ARBITRAGE SIMULATION");
  console.log(SEP);
  console.log(`  Deployer: ${deployer.address}\n`);

  // ── 1. Deploy contracts ──
  console.log("📦 Deploying contracts...");

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const usdc = await MockERC20.deploy("Mock USDC", "USDC");
  console.log(`   USDC deployed at ${await usdc.getAddress()}`);

  const MockAggregator = await ethers.getContractFactory("MockAggregator");
  const usdcAgg = await MockAggregator.deploy(1_0000_0000n); // $1

  const PriceOracleWrapper = await ethers.getContractFactory("PriceOracleWrapper");
  const oracle = await PriceOracleWrapper.deploy();
  await oracle.setPriceFeed(await usdc.getAddress(), await usdcAgg.getAddress());

  const InterestRateModel = await ethers.getContractFactory("InterestRateModel");
  const model = await InterestRateModel.deploy(
    ethers.parseUnits("0.8", 18),
    ethers.parseUnits("0.02", 18),
    ethers.parseUnits("0.04", 18),
    ethers.parseUnits("0.75", 18)
  );

  const LendingPool = await ethers.getContractFactory("LendingPool");
  const pool = await LendingPool.deploy(await oracle.getAddress(), await model.getAddress());
  console.log(`   LendingPool deployed at ${await pool.getAddress()}`);

  await pool.addMarket(await usdc.getAddress(), ethers.parseUnits("0.8", 18), ethers.parseUnits("1.05", 18));

  const ArbitrageBot = await ethers.getContractFactory("ArbitrageBot");
  const bot = await ArbitrageBot.deploy(await pool.getAddress());
  console.log(`   ArbitrageBot deployed at ${await bot.getAddress()}\n`);

  // ── 2. Seed the pool with liquidity ──
  const poolDeposit = ethers.parseUnits("100000", 18);
  await usdc.mint(deployer.address, ethers.parseUnits("200000", 18));
  await usdc.approve(await pool.getAddress(), poolDeposit);
  await pool.deposit(await usdc.getAddress(), poolDeposit);
  console.log(`💰 Pool seeded with ${ethers.formatUnits(poolDeposit, 18)} USDC\n`);

  // ── 3. Pre-fund ArbitrageBot for simulated profit ──
  const flashAmt = ethers.parseUnits("10000", 18);
  const fee = await pool.flashFee(await usdc.getAddress(), flashAmt);
  const profitBuffer = fee + ethers.parseUnits("42", 18); // 42 USDC "profit"
  await usdc.approve(await bot.getAddress(), profitBuffer);
  console.log(`🤖 ArbitrageBot pre-funded with ${ethers.formatUnits(profitBuffer, 18)} USDC (fee + simulated arbitrage profit)`);

  // ── 4. Snapshot before ──
  const poolLiqBefore = (await pool.markets(await usdc.getAddress())).totalLiquidity;
  const deploySbalBefore = await usdc.balanceOf(deployer.address);
  console.log(`\n──── BEFORE Flash Loan ────`);
  console.log(`   Pool liquidity:     ${ethers.formatUnits(poolLiqBefore, 18)} USDC`);
  console.log(`   Deployer balance:   ${ethers.formatUnits(deploySbalBefore, 18)} USDC`);
  console.log(`   Flash loan amount:  ${ethers.formatUnits(flashAmt, 18)} USDC`);
  console.log(`   Flash fee (0.09%):  ${ethers.formatUnits(fee, 18)} USDC`);

  // ── 5. Execute the flash loan arbitrage ──
  console.log(`\n⚡ Executing flash loan arbitrage...`);
  const tx = await bot.executeArbitrage(await usdc.getAddress(), flashAmt);
  const receipt = await tx.wait();
  console.log(`   ✅ Transaction confirmed in block ${receipt.blockNumber}`);

  // ── 6. Snapshot after ──
  const poolLiqAfter = (await pool.markets(await usdc.getAddress())).totalLiquidity;
  const botBalance = await usdc.balanceOf(await bot.getAddress());

  console.log(`\n──── AFTER Flash Loan ────`);
  console.log(`   Pool liquidity:     ${ethers.formatUnits(poolLiqAfter, 18)} USDC  (+${ethers.formatUnits(poolLiqAfter - poolLiqBefore, 18)} fee earned)`);
  console.log(`   Bot residual profit: ${ethers.formatUnits(botBalance, 18)} USDC`);

  // ── 7. Withdraw profits ──
  await bot.withdrawProfits(await usdc.getAddress());
  const finalBal = await usdc.balanceOf(deployer.address);
  console.log(`\n🎉 Profits withdrawn. Deployer final balance: ${ethers.formatUnits(finalBal, 18)} USDC`);
  console.log(SEP);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
