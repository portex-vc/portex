// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {RaiseConfig, CommitmentGates, GraduationGates} from "./libraries/PortexTypes.sol";
import {TrancheLib} from "./libraries/TrancheLib.sol";
import {Stage2Pool} from "./Stage2Pool.sol";
import {DiamondVault} from "./DiamondVault.sol";
import {ProjectToken} from "./ProjectToken.sol";
import {AttestationBoard} from "./AttestationBoard.sol";

/// @dev Minimal view of the Rule 2 SpendGovernor (declared here to avoid an import cycle;
///      SpendGovernor imports Raise). Only used when `governor != address(0)`.
interface ISpendGovernorHook {
    function proposalInFlight() external view returns (bool);
    function depositsPaused() external view returns (bool);
}

/// @notice One raise: lifecycle, escrow, tranches (§5.1–§5.4). Deployed as an EIP-1167 clone
///         pinned to a registry version. Principal is tracked as shares × index (index starts at
///         1e27 and never moves under Rule 1). The flat price b is never stored as a ratio;
///         entitlements and pool initialisation are derived with full-precision mulDiv on
///         (A1, commitPrincipalTotal, T0). All rounding favours the protocol/pool.
contract Raise is Initializable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;
    using Math for uint256;

    uint256 public constant INDEX_SCALE = 1e27;
    uint256 public constant FACTOR_SCALE = 1e18;
    uint256 public constant BPS = 10_000;

    enum State {
        Incubation,
        Commitment,
        Growth,
        Migrated,
        Failed
    }

    /// @dev 2 bits per tranche inside a uint64 bitmap (numTranches ≤ 32).
    uint8 internal constant TS_LOCKED = 0;
    uint8 internal constant TS_COMMITTED = 1;
    uint8 internal constant TS_CLAIMED = 2;
    uint8 internal constant TS_REDEEMED = 3;

    // ---- configuration (fixed at creation) ----
    RaiseConfig internal cfg;
    address public builder;
    address public factory;
    address public governor; // address(0) under ZERO_EXTRACTION: governor hooks unreachable
    ProjectToken public token;
    Stage2Pool public pool;
    DiamondVault public vault;
    AttestationBoard public board;

    // ---- lifecycle ----
    State public state;
    uint64 public start; // creation timestamp
    uint64 public commitmentStart; // startCommitment timestamp
    uint64 public growthStart; // openGrowth timestamp
    uint64 public migrationTime; // graduate timestamp

    // ---- escrow accounting (principal = shares × index / INDEX_SCALE) ----
    uint256 public totalShares;
    uint256 public index; // starts at INDEX_SCALE; only governorSpend can lower it
    uint256 public peakPrincipal; // high-water mark of total principal (governor ceiling)
    uint256 public cumulativeSpend; // governor spend so far

    // ---- commitment / growth ----
    uint256 public commitPrincipalTotal; // P_tot snapshot at startCommitment
    uint256 public committedPrincipal; // principal committed so far (escrow → pool)
    uint256 public totalTranche1Principal; // eligible tranche-1 principal (snapshot at startCommitment; tranche-1 redeems subtract)
    uint256 public redeemedPrincipal; // informational: principal redeemed via tranches
    uint256 public builderClaimed; // builder allocation already paid out

    // ---- per-user ----
    mapping(address => uint256) public sharesOf;
    mapping(address => uint256) public timeWeightOf;
    mapping(address => uint256) internal principalAtCommit; // lazy snapshot at startCommitment
    mapping(address => uint256) internal sharesAtCommit; // lazy share snapshot (early-factor base)
    mapping(address => uint256) internal earlyFactorCached; // 1e18-scaled, lazy
    mapping(address => uint64) internal trancheStates; // 2 bits per tranche
    mapping(address => uint64[32]) internal commitTimes; // per-tranche commit timestamps
    mapping(address => uint64) public withdrawLockUntil; // governor hook (Rule 2 dispute window)

    // ---- events ----
    event Deposited(address indexed user, uint256 amount, uint256 shares, uint256 totalPrincipal);
    event Withdrawn(address indexed user, uint256 amount, uint256 shares, uint256 totalPrincipal);
    event CommitmentStarted(uint256 totalPrincipal, uint256 stage1Alloc, uint64 commitmentStart, uint64 commitmentEnd);
    event RaiseFailed(uint8 indexed reason, uint256 totalPrincipal); // 0 = deadline, 1 = cancel, 2 = opt-in
    event GrowthOpened(uint64 growthStart, uint256 committedPrincipal, uint256 V0, uint256 T0);
    event Migrated(uint64 migrationTime, uint256 quoteSeeded, uint256 tokensSeeded);
    event TrancheCommitted(address indexed user, uint8 indexed k, uint256 principal, uint256 epoch);
    event TrancheClaimed(address indexed user, uint8 indexed k, uint256 tokens, bool staked);
    event TrancheRedeemed(address indexed user, uint8 indexed k, uint256 principal, uint256 tokensBurned);
    event GovernorSpend(address indexed to, uint256 amount, uint256 newIndex, uint256 cumulativeSpend);
    event WithdrawLockSet(address indexed user, uint64 until);
    event BuilderVestedClaimed(address indexed builder, uint256 amount);

    // ---- errors ----
    error InvalidState();
    error OnlyBuilder();
    error OnlyGovernor();
    error ZeroAmount();
    error ZeroAddress();
    error DeadlinePassed();
    error DeadlineNotPassed();
    error MinIncubationNotMet();
    error SoftCapNotReached();
    error VetoActive();
    error HardCapExceeded();
    error InsufficientPrincipal();
    error WithdrawLocked();
    error InvalidTranche();
    error TrancheNotLocked();
    error TrancheNotCommitted();
    error EpochNotReached();
    error CommitmentWindowEnded();
    error CommitmentWindowNotEnded();
    error NotClaimable();
    error GraduationNotReady();
    error NothingToClaim();
    error SpendCeilingExceeded();
    error ProposalInFlight();
    error DepositsPaused();

    modifier onlyBuilder() {
        if (msg.sender != builder) revert OnlyBuilder();
        _;
    }

    constructor() {
        _disableInitializers();
    }

    /// @notice Called once by the factory, atomically with cloning. (Split from `wire` because the
    ///         ABI decoder for a 25-field calldata struct plus 7 addresses overflows the legacy
    ///         codegen stack; both calls happen in the same factory transaction.)
    function initialize(
        RaiseConfig calldata cfg_,
        address builder_,
        address governor_,
        ProjectToken token_,
        Stage2Pool pool_,
        DiamondVault vault_
    ) external initializer {
        __ReentrancyGuard_init();
        cfg = cfg_;
        builder = builder_;
        governor = governor_;
        token = token_;
        pool = pool_;
        vault = vault_;
        state = State.Incubation;
        start = uint64(block.timestamp);
        index = INDEX_SCALE;
        // Let the pool pull escrow quote (convert) and inventory tokens (open) from this raise.
        IERC20(cfg_.quoteAsset).approve(address(pool_), type(uint256).max);
        token_.approve(address(pool_), type(uint256).max);
        token_.setPool(address(pool_));
    }

    /// @notice Second half of initialization: board and factory wiring. Called by the factory in
    ///         the same transaction as `initialize` (which is guaranteed by `reinitializer(2)`),
    ///         so `msg.sender` is the factory and no one else can get in between.
    function wire(AttestationBoard board_) external reinitializer(2) {
        board = board_;
        factory = msg.sender;
    }

    // ================= Stage 1 — Incubation (§5.1) =================

    /// @notice Deposit quote asset into escrow. Principal is tracked as shares × index.
    ///         Accrues time weight in share units: timeWeight += newShares × f(t),
    ///         f(t) = 1 + (deadline − t)/deadline ∈ [1,2], so the early factor is index-independent.
    function deposit(uint256 amount) external nonReentrant {
        if (state != State.Incubation) revert InvalidState();
        if (amount == 0) revert ZeroAmount();
        uint64 now_ = uint64(block.timestamp);
        if (now_ >= start + cfg.deadline) revert DeadlinePassed();
        // Rule 2: once voting on a spend has closed, nobody new may join until it is executed,
        // expired or defeated — a depositor who could not vote must never pay for that spend.
        if (governor != address(0) && ISpendGovernorHook(governor).depositsPaused()) revert DepositsPaused();

        uint256 newShares = amount.mulDiv(INDEX_SCALE, index, Math.Rounding.Floor);
        sharesOf[msg.sender] += newShares;
        totalShares += newShares;

        // time weight with FACTOR_SCALE precision; f(t) ∈ [1,2], tracked per share so a
        // governorSpend (which moves the index, never shares) cannot inflate the early factor
        uint256 factor = FACTOR_SCALE + (FACTOR_SCALE * (start + cfg.deadline - now_)) / cfg.deadline;
        timeWeightOf[msg.sender] += (newShares * factor) / FACTOR_SCALE;

        uint256 tp = totalPrincipal();
        if (tp > cfg.hardCap) revert HardCapExceeded();
        if (tp > peakPrincipal) peakPrincipal = tp;

        IERC20(cfg.quoteAsset).safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount, newShares, tp);
    }

    /// @notice Withdraw principal 1:1 in kind, any time in Incubation or Failed.
    ///         Reduces time weight pro rata to the shares burned.
    function withdraw(uint256 amount) external nonReentrant {
        if (state != State.Incubation && state != State.Failed) revert InvalidState();
        if (amount == 0) revert ZeroAmount();
        if (state == State.Incubation && block.timestamp < withdrawLockUntil[msg.sender]) revert WithdrawLocked();

        uint256 pBefore = principalOf(msg.sender);
        if (amount > pBefore) revert InsufficientPrincipal();

        uint256 sharesBurn;
        if (amount == pBefore) {
            sharesBurn = sharesOf[msg.sender];
            timeWeightOf[msg.sender] = 0;
        } else {
            sharesBurn = amount.mulDiv(INDEX_SCALE, index, Math.Rounding.Ceil);
            uint256 tw = timeWeightOf[msg.sender];
            timeWeightOf[msg.sender] = tw - tw.mulDiv(sharesBurn, sharesOf[msg.sender], Math.Rounding.Ceil);
        }
        sharesOf[msg.sender] -= sharesBurn;
        totalShares -= sharesBurn;

        IERC20(cfg.quoteAsset).safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount, sharesBurn, totalPrincipal());
    }

    /// @notice Open epoch 0 (the commitment window). Anyone, once the gates pass:
    ///         now ≥ start + minIncubation, totalPrincipal ≥ softCap, now ≤ deadline, no active veto.
    ///         Closes deposits and fixes the flat price b = totalPrincipal / A1 (never stored;
    ///         derived per use with mulDiv).
    function startCommitment() external nonReentrant {
        if (state != State.Incubation) revert InvalidState();
        uint64 now_ = uint64(block.timestamp);
        if (now_ < start + cfg.minIncubation) revert MinIncubationNotMet();
        if (now_ > start + cfg.deadline) revert DeadlinePassed();
        if (totalPrincipal() < cfg.softCap) revert SoftCapNotReached();
        if (board.vetoActive(address(this))) revert VetoActive();
        // Rule 2: a governor vote always resolves (and a passed spend executes or expires)
        // before the lifecycle moves on — backers entering commitment must know the final index.
        if (governor != address(0) && ISpendGovernorHook(governor).proposalInFlight()) revert ProposalInFlight();

        state = State.Commitment;
        commitmentStart = now_;
        commitPrincipalTotal = totalPrincipal();
        // Opt-in gate denominator: frozen here (global floor; per-user floor dust is irrelevant
        // to a basis-point gate) and only reduced by tranche-1 redeems during Commitment.
        // A running per-deposit tally would go stale when a governor spend moves the index.
        totalTranche1Principal = commitPrincipalTotal / cfg.numTranches;
        emit CommitmentStarted(commitPrincipalTotal, cfg.stage1Alloc, now_, now_ + cfg.commitmentWindow);
    }

    /// @notice Fail the raise after the deadline if the gates were never met. Incubation only:
    ///         once the commitment window is open the outcome is decided solely by openGrowth()
    ///         (the opt-in gate) or by the builder's cancel() — a late deadline can never let a
    ///         third party kill a raise whose gates were legitimately met.
    function fail() external nonReentrant {
        if (state != State.Incubation) revert InvalidState();
        if (block.timestamp <= start + cfg.deadline) revert DeadlineNotPassed();
        _fail(0);
    }

    /// @notice Builder may cancel any time before Stage 2 opens. Everyone withdraws 100%.
    function cancel() external nonReentrant {
        if (msg.sender != builder) revert OnlyBuilder();
        if (state != State.Incubation && state != State.Commitment) revert InvalidState();
        _fail(1);
    }

    // ================= Tranches (§5.2) =================

    /// @notice Commit tranche k (1-indexed): give up its put. Allowed once currentEpoch ≥ k−1
    ///         (epoch 0 = commitment window). Moves the tranche's principal into the pool as real
    ///         reserve (immediately in Growth; batched at openGrowth for epoch-0 commits).
    function commit(uint8 k) external nonReentrant {
        _commit(msg.sender, k);
    }

    /// @notice Commit many tranches by bitmask (bit k−1 = tranche k). Zero-principal tranches
    ///         are skipped; any tranche that cannot be committed reverts the whole call.
    function commitMany(uint256 mask) external nonReentrant {
        uint8 n = cfg.numTranches;
        for (uint8 k = 1; k <= n; ++k) {
            if ((mask >> (k - 1)) & 1 == 1) _commit(msg.sender, k);
        }
    }

    /// @notice Claim a committed tranche's tokens. Epoch-0 commits are claimable at pool opening;
    ///         later commits at commitTime + epochLength. stake=true sends tokens to the vault.
    function claim(uint8 k, bool stake) external nonReentrant {
        _claim(msg.sender, k, stake);
    }

    function claimMany(uint256 mask, bool stake) external nonReentrant {
        uint8 n = cfg.numTranches;
        for (uint8 k = 1; k <= n; ++k) {
            if ((mask >> (k - 1)) & 1 == 1) _claim(msg.sender, k, stake);
        }
    }

    /// @notice Redeem a Locked tranche 1:1 in kind and burn its tokens. Any time, forever
    ///         (even after Stage 3), while the raise is not Failed (in Failed use withdraw).
    function redeem(uint8 k) external nonReentrant {
        _redeem(msg.sender, k);
    }

    function redeemMany(uint256 mask) external nonReentrant {
        uint8 n = cfg.numTranches;
        for (uint8 k = 1; k <= n; ++k) {
            if ((mask >> (k - 1)) & 1 == 1) _redeem(msg.sender, k);
        }
    }

    /// @notice Open the Growth pool. Anyone, after epoch 0 ends. If committed tranche-1 principal
    ///         is below minOptInBps of eligible tranche-1 principal, the raise fails and
    ///         everyone is refunded 100%. Otherwise the pool opens at the Stage 1 price and
    ///         committed principal is converted from virtual to real reserve.
    function openGrowth() external nonReentrant {
        if (state != State.Commitment) revert InvalidState();
        if (block.timestamp < commitmentStart + cfg.commitmentWindow) revert CommitmentWindowNotEnded();

        if (committedPrincipal * BPS < totalTranche1Principal * cfg.minOptInBps) {
            _fail(2);
            return;
        }

        state = State.Growth;
        uint64 now_ = uint64(block.timestamp);
        growthStart = now_;

        // V0 = P_tot·T0/A1 with full precision (floor: favours the pool on solvency).
        uint256 v0 = commitPrincipalTotal.mulDiv(cfg.stage2Inventory, cfg.stage1Alloc, Math.Rounding.Floor);
        pool.open(cfg.stage2Inventory, v0);
        if (committedPrincipal > 0) {
            pool.convert(committedPrincipal);
        }
        // Vault token rewards stream from the vault after migration; hand over the allocation now.
        IERC20(address(token)).safeTransfer(address(vault), cfg.vaultAlloc);

        emit GrowthOpened(now_, committedPrincipal, v0, cfg.stage2Inventory);
    }

    // ================= Stage 3 — Migration (§5.4) =================

    /// @notice Migrate to the DEX. Anyone, once all N epochs have elapsed and the liquidity /
    ///         real-ratio gates pass. If the conditions are not met the pool simply keeps running.
    function graduate() external nonReentrant {
        if (state != State.Growth) revert InvalidState();
        if (block.timestamp < growthStart + uint64(cfg.numTranches) * cfg.epochLength) revert GraduationNotReady();
        (uint256 r,,) = pool.reserves();
        if (r < cfg.minGraduationLiquidity) revert GraduationNotReady();
        if (pool.realRatioBps() < cfg.minRealRatioBps) revert GraduationNotReady();

        (uint256 quoteSeeded, uint256 tokensSeeded) = pool.graduate();
        migrationTime = uint64(block.timestamp);
        state = State.Migrated;
        vault.notifyMigration(cfg.vaultAlloc);
        emit Migrated(migrationTime, quoteSeeded, tokensSeeded);
    }

    /// @notice Pay the builder's vested allocation. Vests linearly over builderVesting from
    ///         migration. Callable by anyone; funds only ever go to the builder.
    function claimBuilderVested() external nonReentrant {
        if (state != State.Migrated) revert InvalidState();
        uint256 vested;
        if (cfg.builderVesting == 0) {
            vested = cfg.builderAlloc;
        } else {
            uint64 elapsed = uint64(block.timestamp) - migrationTime;
            if (elapsed > cfg.builderVesting) elapsed = cfg.builderVesting;
            vested = (cfg.builderAlloc * elapsed) / cfg.builderVesting;
        }
        uint256 amount = vested - builderClaimed;
        if (amount == 0) revert NothingToClaim();
        builderClaimed = vested;
        IERC20(address(token)).safeTransfer(builder, amount);
        emit BuilderVestedClaimed(builder, amount);
    }

    // ================= Governor hooks (Rule 2; unreachable while governor == address(0)) ====

    /// @notice Pay `amount` from escrow to `to` and lower the principal index so every current
    ///         holder pays pro rata. Incubation only. The raise enforces a hard ceiling of
    ///         maxCumulativeSpendBps of peak principal regardless of what the governor says.
    function governorSpend(uint256 amount, address to) external nonReentrant {
        if (msg.sender != governor) revert OnlyGovernor();
        if (state != State.Incubation) revert InvalidState();
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();

        uint256 p = totalPrincipal();
        if (amount > p) revert InsufficientPrincipal();
        uint256 newSpend = cumulativeSpend + amount;
        if (newSpend > (uint256(cfg.maxCumulativeSpendBps) * peakPrincipal) / BPS) revert SpendCeilingExceeded();

        cumulativeSpend = newSpend;
        // index' = index × (P − amount)/P, floored: holders pay the rounding dust, never the protocol.
        index = index.mulDiv(p - amount, p, Math.Rounding.Floor);
        IERC20(cfg.quoteAsset).safeTransfer(to, amount);
        emit GovernorSpend(to, amount, index, newSpend);
    }

    /// @notice Lock a user's withdrawals until `until` (Rule 2 dispute window). The lock is only
    ///         enforced while the raise is in Incubation; Failed raises are always exitable.
    function setWithdrawLock(address user, uint64 until) external {
        if (msg.sender != governor) revert OnlyGovernor();
        withdrawLockUntil[user] = until;
        emit WithdrawLockSet(user, until);
    }

    // ================= Views =================

    function totalPrincipal() public view returns (uint256) {
        return (totalShares * index) / INDEX_SCALE;
    }

    function principalOf(address user) public view returns (uint256) {
        return (sharesOf[user] * index) / INDEX_SCALE;
    }

    /// @notice The principal the escrow must hold right now (§6.1): all principal in
    ///         Incubation/Commitment/Failed; totalPrincipal() − committedPrincipal once the
    ///         pool is open (committed principal has moved into the pool as real reserve).
    ///         Saturating: under a lowered Rule 2 index the per-tranche ceil share burns can push
    ///         committedPrincipal a few wei above totalPrincipal() (audit L-02) — the two sides
    ///         come from different rounding domains, so the view clamps at 0 instead of reverting.
    function escrowedPrincipal() external view returns (uint256) {
        uint256 tp = totalPrincipal();
        if (state == State.Growth || state == State.Migrated) {
            return tp > committedPrincipal ? tp - committedPrincipal : 0;
        }
        return tp;
    }

    function deadlineAt() external view returns (uint64) {
        return start + cfg.deadline;
    }

    function commitmentEnd() public view returns (uint64) {
        return commitmentStart + cfg.commitmentWindow;
    }

    /// @notice Epoch 0 is the commitment window; during Growth epoch = 1 + (now − growthStart)/epochLength.
    function currentEpoch() public view returns (uint256) {
        if (state == State.Growth || state == State.Migrated) {
            return 1 + (block.timestamp - growthStart) / cfg.epochLength;
        }
        return 0;
    }

    /// @notice Aggregate raise state for the UI.
    function raiseInfo()
        external
        view
        returns (
            State state_,
            uint64 start_,
            uint64 commitmentStart_,
            uint64 growthStart_,
            uint64 migrationTime_,
            uint64 deadline_,
            uint256 totalPrincipal_,
            uint256 committedPrincipal_,
            uint256 epoch_
        )
    {
        return (
            state,
            start,
            commitmentStart,
            growthStart,
            migrationTime,
            start + cfg.deadline,
            totalPrincipal(),
            committedPrincipal,
            currentEpoch()
        );
    }

    /// @notice The full raise configuration (also emitted verbatim in RaiseCreated).
    function getConfig() external view returns (RaiseConfig memory) {
        return cfg;
    }

    /// @notice Stage 0/1 gates with current vs required values.
    function commitmentGates() external view returns (CommitmentGates memory g) {
        g.now_ = block.timestamp;
        g.incubationEndsAt = start + cfg.minIncubation;
        g.timeMet = g.now_ >= g.incubationEndsAt;
        g.principalNow = totalPrincipal();
        g.softCapRequired = cfg.softCap;
        g.capitalMet = g.principalNow >= cfg.softCap;
        g.deadlineTimestamp = start + cfg.deadline;
        g.beforeDeadline = g.now_ <= g.deadlineTimestamp;
        g.vetoActive = board.vetoActive(address(this));
        g.optInCommitted = committedPrincipal;
        g.optInRequired = (totalTranche1Principal * cfg.minOptInBps) / BPS;
        g.optInMet = g.optInCommitted * BPS >= totalTranche1Principal * cfg.minOptInBps;
    }

    /// @notice Stage 3 migration gates with current vs required values.
    function graduationGates() external view returns (GraduationGates memory g) {
        g.epochNow = currentEpoch();
        g.epochsRequired = cfg.numTranches;
        if (address(pool) != address(0)) {
            (g.poolR,,) = pool.reserves();
            g.realRatioNow = pool.realRatioBps();
        }
        g.minLiquidity = cfg.minGraduationLiquidity;
        g.minRealRatio = cfg.minRealRatioBps;
    }

    /// @notice A user's full position. tokenEntitlement and earlyFactor are frozen at
    ///         startCommitment; during Incubation they are live previews.
    function positionOf(address user)
        external
        view
        returns (
            uint256 principal,
            uint256 shares,
            uint256 timeWeight,
            uint256 earlyFactor,
            uint256 tokenEntitlement,
            uint64 trancheBitmap
        )
    {
        principal = principalOf(user);
        shares = sharesOf[user];
        timeWeight = timeWeightOf[user];
        earlyFactor = _earlyFactorOf(user);
        tokenEntitlement = _entitlementOf(user);
        trancheBitmap = trancheStates[user];
    }

    /// @notice Per-tranche detail for the UI (loop k = 1..numTranches off-chain).
    function trancheInfo(address user, uint8 k)
        external
        view
        returns (uint8 trancheState, uint256 principal, uint256 tokens, uint64 commitTime, uint64 claimableTime)
    {
        _checkTranche(k);
        trancheState = _trancheState(user, k);
        uint256 snap = _snapshotPrincipal(user);
        principal = TrancheLib.amount(snap, k, cfg.numTranches);
        tokens = TrancheLib.tokenAmount(_entitlementOf(user), snap, k, cfg.numTranches);
        commitTime = commitTimes[user][k - 1];
        claimableTime = _claimableAt(user, k);
    }

    /// @notice tokens_i = A1·principal_i/P_tot (mulDiv, floor). Uses the frozen commitment-time
    ///         snapshot once commitment has started; live numbers during Incubation.
    function tokenEntitlementOf(address user) external view returns (uint256) {
        return _entitlementOf(user);
    }

    function earlyFactorOf(address user) external view returns (uint256) {
        return _earlyFactorOf(user);
    }

    /// @dev Cache the early factor the first time it is consumed by a claim (the snapshot is
    ///      already in place from the commit path). Share-denominated: spends cannot move it.
    function _cacheEarlyFactor(address user) internal returns (uint256 ef) {
        ef = earlyFactorCached[user];
        if (ef == 0) {
            _cacheSnapshot(user);
            uint256 sh = sharesAtCommit[user];
            if (sh > 0) {
                ef = timeWeightOf[user].mulDiv(FACTOR_SCALE, sh, Math.Rounding.Floor);
                earlyFactorCached[user] = ef;
            }
        }
    }

    /// @notice When tranche k's tokens become claimable: pool opening for epoch-0 commits,
    ///         commitTime + epochLength otherwise. 0 if not committed.
    function claimableAt(address user, uint8 k) external view returns (uint64) {
        return _claimableAt(user, k);
    }

    /// @notice Vested builder allocation so far (post-migration).
    function builderVested() external view returns (uint256) {
        if (state != State.Migrated) return 0;
        if (cfg.builderVesting == 0) return cfg.builderAlloc;
        uint64 elapsed = uint64(block.timestamp) - migrationTime;
        if (elapsed > cfg.builderVesting) elapsed = cfg.builderVesting;
        return (cfg.builderAlloc * elapsed) / cfg.builderVesting;
    }

    // ================= Internals =================

    function _commit(address user, uint8 k) internal {
        if (state != State.Commitment && state != State.Growth) revert InvalidState();
        _checkTranche(k);
        if (_trancheState(user, k) != TS_LOCKED) revert TrancheNotLocked();
        if (currentEpoch() < uint256(k) - 1) revert EpochNotReached();

        if (state == State.Commitment && block.timestamp >= commitmentEnd()) revert CommitmentWindowEnded();

        uint256 snap = _cacheSnapshot(user);
        uint256 pk = TrancheLib.amount(snap, k, cfg.numTranches);
        committedPrincipal += pk;
        if (state == State.Growth && pk > 0) {
            // Move the principal into the pool as real reserve now. (Epoch-0 commits are
            // converted in one batch by openGrowth.)
            pool.convert(pk);
        }

        trancheStates[user] = _setTrancheState(trancheStates[user], k, TS_COMMITTED);
        commitTimes[user][k - 1] = uint64(block.timestamp);
        emit TrancheCommitted(user, k, pk, currentEpoch());
    }

    function _claim(address user, uint8 k, bool stake) internal {
        if (state != State.Growth && state != State.Migrated) revert InvalidState();
        _checkTranche(k);
        if (_trancheState(user, k) != TS_COMMITTED) revert TrancheNotCommitted();
        uint64 at = _claimableAt(user, k);
        if (at == 0 || block.timestamp < at) revert NotClaimable();

        // Tokens are proportional to the tranche's principal, so a zero-principal (dust)
        // tranche carries zero tokens and can never draw on the pool's backing (audit L-01).
        uint256 tokens = TrancheLib.tokenAmount(_entitlementOf(user), _snapshotPrincipal(user), k, cfg.numTranches);
        trancheStates[user] = _setTrancheState(trancheStates[user], k, TS_CLAIMED);

        if (tokens > 0) {
            if (stake) {
                IERC20(address(token)).safeTransfer(address(vault), tokens);
                vault.stake(user, tokens, _cacheEarlyFactor(user));
            } else {
                IERC20(address(token)).safeTransfer(user, tokens);
            }
        }
        emit TrancheClaimed(user, k, tokens, stake);
    }

    function _redeem(address user, uint8 k) internal {
        if (state == State.Incubation || state == State.Failed) revert InvalidState();
        _checkTranche(k);
        if (_trancheState(user, k) != TS_LOCKED) revert TrancheNotLocked();

        uint256 snap = _cacheSnapshot(user);
        uint256 pk = TrancheLib.amount(snap, k, cfg.numTranches);
        uint256 tokens = TrancheLib.tokenAmount(_entitlementOf(user), snap, k, cfg.numTranches);

        trancheStates[user] = _setTrancheState(trancheStates[user], k, TS_REDEEMED);
        if (pk > 0) {
            // Burn the shares backing this tranche's principal (ceil: holders absorb dust).
            // Cap at the user's remaining shares: under a lowered index the per-tranche ceil
            // can overshoot by up to ~N wei in total, which must never brick the last tranche.
            uint256 sharesBurn = pk.mulDiv(INDEX_SCALE, index, Math.Rounding.Ceil);
            uint256 bal = sharesOf[user];
            if (sharesBurn > bal) sharesBurn = bal;
            sharesOf[user] = bal - sharesBurn;
            totalShares -= sharesBurn;
            redeemedPrincipal += pk;
            if (k == 1 && state == State.Commitment) {
                totalTranche1Principal -= pk;
            }
            IERC20(cfg.quoteAsset).safeTransfer(user, pk);
        }
        if (tokens > 0) {
            token.burn(tokens);
        }
        emit TrancheRedeemed(user, k, pk, tokens);
    }

    function _fail(uint8 reason) internal {
        state = State.Failed;
        emit RaiseFailed(reason, totalPrincipal());
    }

    function _checkTranche(uint8 k) internal view {
        if (k == 0 || k > cfg.numTranches) revert InvalidTranche();
    }

    /// @dev Principal and share snapshots at startCommitment, cached lazily on the first
    ///      post-commitment interaction (per-user snapshots in storage avoid an unbounded loop
    ///      at startCommitment). Shares cannot change between startCommitment and the user's
    ///      first interaction, so the cached value equals the commitment-time value.
    function _cacheSnapshot(address user) internal returns (uint256 snap) {
        snap = principalAtCommit[user];
        if (snap == 0) {
            snap = principalOf(user);
            if (snap > 0) {
                principalAtCommit[user] = snap;
                sharesAtCommit[user] = sharesOf[user];
            }
        }
    }

    function _snapshotPrincipal(address user) internal view returns (uint256) {
        uint256 snap = principalAtCommit[user];
        if (snap > 0) return snap;
        // Not cached yet: before the user's first post-commitment interaction, current
        // principal still equals the commitment-time principal.
        return principalOf(user);
    }

    function _snapshotShares(address user) internal view returns (uint256) {
        uint256 sh = sharesAtCommit[user];
        if (sh > 0) return sh;
        // Same laziness argument as _snapshotPrincipal.
        return sharesOf[user];
    }

    function _entitlementOf(address user) internal view returns (uint256) {
        if (commitPrincipalTotal == 0) {
            // Incubation: live preview against current totals.
            uint256 tp = totalPrincipal();
            if (tp == 0) return 0;
            return cfg.stage1Alloc.mulDiv(principalOf(user), tp, Math.Rounding.Floor);
        }
        uint256 snap = _snapshotPrincipal(user);
        if (snap == 0) return 0;
        return cfg.stage1Alloc.mulDiv(snap, commitPrincipalTotal, Math.Rounding.Floor);
    }

    /// @dev earlyFactor = timeWeightShares / shares × 1e18 ∈ [1e18, 2e18]. Share-denominated,
    ///      so it is invariant under governorSpend index moves (spends move the index, never shares).
    function _earlyFactorOf(address user) internal view returns (uint256) {
        uint256 ef = earlyFactorCached[user];
        if (ef > 0) return ef;
        uint256 sh = _snapshotShares(user);
        if (sh == 0) return 0;
        return timeWeightOf[user].mulDiv(FACTOR_SCALE, sh, Math.Rounding.Floor);
    }

    function _claimableAt(address user, uint8 k) internal view returns (uint64) {
        uint64 ct = commitTimes[user][k - 1];
        if (ct == 0) return 0;
        // commitTime < commitmentEnd ⟺ committed in epoch 0 → claimable at pool opening.
        if (ct < commitmentEnd()) return growthStart;
        return ct + cfg.epochLength;
    }

    function _trancheState(address user, uint8 k) internal view returns (uint8) {
        return uint8((trancheStates[user] >> ((k - 1) * 2)) & 3);
    }

    function _setTrancheState(uint64 bitmap, uint8 k, uint8 s) internal pure returns (uint64) {
        uint256 shift = (k - 1) * 2;
        return uint64((uint256(bitmap) & ~(uint256(3) << shift)) | (uint256(s) << shift));
    }
}
