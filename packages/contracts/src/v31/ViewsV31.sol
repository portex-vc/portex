// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ProtectedSplitLib as PS} from "../libraries/ProtectedSplitLib.sol";
import {TypesV31 as V} from "./TypesV31.sol";
import {StorageV31 as S} from "./StorageV31.sol";
import {ReserveMarket as Market} from "./ReserveMarket.sol";
import {ListingMathV31 as LP} from "./ListingMathV31.sol";
import {ClaimVault} from "./ClaimVault.sol";

/// @notice Statically linked typed views, separated from action bytecode (P §2.3, PS §5).
library ViewsV31 {
    using S for S.State;

    function validity(S.State storage s, V.Reason reason) internal view returns (V.Validity memory) {
        if (s.migrating) reason = V.Reason.Migrating;
        return V.Validity(reason == V.Reason.None, reason, s.effectivePhase(), s.nonce);
    }

    /// @notice Live exact-cost or protected-exit quote, including the separately burned book inventory (PS §§2–5).
    function exitQuote(S.State storage s, uint256 id, uint256 q, bool protected, uint256 nonce)
        public
        view
        returns (V.ExitQuote memory r)
    {
        if (s.migrating) {
            r.validity = validity(s, V.Reason.Migrating);
            return r;
        }
        V.Position storage p = s.positions[id];
        V.Phase phase = s.effectivePhase();
        V.Reason reason = V.Reason.None;
        if (nonce != s.nonce) {
            reason = V.Reason.StaleNonce;
        } else if (phase == V.Phase.Stage3 || phase == V.Phase.Dissolved || (protected && phase != V.Phase.Stage2)) {
            reason = V.Reason.PhaseClosed;
        } else if (p.owner == address(0) || p.class == V.Class.Buyer || (protected && p.class != V.Class.Backer)) {
            reason = V.Reason.InvalidPosition;
        } else if (q == 0 || q > p.tokens) {
            reason = V.Reason.InvalidQuantity;
        }
        r.validity = validity(s, reason);
        if (reason != V.Reason.None) return r;
        uint256 basis = s.basis(p);
        r.result.cost = q == p.tokens ? basis : Math.mulDiv(basis, q, p.tokens);
        r.result.burn = q;
        r.result.payout = r.result.cost;
        if (phase == V.Phase.Stage1) return r;
        PS.Book memory b;
        (b, r.depthBurn,) = Market.decay(s.book, s.x0, s.lastT, s.time());
        if (protected) (r.result,, r.bookBurn) = Market.protectedQuote(b, PS.Position(basis, p.tokens), q, s.time());
        else (, r.bookBurn) = Market.shrink(b, r.result.cost);
    }

    /// @notice Ordinary trade projection, with no executable amount when unavailable (P §2.3, PS §3).
    function tradeQuote(S.State storage s, address owner, uint256 amount, bool buying)
        public
        view
        returns (V.TradeQuote memory r)
    {
        if (s.migrating) {
            r.validity = validity(s, V.Reason.Migrating);
            return r;
        }
        V.Phase phase = s.effectivePhase();
        if (phase != V.Phase.Stage2 && (buying || phase != V.Phase.ListingPending)) {
            r.validity = validity(s, V.Reason.PhaseClosed);
            return r;
        }
        if (buying && owner != address(0) && s.isBuilder[owner]) {
            r.validity = validity(s, V.Reason.Unauthorized);
            return r;
        }
        if (amount == 0 || (buying && amount > V.MAX_QUOTE / 4) || (!buying && amount > s.buyerTokens[owner])) {
            r.validity = validity(s, V.Reason.InvalidQuantity);
            return r;
        }
        (PS.Book memory b, uint256 decayBurn,) = Market.decay(s.book, s.x0, s.lastT, s.time());
        if (b.T == 0 || b.R + b.V == 0) {
            r.validity = validity(s, V.Reason.EmptyBook);
            return r;
        }
        if (!buying) {
            uint256 gross = Math.mulDiv(b.R + b.V, amount, b.T + amount);
            if (gross - Market.split(gross).reserve > b.R) {
                r.validity = validity(s, V.Reason.Insolvent);
                return r;
            }
        }
        PS.Book memory afterBook;
        uint256 inventoryBefore = b.T;
        if (buying) (r, afterBook) = Market.buy(b, amount);
        else (r, afterBook) = Market.sell(b, amount);
        if (
            !Market.valid(afterBook, s.modules.token < s.config.quote)
                || (buying && (r.tokens == 0 || r.tokens >= inventoryBefore))
        ) {
            delete r;
            r.validity = validity(s, V.Reason.Insolvent);
            return r;
        }
        r.depthBurn = decayBurn;
        r.validity = validity(s, V.Reason.None);
    }

    /// @notice End-of-stage listing projection at final decay; venues may still revert atomically (P §12.1).
    function listingPreview(S.State storage s) public view returns (V.ListingPreview memory p) {
        if (s.migrating) {
            p.validity = validity(s, V.Reason.Migrating);
            return p;
        }
        return listingPlan(s);
    }

    /// @notice Internal migration plan; the public raise view always applies the migration guard.
    function listingPlan(S.State storage s) public view returns (V.ListingPreview memory p) {
        p.validity = V.Validity(false, V.Reason.PhaseClosed, s.effectivePhase(), s.nonce);
        if (s.effectivePhase() != V.Phase.ListingPending) return p;
        PS.Book memory b;
        (b, p.depthBurn,) = Market.decay(s.book, s.x0, s.lastT, V.SCALE);
        p.escrowRolled = b.E;
        p.desiredQuote = b.E + b.R;
        p.desiredToken = b.T;
        p.backerDelivery = s.totalBackerTokens;
        p.buyerDelivery = b.O;
        p.builderDelivery = s.totalBuilderTokens;
        p.ordinaryDestination = s.modules.token;
        p.builderDestination = s.modules.vesting;
        p.claimLiabilities = ClaimVault(s.modules.claims).liability();
        p.claimsEndOnSuccess = true;
        p.validity = V.Validity(true, V.Reason.None, s.effectivePhase(), s.nonce);
        if (p.desiredQuote != 0 && b.T == 0) {
            p.branch = V.Branch.QuoteWithoutTokens;
            p.validity = V.Validity(false, V.Reason.EmptyBook, s.effectivePhase(), s.nonce);
            return p;
        }
        if (p.desiredQuote != 0) {
            p.price = Math.mulDiv(p.desiredQuote, V.NORMALIZED_PRICE, b.T);
        } else {
            p.branch = b.T == 0 ? V.Branch.Empty : V.Branch.ZeroQuote;
            p.price = b.T == 0 ? s.pEnd : s.lastPrice;
        }
        bool tokenFirst = s.modules.token < s.config.quote;
        if (!LP.representable(p.price, tokenFirst)) {
            p.validity = V.Validity(false, V.Reason.PriceInvalid, s.effectivePhase(), s.nonce);
            return p;
        }
        p.sqrtPriceX96 = LP.sqrtPrice(p.price, tokenFirst);
        if (p.desiredQuote != 0) {
            (p.liquidity, p.usedToken, p.usedQuote) =
                LP.liquidityFor(p.sqrtPriceX96, tokenFirst ? b.T : p.desiredQuote, tokenFirst ? p.desiredQuote : b.T);
            if (!tokenFirst) (p.usedToken, p.usedQuote) = (p.usedQuote, p.usedToken);
            p.minQuote = LP.minimum(p.desiredQuote);
            p.minToken = LP.minimum(b.T);
            if (p.desiredQuote < 1e6 || p.liquidity == 0 || p.usedQuote < p.minQuote || p.usedToken < p.minToken) {
                p.branch = V.Branch.ZeroQuote;
                p.liquidity = 0;
                p.usedQuote = 0;
                p.usedToken = 0;
                p.minQuote = 0;
                p.minToken = 0;
            }
        }
        uint256 reserveUsed = Math.min(p.usedToken, s.liquidityReserve);
        p.liquidityReserveBurn = s.liquidityReserve - reserveUsed;
        p.bookBurn = b.T - (p.usedToken - reserveUsed);
        p.quoteDust = p.desiredQuote - p.usedQuote;
    }

    /// @notice O(1) eligible share capital, rounded once at the common index (P §5.11).
    function eligibleCapital(S.State storage s) public view returns (uint256) {
        if (s.migrating || s.phase == V.Phase.Stage3 || s.phase == V.Phase.Dissolved) return 0;
        return Math.mulDiv(s.eligibleShares, s.J, V.SCALE);
    }

    /// @notice Exact funded/live claim with scheduled, non-closing protection timestamp (P §2.3).
    function claim(S.State storage s, uint256 id) public view returns (V.Claim memory r) {
        r.validity = validity(s, V.Reason.None);
        r.validUntil = s.deadlines.stage2End;
        r.phase = s.effectivePhase();
        r.stateNonce = s.nonce;
        if (s.migrating) return r;
        if (s.positions[id].owner == address(0)) {
            r.validity = validity(s, V.Reason.InvalidPosition);
            return r;
        }
        uint256 amount =
            s.phase == V.Phase.Dissolved ? ClaimVault(s.modules.claims).claimable(id) : s.basis(s.positions[id]);
        r.amount = amount;
    }

    /// @notice Conditional remaining-ceiling bounds, including sole-claimant dust (P §2.3, PS §6).
    function bounds(S.State storage s, uint256 id, V.Phase target) public view returns (V.Bounds memory b) {
        b.validity = validity(s, V.Reason.None);
        if (s.migrating) return b;
        b.asset = s.config.quote;
        b.stateNonce = s.nonce;
        b.backingBucket = "Escrow";
        b.conditions = keccak256("No intervening exit or listing; only remaining authorized Budget draws");
        if (target == V.Phase.Stage3 || s.phase == V.Phase.Stage3) return b;
        if (s.phase == V.Phase.Dissolved) {
            b.backingBucket = "ClaimVault";
            b.lower = ClaimVault(s.modules.claims).claimable(id);
            b.upper = b.lower;
            return b;
        }
        V.Position storage p = s.positions[id];
        b.upper = s.basis(p);
        b.lower = b.upper;
        if (target == V.Phase.Stage1 || !s.budget() || s.H == 0 || p.shares == 0) return b;
        uint256 remaining = s.phase == V.Phase.Stage1
            ? Math.mulDiv(s.book.E, s.config.budgetCeiling, V.SCALE)
            : s.ceilingAmount - s.drawn;
        uint256 floorEscrow = s.book.E > remaining ? s.book.E - remaining : 0;
        if (s.claimCount == 1) b.lower = floorEscrow;
        else b.lower = Math.mulDiv(p.shares, Math.min(s.J, Math.mulDiv(floorEscrow, V.SCALE, s.H)), V.SCALE);
    }

    /// @notice Typed state guarded by the observable migration flag (P §2.3).
    function reserveState(S.State storage s) public view returns (V.ReserveState memory) {
        PS.Book memory b = s.book;
        return V.ReserveState(
            validity(s, V.Reason.None), b.E, b.R, b.V, b.T, b.O, s.x0, s.lastT, s.H, s.J, s.claimCount, s.nonce
        );
    }

    /// @notice Typed state guarded by the observable migration flag (P §2.3).
    function listingStatus(S.State storage s, uint256 id) public view returns (V.ListingStatus memory r) {
        V.Position storage p = s.positions[id];
        bool exists = p.owner != address(0) && p.tokens != 0 && s.phase != V.Phase.Dissolved;
        r.validity = validity(s, exists ? V.Reason.None : V.Reason.InvalidPosition);
        if (s.migrating) return r;
        r.liveCostEligible = exists && p.class != V.Class.Buyer && s.phase != V.Phase.Stage3;
        r.basis = claim(s, id).amount;
        r.destination = p.class == V.Class.BuilderPurchase ? s.modules.vesting : p.owner;
        if (exists) {
            if (p.class == V.Class.BuilderPurchase) r.vestedTokens = p.tokens;
            else r.liquidTokens = p.tokens;
        }
    }

    /// @notice Typed state guarded by the observable migration flag (P §2.3).
    function positionState(S.State storage s, uint256 id) public view returns (V.PositionView memory r) {
        V.Position storage p = s.positions[id];
        r.validity = validity(s, p.owner == address(0) ? V.Reason.InvalidPosition : V.Reason.None);
        if (s.migrating || p.owner == address(0)) return r;
        r = V.PositionView(r.validity, p.owner, p.class, p.tokens, s.basis(p), p.shares, 0, s.effectivePhase());
        if (s.phase == V.Phase.Stage3 || s.phase == V.Phase.Dissolved) r.shares = 0;
        if (s.phase == V.Phase.Dissolved) r.tokens = 0;
        if (p.class == V.Class.Backer && s.phase != V.Phase.Stage3 && s.phase != V.Phase.Dissolved) r.quota = p.tokens;
    }
}
