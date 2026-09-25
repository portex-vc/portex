// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.sol";
import {Raise} from "../src/Raise.sol";
import {DiamondVault} from "../src/DiamondVault.sol";

/// @notice Diamond Vault (§5.5): stake via claim only, weight = tokens × earlyFactor,
///         quote fee rewards, post-migration token streaming, permanent unstake.
contract VaultTest is BaseTest {
    function setUp() public override {
        super.setUp();
        createRaise();
    }

    function test_revert_stakeDirectly() public {
        toGrowth();
        vm.expectRevert(DiamondVault.OnlyRaise.selector);
        vm.prank(alice);
        vault.stake(alice, 1e18, 1e18);
    }

    function test_quoteFeeRewards_accruedPerWeight() public {
        toGrowth();
        claimAs(alice, 1, true); // 25k tokens, ef 2 -> weight 50k
        claimAs(bob, 1, true); // 15k tokens, ef 2 -> weight 30k
        buyAs(whale, 100_000e6); // vault fee share = 300e6
        // alice: 300 * 50/80 = 187.5 ; bob: 112.5
        (uint256 qa,) = vault.pendingRewards(alice);
        (uint256 qb,) = vault.pendingRewards(bob);
        assertEq(qa + qb, 300e6);
        assertEq(qa, 187_500_000); // 187.5 USDG
        assertEq(qb, 112_500_000);
    }

    function test_feesWithNoStakersAreQueuedThenDistributed() public {
        toGrowth();
        buyAs(whale, 100_000e6); // nobody staked yet: 300e6 queued
        assertEq(vault.queuedQuote(), 300e6);
        claimAs(alice, 1, true);
        // first staker alone does not flush the queue (totalWeight was 0 at notify time)
        (uint256 q1,) = vault.pendingRewards(alice);
        assertEq(q1, 0);
        // second stake flushes the queue to existing weight (alice)
        claimAs(bob, 1, true);
        (uint256 q2,) = vault.pendingRewards(alice);
        assertEq(q2, 300e6);
        (uint256 q3,) = vault.pendingRewards(bob);
        assertEq(q3, 0);
    }

    function test_unstake_permanentWeightRemoval() public {
        toGrowth();
        claimAs(alice, 1, true);
        claimAs(bob, 1, true);
        vm.prank(alice);
        vault.unstake(25_000e18);
        (uint256 staked, uint256 weight) = vault.stakeOf(alice);
        assertEq(staked, 0);
        assertEq(weight, 0);
        assertEq(token.balanceOf(alice), 25_000e18); // tokens back in wallet
        // new fees go entirely to bob
        buyAs(whale, 100_000e6);
        (uint256 qa,) = vault.pendingRewards(alice);
        (uint256 qb,) = vault.pendingRewards(bob);
        assertEq(qa, 0);
        assertEq(qb, 300e6);
        // unstaked tokens cannot re-enter: the only entry path is claim(k, stake=true)
        vm.expectRevert(DiamondVault.OnlyRaise.selector);
        vm.prank(alice);
        vault.stake(alice, 25_000e18, 2e18);
    }

    function test_unstake_partial() public {
        toGrowth();
        claimAs(alice, 1, true); // 25k staked, weight 50k
        vm.prank(alice);
        vault.unstake(5_000e18);
        (uint256 staked, uint256 weight) = vault.stakeOf(alice);
        assertEq(staked, 20_000e18);
        assertEq(weight, 40_000e18);
    }

    function test_revert_unstakeTooMuch() public {
        toGrowth();
        claimAs(alice, 1, true);
        vm.expectRevert(DiamondVault.InsufficientStake.selector);
        vm.prank(alice);
        vault.unstake(25_000e18 + 1);
    }

    function test_revert_claimRewardsNothing() public {
        toGrowth();
        vm.expectRevert(DiamondVault.NothingToClaim.selector);
        vm.prank(alice);
        vault.claimRewards();
    }

    function test_claimRewards_paysQuote() public {
        toGrowth();
        claimAs(alice, 1, true);
        buyAs(whale, 100_000e6);
        uint256 before = usdg.balanceOf(alice);
        vm.prank(alice);
        vault.claimRewards();
        assertEq(usdg.balanceOf(alice) - before, 300e6);
    }

    // ---------------- H-01: quote reward access control + delta accounting ----------------

    /// @notice Audit H-01: notifyQuoteReward is pool-only, and even the pool can never credit
    ///         more quote than actually arrived (balance-delta accounting).
    function test_notifyQuoteReward_rejectsNonPool_andCannotOvercredit() public {
        toGrowth();
        claimAs(alice, 1, true); // 25k tokens, ef 2 -> weight 50k
        claimAs(bob, 1, true); // 15k tokens, ef 2 -> weight 30k
        buyAs(whale, 100_000e6); // real fee: 300e6 arrives and is credited

        // 1) a non-pool caller reverts (the audit's forged-reward attack)
        vm.expectRevert(DiamondVault.OnlyPool.selector);
        vm.prank(alice);
        vault.notifyQuoteReward(180e6);

        // 2) a pool call claiming more than arrived credits only what arrived:
        //    100e6 reaches the vault but the notify claims 180e6 -> +100e6, never +180e6
        vm.prank(whale);
        usdg.transfer(address(vault), 100e6);
        vm.prank(address(pool));
        vault.notifyQuoteReward(180e6);

        (uint256 qa,) = vault.pendingRewards(alice);
        (uint256 qb,) = vault.pendingRewards(bob);
        assertEq(qa + qb, 400e6); // 300 real + 100 arrived
        assertEq(usdg.balanceOf(address(vault)), 400e6);
        assertEq(vault.accountedQuote(), 400e6);

        // no freeze: both stakers claim in full and the vault drains exactly to zero
        vm.prank(alice);
        vault.claimRewards();
        assertEq(usdg.balanceOf(alice), 10_000_000e6 - 100_000e6 + 250e6);
        vm.prank(bob);
        vault.claimRewards();
        assertEq(usdg.balanceOf(address(vault)), 0);
        assertEq(vault.accountedQuote(), 0);
    }

    /// @notice H-01 freeze path: a forged notification while nothing is staked must not be
    ///         able to inflate the queue; a real fee queued at totalWeight == 0 still pays the
    ///         first staker correctly at the next accrual event.
    function test_queuedRewards_payFirstStaker_andCannotBeForged() public {
        toGrowth();
        // forge attempt while nothing is staked: reverts (non-pool) ...
        vm.expectRevert(DiamondVault.OnlyPool.selector);
        vm.prank(alice);
        vault.notifyQuoteReward(1_000e6);
        // ... and even via the pool nothing is credited without a real transfer
        vm.prank(address(pool));
        vault.notifyQuoteReward(1_000e6);
        assertEq(vault.queuedQuote(), 0);

        // a real fee with no stakers queues, then pays the first staker at the next accrual
        buyAs(whale, 100_000e6); // 300e6 queued
        assertEq(vault.queuedQuote(), 300e6);
        claimAs(alice, 1, true); // totalWeight == 0 at her stake: queue stays
        claimAs(bob, 1, true); // flush: the queue goes to alice (the existing weight)
        vm.prank(alice);
        vault.claimRewards();
        assertEq(usdg.balanceOf(alice), 10_000_000e6 - 100_000e6 + 300e6);
        assertEq(usdg.balanceOf(address(vault)), 0);
    }

    // ---------------- H-01 residual (delta re-audit): overflow DoS via direct transfer ----------------

    /// @notice The auditor's exact sequence: mint 2^256/1e36 + 1 MockUSDG directly to the vault,
    ///         then a fee-generating buy. Previously `(queued + received) * 1e36` overflowed and
    ///         every fee-generating trade reverted (Stage 2 DoS). Now the buy succeeds and only
    ///         the declared fee is credited; the surplus stays unaccounted and undistributed.
    function test_notifyQuoteReward_hugeDirectTransfer_noOverflow_creditsDeclaredOnly() public {
        toGrowth();
        claimAs(alice, 1, true); // weight 50k
        claimAs(bob, 1, true); // weight 30k

        // 2^256/1e36 + 1 quote-wei — the auditor's overflow threshold
        uint256 huge = type(uint256).max / 1e36 + 1;
        usdg.mint(whale, huge);
        vm.prank(whale);
        usdg.transfer(address(vault), huge);

        // the fee-generating buy must NOT revert and must credit only the declared 300e6
        buyAs(whale, 100_000e6);
        assertEq(vault.accountedQuote(), 300e6);
        (uint256 qa,) = vault.pendingRewards(alice);
        (uint256 qb,) = vault.pendingRewards(bob);
        assertEq(qa, 187_500_000); // 300e6 * 50/80
        assertEq(qb, 112_500_000);

        // claims drain only accounted quote; the surplus remains in the vault, undistributed
        vm.prank(alice);
        vault.claimRewards();
        vm.prank(bob);
        vault.claimRewards();
        assertEq(vault.accountedQuote(), 0);
        assertEq(usdg.balanceOf(address(vault)), huge);

        // a later notify again credits only what the pool declares — the surplus never floods in
        buyAs(whale, 100_000e6);
        assertEq(vault.accountedQuote(), 300e6);
        assertEq(usdg.balanceOf(address(vault)), huge + 300e6);
    }

    /// @notice The min-cap must not change normal accounting: repeated fee/claim cycles settle
    ///         exactly, and `accountedQuote` tracks the vault balance throughout.
    function test_notifyQuoteReward_normalAccountingUnchanged() public {
        toGrowth();
        claimAs(alice, 1, true); // weight 50k
        claimAs(bob, 1, true); // weight 30k

        buyAs(whale, 100_000e6); // vault fee 300e6 -> 187.5 / 112.5
        vm.prank(alice);
        vault.claimRewards();
        assertEq(usdg.balanceOf(alice), 10_000_000e6 - 100_000e6 + 187_500_000);
        assertEq(vault.accountedQuote(), 112_500_000); // bob's share still inside

        buyAs(whale, 50_000e6); // vault fee 150e6 -> 93.75 / 56.25
        assertEq(vault.accountedQuote(), 262_500_000);
        assertEq(usdg.balanceOf(address(vault)), vault.accountedQuote());
        (uint256 qa,) = vault.pendingRewards(alice);
        (uint256 qb,) = vault.pendingRewards(bob);
        assertEq(qa, 93_750_000);
        assertEq(qb, 168_750_000);

        vm.prank(bob);
        vault.claimRewards();
        vm.prank(alice);
        vault.claimRewards();
        assertEq(usdg.balanceOf(address(vault)), 0);
        assertEq(vault.accountedQuote(), 0);
    }

    /// @notice Fuzz over notify/claim/unstake sequences (including huge direct-transfer surplus
    ///         and arbitrary pool-declared amounts): the vault's quote balance must always cover
    ///         the credited-but-unclaimed `accountedQuote`.
    function testFuzz_quoteBalanceAlwaysCoversAccounted(uint256 seed) public {
        toGrowth();
        claimAs(alice, 1, true);
        claimAs(bob, 1, true);
        address[3] memory users = [alice, bob, carol];
        for (uint256 i = 0; i < 32; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            uint256 action = r % 4;
            if (action == 0) {
                // fee-generating buy (pool declares exactly what it sends)
                buyAs(whale, 1e6 + (r % 50_000e6));
            } else if (action == 1) {
                // direct surplus transfer (sometimes the auditor's huge amount) + pool notify
                uint256 surplus = r % 7 == 0 ? type(uint256).max / 1e36 + 1 : r % 1_000e6;
                usdg.mint(whale, surplus);
                vm.prank(whale);
                usdg.transfer(address(vault), surplus);
                vm.prank(address(pool));
                vault.notifyQuoteReward(r % 500e6);
            } else if (action == 2) {
                address u = users[r % 3];
                (uint256 q, uint256 t) = vault.pendingRewards(u);
                if (q > 0 || t > 0) {
                    vm.prank(u);
                    vault.claimRewards();
                }
            } else {
                address u = users[r % 3];
                (uint256 staked,) = vault.stakeOf(u);
                if (staked > 0) {
                    vm.prank(u);
                    vault.unstake(1 + (r % staked));
                }
            }
            assertGe(usdg.balanceOf(address(vault)), vault.accountedQuote());
        }
    }

    // ---------------- token streaming after migration ----------------

    function _migrateWithStakers() internal {
        toGrowth();
        claimAs(alice, 1, true); // weight 50k
        uint64 g0 = raise.growthStart();
        for (uint8 k = 2; k <= 4; ++k) {
            vm.warp(g0 + (k - 2) * 5 minutes);
            commitAs(alice, k);
            commitAs(bob, k);
            commitAs(carol, k);
        }
        buyAs(whale, 50_000e6);
        vm.warp(g0 + 20 minutes);
        raise.graduate();
    }

    function test_tokenStreaming_afterMigration() public {
        _migrateWithStakers();
        assertEq(uint8(raise.state()), uint8(Raise.State.Migrated));
        // half the stream elapsed
        vm.warp(block.timestamp + 10 minutes);
        (uint256 q, uint256 t) = vault.pendingRewards(alice);
        assertGt(q, 0); // quote fees from the whale buy
        assertGt(t, 0);
        assertLe(t, 100_000e18 / 2 + 1e18);
        vm.prank(alice);
        vault.claimRewards();
        // stream fully elapsed; alice already claimed the first half above
        vm.warp(block.timestamp + 20 minutes);
        (, uint256 t2) = vault.pendingRewards(alice);
        // alice is the only staker: the second half of the stream is hers too
        uint256 tol = token.totalSupply() / 10 / 1200 + 1e18; // vaultAlloc/1200 + 1e18
        assertApproxEqAbs(t2, 50_000e18, tol);
        vm.prank(alice);
        vault.claimRewards();
        assertGt(token.balanceOf(alice), 99_000e18);
    }

    function test_emissionsWhileEmptyAreNotDistributed() public {
        toGrowth();
        uint64 g0 = raise.growthStart();
        for (uint8 k = 2; k <= 4; ++k) {
            vm.warp(g0 + (k - 2) * 5 minutes);
            commitAs(alice, k);
            commitAs(bob, k);
            commitAs(carol, k);
        }
        buyAs(whale, 50_000e6);
        vm.warp(g0 + 20 minutes);
        raise.graduate(); // nobody staked
        // half the vault duration passes with zero weight
        vm.warp(block.timestamp + 10 minutes);
        claimAs(alice, 1, true); // tranche 1 was committed in epoch 0; claimable since opening
        vm.warp(block.timestamp + 10 minutes); // rest of the stream
        (, uint256 t) = vault.pendingRewards(alice);
        // only the second half of the stream accrued to alice
        uint256 tol = token.totalSupply() / 10 / 1200 + 1e18; // vaultAlloc/1200 + 1e18
        assertApproxEqAbs(t, 50_000e18, tol);
    }
}
