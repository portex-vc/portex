// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TypesV31 as V} from "./TypesV31.sol";

/// @notice Exact rational kappa=3/2 issuance; no intermediate price floor (P §3).
library CurveV31 {
    /// @notice Integral difference rounded up only in native quote units (P §3, PS §1).
    function cost(uint256 target, uint256 allocation, uint256 sold, uint256 quantity) internal pure returns (uint256) {
        // Bounded search/cohort validation must reject invalid inputs rather than skip them (P §3; PS §1).
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (allocation == 0 || sold > allocation || quantity > allocation - sold) revert V.InvalidAmount();
        // supply <= 1e30 makes both factors and the denominator representable.
        uint256 area = quantity * (4 * allocation + 2 * sold + quantity);
        return Math.mulDiv(target, area, 6 * allocation * V.NORMALIZED_PRICE, Math.Rounding.Ceil);
    }

    /// @notice Greatest affordable integer quantity, bounded by remaining sale inventory (P §3).
    function purchase(uint256 target, uint256 allocation, uint256 sold, uint256 deposit)
        internal
        pure
        returns (uint256 quantity, uint256 debit)
    {
        uint256 high = allocation - sold;
        while (quantity < high) {
            uint256 middle = quantity + (high - quantity + 1) / 2;
            if (cost(target, allocation, sold, middle) <= deposit) quantity = middle;
            else high = middle - 1;
        }
        debit = cost(target, allocation, sold, quantity);
    }

    /// @notice Floored marginal price of the exact rational curve (P §3).
    function price(uint256 target, uint256 allocation, uint256 sold) internal pure returns (uint256) {
        return Math.mulDiv(target, 2 * allocation + sold, 3 * allocation);
    }
}
