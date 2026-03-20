import pkg from "hardhat";
const { ethers } = pkg;

// ── Mainnet addresses (pinned block ~19M) ──────────────────────────
const WETH_ADDR       = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC_ADDR       = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const UNI_ROUTER      = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D"; // Uniswap V2
const SUSHI_ROUTER    = "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F"; // Sushiswap

// WETH whale to impersonate & seed our bot with WETH (Binance 7)
const WETH_WHALE      = "0xF977814e90dA44bFA03b6295A0616a897441aceC";

const BLOCK_NUMBER    = 19_000_000; // Reproducible fork

async function main() {
  console.log("--------------------------------------------");
  console.log("  REAL UNISWAP V2 <-> SUSHISWAP ARBITRAGE");
  console.log("  (Mainnet fork - block " + BLOCK_NUMBER + ")");
  console.log("--------------------------------------------\n");

  const [deployer] = await ethers.getSigners();
  const WETH = await ethers.getContractAt("IERC20", WETH_ADDR);
  const USDC = await ethers.getContractAt("IERC20", USDC_ADDR);

  // --- 1. Deploy the full protocol ---
  console.log("Deploying protocol contracts...");

  const MockAggregator = await ethers.getContractFactory("MockAggregator");
  const wethAgg = await MockAggregator.deploy(2000_0000_0000n); // $2000/ETH
  const usdcAgg = await MockAggregator.deploy(1_0000_0000n);    // $1/USDC

  const PriceOracleWrapper = await ethers.getContractFactory("PriceOracleWrapper");
  const oracle = await PriceOracleWrapper.deploy();
  await oracle.setPriceFeed(WETH_ADDR, await wethAgg.getAddress());
  await oracle.setPriceFeed(USDC_ADDR, await usdcAgg.getAddress());

  const InterestRateModel = await ethers.getContractFactory("InterestRateModel");
  const irm = await InterestRateModel.deploy(
    ethers.parseUnits("0.8", 18),
    ethers.parseUnits("0.02", 18),
    ethers.parseUnits("0.04", 18),
    ethers.parseUnits("0.75", 18)
  );

  const LendingPool = await ethers.getContractFactory("LendingPool");
  const pool = await LendingPool.deploy(await oracle.getAddress(), await irm.getAddress());

  // Add WETH market (used as flash loan source)
  await pool.addMarket(
    WETH_ADDR,
    ethers.parseUnits("0.75", 18),
    ethers.parseUnits("1.08", 18),
    "Lending WETH",
    "lWETH"
  );

  const UniswapArbitrageBot = await ethers.getContractFactory("UniswapArbitrageBot");
  const bot = await UniswapArbitrageBot.deploy(
    await pool.getAddress(),
    UNI_ROUTER,
    SUSHI_ROUTER
  );
  console.log(`   LendingPool:        ${await pool.getAddress()}`);
  console.log(`   UniswapArbitrageBot: ${await bot.getAddress()}\n`);

  // --- 2. Impersonate whale and seed the pool ---
  console.log("Seed the pool with WETH from whale account...");
  await ethers.provider.send("hardhat_impersonateAccount", [WETH_WHALE]);
  await ethers.provider.send("hardhat_setBalance", [WETH_WHALE, "0x56BC75E2D63100000"]);
  const whale = await ethers.getSigner(WETH_WHALE);

  const poolSeed = ethers.parseEther("50"); // 50 WETH into the pool
  await WETH.connect(whale).approve(await pool.getAddress(), poolSeed);
  await pool.connect(whale).deposit(WETH_ADDR, poolSeed);
  console.log(`   Seeded pool with 50 WETH\n`);

  // --- 3. Preview profitability ---
  const flashAmount = ethers.parseEther("10"); // 10 WETH flash loan
  const fee = await pool.flashFee(WETH_ADDR, flashAmount);

  console.log("Checking arbitrage opportunity...");
  console.log(`   Flash loan: ${ethers.formatEther(flashAmount)} WETH`);
  console.log(`   Flash fee:  ${ethers.formatEther(fee)} WETH (0.09%)\n`);

  // Preview both directions
  const profitUniFirst = await bot.previewArbitrage(WETH_ADDR, USDC_ADDR, flashAmount, fee, true);
  const profitSushiFirst = await bot.previewArbitrage(WETH_ADDR, USDC_ADDR, flashAmount, fee, false);

  console.log(`   Direction A (Uni buy  -> Sushi sell): ${ethers.formatEther(profitUniFirst)} WETH`);
  console.log(`   Direction B (Sushi buy -> Uni sell):  ${ethers.formatEther(profitSushiFirst)} WETH`);

  const uniFirst = profitUniFirst >= profitSushiFirst;
  const bestProfit = uniFirst ? profitUniFirst : profitSushiFirst;

  if (bestProfit <= 0n) {
    console.log("\n  No profitable arbitrage opportunity at current block.");
    console.log("  (Standard for mainnet forks without active volatility)");
    console.log("--------------------------------------------");
    return;
  }

  // --- 4. Execute the arbitrage ---
  console.log(`\nOpportunity found! Direction: ${uniFirst ? "Uni->Sushi" : "Sushi->Uni"}`);
  console.log(`   Expected profit: ${ethers.formatEther(bestProfit)} WETH\n`);

  // Give deployer some ETH for gas
  const botBefore = await WETH.balanceOf(await bot.getAddress());
  await bot.executeArbitrage(WETH_ADDR, USDC_ADDR, flashAmount, uniFirst, 0);

  const botAfter = await WETH.balanceOf(await bot.getAddress());
  const actualProfit = botAfter - botBefore;

  console.log(`Arbitrage transaction complete!`);
  console.log(`   Actual profit: ${ethers.formatEther(actualProfit)} WETH`);

  await bot.withdraw(WETH_ADDR);
  console.log(`   Profits withdrawn to deployer account`);
  console.log("--------------------------------------------");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
