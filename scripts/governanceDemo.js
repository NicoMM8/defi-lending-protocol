import pkg from "hardhat";
const { ethers } = pkg;

async function main() {
  console.log("--------------------------------------------");
  console.log("  ON-CHAIN GOVERNANCE DEMO");
  console.log("  Propose -> Vote -> Queue -> Execute");
  console.log("--------------------------------------------\n");

  const [deployer, voter1, voter2, voter3] = await ethers.getSigners();
  const TOTAL_SUPPLY = ethers.parseUnits("10000000", 18); // 10M PGT

  // --- 1. Deploy Governance stack ---
  console.log("Deploying Governance stack...");

  const GovernanceToken = await ethers.getContractFactory("GovernanceToken");
  const token = await GovernanceToken.deploy(deployer.address, TOTAL_SUPPLY);
  console.log(`   GovernanceToken (PGT): ${await token.getAddress()}`);

  // TimelockController: 2-day min delay (we'll use 2 seconds for demo)
  const TimelockController = await ethers.getContractFactory("TimelockController");
  const minDelay = 2; // 2 seconds for demo (would be 2 days in prod)
  const timelock = await TimelockController.deploy(
    minDelay,
    [], // proposers (set after governor is deployed)
    [], // executors (set after governor is deployed)
    deployer.address
  );
  console.log(`   TimelockController:    ${await timelock.getAddress()}`);

  const ProtocolGovernor = await ethers.getContractFactory("ProtocolGovernor");
  const governor = await ProtocolGovernor.deploy(
    await token.getAddress(),
    await timelock.getAddress()
  );
  console.log(`   ProtocolGovernor:      ${await governor.getAddress()}`);

  // --- 2. Set up Timelock roles ---
  const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
  const EXECUTOR_ROLE = await timelock.EXECUTOR_ROLE();
  const ADMIN_ROLE    = await timelock.DEFAULT_ADMIN_ROLE();

  await timelock.grantRole(PROPOSER_ROLE, await governor.getAddress());
  await timelock.grantRole(EXECUTOR_ROLE, ethers.ZeroAddress); // anyone can execute
  await timelock.revokeRole(ADMIN_ROLE, deployer.address);     // fully decentralised
  console.log("\n   Timelock roles configured (Governor=proposer, anyone=executor)");

  // --- 3. Deploy LendingPool owned by Timelock ---
  const MockAggregator  = await ethers.getContractFactory("MockAggregator");
  const usdcAgg = await MockAggregator.deploy(1_0000_0000n);
  const PriceOracleWrapper = await ethers.getContractFactory("PriceOracleWrapper");
  const oracle = await PriceOracleWrapper.deploy();
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const usdc = await MockERC20.deploy("Mock USDC", "USDC");
  await oracle.setPriceFeed(await usdc.getAddress(), await usdcAgg.getAddress());

  const InterestRateModel = await ethers.getContractFactory("InterestRateModel");
  const irm = await InterestRateModel.deploy(
    ethers.parseUnits("0.8", 18), ethers.parseUnits("0.02", 18),
    ethers.parseUnits("0.04", 18), ethers.parseUnits("0.75", 18)
  );

  const LendingPool = await ethers.getContractFactory("LendingPool");
  const pool = await LendingPool.deploy(await oracle.getAddress(), await irm.getAddress());

  // Transfer ownership to Timelock — now only governance can call admin functions
  await pool.transferOwnership(await timelock.getAddress());
  console.log(`\n   LendingPool:           ${await pool.getAddress()}`);
  console.log(`   LendingPool owner:     ${await pool.owner()} (Timelock)\n`);

  // --- 4. Distribute PGT and delegate voting power ---
  console.log("Distributing PGT and delegating votes...");
  const share = ethers.parseUnits("1000000", 18); // 1M PGT each
  await token.transfer(voter1.address, share);
  await token.transfer(voter2.address, share);
  await token.transfer(voter3.address, share);

  // Holders MUST self-delegate to activate voting power
  await token.connect(deployer).delegate(deployer.address);
  await token.connect(voter1).delegate(voter1.address);
  await token.connect(voter2).delegate(voter2.address);
  await token.connect(voter3).delegate(voter3.address);

  const deployerVotes = await token.getVotes(deployer.address);
  console.log(`   Deployer votes: ${ethers.formatUnits(deployerVotes, 18)} PGT\n`);

  // --- 5. Create governance proposal ---
  console.log("Creating proposal: Add USDC market to LendingPool");

  const addMarketCall = pool.interface.encodeFunctionData("addMarket", [
    await usdc.getAddress(),
    ethers.parseUnits("0.8", 18),
    ethers.parseUnits("1.05", 18),
    "Lending USDC",
    "lUSDC"
  ]);

  const proposalDescription = "Proposal #1: Add USDC as a borrowable market with 80% LTV and 5% liquidation bonus";
  const descriptionHash = ethers.keccak256(ethers.toUtf8Bytes(proposalDescription));

  const tx = await governor.propose(
    [await pool.getAddress()],
    [0],
    [addMarketCall],
    proposalDescription
  );
  const receipt = await tx.wait();
  const proposalId = receipt.logs[0].args[0];
  console.log(`   Proposal ID: ${proposalId.toString().slice(0, 20)}...`);
  console.log(`   State: ${stateLabel(await governor.state(proposalId))}`);

  // --- 6. Advance past voting delay ---
  await ethers.provider.send("evm_mine", []);
  console.log(`\nVoting delay passed. State: ${stateLabel(await governor.state(proposalId))}`);

  // --- 7. Cast votes ---
  console.log("\nCasting votes (0=Against, 1=For, 2=Abstain):");
  await governor.connect(deployer).castVote(proposalId, 1); console.log(`   Deployer: FOR`);
  await governor.connect(voter1).castVote(proposalId, 1);   console.log(`   Voter 1:  FOR`);
  await governor.connect(voter2).castVote(proposalId, 1);   console.log(`   Voter 2:  FOR`);
  await governor.connect(voter3).castVote(proposalId, 0);   console.log(`   Voter 3:  AGAINST`);

  const { forVotes, againstVotes } = await governor.proposalVotes(proposalId);
  console.log(`\n   For: ${ethers.formatUnits(forVotes, 18)} PGT | Against: ${ethers.formatUnits(againstVotes, 18)} PGT`);

  // --- 8. Advance past voting period ---
  await ethers.provider.send("hardhat_mine", ["0xC4F0"]); // 50400 blocks
  console.log(`\nVoting period ended. State: ${stateLabel(await governor.state(proposalId))}`);

  // --- 9. Queue in Timelock ---
  await governor.queue(
    [await pool.getAddress()], [0], [addMarketCall], descriptionHash
  );
  console.log(`Proposal queued in Timelock. State: ${stateLabel(await governor.state(proposalId))}`);

  // --- 10. Wait for Timelock delay, then execute ---
  await ethers.provider.send("evm_increaseTime", [minDelay + 1]);
  await ethers.provider.send("evm_mine", []);

  await governor.execute(
    [await pool.getAddress()], [0], [addMarketCall], descriptionHash
  );
  console.log(`Proposal executed! State: ${stateLabel(await governor.state(proposalId))}`);

  // --- 11. Verify the market was actually added ---
  const market = await pool.markets(await usdc.getAddress());
  console.log(`\nResult - USDC market listed: ${market[0]}`); // isListed
  console.log(`   lUSDC address: ${await pool.getLToken(await usdc.getAddress())}`);

  console.log("\n--------------------------------------------");
  console.log("  Governance flow complete!");
  console.log("--------------------------------------------");
}

function stateLabel(s) {
  return ["Pending","Active","Canceled","Defeated","Succeeded","Queued","Expired","Executed"][Number(s)];
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
