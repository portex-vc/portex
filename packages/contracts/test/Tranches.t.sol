// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.sol";
import {Raise} from "../src/Raise.sol";

/// @notice Tranche mechanics (§5.2): commit/claim/redeem, epoch gating, opt-in gate, dust.
contract TranchesTest is BaseTest {
    function setUp() public override {
        super.setUp();
        createRaise();
    }

    // ---------------- commit gating ----------------

    function test_commit_tranche1InEpoch0() public {
        toCommitment();
        commitAs(alice, 1);
        (uint8 st, uint256 principal, uint256 tokens, uint64 commitTime,) = raise.trancheInfo(alice, 1);
        assertEq(st, 1); // Committed
        assertEq(principal, 25_000e6); // 100k / 4
        assertEq(tokens, 25_000e18);
        assertEq(commitTime, uint64(block.timestamp));
        assertEq(raise.committedPrincipal(), 25_000e6);
        // escrow unchanged while the pool is not open
        assertEq(usdg.balanceOf(address(raise)), 200_000e6);
    }

    function test_revert_commitTranche2InEpoch0() public {
        toCommitment();
        vm.expectRevert(Raise.EpochNotReached.selector);
        vm.prank(alice);
        raise.commit(2);
    }

    function test_revert_commitAfterWindowBeforeOpen() public {
        toCommitment();
        commitAs(alice, 1);
        vm.warp(block.timestamp + 5 minutes); // window over, openGrowth not called
        vm.expectRevert(Raise.CommitmentWindowEnded.selector);
        vm.prank(bob); // bob's tranche 1 is still Locked, but the window is closed
        raise.commit(1);
    }

    function test_revert_commitTwice() public {
        toCommitment();
        commitAs(alice, 1);
        vm.expectRevert(Raise.TrancheNotLocked.selector);
        vm.prank(alice);
        raise.commit(1);
    }

    function test_revert_commitInvalidTranche() public {
        toCommitment();
        vm.expectRevert(Raise.InvalidTranche.selector);
        vm.prank(alice);
        raise.commit(0);
        vm.expectRevert(Raise.InvalidTranche.selector);
        vm.prank(alice);
        raise.commit(5); // N = 4
    }

    function test_commitMany_epoch0OnlyTranche1Possible() public {
        toCommitment();
        vm.expectRevert(Raise.EpochNotReached.selector); // mask includes tranche 2
        vm.prank(alice);
        raise.commitMany(
            0x3 /* tranches 1,2 */
        );
        vm.prank(alice);
        raise.commitMany(
            0x1 /* tranche 1 */
        );
        (uint8 st,,,,) = raise.trancheInfo(alice, 1);
        assertEq(st, 1);
    }

    // ---------------- openGrowth opt-in gate ----------------

    function test_openGrowth_passesAtExactlyMinOptIn() public {
        // alice 100k -> t1 25k; make alice commit t1 and bob not -> 25k/75k... use two users.
        depositAs(alice, 100_000e6);
        depositAs(bob, 60_000e6);
        vm.warp(block.timestamp + 10 minutes);
        raise.startCommitment();
        // eligible t1 = 160k/4 = 40k; 30% = 12k. alice's t1 = 25k >= 12k -> passes.
        commitAs(alice, 1);
        vm.warp(block.timestamp + 5 minutes);
        raise.openGrowth();
        assertEq(uint8(raise.state()), uint8(Raise.State.Growth));
        (uint256 r, uint256 v, uint256 t) = pool.reserves();
        assertEq(r, 25_000e6);
        // V0 = P_tot * T0 / A1 = 160k * 2 = 320k; V = 320k - 25k
        assertEq(v, 295_000e6);
        assertEq(t, 400_000e18);
        assertEq(token.balanceOf(address(pool)), 400_000e18);
        assertEq(token.balanceOf(address(vault)), 100_000e18);
        // escrow = totalPrincipal - committed
        assertEq(usdg.balanceOf(address(raise)), 160_000e6 - 25_000e6);
        // pool opened at the flat price b = 1 USDG/token: bookPrice = Q/T
        assertEq(pool.bookPrice(), uint256(320_000e6) * 1e18 / 400_000e18);
    }

    function test_openGrowth_belowMinOptIn_failsAndRefunds() public {
        depositAs(alice, 100_000e6);
        depositAs(bob, 60_000e6);
        depositAs(carol, 40_000e6);
        vm.warp(block.timestamp + 10 minutes);
        raise.startCommitment();
        // eligible tranche-1 principal = 200k/4 = 50k; need 30% = 15k committed.
        // Only carol commits her tranche 1 (10k) -> 10k < 15k -> the raise fails.
        commitAs(carol, 1);
        vm.warp(block.timestamp + 5 minutes);
        raise.openGrowth();
        assertEq(uint8(raise.state()), uint8(Raise.State.Failed));
        // full refunds, including carol's committed principal
        withdrawAs(alice, 100_000e6);
        withdrawAs(bob, 60_000e6);
        withdrawAs(carol, 40_000e6);
        assertEq(usdg.balanceOf(alice), 10_000_000e6);
        assertEq(usdg.balanceOf(carol), 10_000_000e6);
        assertEq(usdg.balanceOf(address(raise)), 0);
    }

    // ---------------- claim timing ----------------

    function test_claim_epoch0CommitAtPoolOpening() public {
        toGrowth();
        claimAs(alice, 1, false);
        assertEq(token.balanceOf(alice), 25_000e18);
        (uint8 st,,,,) = raise.trancheInfo(alice, 1);
        assertEq(st, 2); // Claimed
    }

    function test_claim_epoch0CommitStakeToVault() public {
        toGrowth();
        claimAs(alice, 1, true);
        assertEq(token.balanceOf(alice), 0);
        (uint256 staked, uint256 weight) = vault.stakeOf(alice);
        assertEq(staked, 25_000e18);
        // alice deposited at t=0 -> earlyFactor 2x
        assertEq(weight, 50_000e18);
        assertEq(vault.totalStaked(), 25_000e18);
    }

    function test_claim_laterCommitAfterLag() public {
        toGrowth();
        claimAs(alice, 1, false); // epoch-0 commit: claimable at pool opening
        // epoch 1: tranche 2 committable immediately
        commitAs(alice, 2);
        // not claimable until commitTime + epochLength
        vm.expectRevert(Raise.NotClaimable.selector);
        vm.prank(alice);
        raise.claim(2, false);
        vm.warp(block.timestamp + 5 minutes);
        claimAs(alice, 2, false);
        assertEq(token.balanceOf(alice), 50_000e18);
    }

    function test_revert_claimLockedTranche() public {
        toGrowth();
        vm.expectRevert(Raise.TrancheNotCommitted.selector);
        vm.prank(alice);
        raise.claim(2, false);
    }

    function test_revert_claimTwice() public {
        toGrowth();
        claimAs(alice, 1, false);
        vm.expectRevert(Raise.TrancheNotCommitted.selector);
        vm.prank(alice);
        raise.claim(1, false);
    }

    function test_claimMany() public {
        toGrowth();
        commitAs(alice, 2);
        vm.warp(block.timestamp + 5 minutes);
        vm.prank(alice);
        raise.claimMany(
            0x3,
            /* tranches 1,2 */
            false
        ); // tranches 1 and 2
        assertEq(token.balanceOf(alice), 50_000e18);
    }

    // ---------------- redeem ----------------

    function test_redeem_returnsPrincipalAndBurnsTokens() public {
        toCommitment();
        uint256 supplyBefore = token.totalSupply();
        redeemAs(alice, 4); // last tranche
        assertEq(usdg.balanceOf(alice), 10_000_000e6 - 100_000e6 + 25_000e6);
        assertEq(raise.principalOf(alice), 75_000e6);
        assertEq(token.totalSupply(), supplyBefore - 25_000e18);
        (uint8 st,,,,) = raise.trancheInfo(alice, 4);
        assertEq(st, 3); // Redeemed
        assertEq(usdg.balanceOf(address(raise)), 175_000e6);
    }

    function test_redeem_inGrowth() public {
        toGrowth();
        redeemAs(alice, 4);
        assertEq(raise.principalOf(alice), 75_000e6);
        assertEq(usdg.balanceOf(address(raise)), 200_000e6 - 50_000e6 - 25_000e6); // escrow excl. committed
    }

    // ---------------- redeem after migration (full drive) ----------------

    function test_redeem_afterMigration() public {
        toGrowth();
        uint64 g0 = raise.growthStart();
        // commit everything for alice/bob, carol commits 1..3 (keeps 4 locked)
        for (uint8 k = 2; k <= 4; ++k) {
            vm.warp(g0 + (k - 2) * 5 minutes);
            commitAs(alice, k);
            commitAs(bob, k);
            if (k < 4) commitAs(carol, k);
        }
        buyAs(whale, 50_000e6); // push real ratio above 50%
        vm.warp(g0 + 20 minutes); // all N=4 epochs elapsed
        raise.graduate();
        assertEq(uint8(raise.state()), uint8(Raise.State.Migrated));
        // carol redeems her locked tranche 4 after Stage 3
        uint256 balBefore = usdg.balanceOf(carol);
        redeemAs(carol, 4);
        assertEq(usdg.balanceOf(carol) - balBefore, 10_000e6); // 40k/4
        // locked tranches can no longer commit after migration
        vm.expectRevert(Raise.InvalidState.selector);
        vm.prank(carol);
        raise.commit(4);
    }

    function test_redeemMany() public {
        toCommitment();
        vm.prank(alice);
        raise.redeemMany(
            0xE /* tranches 2,3,4 */
        ); // tranches 2,3,4
        assertEq(raise.principalOf(alice), 25_000e6);
        commitAs(alice, 1);
    }

    function test_revert_redeemCommittedTranche() public {
        toCommitment();
        commitAs(alice, 1);
        vm.expectRevert(Raise.TrancheNotLocked.selector);
        vm.prank(alice);
        raise.redeem(1);
    }

    function test_revert_redeemInIncubation() public {
        depositAs(alice, 100_000e6);
        vm.expectRevert(Raise.InvalidState.selector);
        vm.prank(alice);
        raise.redeem(1);
    }

    // ---------------- dust / exact sums ----------------

    function test_trancheDust_lastTrancheAbsorbs() public {
        depositAs(alice, 100_000_000_007); // 100000.000007 USDG — not divisible by 4, >= softCap
        depositAs(bob, 50_000e6);
        vm.warp(block.timestamp + 10 minutes);
        raise.startCommitment();
        uint256 snap = raise.principalOf(alice);
        uint256 sum;
        for (uint8 k = 1; k <= 4; ++k) {
            (, uint256 p, uint256 tk,,) = raise.trancheInfo(alice, k);
            sum += p;
            if (k < 4) assertEq(p, snap / 4);
            if (k == 4) assertEq(p, snap - 3 * (snap / 4));
        }
        assertEq(sum, snap);
        uint256 ent = raise.tokenEntitlementOf(alice);
        uint256 tsum;
        for (uint8 k = 1; k <= 4; ++k) {
            (,, uint256 tk,,) = raise.trancheInfo(alice, k);
            tsum += tk;
        }
        assertEq(tsum, ent);
    }

    /// @notice Audit L-01: a position with principal < numTranches has dust-only tranches that
    ///         carry ZERO tokens — committing/claiming them yields nothing — while the last
    ///         tranche still carries the full entitlement. Tranche sums stay exact.
    function test_dustOnlyTranches_carryNoTokens() public {
        depositAs(alice, 100_000e6); // carries the softCap
        depositAs(bob, 2); // 2 wei of principal < 4 tranches
        vm.warp(block.timestamp + 10 minutes);
        raise.startCommitment();

        uint256 bobEnt = raise.tokenEntitlementOf(bob);
        assertGt(bobEnt, 0);
        uint256 pSum;
        for (uint8 k = 1; k <= 4; ++k) {
            (, uint256 p, uint256 tk,,) = raise.trancheInfo(bob, k);
            pSum += p;
            if (k < 4) {
                assertEq(p, 0);
                assertEq(tk, 0); // zero-principal tranche -> zero tokens
            } else {
                assertEq(tk, bobEnt); // last tranche carries the whole entitlement
            }
        }
        assertEq(pSum, 2);

        // committing a dust tranche moves no principal into the opt-in gate
        commitAs(bob, 1);
        assertEq(raise.committedPrincipal(), 0);
        commitAs(alice, 1);
        vm.warp(block.timestamp + 5 minutes);
        raise.openGrowth();

        // claiming the dust tranche pays exactly zero tokens
        claimAs(bob, 1, false);
        assertEq(token.balanceOf(bob), 0);

        // the last tranche still works and pays the full entitlement
        uint64 g0 = raise.growthStart();
        vm.warp(g0 + 10 minutes); // epoch 3: tranche 4 committable
        commitAs(bob, 4);
        vm.warp(block.timestamp + 5 minutes); // claim lag
        claimAs(bob, 4, false);
        assertEq(token.balanceOf(bob), bobEnt);
    }

    // ---------------- epoch schedule ----------------

    function test_epochSchedule() public {
        toGrowth();
        uint64 g0 = raise.growthStart();
        assertEq(raise.currentEpoch(), 1);
        vm.warp(g0 + 5 minutes);
        assertEq(raise.currentEpoch(), 2);
        // tranche 3 committable at epoch 2
        commitAs(alice, 3);
        vm.expectRevert(Raise.EpochNotReached.selector);
        vm.prank(alice);
        raise.commit(4);
        vm.warp(g0 + 10 minutes); // epoch 3
        commitAs(alice, 4);
    }

    function test_revert_commitInIncubation() public {
        depositAs(alice, 100_000e6);
        vm.expectRevert(Raise.InvalidState.selector);
        vm.prank(alice);
        raise.commit(1);
    }
}
