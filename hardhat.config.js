import "@nomicfoundation/hardhat-toolbox";
import "dotenv/config.js";

/** @type import('hardhat/config').HardhatUserConfig */
export default {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    hardhat: {
      allowUnlimitedContractSize: true,
      forking: process.env.MAINNET_RPC_URL
        ? {
            url: process.env.MAINNET_RPC_URL,
            // blockNumber: 19_000_000, // pin block for reproducible tests
          }
        : undefined,
    },
  },
};
