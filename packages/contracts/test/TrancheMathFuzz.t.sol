// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.sol";
import {TrancheLib} from "../src/libraries/TrancheLib.sol";
import {RaiseConfig} from "../src/libraries/PortexTypes.sol";

/// @notice Fuzz tranche arithmetic: a position's tranches sum exactly to its principal and
///         tokens (last tranche absorbs dust); entitlements never exceed A1 in aggregate.
contract TrancheMathFuzz is BaseTest {
    /// @dev pure library property: sum of tranches == total, exactly.
    function testFuzz_tranchesSumExactly(uint256 total, uint8 n) public {
        n = uint8(bound(n, 1, 32));
        uint256 sum;
        for (uint8 k = 1; k <= n; ++k) {
            sum += TrancheLib.amount(total, k, n);
        }
        assertEq(sum, total);
    }

    /// @dev every non-last tranche is floor(total/n); last takes the dust.
    function testFuzz_lastTrancheTakesDust(uint256 total, uint8 n) public {
        n = uint8(bound(n, 1, 32));
        uint256 base = total / n;
        for (uint8 k = 1; k < n; ++k) {
            assertEq(TrancheLib.amount(total, k, n), base);
        }
        assertEq(TrancheLib.amount(total, n, n), total - base * (n - 1));
    }

    /// @dev L-01: tranche tokens are proportional to tranche principal (mulDiv, floor); a
    ///      zero-principal tranche carries zero tokens; per-tranche tokens sum exactly to the
    ///      entitlement (last tranche absorbs the dust).
    function testFuzz_trancheTokensProportionalToPrincipal(uint256 entitlement, uint256 principal, uint8 nRaw) public {
        uint8 n = uint8(bound(nRaw, 1, 32));
        principal = bound(principal, 1, type(uint128).max);
        entitlement = bound(entitlement, 0, type(uint128).max);
        uint256 sum;
        for (uint8 k = 1; k <= n; ++k) {
            uint256 tk = TrancheLib.tokenAmount(entitlement, principal, k, n);
            if (TrancheLib.amount(principal, k, n) == 0) assertEq(tk, 0);
            sum += tk;
        }
        assertEq(sum, entitlement);
    }

    /// @dev integration: fuzzed deposits -> per-position tranche sums == principal & entitlement.
    function testFuzz_positionTranchesSumExactly(uint256 a, uint256 b, uint256 c, uint8 nRaw) public {
        uint8 n = uint8(bound(nRaw, 1, 32));
        a = bound(a, 1, 100_000e6);
        b = bound(b, 0, 100_000e6);
        c = bound(c, 0, 100_000e6);
        // keep under the 200k hard cap
        if (a + b + c > 200_000e6) c = 200_000e6 - a - b;

        createRaise(_cfgWithTranches(n));

        depositAs(alice, a);
        if (b > 0) depositAs(bob, b);
        if (c > 0) depositAs(carol, c);
        vm.warp(block.timestamp + 10 minutes);
        if (raise.totalPrincipal() < 50_000e6) return; // softCap not reached; skip
        raise.startCommitment();

        address[3] memory users = [alice, bob, carol];
        uint256 sumEntitlements;
        for (uint256 i = 0; i < 3; ++i) {
            (uint256 principal,,,, uint256 entitlement,) = raise.positionOf(users[i]);
            uint256 pSum;
            uint256 tSum;
            for (uint8 k = 1; k <= n; ++k) {
                (, uint256 p, uint256 tk,,) = raise.trancheInfo(users[i], k);
                pSum += p;
                tSum += tk;
            }
            assertEq(pSum, principal); // tranches sum exactly to the position
            assertEq(tSum, entitlement);
            sumEntitlements += entitlement;
        }
        // aggregate entitlements never exceed A1 (floor per position)
        assertLe(sumEntitlements, 200_000e18);
    }

    function _cfgWithTranches(uint8 n) internal view returns (RaiseConfig memory cfg) {
        cfg = defaultConfig();
        cfg.numTranches = n;
    }
}
