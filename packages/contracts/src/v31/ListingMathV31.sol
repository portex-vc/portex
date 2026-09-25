// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {TypesV31 as V} from "./TypesV31.sol";

/// @notice Full-width canonical v4 price and full-range amounts (P §12.1).
library ListingMathV31 {
    uint256 internal constant Q96 = 1 << 96;
    uint256 internal constant Q192 = 1 << 192;
    // Uniswap v4 TickMath.getSqrtPriceAtTick(-887200 / +887200), rounded up by TickMath.
    uint160 internal constant LOWER = 4310618292;
    uint160 internal constant UPPER = 1456195216270955103206513029158776779468408838535;
    uint128 internal constant MAX_LIQUIDITY = type(uint128).max / 8873;

    /// @notice Compare s*s*d <= n*2^192 with exact 512-bit products (P §12.1).
    function squareLe(uint256 s, uint256 n, uint256 d) internal pure returns (bool) {
        (uint256 high, uint256 low) = Math.mul512(s, s);
        (uint256 carry, uint256 bottom) = Math.mul512(low, d);
        (uint256 top, uint256 middle) = Math.mul512(high, d);
        (uint256 overflow, uint256 combined) = Math.add512(middle, carry);
        // The left product is 768 bits. A nonzero top limb exceeds the entire 512-bit right side.
        if (top != 0 || overflow != 0) return false;
        high = combined;
        (uint256 rhsHigh, uint256 rhsLow) = Math.mul512(n, Q192);
        return high < rhsHigh || (high == rhsHigh && bottom <= rhsLow);
    }

    /// @notice Canonical price fits strictly inside the pinned full range (P §12.1).
    function representable(uint256 price, bool tokenFirst) internal pure returns (bool) {
        if (price == 0) return false;
        (uint256 n, uint256 d) = tokenFirst ? (price, uint256(1e30)) : (uint256(1e30), price);
        return squareLe(uint256(LOWER) + 1, n, d) && !squareLe(UPPER, n, d);
    }

    /// @notice Exact floor(sqrt(rho*2^192)), including ratios whose square exceeds uint256 (P §12.1).
    function sqrtPrice(uint256 price, bool tokenFirst) internal pure returns (uint160) {
        // Bounded search/cohort validation must reject invalid inputs rather than skip them (P §3; PS §1).
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (!representable(price, tokenFirst)) revert V.InvalidConfig();
        (uint256 n, uint256 d) = tokenFirst ? (price, uint256(1e30)) : (uint256(1e30), price);
        uint256 low = uint256(LOWER) + 1;
        uint256 high = uint256(UPPER) - 1;
        while (low < high) {
            uint256 middle = low + (high - low + 1) / 2;
            if (squareLe(middle, n, d)) low = middle;
            else high = middle - 1;
        }
        return SafeCast.toUint160(low);
    }

    /// @notice Exact v4 SqrtPriceMath upward deltas; nested ceilings preserve the rational ceiling (P §12.1).
    function amounts(uint160 s, uint128 liquidity) internal pure returns (uint256 amount0, uint256 amount1) {
        // Bounded search/cohort validation must reject invalid inputs rather than skip them (P §3; PS §1).
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (s <= LOWER || s >= UPPER) revert V.InvalidConfig();
        amount0 = Math.ceilDiv(Math.mulDiv(uint256(liquidity) << 96, uint256(UPPER) - s, UPPER, Math.Rounding.Ceil), s);
        amount1 = Math.mulDiv(liquidity, uint256(s) - LOWER, Q96, Math.Rounding.Ceil);
    }

    /// @notice Largest usable integer liquidity, capped by v4's per-tick bound (P §12.1).
    function liquidityFor(uint160 s, uint256 desired0, uint256 desired1)
        internal
        pure
        returns (uint128 liquidity, uint256 used0, uint256 used1)
    {
        uint256 low = 0;
        uint256 high = MAX_LIQUIDITY;
        while (low < high) {
            uint256 middle = low + (high - low + 1) / 2;
            (uint256 a0, uint256 a1) = amounts(s, SafeCast.toUint128(middle));
            if (a0 <= desired0 && a1 <= desired1) low = middle;
            else high = middle - 1;
        }
        liquidity = SafeCast.toUint128(low);
        (used0, used1) = amounts(s, liquidity);
    }

    /// @notice Positive-listing minimum actual usage (P §12.1 implementation default).
    function minimum(uint256 desired) internal pure returns (uint256) {
        return Math.max(1, Math.mulDiv(desired, 9999, 10000));
    }
}
