// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ProtectedSplitLib as PS} from "../libraries/ProtectedSplitLib.sol";
import {TypesV31 as V} from "./TypesV31.sol";
import {StorageV31 as S} from "./StorageV31.sol";
import {ReserveMarket as Market} from "./ReserveMarket.sol";
import {LedgerV31} from "./LedgerV31.sol";
import {LifecycleV31} from "./LifecycleV31.sol";
import {ViewsV31 as Views} from "./ViewsV31.sol";
import {IDexAdapterV31} from "./IDexAdapterV31.sol";
import {ProjectTokenV31} from "./ProjectTokenV31.sol";
import {GovernanceV31} from "./GovernanceV31.sol";

/// @notice One immutable launch clone; disjoint custody buckets and deadline-aware phases (P §§1–7,12).
contract RaiseCore is Initializable {
    using SafeERC20 for IERC20;
    using S for S.State;
    /// @notice Rollover router trusted to exit and deposit for its own caller; zero disables rollover.
    address public immutable router;
    S.State private s;

    event Deposited(
        address indexed raise,
        V.Phase phase,
        uint256 stateNonce,
        address indexed owner,
        uint256 indexed id,
        V.Class class,
        uint256 debit,
        uint256 tokens,
        uint256 sold,
        uint256 escrow
    );
    event PhaseChanged(address indexed raise, V.Phase phase, uint256 stateNonce, uint64 stage2Start, uint64 stage2End);
    event AtCostExited(
        address indexed raise,
        V.Phase phase,
        uint256 stateNonce,
        address indexed owner,
        uint256 indexed id,
        uint256 quantity,
        PS.Result result,
        PS.Book balances
    );
    event ProtectedSplitExecuted(
        address indexed raise,
        V.Phase phase,
        uint256 stateNonce,
        address indexed owner,
        uint256 indexed id,
        uint256 quantity,
        PS.Result result,
        PS.Book balances
    );
    event MarketBought(
        address indexed raise,
        V.Phase phase,
        uint256 stateNonce,
        address indexed owner,
        uint256 indexed id,
        V.TradeQuote trade,
        PS.Book balances
    );
    event MarketSold(
        address indexed raise,
        V.Phase phase,
        uint256 stateNonce,
        address indexed owner,
        uint256 indexed id,
        V.TradeQuote trade,
        PS.Book balances
    );
    event DepthAdvanced(
        address indexed raise,
        V.Phase phase,
        uint256 stateNonce,
        uint256 oldTime,
        uint256 newTime,
        uint256 oldV,
        uint256 newV,
        uint256 burn
    );
    event QuotaDestroyed(
        address indexed raise,
        V.Phase phase,
        uint256 stateNonce,
        address indexed owner,
        uint256 indexed id,
        uint256 quantity,
        uint256 remainingQuota
    );
    event FeeRouted(
        address indexed raise,
        V.Phase phase,
        uint256 stateNonce,
        address indexed destination,
        address asset,
        uint256 amount,
        bytes32 source
    );
    event BudgetHaircutApplied(
        address indexed raise,
        V.Phase phase,
        uint256 stateNonce,
        uint256 indexed proposal,
        uint256 draw,
        uint256 cumulativeDraw,
        uint256 escrow,
        uint256 totalShares,
        uint256 index,
        uint256 bookBurn
    );
    event ListingFinalized(
        address indexed raise,
        V.Phase phase,
        uint256 stateNonce,
        IDexAdapterV31.Receipt receipt,
        V.ListingPreview migration
    );
    /// @notice The builder chose to dissolve during Stage 1 (the phase change itself is `PhaseChanged`).
    event DissolvedByBuilder(address indexed raise, uint256 stateNonce, address indexed builder);
    event VetoChanged(
        address indexed raise,
        V.Phase phase,
        uint256 stateNonce,
        bytes32 report,
        uint64 vetoUntil,
        uint64 cumulativeDelay
    );

    constructor(address router_) {
        router = router_;
        _disableInitializers();
    }
    modifier action() {
        if (s.busy) revert V.Reentrancy();
        s.busy = true;
        _;
        s.busy = false;
    }
    modifier onlyRouter() {
        if (msg.sender != router || router == address(0)) revert V.Unauthorized();
        _;
    }

    /// @notice Pin the validated configuration, modules, code commitment and authority before deposits (P §§1,5–7).
    function initialize(
        V.Config calldata config_,
        V.Parameters calldata parameters_,
        V.Modules calldata modules_,
        address builder_,
        bytes32 templateId_,
        uint64 version_,
        bytes32 bundleHash_
    ) external initializer {
        s.config = config_;
        s.parameters = parameters_;
        s.modules = modules_;
        s.factory = msg.sender;
        s.builder = builder_;
        s.templateId = templateId_;
        s.version = version_;
        s.bundleHash = bundleHash_;
        s.adapterHash = modules_.adapter.codehash;
        s.deadlines.start = SafeCast.toUint64(block.timestamp);
        s.deadlines.stage1End = SafeCast.toUint64(block.timestamp + config_.stage1Length);
        s.J = V.SCALE;
        s.isBuilder[builder_] = true;
        for (uint256 i; i < config_.builders.length; ++i) {
            s.isBuilder[config_.builders[i]] = true;
        }
    }

    /// @notice Buy maximal affordable Stage 1 tokens, debit only their exact curve cost (P §3).
    function deposit(uint256 amount, uint256 minTokens, uint256 nonce, uint256 deadline)
        external
        action
        returns (uint256 id, uint256 quantity)
    {
        return LedgerV31.deposit(s, msg.sender, amount, minTokens, nonce, deadline);
    }

    /// @notice Rollover: the router deposits for its own caller with funds it just collected (P §3).
    function depositFor(address owner, uint256 amount, uint256 minTokens, uint256 nonce, uint256 deadline)
        external
        action
        onlyRouter
        returns (uint256 id, uint256 quantity)
    {
        return LedgerV31.deposit(s, owner, amount, minTokens, nonce, deadline);
    }

    /// @notice At deadline, successful gates take priority over dissolution; the AI can only delay (P §§2.4,3).
    function advanceStage1() external action {
        // Protocol deadlines and daily release explicitly use block time (P §§2.4,12.2).
        // forge-lint: disable-next-line(block-timestamp)
        if (s.phase != V.Phase.Stage1 || block.timestamp < s.deadlines.stage1End) revert V.InvalidPhase();
        // Stage 1 exits return allocation to the sale, so this measures what backers still hold at the deadline.
        bool gates = s.sold >= Math.mulDiv(s.config.supply / 5, V.GRADUATION_HOLD_BPS, 10_000, Math.Rounding.Ceil)
            && s.liveBackers >= s.parameters.minimumBackers && s.book.E != 0
            && Math.mulDiv(2 * s.book.E, V.NORMALIZED_PRICE, s.config.targetPrice) != 0;
        // Protocol deadlines and daily release explicitly use block time (P §§2.4,12.2).
        // forge-lint: disable-next-line(block-timestamp)
        if (gates && block.timestamp < s.deadlines.vetoUntil) revert V.Expired();
        ++s.nonce;
        if (!gates) _dissolve();
        else _openStage2();
        // The shared raise action lock covers these interactions and their resulting-nonce events (PS §§2,5).
        // forge-lint: disable-next-line(reentrancy-events)
        emit PhaseChanged(address(this), s.phase, s.nonce, s.deadlines.stage2Start, s.deadlines.stage2End);
    }

    /// @notice The builder may dissolve during Stage 1 once its minimum length has passed; every position then
    /// claims its full cost (base layer: Stage 1 carries no downside).
    function dissolve() external action {
        if (msg.sender != s.builder) revert V.Unauthorized();
        // Protocol deadlines and daily release explicitly use block time (P §§2.4,12.2).
        // forge-lint: disable-next-line(block-timestamp)
        if (s.phase != V.Phase.Stage1 || block.timestamp < uint256(s.deadlines.start) + s.parameters.stage1Min) {
            revert V.InvalidPhase();
        }
        ++s.nonce;
        _dissolve();
        // The shared raise action lock covers these interactions and their resulting-nonce events (PS §§2,5).
        // forge-lint: disable-start(reentrancy-events)
        emit DissolvedByBuilder(address(this), s.nonce, msg.sender);
        emit PhaseChanged(address(this), s.phase, s.nonce, 0, 0);
        // forge-lint: disable-end(reentrancy-events)
    }

    /// @notice Pinned attester delay, per-veto/cumulative/cooldown limits and absolute 60-day cap (P §§3,5.15).
    function veto(uint64 delay, bytes32 report) external action {
        if (msg.sender != s.modules.attester) revert V.Unauthorized();
        // Protocol deadlines and daily release explicitly use block time (P §§2.4,12.2).
        // forge-lint: disable-next-line(block-timestamp)
        if (s.phase != V.Phase.Stage1 || block.timestamp < s.cooldownUntil) revert V.InvalidPhase();
        // Absolute horizon: the version's pinned Stage 1 maximum, so no veto outlives the Stage 1 limit (C-M1).
        uint256 hardEnd = uint256(s.deadlines.start) + s.parameters.stage1Max;
        // Protocol deadlines and daily release explicitly use block time (P §§2.4,12.2).
        // forge-lint: disable-next-line(block-timestamp)
        if (delay == 0 || delay > s.parameters.vetoMax || block.timestamp >= hardEnd) revert V.InvalidAmount();
        uint64 until = SafeCast.toUint64(Math.min(block.timestamp + delay, hardEnd));
        uint64 used = SafeCast.toUint64(until - block.timestamp);
        if (s.vetoUsed + used > s.parameters.vetoTotal) revert V.InvalidAmount();
        ++s.nonce;
        s.vetoUsed += used;
        s.deadlines.vetoUntil = until;
        s.cooldownUntil = until + s.parameters.vetoCooldown;
        // The shared raise action lock covers these interactions and their resulting-nonce events (PS §§2,5).
        // forge-lint: disable-next-line(reentrancy-events)
        emit VetoChanged(address(this), phase(), s.nonce, report, until, s.vetoUsed);
    }

    /// @notice Council may only shorten a veto; consumed veto budget is never restored (P §§1,5.15).
    function clearVeto() external action {
        if (msg.sender != s.modules.council) revert V.Unauthorized();
        // Protocol deadlines and daily release explicitly use block time (P §§2.4,12.2).
        // forge-lint: disable-next-line(block-timestamp)
        if (s.phase != V.Phase.Stage1 || s.deadlines.vetoUntil <= block.timestamp) revert V.InvalidPhase();
        ++s.nonce;
        s.deadlines.vetoUntil = 0;
        s.cooldownUntil = SafeCast.toUint64(block.timestamp + s.parameters.vetoCooldown);
        emit VetoChanged(address(this), phase(), s.nonce, bytes32(0), 0, s.vetoUsed);
    }

    /// @notice Exact live basis, including zero-cost dust and all listing retries (PS §§2–4).
    function exitAtCost(uint256 id, uint256 q, uint256 minPayout, uint256 nonce, uint256 deadline)
        external
        action
        returns (uint256)
    {
        return LedgerV31._exit(s, msg.sender, id, q, minPayout, nonce, deadline, false);
    }

    /// @notice Fee-free backer cost plus lambda-throttled, solvent premium during Stage 2 (PS §3).
    function protectedExit(uint256 id, uint256 q, uint256 minPayout, uint256 nonce, uint256 deadline)
        external
        action
        returns (uint256)
    {
        return LedgerV31._exit(s, msg.sender, id, q, minPayout, nonce, deadline, true);
    }

    /// @notice Rollover: the router exits its caller's position (at cost, or protected in Stage 2) and receives the
    /// payout to deposit elsewhere in the same transaction (PS §§2–4).
    function exitFor(
        address owner,
        uint256 id,
        uint256 q,
        uint256 minPayout,
        uint256 nonce,
        uint256 deadline,
        bool withProfit
    ) external action onlyRouter returns (uint256) {
        return LedgerV31._exit(s, owner, id, q, minPayout, nonce, deadline, withProfit);
    }

    /// @notice Stage 2 buyer ledger purchase with exact 1% fee splitting (PS §3).
    function buy(uint256 gross, uint256 minTokens, uint256 nonce, uint256 deadline) external action returns (uint256) {
        return LedgerV31.buy(s, gross, minTokens, nonce, deadline);
    }

    /// @notice Sell only the caller's buyer ledger; net payout never includes fee accruals (PS §3).
    function sell(uint256 q, uint256 minPayout, uint256 nonce, uint256 deadline) external action returns (uint256) {
        return LedgerV31.sell(s, q, minPayout, nonce, deadline);
    }

    /// @notice Permissionless lazy decay; a true no-op neither writes time nor increments nonce (PS §§3,5).
    function advanceDepth() external action {
        if (s.phase != V.Phase.Stage2) revert V.InvalidPhase();
        (PS.Book memory b,,) = Market.decay(s.book, s.x0, s.lastT, s.time());
        if (b.V == s.book.V) return;
        ++s.nonce;
        _advance();
    }

    /// @notice Atomic permissionless direct v4 listing, including zero-quote branches (P §12.1).
    function list() external action {
        // The action/custody guard stays held across this call; authenticated callbacks cannot enter a new action (PS §2).
        // forge-lint: disable-next-line(reentrancy-no-eth)
        LifecycleV31.list(s);
    }

    /// @notice One authenticated callback for exactly the precomputed amounts, under the listing guard (P §12.1).
    function listingCallback(bytes32 poolId, uint256 quoteAmount, uint256 tokenAmount) external {
        if (
            msg.sender != s.modules.adapter || !s.busy || !s.callbackPending || poolId != s.callbackPool
                || quoteAmount != s.callbackQuote || tokenAmount != s.callbackToken
        ) revert V.Unauthorized();
        // This is a transaction-scoped lock/callback flag, not a change of authority; the outer action emits its result.
        // forge-lint: disable-next-line(missing-events-access-control)
        s.callbackPending = false;
        _pay(s.modules.adapter, quoteAmount);
        ProjectTokenV31(s.modules.token).custodyMove(s.modules.adapter, tokenAmount);
    }

    /// @notice Shared cross-module lock; the raise nonce is frozen after listing (PS §§2,5).
    function beginModuleAction() external returns (uint256) {
        if (msg.sender != s.modules.governor && msg.sender != s.modules.vesting && msg.sender != s.modules.claims) {
            revert V.Unauthorized();
        }
        if (s.busy) revert V.Reentrancy();
        s.busy = true;
        // This is a transaction-scoped lock/callback flag, not a change of authority; the outer action emits its result.
        // forge-lint: disable-next-line(missing-events-access-control)
        s.activeModule = msg.sender;
        if (s.phase != V.Phase.Stage3) ++s.nonce;
        return s.nonce;
    }

    /// @notice Only the active authenticated module can finish its action (PS §5).
    function endModuleAction() external {
        if (s.activeModule != msg.sender || !s.busy) revert V.Unauthorized();
        // This is a transaction-scoped lock/callback flag, not a change of authority; the outer action emits its result.
        // forge-lint: disable-next-line(missing-events-access-control)
        s.activeModule = address(0);
        s.busy = false;
    }

    /// @notice Ceiling/YES-capped draw with constant-work share haircut and equal V/E shrink (P §3, PS §6).
    function governorDraw(uint256 proposal, uint256 amount, uint256 yesWeight) external {
        if (msg.sender != s.modules.governor || s.activeModule != msg.sender || !s.busy || !s.budget()) {
            revert V.Unauthorized();
        }
        if (phase() != V.Phase.Stage2) revert V.InvalidPhase();
        if (
            amount == 0 || amount > s.book.E || amount > s.ceilingAmount - s.drawn || amount > yesWeight / 10
                || s.H == 0
        ) revert V.InvalidAmount();
        _advance();
        s.J = Math.min(s.J, Math.mulDiv(s.book.E - amount, V.SCALE, s.H));
        uint256 burn;
        (s.book, burn) = Market.shrink(s.book, amount);
        s.drawn += amount;
        _burn(burn, "Book");
        _rememberPrice();
        _pay(s.builder, amount);
        // The shared raise action lock covers these interactions and their resulting-nonce events (PS §§2,5).
        // forge-lint: disable-next-line(reentrancy-events)
        emit BudgetHaircutApplied(address(this), phase(), s.nonce, proposal, amount, s.drawn, s.book.E, s.H, s.J, burn);
    }

    /// @notice Pull only the Stage 2 treasury fee bucket; principal buckets are inaccessible (P §§5.18,7).
    function claimTreasuryFees() external action returns (uint256 amount) {
        amount = s.treasuryFees;
        if (amount == 0) revert V.InvalidAmount();
        if (s.phase != V.Phase.Stage3) ++s.nonce;
        s.treasuryFees = 0;
        _pay(s.config.treasury, amount);
        emit FeeRouted(address(this), phase(), s.nonce, s.config.treasury, s.config.quote, amount, "TradeFees");
    }

    /// @notice Collect LP fees to treasury while retaining permanently locked principal (P §12.1).
    function collectLPFees() external action returns (uint256 quoteFees, uint256 tokenFees) {
        return LifecycleV31.collectLPFees(s);
    }

    /// @notice Effective phase switches to listing-pending exactly at the scheduled end (P §2.4).
    function phase() public view returns (V.Phase) {
        return s.effectivePhase();
    }

    /// @notice Observable guard for atomic listing views (P §12.1).
    function migrating() external view returns (bool) {
        return s.migrating;
    }

    /// @notice Executable-quote version, frozen after successful listing (PS §5).
    function stateNonce() external view returns (uint256) {
        return s.nonce;
    }

    /// @notice Unsolicited quote remains locked, separate from every backing/fee bucket (PS §8; implementation default).
    function custodySurplus() external view returns (uint256) {
        if (s.migrating) return 0;
        return IERC20(s.config.quote).balanceOf(address(this)) - s.book.E - s.book.R - s.rewardFees - s.treasuryFees
            - s.listingDust;
    }

    /// @notice Immutable launch configuration (P §1/I2).
    function getConfig() external view returns (V.Config memory) {
        return s.config;
    }

    /// @notice Pinned module addresses (P §1/I2).
    function modules() external view returns (V.Modules memory) {
        return s.modules;
    }

    /// @notice Exact registry version and bytecode commitment (P §1/I2).
    function template() external view returns (bytes32, uint64, bytes32) {
        return (s.templateId, s.version, s.bundleHash);
    }

    /// @notice Stage deadlines and listed timestamp (P §2.3).
    function stageDeadlines() external view returns (V.Deadlines memory) {
        V.Deadlines memory d = s.deadlines;
        d.validity = Views.validity(s, V.Reason.None);
        return d;
    }

    /// @notice Stored book, shares and decay checkpoint; quotes independently simulate lazy decay (P §2.3).
    function reserveState() external view returns (V.ReserveState memory) {
        return Views.reserveState(s);
    }

    /// @notice Exact cost quote bound to the stored nonce (P §2.3, PS §5).
    function redeemQuote(uint256 id, uint256 q, uint256 nonce) external view returns (V.ExitQuote memory) {
        return Views.exitQuote(s, id, q, false, nonce);
    }

    /// @notice Separate enforceable claim and scheduled protection end (P §2.3).
    function guaranteedClaim(uint256 id) external view returns (V.Claim memory) {
        return Views.claim(s, id);
    }

    /// @notice Post-shrink cost/value/premium/cap/profit/sold/burn/payout projection (PS §§3,5).
    function protectedExitQuote(uint256 id, uint256 q) external view returns (V.ExitQuote memory) {
        return Views.exitQuote(s, id, q, true, s.nonce);
    }

    /// @notice Exact ordinary buy amounts, fees and before/after canonical prices (P §2.3).
    function marketBuyQuote(uint256 gross) external view returns (V.TradeQuote memory) {
        return Views.tradeQuote(s, address(0), gross, true);
    }

    /// @notice Buy quote for a specific caller; builders get `Unauthorized` because `buy` would revert (P §2.3).
    function marketBuyQuoteFor(address buyer, uint256 gross) external view returns (V.TradeQuote memory) {
        return Views.tradeQuote(s, buyer, gross, true);
    }

    /// @notice Executable buyer-ledger sell quote (P §2.3).
    function marketExitQuote(address owner, uint256 q) external view returns (V.TradeQuote memory) {
        return Views.tradeQuote(s, owner, q, false);
    }

    /// @notice Conditional basis bounds after remaining authorized Budget haircuts (P §2.3, PS §6).
    function futureClaimBounds(uint256 id, V.Phase target) external view returns (V.Bounds memory) {
        return Views.bounds(s, id, target);
    }

    /// @notice Historical remaining cost at risk; all historical basis is at risk after listing (P §2.3).
    function atRiskBasis(uint256 id) external view returns (uint256) {
        // A dissolution claim is fully backed or already paid; frozen historical records are not capital at risk.
        if (s.migrating || s.phase == V.Phase.Dissolved) return 0;
        uint256 historical = s.positions[id].historicalRemaining;
        uint256 basis = Views.claim(s, id).amount;
        return historical > basis ? historical - basis : 0;
    }

    /// @notice Full mandatory-listing branch, consumption, burns and delivery preview (P §12.1).
    function listingPreview() external view returns (V.ListingPreview memory) {
        return Views.listingPreview(s);
    }

    /// @notice Live-cost eligibility and automatic delivery destination; no consent is required (P §2.3).
    function listingStatus(uint256 id) external view returns (V.ListingStatus memory r) {
        return Views.listingStatus(s, id);
    }

    /// @notice Frozen terminal delivery record or current ledger position, with separate class and basis (P §2.3).
    function positionState(uint256 id) external view returns (V.PositionView memory r) {
        return Views.positionState(s, id);
    }

    /// @notice Segregated pending fee buckets and cumulative Reserve fee retention (P §2.3).
    function feeAccruals() external view returns (uint256 reserveRetained, uint256 rewards, uint256 treasury) {
        return (s.reserveFeesCumulative, s.rewardFees, s.treasuryFees);
    }

    /// @notice Disjoint token-bucket accounting plus permanent migration dust (PS §8).
    function accounting()
        external
        view
        returns (
            uint256 sold,
            uint256 liquidityReserve,
            uint256 backers,
            uint256 builders,
            uint256 quoteDust,
            uint256 positionCount
        )
    {
        return (s.sold, s.liquidityReserve, s.totalBackerTokens, s.totalBuilderTokens, s.listingDust, s.positionCount);
    }

    /// @notice Buyer ledger is extinguished at successful listing (P §12.1).
    function buyerTokens(address owner) external view returns (uint256) {
        return s.phase == V.Phase.Stage3 ? 0 : s.buyerTokens[owner];
    }

    /// @notice Frozen credits consumed only by token lazy materialization (P §12.1).
    function deliveryOf(address owner) external view returns (uint256 tokens, uint256 quota) {
        if (s.migrating || s.phase != V.Phase.Stage3) return (0, 0);
        return (s.backerTokens[owner] + s.buyerTokens[owner], s.backerTokens[owner]);
    }

    /// @notice Frozen builder-only grant, with no free allocation (P §2.2).
    function builderGrant(address owner) external view returns (uint256) {
        return !s.migrating && s.phase == V.Phase.Stage3 ? s.builderTokens[owner] : 0;
    }

    /// @notice Exact frozen dissolution entitlement; funded liabilities stay in ClaimVault (PS §6).
    function dissolutionRecord(uint256 id) external view returns (address owner, V.Class class, uint256 amount) {
        V.Position storage p = s.positions[id];
        return (p.owner, p.class, s.phase == V.Phase.Dissolved ? p.basis : 0);
    }

    /// @notice Immutable proposer and pinned governance rules (P §§3,7).
    function governanceConfig() external view returns (address builder, V.Parameters memory parameters, bool enabled) {
        return (s.builder, s.parameters, s.budget());
    }

    /// @notice Remaining authorized spending and phase deadline (P §3).
    function governanceState() external view returns (uint64 end, uint256 escrow, uint256 remainingCeiling) {
        return (s.deadlines.stage2End, s.book.E, s.ceilingAmount - s.drawn);
    }

    /// @notice O(1) eligible share capital, excluding builder purchases and buyer balances (P §5.11).
    function eligibleCapital() external view returns (uint256) {
        return Views.eligibleCapital(s);
    }

    /// @notice Only backer-class live capital can vote (P §§3,5.11).
    function votingPosition(uint256 id) external view returns (address owner, uint256 weight, bool eligible) {
        V.Position storage p = s.positions[id];
        return (p.owner, s.basis(p), p.class == V.Class.Backer && p.tokens != 0 && !s.isBuilder[p.owner]);
    }

    /// @notice Confirmed LP ownership, actual asset usage and immutable price (P §12.1 step 7).
    function listingRecord() external view returns (IDexAdapterV31.Receipt memory) {
        return s.listingReceipt;
    }

    function _advance() internal {
        // The action/custody guard stays held across this call; authenticated callbacks cannot enter a new action (PS §2).
        // forge-lint: disable-next-line(reentrancy-no-eth)
        LifecycleV31._advance(s);
    }

    function _openStage2() internal {
        // The action/custody guard stays held across this call; authenticated callbacks cannot enter a new action (PS §2).
        // forge-lint: disable-next-line(reentrancy-no-eth)
        LifecycleV31._openStage2(s);
    }

    function _dissolve() internal {
        // The action/custody guard stays held across this call; authenticated callbacks cannot enter a new action (PS §2).
        // forge-lint: disable-next-line(reentrancy-no-eth)
        LifecycleV31._dissolve(s);
    }

    function _rememberPrice() internal {
        if (!Market.valid(s.book, s.modules.token < s.config.quote)) revert V.InvariantFailure();
        uint256 price = Market.price(s.book);
        if (price != 0) s.lastPrice = price;
    }

    function _burn(uint256 amount, bytes32 bucket) internal {
        // The action/custody guard stays held across this call; authenticated callbacks cannot enter a new action (PS §2).
        // forge-lint: disable-next-line(reentrancy-no-eth)
        if (amount != 0) ProjectTokenV31(s.modules.token).custodyBurn(amount, bucket);
    }

    function _pay(address to, uint256 amount) internal {
        if (amount == 0) return;
        IERC20 quote = IERC20(s.config.quote);
        uint256 beforeBalance = quote.balanceOf(to);
        uint256 ownBefore = quote.balanceOf(address(this));
        quote.safeTransfer(to, amount);
        // Exact per-call asset deltas are mandatory; unsolicited preexisting balances cancel out (PS §3).
        // forge-lint: disable-next-line(incorrect-strict-equality)
        if (quote.balanceOf(to) - beforeBalance != amount || ownBefore - quote.balanceOf(address(this)) != amount) {
            revert V.WrongAssetDelta();
        }
    }
}
