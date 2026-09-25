// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {TypesV31 as V} from "./TypesV31.sol";
import {StorageV31 as S} from "./StorageV31.sol";
import {CurveV31 as Curve} from "./CurveV31.sol";
import {ReserveMarket as Market} from "./ReserveMarket.sol";
import {ViewsV31 as Views} from "./ViewsV31.sol";
import {IDexAdapterV31} from "./IDexAdapterV31.sol";
import {ProjectTokenV31} from "./ProjectTokenV31.sol";
import {GovernanceV31} from "./GovernanceV31.sol";
import {ClaimVault} from "./ClaimVault.sol";

/// @notice Statically linked lifecycle code; immutable library addresses are embedded in the pinned raise bytecode (P §1/I2).
library LifecycleV31 {
    using SafeERC20 for IERC20;
    using S for S.State;
    event ListingFinalized(
        address indexed raise,
        V.Phase phase,
        uint256 stateNonce,
        IDexAdapterV31.Receipt receipt,
        V.ListingPreview migration
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
    event FeeRouted(
        address indexed raise,
        V.Phase phase,
        uint256 stateNonce,
        address indexed destination,
        address asset,
        uint256 amount,
        bytes32 source
    );

    /// @notice Atomic listing and custody validation (P §12.1).
    function list(S.State storage s) public {
        s.migrating = true;
        V.ListingPreview memory p = Views.listingPlan(s);
        if (!p.validity.available) revert V.VenueFailure();
        if (s.modules.adapter.codehash != s.adapterHash) revert V.VenueFailure();
        ++s.nonce;
        _advance(s);
        s.phase = V.Phase.Stage3;
        s.callbackPool = IDexAdapterV31(s.modules.adapter).poolKey(s.modules.token, s.config.quote);
        s.callbackQuote = p.usedQuote;
        s.callbackToken = p.usedToken;
        s.callbackPending = p.liquidity != 0;
        IDexAdapterV31.Receipt memory receipt = IDexAdapterV31(s.modules.adapter)
            .initializeAndMint(
                IDexAdapterV31.Request(
                    s.modules.token,
                    s.config.quote,
                    address(this),
                    p.sqrtPriceX96,
                    p.liquidity == 0 ? 0 : p.desiredQuote,
                    p.liquidity == 0 ? 0 : p.desiredToken,
                    p.minQuote,
                    p.minToken
                )
            );
        _verifyReceipt(s, receipt, p);
        s.listingReceipt = receipt;
        _completeListing(s, p);
        s.migrating = false;
        p.validity = V.Validity(true, V.Reason.None, V.Phase.Stage3, s.nonce);
        // The shared raise action lock covers these interactions and their resulting-nonce events (PS §§2,5).
        // forge-lint: disable-next-line(reentrancy-events)
        emit ListingFinalized(address(this), s.phase, s.nonce, receipt, p);
    }

    /// @notice Pinned lifecycle accounting (P §§2.4,12.1; PS §§3,6–7).
    function _advance(S.State storage s) public {
        uint256 oldV = s.book.V;
        uint256 oldTime = s.lastT;
        uint256 burn;
        (s.book, burn, s.lastT) = Market.decay(s.book, s.x0, s.lastT, s.time());
        if (oldV == s.book.V) return;
        _burn(s, burn, "Book");
        _rememberPrice(s);
        // The shared raise action lock covers these interactions and their resulting-nonce events (PS §§2,5).
        // forge-lint: disable-next-line(reentrancy-events)
        emit DepthAdvanced(address(this), s.effectivePhase(), s.nonce, oldTime, s.lastT, oldV, s.book.V, burn);
    }

    /// @notice Pinned lifecycle accounting (P §§2.4,12.1; PS §§3,6–7).
    function _openStage2(S.State storage s) public {
        uint256 endPrice = Curve.price(s.config.targetPrice, s.config.supply / 5, s.sold);
        uint256 seed = Math.mulDiv(2 * s.book.E, V.NORMALIZED_PRICE, endPrice);
        if (s.book.E == 0 || seed == 0) {
            _dissolve(s);
            return;
        }
        s.phase = V.Phase.Stage2;
        s.deadlines.stage2Start = SafeCast.toUint64(block.timestamp);
        s.deadlines.stage2End = SafeCast.toUint64(block.timestamp + s.config.stage2Length);
        s.pEnd = endPrice;
        s.book.V = 2 * s.book.E;
        s.x0 = s.book.E;
        uint256 allocation = Math.mulDiv(s.config.supply, 40, 100);
        // Every held token cost at most the target price, so even when graduating just below a full sale (end price a
        // hair under target) the seed can pass the allocation only by rounding dust, which must not block Stage 2.
        s.book.T = Math.min(seed, allocation);
        s.liquidityReserve = allocation - s.book.T;
        s.ceilingAmount = Math.mulDiv(s.book.E, s.config.budgetCeiling, V.SCALE);
        _burn(s, s.config.supply / 5 - s.sold, "UnsoldSale");
        _rememberPrice(s);
    }

    /// @notice Dissolution: every position's cost moves to the ClaimVault in one transfer, all supply is burned
    /// (P §§2.4,12.1; PS §§3,6–7).
    function _dissolve(S.State storage s) public {
        uint256 escrow = s.book.E;
        s.phase = V.Phase.Dissolved;
        delete s.book;
        s.H = 0;
        s.eligibleShares = 0;
        s.claimCount = 0;
        s.totalBackerTokens = 0;
        s.totalBuilderTokens = 0;
        GovernanceV31(s.modules.governor).cancelAll();
        ProjectTokenV31 token = ProjectTokenV31(s.modules.token);
        uint256 supply = token.totalSupply();
        // All pre-list supply must remain in raise custody before the dissolution burn (F-5).
        // forge-lint: disable-next-line(incorrect-strict-equality)
        if (token.balanceOf(address(this)) != supply) revert V.InvariantFailure();
        _burn(s, supply, "DissolvedUndelivered");
        _pay(s, s.modules.claims, escrow);
        ClaimVault(s.modules.claims).fund(escrow);
    }

    /// @notice Pinned lifecycle accounting (P §§2.4,12.1; PS §§3,6–7).
    function _verifyReceipt(S.State storage s, IDexAdapterV31.Receipt memory r, V.ListingPreview memory p)
        internal
        view
    {
        if (
            s.callbackPending || r.poolId != s.callbackPool || r.owner != address(this)
                || r.sqrtPriceX96 != p.sqrtPriceX96 || r.liquidity != p.liquidity || r.usedQuote != p.usedQuote
                || r.usedToken != p.usedToken
        ) revert V.VenueFailure();
        IDexAdapterV31.Receipt memory confirmed = IDexAdapterV31(s.modules.adapter).position(r.positionId);
        if (keccak256(abi.encode(confirmed)) != keccak256(abi.encode(r))) revert V.VenueFailure();
    }

    /// @notice Pinned lifecycle accounting (P §§2.4,12.1; PS §§3,6–7).
    function _completeListing(S.State storage s, V.ListingPreview memory p) internal {
        _burn(s, p.bookBurn, "Book");
        _burn(s, p.liquidityReserveBurn, "LiquidityReserve");
        s.listingDust = p.quoteDust;
        s.liquidityReserve = 0;
        delete s.book;
        s.H = 0;
        s.eligibleShares = 0;
        s.claimCount = 0;
        s.deadlines.listedAt = SafeCast.toUint64(block.timestamp);
        GovernanceV31(s.modules.governor).cancelAll();
        ProjectTokenV31 token = ProjectTokenV31(s.modules.token);
        uint256 rewardTokens = Math.mulDiv(s.config.supply, 30, 100);
        token.custodyMove(s.modules.vesting, s.totalBuilderTokens);
        token.custodyMove(s.modules.token, rewardTokens);
        token.custodyMove(s.config.treasury, s.config.supply / 10);
        uint256 quoteRewards = s.rewardFees;
        s.rewardFees = 0;
        _pay(s, s.modules.token, quoteRewards);
        // The shared raise action lock covers these interactions and their resulting-nonce events (PS §§2,5).
        // forge-lint: disable-start(reentrancy-events)
        emit FeeRouted(
            address(this), s.phase, s.nonce, s.modules.token, s.config.quote, quoteRewards, "TradeRewardStream"
        );
        // forge-lint: disable-end(reentrancy-events)
        token.activate(
            s.totalBackerTokens + p.buyerDelivery, s.totalBackerTokens, s.backerHolders, rewardTokens, quoteRewards
        );
    }

    /// @notice Pinned lifecycle accounting (P §§2.4,12.1; PS §§3,6–7).
    function _rememberPrice(S.State storage s) internal {
        // Decay must not obstruct a live cost exit through the zero-inventory branch (PS §4).
        if (s.book.T == 0) return;
        if (!Market.valid(s.book, s.modules.token < s.config.quote)) revert V.InvariantFailure();
        uint256 price = Market.price(s.book);
        if (price != 0) s.lastPrice = price;
    }

    /// @notice Pinned lifecycle accounting (P §§2.4,12.1; PS §§3,6–7).
    function _burn(S.State storage s, uint256 amount, bytes32 bucket) internal {
        if (amount != 0) ProjectTokenV31(s.modules.token).custodyBurn(amount, bucket);
    }

    /// @notice Pinned lifecycle accounting (P §§2.4,12.1; PS §§3,6–7).
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

    /// @notice Collect only LP fees; the listing nonce and principal remain frozen (P §12.1, PS §5).
    function collectLPFees(S.State storage s) public returns (uint256 quoteFees, uint256 tokenFees) {
        if (s.effectivePhase() != V.Phase.Stage3 || s.modules.adapter.codehash != s.adapterHash) {
            revert V.InvalidPhase();
        }
        uint256 qBefore = IERC20(s.config.quote).balanceOf(s.config.treasury);
        uint256 tBefore = IERC20(s.modules.token).balanceOf(s.config.treasury);
        (quoteFees, tokenFees) =
        // The action/custody guard stays held across this call; authenticated callbacks cannot enter a new action (PS §2).
        // forge-lint: disable-next-line(reentrancy-no-eth)
        IDexAdapterV31(s.modules.adapter).collectFees(s.listingReceipt.positionId, s.config.treasury);
        if (
            // Exact per-call asset deltas are mandatory; unsolicited preexisting balances cancel out (PS §3).
            // forge-lint: disable-next-line(incorrect-strict-equality)
            IERC20(s.config.quote).balanceOf(s.config.treasury) - qBefore != quoteFees
                // Exact per-call asset deltas are mandatory; unsolicited preexisting balances cancel out (PS §3).
                // forge-lint: disable-next-line(incorrect-strict-equality)
                || IERC20(s.modules.token).balanceOf(s.config.treasury) - tBefore != tokenFees
        ) {
            revert V.WrongAssetDelta();
        }
        // The shared raise action lock covers these interactions and their resulting-nonce events (PS §§2,5).
        // forge-lint: disable-start(reentrancy-events)
        emit FeeRouted(
            address(this), s.effectivePhase(), s.nonce, s.config.treasury, s.config.quote, quoteFees, "LPFees"
        );
        // forge-lint: disable-end(reentrancy-events)
        // The shared raise action lock covers these interactions and their resulting-nonce events (PS §§2,5).
        // forge-lint: disable-start(reentrancy-events)
        emit FeeRouted(
            address(this), s.effectivePhase(), s.nonce, s.config.treasury, s.modules.token, tokenFees, "LPFees"
        );
        // forge-lint: disable-end(reentrancy-events)
    }
}
