import pkg from "hardhat";
const { ethers } = pkg;

async function main() {
  const provider = ethers.provider;
  // Get deployed contracts (In a real scenario, you'd load addresses from a config or env)
  // For this local script, we assume the addresses are passed or hardcoded
  const LENDING_POOL_ADDRESS = process.env.LENDING_POOL_ADDRESS;
  const LENDING_POOL_ABI = [
    "function getHealthFactor(address) view returns (uint256)",
    "function liquidate(address,address,address)",
    "function allMarkets(uint256) view returns (address)"
  ];
  const lendingPool = new ethers.Contract(LENDING_POOL_ADDRESS, LENDING_POOL_ABI, provider);
  
  // A mock list of borrowers to monitor
  const borrowers = [
    // "0xUserAddress1...",
    // "0xUserAddress2..."
  ];

  const collateralToken = process.env.COLLATERAL_TOKEN;
  const debtToken = process.env.DEBT_TOKEN;

  console.log("Starting Liquidation Bot...");

  provider.on("block", async (blockNumber) => {
    console.log(`[Block ${blockNumber}] Monitoring health factors...`);
    
    for (const user of borrowers) {
      try {
        const hf = await lendingPool.getHealthFactor(user);
        const hfFormatted = ethers.formatUnits(hf, 18);
        console.log(`User ${user} Health Factor: ${hfFormatted}`);

        if (hf < ethers.parseUnits("1.0", 18)) {
          console.log(`!!! LIQUIDATION OPPORTUNITY DETECTED for ${user} !!!`);
          
          // Connect to the liquidator wallet
          const liquidatorWallet = new ethers.Wallet(process.env.LIQUIDATOR_PRIVATE_KEY, provider);
          const lendingPoolWithSigner = lendingPool.connect(liquidatorWallet);

          console.log(`Sending liquidate transaction...`);
          const tx = await lendingPoolWithSigner.liquidate(user, collateralToken, debtToken);
          console.log(`Transaction sent: ${tx.hash}`);
          
          const receipt = await tx.wait();
          console.log(`Transaction confirmed in block ${receipt.blockNumber}`);
        }
      } catch (error) {
        console.error(`Error checking user ${user}:`, error.message);
      }
    }
  });
}

// Ensure the script keeps running
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
