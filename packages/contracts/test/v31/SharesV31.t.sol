// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TypesV31 as V} from "../../src/v31/TypesV31.sol";
import {StorageV31 as S} from "../../src/v31/StorageV31.sol";

/// @notice Isolate PS §6 share/index degeneracies independently of governance timing.
contract ShareHarnessV31 {
    using S for S.State;
    S.State private s;

    function initialize(uint256[3] calldata shares, uint256 index, uint256 escrow) external {
        s.templateId = V.BUDGET_LAUNCH;
        s.phase = V.Phase.Stage2;
        s.J = index;
        s.book.E = escrow;
        s.H = 0;
        s.eligibleShares = 0;
        s.claimCount = 0;
        for (uint256 i; i < 3; ++i) {
            s.positions[i] = V.Position(address(uint160(i + 1)), V.Class.Backer, 1e18, shares[i], shares[i], shares[i]);
            s.H += shares[i];
            s.eligibleShares += shares[i];
            if (shares[i] != 0) ++s.claimCount;
        }
    }

    function exit(uint256 id, uint256 q) external returns (uint256 cost) {
        V.Position storage p = s.positions[id];
        uint256 basis = s.basis(p);
        cost = q == p.tokens ? basis : Math.mulDiv(basis, q, p.tokens);
        s.reduceShares(p, q, cost, basis);
        s.book.E -= cost;
        p.tokens -= q;
    }

    function draw(uint256 amount) external {
        s.J = Math.min(s.J, Math.mulDiv(s.book.E - amount, V.SCALE, s.H));
        s.book.E -= amount;
    }

    function basisOf(uint256 id) external view returns (uint256) {
        return s.basis(s.positions[id]);
    }

    function sharesOf(uint256 id) external view returns (uint256) {
        return s.positions[id].shares;
    }

    function state() external view returns (uint256 escrow, uint256 H, uint256 J, uint256 count) {
        return (s.book.E, s.H, s.J, s.claimCount);
    }
}

contract SharesV31Test is Test {
    ShareHarnessV31 internal harness = new ShareHarnessV31();

    function test_zeroIndex_partialZeroCostKeepsShares_finalClaimTakesDust() public {
        harness.initialize([uint256(1e24), 2e24, 3e24], 0, 7);
        assertEq(harness.exit(0, 1), 0);
        assertEq(harness.sharesOf(0), 1e24);
        assertEq(harness.exit(0, 1e18 - 1), 0);
        assertEq(harness.exit(1, 1e18), 0);
        assertEq(harness.basisOf(2), 7);
        assertEq(harness.exit(2, 1e18), 7);
        (uint256 e, uint256 h,, uint256 count) = harness.state();
        assertEq(e + h + count, 0);
    }

    function testFuzz_haircutAndPartialRemainder(
        uint256 a,
        uint256 b,
        uint256 c,
        uint256 drawSeed,
        uint256 quantitySeed
    ) public {
        uint256[3] memory shares = [bound(a, 1, 1e30), bound(b, 1, 1e30), bound(c, 1, 1e30)];
        uint256 initial = shares[0] + shares[1] + shares[2];
        harness.initialize(shares, V.SCALE, initial);
        uint256 draw = bound(drawSeed, 0, initial);
        harness.draw(draw);
        uint256 basis = harness.basisOf(0);
        uint256 other1 = harness.basisOf(1);
        uint256 other2 = harness.basisOf(2);
        uint256 q = bound(quantitySeed, 1, 1e18 - 1);
        uint256 paid = harness.exit(0, q);
        assertEq(paid, Math.mulDiv(basis, q, 1e18));
        assertEq(harness.basisOf(0), basis - paid);
        assertEq(harness.basisOf(1), other1);
        assertEq(harness.basisOf(2), other2);
        paid += harness.exit(0, 1e18 - q);
        paid += harness.exit(1, 1e18);
        paid += harness.exit(2, 1e18);
        assertEq(paid + draw, initial);
        (uint256 escrow, uint256 H,, uint256 count) = harness.state();
        assertEq(escrow + H + count, 0);
    }
}
