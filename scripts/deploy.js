const { ethers } = require("hardhat");
const fs = require('fs');
const path = require('path');

async function main() {
  console.log("🚀 Starting Simple Bank v2.1 deployment...");
  console.log("=====================================");
  
  // Get deployer account
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  
  console.log(`📡 Network: ${network.name} (Chain ID: ${network.chainId})`);
  console.log(`👤 Deploying with account: ${deployer.address}`);
  
  // Check deployer balance
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`💰 Account balance: ${ethers.formatEther(balance)} ETH`);
  
  if (balance < ethers.parseEther("0.01")) {
    throw new Error("❌ Insufficient balance for deployment. Need at least 0.01 ETH");
  }
  
  // Get fee data (ethers v6 compatible)
  const feeData = await ethers.provider.getFeeData();
  const gasPrice = feeData.gasPrice;
  console.log(`⛽ Gas price: ${ethers.formatUnits(gasPrice, "gwei")} gwei`);
  
  console.log("\n🏗️ Deploying contract...");
  
  // Deploy the contract
  const SimpleBankV21 = await ethers.getContractFactory("SimpleBankV2_1");
  
  // Deploy with optimization settings
  const simpleBankV21 = await SimpleBankV21.deploy();
  
  console.log(`⏳ Transaction hash: ${simpleBankV21.deploymentTransaction().hash}`);
  console.log("⏳ Waiting for deployment confirmation...");
  
  // Wait for deployment
  await simpleBankV21.waitForDeployment();
  const contractAddress = await simpleBankV21.getAddress();
  
  console.log(`✅ Contract deployed to: ${contractAddress}`);
  
  // Initialize the contract
  console.log("\n🎯 Initializing contract...");
  const initTx = await simpleBankV21.initialize();
  const initReceipt = await initTx.wait();
  
  console.log(`✅ Contract initialized (Gas used: ${initReceipt.gasUsed.toLocaleString()})`);
  
  // Get final deployment details
  const deploymentBlock = await ethers.provider.getBlockNumber();
  const deploymentTimestamp = (await ethers.provider.getBlock(deploymentBlock)).timestamp;
  
  // Create deployment info object
  const deploymentInfo = {
    network: network.name,
    chainId: Number(network.chainId),
    contractName: "SimpleBankV2_1",
    contractAddress: contractAddress,
    deployer: deployer.address,
    deploymentHash: simpleBankV21.deploymentTransaction().hash,
    initializationHash: initTx.hash,
    blockNumber: deploymentBlock,
    timestamp: deploymentTimestamp,
    gasUsed: {
      deployment: (await simpleBankV21.deploymentTransaction().wait()).gasUsed.toString(),
      initialization: initReceipt.gasUsed.toString()
    },
    gasPrice: gasPrice ? gasPrice.toString() : "0",
    totalCost: "calculated_post_deployment", // Fixed: no BigInt conversion needed
    deployedAt: new Date().toISOString(),
    compiler: {
      version: "0.8.19",
      optimizer: {
        enabled: true,
        runs: 1
      }
    },
    dependencies: {
      openzeppelin: "@openzeppelin/contracts-upgradeable",
      chainlink: "@chainlink/contracts"
    }
  };
  
  // Save deployment info
  const deploymentsDir = path.join(__dirname, '..', 'deployments');
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }
  
  const deploymentFile = path.join(deploymentsDir, `${network.name}-deployment.json`);
  fs.writeFileSync(deploymentFile, JSON.stringify(deploymentInfo, null, 2));
  
  console.log(`📄 Deployment info saved to: ${deploymentFile}`);
  
  // Run basic verification tests
  console.log("\n🧪 Running deployment verification...");
  
  try {
    // Test basic contract functions
    const bankStats = await simpleBankV21.getBankStats();
    console.log(`✅ Bank owner: ${bankStats.owner}`);
    console.log(`✅ Total deposits: ${bankStats.totalDeposits}`);
    console.log(`✅ Emergency mode: ${bankStats.emergencyMode}`);
    
    // Test role assignments
    const ADMIN_ROLE = await simpleBankV21.ADMIN_ROLE();
    const hasAdminRole = await simpleBankV21.hasRole(ADMIN_ROLE, deployer.address);
    console.log(`✅ Admin role assigned: ${hasAdminRole}`);
    
    console.log("✅ Basic verification tests passed!");
    
  } catch (error) {
    console.log("⚠️ Verification tests failed:", error.message);
  }
  
  // Final summary
  console.log("\n🎉 DEPLOYMENT COMPLETE!");
  console.log("=====================================");
  console.log(`📍 Network: ${network.name}`);
  console.log(`🏦 Contract: ${contractAddress}`);
  console.log(`💰 Gas Used: ${(await simpleBankV21.deploymentTransaction().wait()).gasUsed.toLocaleString()}`);
  console.log(`🔗 Etherscan: https://${network.name === 'sepolia' ? 'sepolia.' : ''}etherscan.io/address/${contractAddress}`);
  console.log("=====================================");
  
  // Instructions for verification
  if (network.name !== "hardhat" && network.name !== "localhost") {
    console.log("\n📋 Next steps:");
    console.log("1. Verify contract on Etherscan:");
    console.log(`   npx hardhat verify --network ${network.name} ${contractAddress}`);
    console.log("2. Set up monitoring for the deployed contract");
    console.log("3. Update frontend with new contract address");
    console.log("4. Announce deployment to stakeholders");
  }
  
  return {
    contractAddress,
    deploymentInfo
  };
}

// Execute deployment
main()
  .then((result) => {
    console.log(`\n✅ Deployment script completed successfully!`);
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ Deployment failed:");
    console.error(error);
    process.exit(1);
  });