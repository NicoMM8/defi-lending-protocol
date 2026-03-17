import pkg from "hardhat";
const { ethers } = pkg;
import { writeFileSync } from "fs";

async function main() {
  const [deployer] = await ethers.getSigners();
  const SEP = "═".repeat(60);

  console.log(SEP);
  console.log("  🚀 DEPLOYING DeFi LENDING PROTOCOL");
  console.log(SEP);
  console.log(`  Deployer: ${deployer.address}\n`);

  const addresses = {};

  // 1. Deploy Oracle
  console.log("📦 Deploying PriceOracleWrapper...");
  const PriceOracleWrapper = await ethers.getContractFactory("PriceOracleWrapper");
  const oracle = await PriceOracleWrapper.deploy();
  addresses.PriceOracleWrapper = await oracle.getAddress();
  console.log(`   ✅ ${addresses.PriceOracleWrapper}`);

  // 2. Deploy InterestRateModel
  console.log("📦 Deploying InterestRateModel...");
  const InterestRateModel = await ethers.getContractFactory("InterestRateModel");
  const model = await InterestRateModel.deploy(
    ethers.parseUnits("0.8", 18),   // 80% optimal utilization
    ethers.parseUnits("0.02", 18),  // 2% base rate
    ethers.parseUnits("0.04", 18),  // 4% slope1
    ethers.parseUnits("0.75", 18)   // 75% slope2
  );
  addresses.InterestRateModel = await model.getAddress();
  console.log(`   ✅ ${addresses.InterestRateModel}`);

  // 3. Deploy LendingPool
  console.log("📦 Deploying LendingPool...");
  const LendingPool = await ethers.getContractFactory("LendingPool");
  const pool = await LendingPool.deploy(addresses.PriceOracleWrapper, addresses.InterestRateModel);
  addresses.LendingPool = await pool.getAddress();
  console.log(`   ✅ ${addresses.LendingPool}`);

  // 4. Deploy ArbitrageBot
  console.log("📦 Deploying ArbitrageBot...");
  const ArbitrageBot = await ethers.getContractFactory("ArbitrageBot");
  const bot = await ArbitrageBot.deploy(addresses.LendingPool);
  addresses.ArbitrageBot = await bot.getAddress();
  console.log(`   ✅ ${addresses.ArbitrageBot}`);

  // Save addresses
  const outputPath = "deployed-addresses.json";
  writeFileSync(outputPath, JSON.stringify(addresses, null, 2));
  console.log(`\n📝 Addresses saved to ${outputPath}`);

  console.log(`\n${SEP}`);
  console.log("  ✅ Deployment complete!");
  console.log(SEP);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
