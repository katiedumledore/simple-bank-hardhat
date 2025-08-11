const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Simple Bank v2.1 - Basic Tests", function () {
  let simpleBankV21;
  let owner;
  let user1;
  let user2;

  beforeEach(async function () {
    [owner, user1, user2] = await ethers.getSigners();
    
    console.log("🏦 Deploying Simple Bank v2.1...");
    
    const SimpleBankV21 = await ethers.getContractFactory("SimpleBankV2_1");
    simpleBankV21 = await SimpleBankV21.deploy();
    await simpleBankV21.waitForDeployment();
    
    // Initialize the upgradeable contract
    await simpleBankV21.initialize();
    
    console.log(`✅ Contract deployed and initialized`);
  });

  describe("🏗️ Deployment & Initialization", function () {
    it("Should initialize correctly", async function () {
      const bankStats = await simpleBankV21.getBankStats();
      expect(bankStats.owner).to.equal(owner.address);
        // Convert BigInt to string for comparison, or use Number()
      expect(Number(bankStats.totalDeposits)).to.equal(0);
      expect(Number(bankStats.totalUsers)).to.equal(0);
      expect(bankStats.emergencyMode).to.equal(false);
    });

    it("Should grant admin role to deployer", async function () {
      const ADMIN_ROLE = await simpleBankV21.ADMIN_ROLE();
      expect(await simpleBankV21.hasRole(ADMIN_ROLE, owner.address)).to.be.true;
    });
  });

  describe("💰 Basic Banking Functions", function () {
    it("Should allow deposit", async function () {
      const depositAmount = ethers.parseEther("1.0");
      
      console.log(`💵 User1 depositing 1 ETH...`);
      
      await simpleBankV21.connect(user1).deposit({ value: depositAmount });
      
      const balance = await simpleBankV21.connect(user1).getMyBalance();
      expect(balance).to.equal(depositAmount);
      
      console.log(`✅ Deposit successful!`);
    });

    it("Should allow withdrawal", async function () {
      // Setup: deposit first
      const depositAmount = ethers.parseEther("2.0");
      await simpleBankV21.connect(user1).deposit({ value: depositAmount });
      
      const withdrawAmount = ethers.parseEther("1.0");
      
      console.log(`🏧 User1 withdrawing 1 ETH...`);
      
      await simpleBankV21.connect(user1).withdraw(withdrawAmount);
      
      const balance = await simpleBankV21.connect(user1).getMyBalance();
      expect(balance).to.equal(ethers.parseEther("1.0"));
      
      console.log(`✅ Withdrawal successful!`);
    });

    it("Should allow transfers", async function () {
      // Setup: User1 deposits
      const depositAmount = ethers.parseEther("3.0");
      await simpleBankV21.connect(user1).deposit({ value: depositAmount });
      
      const transferAmount = ethers.parseEther("1.0");
      
      console.log(`🔄 User1 transferring 1 ETH to User2...`);
      
      await simpleBankV21.connect(user1).transferTo(user2.address, transferAmount);
      
      const user1Balance = await simpleBankV21.connect(user1).getMyBalance();
      const user2Balance = await simpleBankV21.connect(user2).getMyBalance();
      
      expect(user1Balance).to.equal(ethers.parseEther("2.0"));
      expect(user2Balance).to.equal(transferAmount);
      
      console.log(`✅ Transfer successful!`);
    });
  });
});