// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ProtectedSplitLib as PS} from "../libraries/ProtectedSplitLib.sol";
import {TypesV31 as V} from "./TypesV31.sol";
import {StorageV31 as S} from "./StorageV31.sol";
import {CurveV31 as Curve} from "./CurveV31.sol";
import {ReserveMarket as Market} from "./ReserveMarket.sol";
import {LifecycleV31} from "./LifecycleV31.sol";
import {ViewsV31 as Views} from "./ViewsV31.sol";
import {ProjectTokenV31} from "./ProjectTokenV31.sol";
import {GovernanceV31} from "./GovernanceV31.sol";

/// @notice Statically linked issuance and protected-ledger actions (P §3; PS §§2–4,6).
library LedgerV31 {
    using SafeERC20 for IERC20;
    using S for S.State;
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
    event QuotaDestroyed(
        address indexed raise,
        V.Phase phase,
        uint256 stateNonce,
        address indexed owner,
        uint256 indexed id,
        uint256 quantity,
        uint256 remainingQuota
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

    /// @notice Stage 1 deposit for `owner`, paid by the caller (the owner, or the rollover router for its caller)
    /// with exact native-quote accounting (P §3; PS §§2–4,6).
    function deposit(
        S.State storage s,
        address owner,
        uint256 amount,
        uint256 minTokens,
        uint256 nonce,
        uint256 deadline
    ) public returns (uint256 id, uint256 quantity) {
        _validate(s, nonce, deadline);
        // Protocol deadlines and daily release explicitly use block time (P §§2.4,12.2).
        // forge-lint: disable-next-line(block-timestamp)
        if (s.phase != V.Phase.Stage1 || block.timestamp >= s.deadlines.stage1End) revert V.InvalidPhase();
        if (amount == 0 || amount > V.MAX_QUOTE / 4) {
            revert V.InvalidAmount();
        }
        uint256 debit;
        (quantity, debit) = Curve.purchase(s.config.targetPrice, s.config.supply / 5, s.sold, amount);
        if (quantity == 0 || quantity < minTokens) revert V.Slippage();
        _checkSeedCapacity(s, debit);
        bool builder = s.isBuilder[owner];
        if (builder && s.builderPurchased + quantity > s.config.supply / 10) revert V.InvalidAmount();
        ++s.nonce;
        id = ++s.positionCount;
        V.Class class = builder ? V.Class.BuilderPurchase : V.Class.Backer;
        s.positions[id] = V.Position(owner, class, quantity, debit, debit, debit);
        s.sold += quantity;
        s.book.E += debit;
        s.H += debit;
        ++s.claimCount;
        if (builder) {
            s.builderPurchased += quantity;
            s.builderTokens[owner] += quantity;
            s.totalBuilderTokens += quantity;
        } else {
            s.eligibleShares += debit;
            if (s.backerTokens[owner] == 0) ++s.backerHolders;
            if (s.backerBasis[owner] == 0) ++s.liveBackers;
            s.backerTokens[owner] += quantity;
            s.backerBasis[owner] += debit;
            s.totalBackerTokens += quantity;
        }
        _pull(s, msg.sender, debit);
        _emitDeposit(s, id, debit, quantity);
    }

    /// @notice Exit `owner`'s position and pay the caller (the owner, or the rollover router for its caller)
    /// with exact native-quote accounting (P §3; PS §§2–4,6).
    function _exit(
        S.State storage s,
        address owner,
        uint256 id,
        uint256 q,
        uint256 minimum,
        uint256 nonce,
        uint256 deadline,
        bool protected
    ) public returns (uint256) {
        _validate(s, nonce, deadline);
        if (owner != s.positions[id].owner) revert V.Unauthorized();
        return _settleExit(s, id, q, minimum, nonce, protected);
    }

    function _settleExit(S.State storage s, uint256 id, uint256 q, uint256 minimum, uint256 nonce, bool protected)
        internal
        returns (uint256)
    {
        V.Position storage p = s.positions[id];
        V.ExitQuote memory quote = Views.exitQuote(s, id, q, protected, nonce);
        if (!quote.validity.available) revert V.InvalidPosition();
        if (quote.result.payout < minimum) revert V.Slippage();
        uint256 basis = s.basis(p);
        ++s.nonce;
        if (s.phase == V.Phase.Stage2) LifecycleV31._advance(s);
        GovernanceV31(s.modules.governor).cancelVote(id);
        s.reduceShares(p, q, quote.result.cost, basis);
        _reducePosition(s, p, id, q, quote.result.cost);
        if (s.phase == V.Phase.Stage1) {
            s.book.E -= quote.result.cost;
            // The exited allocation goes back on sale (the curve steps back): graduation then measures the
            // allocation actually held at the deadline, not what was ever sold.
            s.sold -= q;
        } else {
            (s.book,) = Market.shrink(s.book, quote.result.cost);
            s.book.R -= quote.result.profit;
            s.book.T += quote.result.qSold;
            _rememberPrice(s);
        }
        _burn(s, quote.bookBurn, "Book");
        // This named bucket/class is a fixed ASCII literal shorter than 32 bytes.
        // forge-lint: disable-next-line(unsafe-typecast)
        _burn(s, quote.result.burn, p.class == V.Class.Backer ? bytes32("BackerLedger") : bytes32("BuilderLedger"));
        _pay(s, msg.sender, quote.result.payout);
        _emitExit(s, id, q, quote.result, protected);
        return quote.result.payout;
    }

    /// @notice Stage 2 buyer ledger purchase with exact 1% fee splitting (PS §3).
    function buy(S.State storage s, uint256 gross, uint256 minTokens, uint256 nonce, uint256 deadline)
        public
        returns (uint256)
    {
        if (s.isBuilder[msg.sender]) revert V.Unauthorized();
        _validate(s, nonce, deadline);
        V.TradeQuote memory r = Views.tradeQuote(s, msg.sender, gross, true);
        if (!r.validity.available) revert V.InvalidAmount();
        if (r.tokens < minTokens) revert V.Slippage();
        ++s.nonce;
        LifecycleV31._advance(s);
        (, s.book) = Market.buy(s.book, gross);
        uint256 id = s.buyerId[msg.sender];
        if (id == 0) {
            id = ++s.positionCount;
            s.buyerId[msg.sender] = id;
            s.positions[id].owner = msg.sender;
            s.positions[id].class = V.Class.Buyer;
        }
        s.positions[id].tokens += r.tokens;
        s.buyerTokens[msg.sender] += r.tokens;
        _fees(s, r.fees);
        _rememberPrice(s);
        r.validity.stateNonce = s.nonce;
        _pull(s, msg.sender, gross);
        // The shared raise action lock covers these interactions and their resulting-nonce events (PS §§2,5).
        // forge-lint: disable-next-line(reentrancy-events)
        emit MarketBought(address(this), s.effectivePhase(), s.nonce, msg.sender, id, r, s.book);
        return r.tokens;
    }

    /// @notice Sell only the caller's buyer ledger; net payout never includes fee accruals (PS §3).
    function sell(S.State storage s, uint256 q, uint256 minPayout, uint256 nonce, uint256 deadline)
        public
        returns (uint256)
    {
        _validate(s, nonce, deadline);
        V.TradeQuote memory r = Views.tradeQuote(s, msg.sender, q, false);
        if (!r.validity.available) revert V.InvalidAmount();
        if (r.net < minPayout) revert V.Slippage();
        ++s.nonce;
        LifecycleV31._advance(s);
        (, s.book) = Market.sell(s.book, q);
        uint256 id = s.buyerId[msg.sender];
        s.positions[id].tokens -= q;
        s.buyerTokens[msg.sender] -= q;
        _fees(s, r.fees);
        _rememberPrice(s);
        r.validity.stateNonce = s.nonce;
        _pay(s, msg.sender, r.net);
        // The shared raise action lock covers these interactions and their resulting-nonce events (PS §§2,5).
        // forge-lint: disable-next-line(reentrancy-events)
        emit MarketSold(address(this), s.effectivePhase(), s.nonce, msg.sender, id, r, s.book);
        return r.net;
    }

    /// @notice Segregate the 1% trade fee into its pinned buckets (PS §3).
    function _fees(S.State storage s, V.Fees memory f) internal {
        s.rewardFees += f.reward;
        s.treasuryFees += f.treasury;
        s.reserveFeesCumulative += f.reserve;
    }

    /// @notice Internal accounting for the authorized ledger action.
    function _reducePosition(S.State storage s, V.Position storage p, uint256 id, uint256 q, uint256 cost) internal {
        uint256 historical = q == p.tokens ? p.historicalRemaining : Math.mulDiv(p.historicalRemaining, q, p.tokens);
        p.historicalRemaining -= historical;
        if (s.phase == V.Phase.Stage1 || !s.budget()) p.basis -= cost;
        p.tokens -= q;
        if (p.class == V.Class.Backer) {
            s.backerTokens[p.owner] -= q;
            s.totalBackerTokens -= q;
            if (s.backerTokens[p.owner] == 0) --s.backerHolders;
            if (s.phase == V.Phase.Stage1) {
                uint256 previous = s.backerBasis[p.owner];
                s.backerBasis[p.owner] -= cost;
                if (previous != 0 && s.backerBasis[p.owner] == 0) --s.liveBackers;
            }
            // The shared raise action lock covers these interactions and their resulting-nonce events (PS §§2,5).
            // forge-lint: disable-next-line(reentrancy-events)
            emit QuotaDestroyed(address(this), s.effectivePhase(), s.nonce, p.owner, id, q, p.tokens);
        } else {
            s.builderTokens[p.owner] -= q;
            s.totalBuilderTokens -= q;
        }
    }

    /// @notice Internal accounting for the authorized ledger action.
    function _rememberPrice(S.State storage s) internal {
        // Cost exits do not depend on a usable market; the zero-T fallback is mandatory (PS §4).
        if (s.book.T == 0) return;
        if (!Market.valid(s.book, s.modules.token < s.config.quote)) revert V.InvariantFailure();
        uint256 price = Market.price(s.book);
        if (price != 0) s.lastPrice = price;
    }

    /// @notice Internal accounting for the authorized ledger action.
    function _burn(S.State storage s, uint256 amount, bytes32 bucket) internal {
        if (amount != 0) ProjectTokenV31(s.modules.token).custodyBurn(amount, bucket);
    }

    /// @notice Internal accounting for the authorized ledger action.
    function _pull(S.State storage s, address from, uint256 amount) internal {
        IERC20 quote = IERC20(s.config.quote);
        uint256 beforeBalance = quote.balanceOf(address(this));
        quote.safeTransferFrom(from, address(this), amount);
        // Exact per-call asset deltas are mandatory; unsolicited preexisting balances cancel out (PS §3).
        // forge-lint: disable-next-line(incorrect-strict-equality)
        if (quote.balanceOf(address(this)) - beforeBalance != amount) revert V.WrongAssetDelta();
    }

    /// @notice Internal accounting for the authorized ledger action.
    function _pay(S.State storage s, address to, uint256 amount) internal {
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

    /// @notice Internal accounting for the authorized ledger action.
    function _validate(S.State storage s, uint256 nonce, uint256 deadline) internal view {
        if (nonce != s.nonce) revert V.StaleNonce();
        // Protocol deadlines and daily release explicitly use block time (P §§2.4,12.2).
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > deadline) revert V.Expired();
    }

    function _checkSeedCapacity(S.State storage s, uint256 debit) internal view {
        uint256 escrow = s.book.E + debit;
        if (
            escrow > V.MAX_QUOTE / 2
                || Math.mulDiv(2 * escrow, V.NORMALIZED_PRICE, s.config.targetPrice)
                    > Math.mulDiv(s.config.supply, 40, 100)
        ) revert V.InvalidAmount();
    }

    function _emitDeposit(S.State storage s, uint256 id, uint256 debit, uint256 quantity) internal {
        // The shared raise action lock covers these interactions and their resulting-nonce events (PS §§2,5).
        // forge-lint: disable-start(reentrancy-events)
        emit Deposited(
            address(this),
            s.phase,
            s.nonce,
            s.positions[id].owner,
            id,
            s.positions[id].class,
            debit,
            quantity,
            s.sold,
            s.book.E
        );
        // forge-lint: disable-end(reentrancy-events)
    }

    function _emitExit(S.State storage s, uint256 id, uint256 q, PS.Result memory r, bool protected) internal {
        if (protected) {
            // The shared raise action lock covers these interactions and their resulting-nonce events (PS §§2,5).
            // forge-lint: disable-next-line(reentrancy-events)
            emit ProtectedSplitExecuted(
                address(this), s.effectivePhase(), s.nonce, s.positions[id].owner, id, q, r, s.book
            );
        } else {
            // The shared raise action lock covers these interactions and their resulting-nonce events (PS §§2,5).
            // forge-lint: disable-next-line(reentrancy-events)
            emit AtCostExited(address(this), s.effectivePhase(), s.nonce, s.positions[id].owner, id, q, r, s.book);
        }
    }
}
