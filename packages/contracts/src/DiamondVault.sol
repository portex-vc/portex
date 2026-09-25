// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

/// @notice Diamond Vault (§5.5). Only genesis tokens enter, via Raise.claim(k, stake=true).
///         weight = tokens × earlyFactor (1e18-scaled). Rewards use a reward-per-weight
///         accumulator (O(1)) for two assets: quote-asset swap fees during Stage 2, and
///         vaultAlloc tokens streamed linearly over vaultDuration after Stage 3 migration.
///         unstake() permanently removes weight; unstaked tokens can never re-enter (the only
///         entry path is claim with stake=true). Emissions/fees accruing while nothing is staked
///         are not distributed (they remain in the vault).
contract DiamondVault is Initializable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;

    uint256 internal constant SCALE = 1e36;
    uint256 internal constant FACTOR_SCALE = 1e18;

    address public raise;
    address public pool; // the only caller allowed to notify quote rewards
    IERC20 public token;
    IERC20 public quote;
    uint64 public vaultDuration;

    uint256 public totalWeight;
    uint256 public totalStaked;

    // Quote fee rewards (notified by the pool during Stage 2).
    uint256 public accQuotePerWeight;
    uint256 public queuedQuote; // fees received while totalWeight == 0; flushed on next accrual
    uint256 public accountedQuote; // quote already credited to the reward system, not yet claimed

    // Token streaming (starts at migration).
    uint64 public migrationTime;
    uint64 public lastTokenUpdate;
    uint256 public tokenRewardRate; // vaultAlloc / vaultDuration, tokens per second
    uint256 public accTokenPerWeight;

    struct UserStake {
        uint256 staked;
        uint256 weight;
        uint256 quoteDebt;
        uint256 tokenDebt;
        uint256 quoteCredit;
        uint256 tokenCredit;
    }

    mapping(address user => UserStake) internal stakes;

    event Staked(address indexed user, uint256 amount, uint256 weight, uint256 totalWeight);
    event Unstaked(address indexed user, uint256 amount, uint256 weight, uint256 totalWeight);
    event RewardsClaimed(address indexed user, uint256 quoteAmount, uint256 tokenAmount);
    event QuoteFeeReceived(uint256 amount, uint256 accQuotePerWeight, uint256 queuedQuote);
    event MigrationStarted(uint64 migrationTime, uint64 vaultDuration, uint256 tokenRewardRate);

    error OnlyRaise();
    error OnlyPool();
    error ZeroAmount();
    error InsufficientStake();
    error NothingToClaim();

    modifier onlyRaise() {
        if (msg.sender != raise) revert OnlyRaise();
        _;
    }

    modifier onlyPool() {
        if (msg.sender != pool) revert OnlyPool();
        _;
    }

    constructor() {
        _disableInitializers();
    }

    function initialize(address raise_, address token_, address quote_, uint64 vaultDuration_, address pool_)
        external
        initializer
    {
        __ReentrancyGuard_init();
        raise = raise_;
        pool = pool_;
        token = IERC20(token_);
        quote = IERC20(quote_);
        vaultDuration = vaultDuration_;
    }

    /// @notice Entry point for genesis tokens; called by the raise as part of claim(k, true).
    ///         The raise transfers the tokens to the vault before calling this.
    function stake(address user, uint256 amount, uint256 earlyFactor) external onlyRaise nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _accrueTokenStream();
        _flushQuoteQueue();
        _settle(user);
        uint256 w = (amount * earlyFactor) / FACTOR_SCALE;
        UserStake storage s = stakes[user];
        s.staked += amount;
        s.weight += w;
        totalStaked += amount;
        totalWeight += w;
        _updateDebts(user);
        emit Staked(user, amount, w, totalWeight);
    }

    /// @notice Sends `amount` tokens to the caller's wallet and permanently removes that weight.
    function unstake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        UserStake storage s = stakes[msg.sender];
        if (amount > s.staked) revert InsufficientStake();
        _accrueTokenStream();
        _settle(msg.sender);
        uint256 w = amount == s.staked ? s.weight : (amount * s.weight) / s.staked;
        s.staked -= amount;
        s.weight -= w;
        totalStaked -= amount;
        totalWeight -= w;
        _updateDebts(msg.sender);
        token.safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount, w, totalWeight);
    }

    /// @notice Pay out accrued quote and token rewards.
    function claimRewards() external nonReentrant {
        _accrueTokenStream();
        _settle(msg.sender);
        UserStake storage s = stakes[msg.sender];
        uint256 q = s.quoteCredit;
        uint256 t = s.tokenCredit;
        if (q == 0 && t == 0) revert NothingToClaim();
        s.quoteCredit = 0;
        s.tokenCredit = 0;
        _updateDebts(msg.sender);
        if (q > 0) {
            accountedQuote -= q; // credited-but-unclaimed quote leaves the vault
            quote.safeTransfer(msg.sender, q);
        }
        if (t > 0) token.safeTransfer(msg.sender, t);
        emit RewardsClaimed(msg.sender, q, t);
    }

    /// @notice Quote fee share from the pool. The pool transfers the quote before calling this.
    ///         Accounting is capped by both the balance delta and the declared amount:
    ///         `received = min(amount, balance − accountedQuote)` — no caller can ever credit
    ///         more quote than actually arrived, and an unrequested surplus (e.g. a huge direct
    ///         transfer, audit H-01 residual) stays unaccounted instead of entering the
    ///         accumulator uncontrolled. Such a surplus is never lost and never explosive: it can
    ///         only be credited across later notifications, each bounded by its declared amount
    ///         (the pool declares exactly what it sends, so unrequested surplus simply remains in
    ///         the vault, undistributed). The accumulator increment uses `Math.mulDiv`, so a
    ///         legitimately large credit cannot overflow the intermediate product.
    function notifyQuoteReward(uint256 amount) external onlyPool {
        uint256 bal = quote.balanceOf(address(this));
        uint256 delta = bal > accountedQuote ? bal - accountedQuote : 0;
        uint256 received = amount < delta ? amount : delta;
        if (received == 0) return;
        accountedQuote += received;
        if (totalWeight > 0) {
            accQuotePerWeight += Math.mulDiv(queuedQuote + received, SCALE, totalWeight);
            queuedQuote = 0;
        } else {
            queuedQuote += received;
        }
        emit QuoteFeeReceived(received, accQuotePerWeight, queuedQuote);
    }

    /// @notice Starts the linear vaultAlloc token stream. Called by the raise at migration.
    function notifyMigration(uint256 vaultAlloc) external onlyRaise {
        if (migrationTime == 0) {
            migrationTime = uint64(block.timestamp);
            lastTokenUpdate = uint64(block.timestamp);
            tokenRewardRate = vaultAlloc / vaultDuration;
            emit MigrationStarted(migrationTime, vaultDuration, tokenRewardRate);
        }
    }

    // ---------------- views ----------------

    function stakeOf(address user) external view returns (uint256 staked, uint256 weight) {
        UserStake storage s = stakes[user];
        return (s.staked, s.weight);
    }

    function pendingQuote(address user) public view returns (uint256) {
        UserStake storage s = stakes[user];
        return s.quoteCredit + (s.weight * (accQuotePerWeight - s.quoteDebt)) / SCALE;
    }

    function pendingToken(address user) public view returns (uint256) {
        UserStake storage s = stakes[user];
        return s.tokenCredit + (s.weight * (_projectedAccToken() - s.tokenDebt)) / SCALE;
    }

    function pendingRewards(address user) external view returns (uint256 quoteAmount, uint256 tokenAmount) {
        return (pendingQuote(user), pendingToken(user));
    }

    function tokenStreamEnd() external view returns (uint64) {
        return migrationTime + vaultDuration;
    }

    // ---------------- internals ----------------

    /// @dev Fold any queued fees into the accumulator once weight exists. Called before a new
    ///      stake's weight is added, so pre-stake fees go to already-staked users only.
    function _flushQuoteQueue() internal {
        if (queuedQuote > 0 && totalWeight > 0) {
            accQuotePerWeight += Math.mulDiv(queuedQuote, SCALE, totalWeight);
            queuedQuote = 0;
        }
    }

    function _projectedAccToken() internal view returns (uint256) {
        if (migrationTime == 0) return accTokenPerWeight;
        uint64 end = migrationTime + vaultDuration;
        uint64 t = block.timestamp >= end ? end : uint64(block.timestamp);
        if (t <= lastTokenUpdate) return accTokenPerWeight;
        if (totalWeight == 0) return accTokenPerWeight;
        return accTokenPerWeight + (tokenRewardRate * (t - lastTokenUpdate) * SCALE) / totalWeight;
    }

    function _accrueTokenStream() internal {
        if (migrationTime == 0) return;
        uint64 end = migrationTime + vaultDuration;
        uint64 t = block.timestamp >= end ? end : uint64(block.timestamp);
        if (t <= lastTokenUpdate) return;
        if (totalWeight > 0) {
            accTokenPerWeight += (tokenRewardRate * (t - lastTokenUpdate) * SCALE) / totalWeight;
        }
        // Emissions while nothing is staked are skipped and remain in the vault.
        lastTokenUpdate = t;
    }

    /// @dev Move a user's earned-but-unaccounted rewards into their credit balances.
    function _settle(address user) internal {
        UserStake storage s = stakes[user];
        if (s.weight > 0) {
            s.quoteCredit += (s.weight * (accQuotePerWeight - s.quoteDebt)) / SCALE;
            s.tokenCredit += (s.weight * (accTokenPerWeight - s.tokenDebt)) / SCALE;
        }
    }

    function _updateDebts(address user) internal {
        UserStake storage s = stakes[user];
        s.quoteDebt = accQuotePerWeight;
        s.tokenDebt = accTokenPerWeight;
    }
}
