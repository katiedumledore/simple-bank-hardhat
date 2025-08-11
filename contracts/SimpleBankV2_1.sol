// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

// ===== SECURITY IMPORTS =====
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

// ===== CHAINLINK ORACLE IMPORT =====
import "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

contract SimpleBankV2_1 is Initializable, ReentrancyGuardUpgradeable, AccessControlUpgradeable, PausableUpgradeable {
    
    // ===== CUSTOM ERRORS (Gas Efficient) =====
    error InsufficientBalance(uint256 requested, uint256 available);
    error InvalidAmount(uint256 amount);
    error StaleOracleData(uint256 lastUpdate, uint256 maxAge);
    error UnauthorizedAccess(address caller, bytes32 requiredRole);
    error InvalidIPFSHash(string hash);
    error MaxReceiptsExceeded(uint256 current, uint256 maximum);
    error InvalidRecipient(address recipient);
    error TransferToSelf();
    
    // ===== ROLE-BASED ACCESS CONTROL =====
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant AUDITOR_ROLE = keccak256("AUDITOR_ROLE");
    
    // ===== CHAINLINK ORACLE =====
    AggregatorV3Interface internal priceFeed;
    
    // ===== SECURITY CONSTANTS =====
    uint256 public constant MAX_RECEIPTS_PER_USER = 50;  // DoS prevention
    uint256 public constant MIN_REVEAL_TIME = 1 minutes; // Front-running protection
    uint256 public constant MAX_ORACLE_STALENESS = 3600; // 1 hour
    uint256 public constant LARGE_TRANSACTION_THRESHOLD = 1 ether;
    
    // ===== DATA STRUCTURES =====
    
    struct BankInfo {
        address owner;              
        uint96 totalDeposits;       
        uint32 totalUsers;          
        bool emergencyMode;         
    }
    
    struct UserAccount {
        uint128 balance;            
        uint64 lastActivity;        
        uint32 transactionCount;    
        uint32 accountCreated;      
        bool isActive;              
    }
    
    struct Transaction {
        uint64 timestamp;           
        uint128 amount;             
        uint32 transactionType;     
        uint32 blockNumber;         
    }
    
    struct IPFSData {
        string profileHash;         
        string[] transactionReceipts;
        uint256 lastUpdated;       
        bool hasProfile;           
    }
    
    // ===== FRONT-RUNNING PROTECTION =====
    struct Commitment {
        bytes32 commitHash;
        uint256 timestamp;
        bool revealed;
    }
    
    mapping(address => Commitment) private withdrawalCommitments;
    
    // ===== STATE VARIABLES =====
    
    BankInfo public bankInfo;
    mapping(address => UserAccount) public accounts;
    mapping(address => Transaction[10]) public recentTransactions;
    mapping(address => uint256) public transactionIndex;
    mapping(address => IPFSData) public userIPFSData;
    
    uint256 public globalTransactionId;
    
    // Transaction type constants
    uint32 constant DEPOSIT = 0;
    uint32 constant WITHDRAWAL = 1;
    uint32 constant TRANSFER = 2;
    
    // ===== EVENTS =====
    
    event Deposit(address indexed user, uint256 amount, uint256 newBalance, uint256 indexed timestamp, uint256 indexed transactionId);
    event Withdrawal(address indexed user, uint256 amount, uint256 newBalance, uint256 indexed timestamp, uint256 indexed transactionId);
    event Transfer(address indexed from, address indexed to, uint256 amount, uint256 indexed timestamp, uint256 transactionId);
    event AccountCreated(address indexed user, uint256 indexed timestamp);
    event EmergencyModeToggled(bool enabled, uint256 timestamp);
    event LargeTransactionAlert(address indexed user, uint256 amount, string operation);
    
    // Security events
    event SecurityIncident(address indexed user, string incidentType, uint256 timestamp);
    
    // Oracle & IPFS events
    event ETHPriceRetrieved(int256 price, uint256 timestamp);
    event InterestCalculated(address indexed user, uint256 interest, uint256 timestamp);
    event UserProfileUpdated(address indexed user, string ipfsHash, uint256 timestamp);
    event TransactionReceiptAdded(address indexed user, string ipfsHash, uint256 timestamp);
    
    // Front-running protection events
    event WithdrawalCommitted(address indexed user, bytes32 commitment, uint256 timestamp);
    event WithdrawalRevealed(address indexed user, uint256 amount, uint256 timestamp);
    
    // ===== MODIFIERS =====
    
    modifier onlyAdmin() {
        if (!hasRole(ADMIN_ROLE, msg.sender)) {
            revert UnauthorizedAccess(msg.sender, ADMIN_ROLE);
        }
        _;
    }
    
    modifier onlyOperator() {
        if (!hasRole(OPERATOR_ROLE, msg.sender) && !hasRole(ADMIN_ROLE, msg.sender)) {
            revert UnauthorizedAccess(msg.sender, OPERATOR_ROLE);
        }
        _;
    }
    
    modifier validAmount(uint256 _amount) {
        if (_amount == 0 || _amount > type(uint128).max) {
            revert InvalidAmount(_amount);
        }
        _;
    }
    
    modifier hasSufficientBalance(uint256 _amount) {
        if (accounts[msg.sender].balance < _amount) {
            revert InsufficientBalance(_amount, accounts[msg.sender].balance);
        }
        _;
    }
    
    modifier validIPFSHash(string memory _hash) {
        if (bytes(_hash).length == 0) {
            revert InvalidIPFSHash(_hash);
        }
        _;
    }
    
    modifier receiptsNotExceeded() {
        if (userIPFSData[msg.sender].transactionReceipts.length >= MAX_RECEIPTS_PER_USER) {
            revert MaxReceiptsExceeded(
                userIPFSData[msg.sender].transactionReceipts.length, 
                MAX_RECEIPTS_PER_USER
            );
        }
        _;
    }
    
    // ===== INITIALIZATION (instead of constructor for upgradeable) =====
    
    function initialize() public initializer {
        __ReentrancyGuard_init();
        __AccessControl_init();
        __Pausable_init();
        
        // Initialize roles
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ADMIN_ROLE, msg.sender);
        _grantRole(OPERATOR_ROLE, msg.sender);
        _grantRole(AUDITOR_ROLE, msg.sender);
        
        // Initialize bank info
        bankInfo = BankInfo({
            owner: msg.sender,
            totalDeposits: 0,
            totalUsers: 0,
            emergencyMode: false
        });
        
        globalTransactionId = 1;
        
        // Initialize Chainlink ETH/USD price feed (Ethereum Mainnet)
        priceFeed = AggregatorV3Interface(0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419);
    }
    
    // ===== ORACLE FUNCTIONS (Enhanced Security) =====
    
    function getLatestETHPrice() public view returns (int256 price, uint256 timestamp) {
        (
            , // roundID - unused
            int256 ethPrice,
            , // startedAt - unused
            uint256 timeStamp,
              // answeredInRound - unused
        ) = priceFeed.latestRoundData();
        
        // Enhanced validation
        require(timeStamp > 0, "Round not complete");
        
        if (block.timestamp - timeStamp > MAX_ORACLE_STALENESS) {
            revert StaleOracleData(timeStamp, MAX_ORACLE_STALENESS);
        }
        
        require(ethPrice > 0, "Invalid price data");
        
        return (ethPrice, timeStamp);
    }
    
    function getBalanceInUSD(address _user) public view returns (uint256 usdBalance) {
        uint256 ethBalance = accounts[_user].balance;
        (int256 ethPrice, ) = getLatestETHPrice();
        
        // Overflow protection (built-in Solidity 0.8+)
        return (ethBalance * uint256(ethPrice)) / 1e18;
    }
    
    function calculateInterest(address _user) public view returns (uint256 interest) {
        UserAccount memory account = accounts[_user];
        if (!account.isActive || account.balance == 0) {
            return 0;
        }
        
        (int256 ethPrice, ) = getLatestETHPrice();
        
        // Dynamic interest rate with bounds checking
        uint256 baseRate = 5; // 5% annual base rate
        uint256 bonusRate = uint256(ethPrice) > 2000 * 1e8 ? 2 : 0; // +2% if ETH > $2000
        uint256 totalRate = baseRate + bonusRate;
        
        // Prevent overflow in time calculation
        uint256 timeHeld = block.timestamp - account.lastActivity;
        if (timeHeld > 365 days) {
            timeHeld = 365 days; // Cap at 1 year
        }
        
        return (account.balance * totalRate * timeHeld) / (100 * 365 days);
    }
    
    // ===== IPFS FUNCTIONS (Enhanced Security) =====
    
    function setUserProfile(string memory _ipfsHash) 
        public 
        validIPFSHash(_ipfsHash) 
        whenNotPaused 
    {
        userIPFSData[msg.sender].profileHash = _ipfsHash;
        userIPFSData[msg.sender].lastUpdated = block.timestamp;
        userIPFSData[msg.sender].hasProfile = true;
        
        emit UserProfileUpdated(msg.sender, _ipfsHash, block.timestamp);
    }
    
    function addTransactionReceipt(string memory _ipfsHash) 
        public 
        validIPFSHash(_ipfsHash) 
        receiptsNotExceeded 
        whenNotPaused 
    {
        userIPFSData[msg.sender].transactionReceipts.push(_ipfsHash);
        userIPFSData[msg.sender].lastUpdated = block.timestamp;
        
        emit TransactionReceiptAdded(msg.sender, _ipfsHash, block.timestamp);
    }
    
    function getUserProfile(address _user) public view returns (
        string memory profileHash,
        uint256 lastUpdated,
        bool hasProfile
    ) {
        IPFSData memory data = userIPFSData[_user];
        return (data.profileHash, data.lastUpdated, data.hasProfile);
    }
    
    function getTransactionReceipts(address _user) public view returns (string[] memory) {
        return userIPFSData[_user].transactionReceipts;
    }
    
    function getReceiptCount(address _user) public view returns (uint256) {
        return userIPFSData[_user].transactionReceipts.length;
    }
    
    // ===== CORE BANKING FUNCTIONS (Secure) =====
    
    function deposit() 
        public 
        payable 
        validAmount(msg.value) 
        nonReentrant 
        whenNotPaused 
    {
        UserAccount memory userAccount = accounts[msg.sender];
        bool isNewUser = !userAccount.isActive;
        
        // Effects first (CEI pattern)
        userAccount.balance += uint128(msg.value);
        userAccount.lastActivity = uint64(block.timestamp);
        userAccount.transactionCount++;
        userAccount.isActive = true;
        
        if (isNewUser) {
            userAccount.accountCreated = uint32(block.timestamp);
            bankInfo.totalUsers++;
            emit AccountCreated(msg.sender, block.timestamp);
        }
        
        accounts[msg.sender] = userAccount;
        bankInfo.totalDeposits += uint96(msg.value);
        
        _recordTransaction(msg.sender, uint128(msg.value), DEPOSIT);
        
        emit Deposit(msg.sender, msg.value, userAccount.balance, block.timestamp, globalTransactionId);
        
        if (msg.value >= LARGE_TRANSACTION_THRESHOLD) {
            emit LargeTransactionAlert(msg.sender, msg.value, "deposit");
        }
        
        globalTransactionId++;
    }
    
    function withdraw(uint256 _amount) 
        public 
        validAmount(_amount) 
        hasSufficientBalance(_amount) 
        nonReentrant 
        whenNotPaused 
    {
        _executeWithdrawal(_amount);
    }
    
    function _executeWithdrawal(uint256 _amount) internal {
        UserAccount memory userAccount = accounts[msg.sender];
        
        // Effects first (CEI pattern)
        userAccount.balance -= uint128(_amount);
        userAccount.lastActivity = uint64(block.timestamp);
        userAccount.transactionCount++;
        
        accounts[msg.sender] = userAccount;
        bankInfo.totalDeposits -= uint96(_amount);
        
        _recordTransaction(msg.sender, uint128(_amount), WITHDRAWAL);
        
        // Interaction last
        (bool success, ) = payable(msg.sender).call{value: _amount}("");
        require(success, "Transfer failed");
        
        emit Withdrawal(msg.sender, _amount, userAccount.balance, block.timestamp, globalTransactionId);
        
        if (_amount >= LARGE_TRANSACTION_THRESHOLD) {
            emit LargeTransactionAlert(msg.sender, _amount, "withdrawal");
        }
        
        globalTransactionId++;
    }
    
    function transferTo(address _to, uint256 _amount) 
        public 
        validAmount(_amount) 
        hasSufficientBalance(_amount)
        nonReentrant
        whenNotPaused
    {
        if (_to == address(0)) {
            revert InvalidRecipient(_to);
        }
        if (_to == msg.sender) {
            revert TransferToSelf();
        }
        
        UserAccount memory fromAccount = accounts[msg.sender];
        UserAccount memory toAccount = accounts[_to];
        
        bool isNewRecipient = !toAccount.isActive;
        
        // Effects (CEI pattern)
        fromAccount.balance -= uint128(_amount);
        fromAccount.lastActivity = uint64(block.timestamp);
        fromAccount.transactionCount++;
        
        toAccount.balance += uint128(_amount);
        toAccount.lastActivity = uint64(block.timestamp);
        toAccount.transactionCount++;
        toAccount.isActive = true;
        
        if (isNewRecipient) {
            toAccount.accountCreated = uint32(block.timestamp);
            bankInfo.totalUsers++;
            emit AccountCreated(_to, block.timestamp);
        }
        
        accounts[msg.sender] = fromAccount;
        accounts[_to] = toAccount;
        
        _recordTransaction(msg.sender, uint128(_amount), TRANSFER);
        _recordTransaction(_to, uint128(_amount), TRANSFER);
        
        emit Transfer(msg.sender, _to, _amount, block.timestamp, globalTransactionId);
        
        if (_amount >= LARGE_TRANSACTION_THRESHOLD) {
            emit LargeTransactionAlert(msg.sender, _amount, "transfer");
        }
        
        globalTransactionId++;
    }
    
    // ===== VIEW FUNCTIONS =====
    
    function getMyBalance() public view returns (uint256) {
        return accounts[msg.sender].balance;
    }
    
    function getUserStats(address _user) external view returns (
        uint128 balance,
        uint64 lastActivity,
        uint32 transactionCount,
        uint32 accountCreated,
        bool isActive,
        uint256 accountAge
    ) {
        UserAccount memory account = accounts[_user];
        return (
            account.balance,
            account.lastActivity,
            account.transactionCount,
            account.accountCreated,
            account.isActive,
            account.accountCreated > 0 ? block.timestamp - account.accountCreated : 0
        );
    }
    
    function getBankStats() external view returns (
        address owner,
        uint96 totalDeposits,
        uint32 totalUsers,
        bool emergencyMode,
        uint256 contractBalance
    ) {
        return (
            bankInfo.owner,
            bankInfo.totalDeposits,
            bankInfo.totalUsers,
            bankInfo.emergencyMode,
            address(this).balance
        );
    }
    
    function getRecentTransactions(address _user) external view returns (Transaction[10] memory) {
        return recentTransactions[_user];
    }
    
    // ===== ADMIN FUNCTIONS =====
    
    function pause() external onlyAdmin {
        _pause();
    }
    
    function unpause() external onlyAdmin {
        _unpause();
    }
    
    function toggleEmergencyMode() external onlyAdmin {
        bankInfo.emergencyMode = !bankInfo.emergencyMode;
        emit EmergencyModeToggled(bankInfo.emergencyMode, block.timestamp);
    }
    
    function emergencyWithdraw() external onlyAdmin whenPaused {
        require(address(this).balance > 0, "No funds to withdraw");
        (bool success, ) = payable(bankInfo.owner).call{value: address(this).balance}("");
        require(success, "Emergency withdrawal failed");
    }
    
    function grantOperatorRole(address _operator) external onlyAdmin {
        grantRole(OPERATOR_ROLE, _operator);
    }
    
    function grantAuditorRole(address _auditor) external onlyAdmin {
        grantRole(AUDITOR_ROLE, _auditor);
    }
    
    // ===== INTERNAL FUNCTIONS =====
    
    function _recordTransaction(address _user, uint128 _amount, uint32 _type) internal {
        uint256 index = transactionIndex[_user] % 10;
        
        recentTransactions[_user][index] = Transaction({
            timestamp: uint64(block.timestamp),
            amount: _amount,
            transactionType: _type,
            blockNumber: uint32(block.number)
        });
        
        transactionIndex[_user]++;
    }
    
    // ===== RECEIVE FUNCTION =====
    
    receive() external payable {
        if (msg.value > 0 && !paused()) {
            UserAccount storage userAccount = accounts[msg.sender];
            bool isNewUser = !userAccount.isActive;
            
            userAccount.balance += uint128(msg.value);
            userAccount.lastActivity = uint64(block.timestamp);
            userAccount.transactionCount++;
            userAccount.isActive = true;
            
            if (isNewUser) {
                userAccount.accountCreated = uint32(block.timestamp);
                bankInfo.totalUsers++;
                emit AccountCreated(msg.sender, block.timestamp);
            }
            
            bankInfo.totalDeposits += uint96(msg.value);
            _recordTransaction(msg.sender, uint128(msg.value), DEPOSIT);
            
            emit Deposit(msg.sender, msg.value, userAccount.balance, block.timestamp, globalTransactionId++);
        }
    }
}