// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ProtectedSplitLib as PS} from "../libraries/ProtectedSplitLib.sol";
import {ListingMathV31} from "./ListingMathV31.sol";
import {TypesV31 as V} from "./TypesV31.sol";

/// @notice Stateless ledger-market arithmetic; custody and authority remain in RaiseCore (PS §§1–4).
library ReserveMarket {
    /// @notice Native USDG fee, exact 40/30/remainder split (PS §3).
    function split(uint256 gross) internal pure returns (V.Fees memory f) {
        f.total = gross / 100;
        f.reserve = Math.mulDiv(f.total, 40, 100);
        f.reward = Math.mulDiv(f.total, 30, 100);
        f.treasury = f.total - f.reserve - f.reward;
    }

    /// @notice Canonical normalized quote/token price (PS §1).
    function price(PS.Book memory b) internal pure returns (uint256) {
        return b.T == 0 ? 0 : Math.mulDiv(b.R + b.V, V.NORMALIZED_PRICE, b.T);
    }

    /// @notice Validate bounded products, unique Reserve backing and venue-representable price (PS §§1,3).
    function valid(PS.Book memory b, bool tokenFirst) internal pure returns (bool) {
        if (b.R + b.V > V.MAX_QUOTE || b.T > V.MAX_SUPPLY || b.O > V.MAX_SUPPLY || b.E > b.V) return false;
        if (b.R * b.T < b.V * b.O) return false;
        if (b.E + b.R != 0 && b.T == 0) return false;
        if (b.R + b.V == 0 || b.T == 0) return true;
        return ListingMathV31.representable(price(b), tokenFirst);
    }

    /// @notice Simulate one monotone depth advance; no-op retains lastT (PS §3).
    function decay(PS.Book memory b, uint256 x0, uint256 lastT, uint256 t)
        internal
        pure
        returns (PS.Book memory, uint256 burn, uint256 newLastT)
    {
        if (t < lastT || b.V < b.E) revert V.InvariantFailure();
        uint256 target = Math.mulDiv(x0, V.SCALE - t, V.SCALE);
        if (b.V - b.E < target) revert V.InvariantFailure();
        uint256 delta = b.V - b.E - target;
        newLastT = lastT;
        if (delta == 0) return (b, 0, lastT);
        uint256 q = b.R + b.V;
        if (q == 0) revert V.InvariantFailure();
        burn = Math.mulDiv(delta, b.T, q);
        b.V -= delta;
        b.T -= burn;
        return (b, burn, t);
    }

    /// @notice Cost/draw price-nonincreasing shrink; zero inventory never divides (PS §§3–4).
    function shrink(PS.Book memory b, uint256 cost) internal pure returns (PS.Book memory, uint256 burn) {
        // Bounded search/cohort validation must reject invalid inputs rather than skip them (P §3; PS §1).
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (cost > b.E || cost > b.V) revert V.InvariantFailure();
        if (cost != 0 && b.T != 0) burn = Math.mulDiv(cost, b.T, b.R + b.V);
        b.E -= cost;
        b.V -= cost;
        b.T -= burn;
        return (b, burn);
    }

    /// @notice ProtectedSplitLib reuse with an explicit check against its legacy defensive clamp (PS §3.10).
    function protectedQuote(PS.Book memory b, PS.Position memory p, uint256 q, uint256 t)
        internal
        pure
        returns (PS.Result memory r, PS.Book memory afterBook, uint256 bookBurn)
    {
        if (b.T == 0) {
            r.cost = q == p.tokens ? p.basis : Math.mulDiv(p.basis, q, p.tokens);
            r.payout = r.cost;
            r.burn = q;
            (afterBook, bookBurn) = shrink(b, r.cost);
            return (r, afterBook, bookBurn);
        }
        (r, afterBook,) = PS.quote(b, p, q, t);
        bookBurn = b.T + r.qSold - afterBook.T;
        if (r.profit != 0) {
            uint256 postQ = b.R + b.V - r.cost;
            // Bounded search/cohort validation must reject invalid inputs rather than skip them (P §3; PS §1).
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (postQ <= r.profit) revert V.InvariantFailure();
            uint256 exactSold = Math.mulDiv(r.profit, b.T - bookBurn, postQ - r.profit, Math.Rounding.Ceil);
            // Bounded search/cohort validation must reject invalid inputs rather than skip them (P §3; PS §1).
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (exactSold > q || exactSold != r.qSold) revert V.InvariantFailure();
        }
    }

    /// @notice Ordinary buy with the fee kept outside AMM input (PS §3).
    function buy(PS.Book memory b, uint256 gross)
        internal
        pure
        returns (V.TradeQuote memory r, PS.Book memory afterBook)
    {
        r.gross = gross;
        r.fees = split(gross);
        r.ammAmount = gross - r.fees.total;
        r.tokens = Math.mulDiv(b.T, r.ammAmount, b.R + b.V + r.ammAmount);
        r.net = r.tokens;
        r.priceBefore = price(b);
        b.R += r.ammAmount + r.fees.reserve;
        b.T -= r.tokens;
        b.O += r.tokens;
        r.priceAfter = price(b);
        r.priceImpactBps = _impact(r.priceBefore, r.priceAfter);
        return (r, b);
    }

    /// @notice Ordinary sell debits only gross less retained Reserve fees (PS §3).
    function sell(PS.Book memory b, uint256 quantity)
        internal
        pure
        returns (V.TradeQuote memory r, PS.Book memory afterBook)
    {
        r.tokens = quantity;
        r.gross = Math.mulDiv(b.R + b.V, quantity, b.T + quantity);
        r.ammAmount = r.gross;
        r.fees = split(r.gross);
        r.net = r.gross - r.fees.total;
        r.priceBefore = price(b);
        uint256 debit = r.gross - r.fees.reserve;
        if (debit > b.R) revert V.InvariantFailure();
        b.R -= debit;
        b.T += quantity;
        b.O -= quantity;
        r.priceAfter = price(b);
        r.priceImpactBps = _impact(r.priceBefore, r.priceAfter);
        return (r, b);
    }

    function _impact(uint256 beforePrice, uint256 afterPrice) private pure returns (uint256) {
        if (beforePrice == 0) revert V.InvariantFailure();
        uint256 delta = afterPrice >= beforePrice ? afterPrice - beforePrice : beforePrice - afterPrice;
        return Math.mulDiv(delta, 10000, beforePrice);
    }
}
