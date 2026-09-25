// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Splits a position total into `n` equal tranches (1-indexed); the last tranche absorbs
///         rounding dust, so a position's tranches always sum exactly to the total.
///         Token entitlements are sliced PROPORTIONALLY to each tranche's principal
///         (mulDiv, floor; the last tranche takes the remaining dust), so a zero-principal
///         tranche always carries zero tokens (audit L-01) and tranche tokens sum exactly
///         to the entitlement.
library TrancheLib {
    /// @dev Principal of tranche k: floor(total/n), last tranche takes the dust.
    function amount(uint256 total, uint8 k, uint8 n) internal pure returns (uint256) {
        uint256 base = total / n;
        if (k < n) return base;
        return total - base * (n - 1);
    }

    /// @dev Tokens of tranche k: floor(entitlement · principal_k / snapshotPrincipal); the last
    ///      tranche takes whatever is left so the per-tranche tokens sum exactly to the
    ///      entitlement. Zero-principal tranches (and a zero snapshot) yield zero tokens.
    function tokenAmount(uint256 entitlement, uint256 snapshotPrincipal, uint8 k, uint8 n)
        internal
        pure
        returns (uint256)
    {
        if (snapshotPrincipal == 0 || entitlement == 0) return 0;
        if (k < n) {
            return Math.mulDiv(entitlement, amount(snapshotPrincipal, k, n), snapshotPrincipal, Math.Rounding.Floor);
        }
        uint256 used;
        for (uint8 i = 1; i < n; ++i) {
            used += Math.mulDiv(entitlement, amount(snapshotPrincipal, i, n), snapshotPrincipal, Math.Rounding.Floor);
        }
        return entitlement - used;
    }
}
