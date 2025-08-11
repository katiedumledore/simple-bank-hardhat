 // monitoring/contract-monitor.js
const axios = require('axios');
const { ethers } = require('ethers');
require('dotenv').config();

class SimpleBankMonitor {
  constructor() {
    this.contractAddress = "0x9FFF42a6d78344D635e100EeEA5EFdd8ED8CDfF8";
    this.etherscanApiKey = process.env.ETHERSCAN_API_KEY;
    this.infuraKey = process.env.INFURA_API_KEY;
    
    // Initialize provider
    this.provider = new ethers.JsonRpcProvider(`https://sepolia.infura.io/v3/${this.infuraKey}`);
    
    // Contract ABI (minimal for monitoring)
    this.contractAbi = [
      "function getBankStats() external view returns (address owner, uint96 totalDeposits, uint32 totalUsers, bool emergencyMode, uint256 contractBalance)",
      "function getMyBalance() public view returns (uint256)",
      "event Deposit(address indexed user, uint256 amount, uint256 newBalance, uint256 indexed timestamp, uint256 indexed transactionId)",
      "event Withdrawal(address indexed user, uint256 amount, uint256 newBalance, uint256 indexed timestamp, uint256 indexed transactionId)",
      "event Transfer(address indexed from, address indexed to, uint256 amount, uint256 indexed timestamp, uint256 transactionId)",
      "event LargeTransactionAlert(address indexed user, uint256 amount, string operation)"
    ];
    
    this.contract = new ethers.Contract(this.contractAddress, this.contractAbi, this.provider);
    
    console.log("🎧 Simple Bank Monitor initialized");
    console.log(`📍 Monitoring contract: ${this.contractAddress}`);
    console.log(`📡 Network: Sepolia`);
  }

  // Monitor basic contract health
  async checkContractHealth() {
    try {
      console.log("\n🏥 Checking contract health...");
      
      const bankStats = await this.contract.getBankStats();
      const blockNumber = await this.provider.getBlockNumber();
      const balance = await this.provider.getBalance(this.contractAddress);
      
      const healthReport = {
        timestamp: new Date().toISOString(),
        blockNumber: blockNumber,
        contractBalance: ethers.formatEther(balance),
        totalDeposits: ethers.formatEther(bankStats.totalDeposits),
        totalUsers: Number(bankStats.totalUsers),
        emergencyMode: bankStats.emergencyMode,
        owner: bankStats.owner,
        status: bankStats.emergencyMode ? "⚠️ EMERGENCY" : "✅ HEALTHY"
      };
      
      console.log("📊 Contract Health Report:");
      console.log(`   Status: ${healthReport.status}`);
      console.log(`   Block: ${healthReport.blockNumber}`);
      console.log(`   Contract Balance: ${healthReport.contractBalance} ETH`);
      console.log(`   Total Deposits: ${healthReport.totalDeposits} ETH`);
      console.log(`   Active Users: ${healthReport.totalUsers}`);
      console.log(`   Emergency Mode: ${healthReport.emergencyMode}`);
      
      // Alert conditions
      if (bankStats.emergencyMode) {
        await this.sendAlert("🚨 EMERGENCY MODE ACTIVATED", healthReport);
      }
      
      if (Number(bankStats.totalUsers) > 100) {
        await this.sendAlert("📈 USER MILESTONE: 100+ users reached", healthReport);
      }
      
      return healthReport;
      
    } catch (error) {
      console.error("❌ Health check failed:", error.message);
      await this.sendAlert("🔴 CONTRACT HEALTH CHECK FAILED", { error: error.message });
      return null;
    }
  }

  // Monitor recent transactions using Etherscan API
  async checkRecentTransactions() {
    try {
      console.log("\n📊 Checking recent transactions...");
      
      const response = await axios.get('https://api-sepolia.etherscan.io/api', {
        params: {
          module: 'account',
          action: 'txlist',
          address: this.contractAddress,
          startblock: 0,
          endblock: 99999999,
          page: 1,
          offset: 10,
          sort: 'desc',
          apikey: this.etherscanApiKey
        }
      });

      if (response.data.status === '1') {
        const transactions = response.data.result;
        
        console.log(`📋 Found ${transactions.length} recent transactions`);
        
        // Analyze transactions
        let totalVolume = 0n;
        let largeTransactions = 0;
        const oneEth = ethers.parseEther("1.0");
        
        transactions.forEach((tx, index) => {
          const value = BigInt(tx.value);
          totalVolume += value;
          
          if (value >= oneEth) {
            largeTransactions++;
            console.log(`   🚨 Large transaction #${index + 1}: ${ethers.formatEther(value)} ETH`);
          }
        });
        
        console.log(`📊 Transaction Analysis:`);
        console.log(`   Total Volume: ${ethers.formatEther(totalVolume)} ETH`);
        console.log(`   Large Transactions (>1 ETH): ${largeTransactions}`);
        
        // Alert for unusual activity
        if (largeTransactions > 3) {
          await this.sendAlert("⚠️ HIGH VOLUME ACTIVITY", {
            largeTransactions,
            totalVolume: ethers.formatEther(totalVolume)
          });
        }
        
        return {
          totalTransactions: transactions.length,
          totalVolume: ethers.formatEther(totalVolume),
          largeTransactions
        };
        
      } else {
        console.log("⚠️ No transactions found or API error");
        return null;
      }
      
    } catch (error) {
      console.error("❌ Transaction monitoring failed:", error.message);
      return null;
    }
  }

  // Listen for real-time events
  startEventListener() {
    console.log("\n🎧 Starting real-time event monitoring...");
    
    // Listen for deposits
    this.contract.on("Deposit", (user, amount, newBalance, timestamp, transactionId) => {
      const formattedAmount = ethers.formatEther(amount);
      console.log(`💰 DEPOSIT: ${user} deposited ${formattedAmount} ETH`);
      
      if (amount >= ethers.parseEther("1.0")) {
        this.sendAlert("💰 LARGE DEPOSIT DETECTED", {
          user,
          amount: formattedAmount,
          transactionId: Number(transactionId)
        });
      }
    });
    
    // Listen for withdrawals
    this.contract.on("Withdrawal", (user, amount, newBalance, timestamp, transactionId) => {
      const formattedAmount = ethers.formatEther(amount);
      console.log(`🏧 WITHDRAWAL: ${user} withdrew ${formattedAmount} ETH`);
      
      if (amount >= ethers.parseEther("1.0")) {
        this.sendAlert("🏧 LARGE WITHDRAWAL DETECTED", {
          user,
          amount: formattedAmount,
          transactionId: Number(transactionId)
        });
      }
    });
    
    // Listen for transfers
    this.contract.on("Transfer", (from, to, amount, timestamp, transactionId) => {
      const formattedAmount = ethers.formatEther(amount);
      console.log(`🔄 TRANSFER: ${from} → ${to} (${formattedAmount} ETH)`);
    });
    
    // Listen for large transaction alerts
    this.contract.on("LargeTransactionAlert", (user, amount, operation) => {
      const formattedAmount = ethers.formatEther(amount);
      console.log(`🚨 LARGE TRANSACTION ALERT: ${operation} of ${formattedAmount} ETH by ${user}`);
      
      this.sendAlert("🚨 AUTOMATIC LARGE TRANSACTION ALERT", {
        user,
        amount: formattedAmount,
        operation
      });
    });
    
    console.log("✅ Event listeners active");
  }

  // Send alerts (webhook/email simulation)
  async sendAlert(title, data) {
    const alert = {
      timestamp: new Date().toISOString(),
      contract: this.contractAddress,
      network: "sepolia",
      title: title,
      data: data
    };
    
    console.log(`\n🚨 ALERT: ${title}`);
    console.log(`📋 Details:`, JSON.stringify(data, null, 2));
    
    // In a real implementation, you would send to:
    // - Slack webhook
    // - Discord webhook  
    // - Email service (SendGrid, etc.)
    // - PagerDuty
    // - Custom monitoring dashboard
    
    // For now, just log to console
    console.log("📤 Alert logged (would notify external systems)");
    
    return alert;
  }

  // Run comprehensive monitoring cycle
  async runMonitoringCycle() {
    console.log("\n🔄 Running monitoring cycle...");
    console.log("=====================================");
    
    const healthReport = await this.checkContractHealth();
    const transactionReport = await this.checkRecentTransactions();
    
    const monitoringReport = {
      timestamp: new Date().toISOString(),
      health: healthReport,
      transactions: transactionReport,
      status: healthReport ? "✅ OPERATIONAL" : "❌ ISSUES DETECTED"
    };
    
    console.log(`\n📋 Monitoring Summary: ${monitoringReport.status}`);
    
    return monitoringReport;
  }

  // Continuous monitoring (runs every 5 minutes)
  startContinuousMonitoring() {
    console.log("🎯 Starting continuous monitoring (5-minute intervals)...");
    
    // Initial check
    this.runMonitoringCycle();
    
    // Start event listening
    this.startEventListener();
    
    // Schedule periodic checks
    setInterval(async () => {
      await this.runMonitoringCycle();
    }, 5 * 60 * 1000); // 5 minutes
    
    console.log("✅ Continuous monitoring active");
  }
}

// Usage example
async function main() {
  const monitor = new SimpleBankMonitor();
  
  // Run one-time monitoring report
  console.log("🚀 Simple Bank v2.1 Monitoring System");
  console.log("=====================================");
  
  await monitor.runMonitoringCycle();
  
  // For continuous monitoring, uncomment:
  // monitor.startContinuousMonitoring();
  
  console.log("\n✅ Monitoring complete!");
  console.log("🔗 Check your contract: https://sepolia.etherscan.io/address/0x9FFF42a6d78344D635e100EeEA5EFdd8ED8CDfF8");
}

// Run monitoring
if (require.main === module) {
  main()
    .then(() => console.log("Monitoring script completed"))
    .catch(console.error);
}

module.exports = SimpleBankMonitor;
