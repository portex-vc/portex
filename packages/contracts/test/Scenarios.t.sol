// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.sol";
import {Raise} from "../src/Raise.sol";

/// @notice Design §9 scenario tests at the contract level: S1, S2, S4, S5, S6.
contract ScenarioTest is BaseTest {
    function setUp() public override {
        super.setUp();
        createRaise();
    }

    // ================= S1: happy path, strong Stage 2 demand =================

    function test_S1_happyPathStrongDemand() public {
        // Stage 1: three backers fill the raise
        depositAs(alice, 100_000e6);
        depositAs(bob, 60_000e6);
        depositAs(carol, 40_000e6);
        vm.warp(block.timestamp + 10 minutes);
        raise.startCommitment();

        // epoch 0: everyone commits tranche 1 (50% opt-in > 30%)
        commitAs(alice, 1);
        commitAs(bob, 1);
        commitAs(carol, 1);
        vm.warp(block.timestamp + 5 minutes);
        raise.openGrowth();
        assertEq(uint8(raise.state()), uint8(Raise.State.Growth));

        // alice stakes her tranche-1 tokens in the Diamond Vault (ef=2)
        claimAs(alice, 1, true);
        claimAs(bob, 1, false);

        // strong demand: whale buys 300k USDG of tokens
        uint256 whaleOut = buyAs(whale, 300_000e6);
        assertGt(whaleOut, 0);
        assertGt(pool.bookPrice(), 1e6); // price moved off b = 1 USDG/token

        // Growth epochs: remaining tranches commit (carol keeps tranche 4 locked)
        uint64 g0 = raise.growthStart();
        commitAs(alice, 2);
        commitAs(bob, 2);
        commitAs(carol, 2);
        vm.warp(g0 + 5 minutes);
        commitAs(alice, 3);
        commitAs(bob, 3);
        commitAs(carol, 3);
        vm.warp(g0 + 10 minutes);
        commitAs(alice, 4);
        commitAs(bob, 4);

        // claims after the 1-epoch lag
        vm.warp(g0 + 15 minutes);
        claimAs(alice, 2, true);
        claimAs(bob, 2, false);
        claimAs(carol, 2, false);

        // bob sells his claimed tokens into the pool: profit comes from the whale's money
        uint256 bobBefore = usdg.balanceOf(bob);
        sellAs(bob, 30_000e18); // tranches 1+2 (15k tokens each)
        uint256 bobProceeds = usdg.balanceOf(bob) - bobBefore;
        assertGt(bobProceeds, 30_000e6); // > principal of those tranches

        // vault earned quote fees
        (uint256 aliceQ,) = vault.pendingRewards(alice);
        assertGt(aliceQ, 0);

        // graduate after all N epochs elapsed
        vm.warp(g0 + 20 minutes);
        (uint256 r,,) = pool.reserves();
        assertGe(r, 20_000e6);
        assertGe(pool.realRatioBps(), 5000);
        uint256 bookBefore = pool.bookPrice();
        raise.graduate();
        assertEq(uint8(raise.state()), uint8(Raise.State.Migrated));

        // migration seeded the DEX at the book price (continuous)
        (uint256 qRes, uint256 tRes) = adapter.getReserves(address(token));
        assertGt(qRes, 0);
        assertGt(tRes, 0);
        assertApproxEqRel(qRes * 1e18 / tRes, bookBefore, 0.01e18);

        // Stage 3 trading works on the adapter both directions
        vm.startPrank(whale);
        usdg.approve(address(adapter), 10_000e6);
        uint256 out3 = adapter.swapExactQuoteForTokens(address(token), 10_000e6, 0, whale);
        token.approve(address(adapter), out3);
        uint256 back3 = adapter.swapExactTokensForQuote(address(token), out3, 0, whale);
        assertLt(back3, 10_000e6);
        vm.stopPrank();

        // carol redeems her locked tranche 4 after migration: 1:1 in kind
        uint256 carolBefore = usdg.balanceOf(carol);
        redeemAs(carol, 4);
        assertEq(usdg.balanceOf(carol) - carolBefore, 10_000e6);

        // vault token stream pays holders after migration
        vm.warp(block.timestamp + 21 minutes);
        (, uint256 aliceT) = vault.pendingRewards(alice);
        assertGt(aliceT, 0);
        uint256 aliceTokBefore = token.balanceOf(alice);
        uint256 aliceQBefore = usdg.balanceOf(alice);
        vm.prank(alice);
        vault.claimRewards();
        assertGt(token.balanceOf(alice), aliceTokBefore);
        assertGt(usdg.balanceOf(alice), aliceQBefore);

        // builder vesting: linear over 20 min from migration
        vm.warp(block.timestamp + 20 minutes);
        raise.claimBuilderVested();
        assertEq(token.balanceOf(builder), 300_000e18);

        // builder fee share from Stage 2 swaps
        pool.claimBuilderFees();
        assertGt(usdg.balanceOf(builder), 10_000_000e6);
    }

    // ================= S2: gates never met =================

    function test_S2_gatesNeverMet_fullRefunds() public {
        depositAs(alice, 30_000e6); // below softCap
        depositAs(bob, 10_000e6);
        vm.warp(block.timestamp + 31 minutes); // deadline passes with gates unmet
        raise.fail();
        assertEq(uint8(raise.state()), uint8(Raise.State.Failed));
        withdrawAs(alice, 30_000e6);
        withdrawAs(bob, 10_000e6);
        assertEq(usdg.balanceOf(alice), 10_000_000e6);
        assertEq(usdg.balanceOf(bob), 10_000_000e6);
        assertEq(usdg.balanceOf(address(raise)), 0);
        // builder resets cleanly: nothing owed, nothing vested
        assertEq(token.balanceOf(builder), 0);
    }

    // ================= S4: no Stage 2 demand, mass exit =================

    function test_S4_noDemand_massExit() public {
        depositAs(alice, 100_000e6);
        depositAs(bob, 60_000e6);
        depositAs(carol, 40_000e6);
        vm.warp(block.timestamp + 10 minutes);
        raise.startCommitment();

        // only alice commits tranche 1: 25k of 50k eligible = 50% > 30% -> pool opens
        commitAs(alice, 1);
        vm.warp(block.timestamp + 5 minutes);
        raise.openGrowth();

        // no Stage 2 demand at all. Alice claims and sells her tranche-1 tokens.
        claimAs(alice, 1, false);
        uint256 aliceBefore = usdg.balanceOf(alice);
        uint256 got = sellAs(alice, 25_000e18);
        // opted-in tranche loses only slippage + fee: slightly less than the 25k principal
        // (selling 1/16 of the pool's token depth costs ~6.8% here)
        assertLt(got, 25_000e6);
        assertGt(got, 23_000e6);
        assertEq(usdg.balanceOf(alice), aliceBefore + got);

        // everyone mass-exits via redeem: 100% of protected principal intact
        redeemAs(bob, 1);
        redeemAs(bob, 2);
        redeemAs(bob, 3);
        redeemAs(bob, 4);
        redeemAs(carol, 1);
        redeemAs(carol, 2);
        redeemAs(carol, 3);
        redeemAs(carol, 4);
        redeemAs(alice, 2);
        redeemAs(alice, 3);
        redeemAs(alice, 4);
        assertEq(usdg.balanceOf(bob), 10_000_000e6);
        assertEq(usdg.balanceOf(carol), 10_000_000e6);
        assertEq(usdg.balanceOf(alice), 10_000_000e6 - 25_000e6 + got);

        // pool remains solvent: nothing left outside, R/V consistent
        (uint256 r, uint256 v,) = pool.reserves();
        assertEq(usdg.balanceOf(address(pool)), r + pool.builderAccrued());
        assertGe(v, 0);
        // escrow only ever held exactly the protected principal
        assertEq(usdg.balanceOf(address(raise)), 0);

        // graduation is impossible without liquidity: the pool just keeps running
        vm.warp(raise.growthStart() + 20 minutes);
        vm.expectRevert(Raise.GraduationNotReady.selector);
        raise.graduate();
    }

    // ================= S5: whale pumps early Stage 2, tranches unlock into it =================

    function test_S5_whalePumps_backersSellIntoIt() public {
        depositAs(alice, 100_000e6);
        depositAs(bob, 60_000e6);
        depositAs(carol, 40_000e6);
        vm.warp(block.timestamp + 10 minutes);
        raise.startCommitment();
        commitAs(alice, 1);
        commitAs(bob, 1);
        commitAs(carol, 1);
        vm.warp(block.timestamp + 5 minutes);
        raise.openGrowth();

        // whale pumps hard at the open
        uint256 whalePaid = 200_000e6;
        uint256 whaleTokens = buyAs(whale, whalePaid);
        uint256 priceAfterPump = pool.bookPrice();
        assertGt(priceAfterPump, 2e6); // more than doubled

        // tranches unlock epoch by epoch; backers commit, wait the lag, claim and sell into it
        uint64 g0 = raise.growthStart();
        uint256 backerProceeds;
        for (uint8 k = 2; k <= 4; ++k) {
            vm.warp(g0 + (k - 2) * 5 minutes);
            commitAs(alice, k);
            commitAs(bob, k);
            commitAs(carol, k);
        }
        vm.warp(g0 + 15 minutes); // all claims available
        address[3] memory backers = [alice, bob, carol];
        uint256[3] memory principals = [uint256(100_000e6), 60_000e6, 40_000e6];
        for (uint256 i = 0; i < 3; ++i) {
            uint256 before = usdg.balanceOf(backers[i]);
            for (uint8 k = 1; k <= 4; ++k) {
                claimAs(backers[i], k, false);
            }
            sellAs(backers[i], token.balanceOf(backers[i])); // sell the whole position
            backerProceeds += usdg.balanceOf(backers[i]) - before;
        }
        // backers sold 200k principal of tokens into the whale's pump: profit > 0
        assertGt(backerProceeds, 200_000e6);

        // the whale dumps everything last
        uint256 whaleBefore = usdg.balanceOf(whale);
        sellAs(whale, token.balanceOf(whale));
        uint256 whaleBack = usdg.balanceOf(whale) - whaleBefore;
        // whale pays: he gets back strictly less than he put in
        assertLt(whaleBack, whalePaid);

        // pool is solvent and consistent after everything
        (uint256 r, uint256 v, uint256 t) = pool.reserves();
        assertEq(usdg.balanceOf(address(pool)), r + pool.builderAccrued());
        uint256 outside = token.totalSupply() - t - token.balanceOf(address(raise)) - token.balanceOf(address(vault));
        if (outside > 0) {
            uint256 q = r + v;
            uint256 newQ = (q * t) / (t + outside) + (((q * t) % (t + outside)) != 0 ? 1 : 0);
            assertLe(q - newQ, r);
        }
    }

    // ================= S6: opt-in below minOptInBps =================

    function test_S6_optInTooLow_stage2NeverOpens() public {
        depositAs(alice, 100_000e6);
        depositAs(bob, 60_000e6);
        depositAs(carol, 40_000e6);
        vm.warp(block.timestamp + 10 minutes);
        raise.startCommitment();

        // only carol commits her tranche 1: 10k of 50k eligible = 20% < 30%
        commitAs(carol, 1);
        vm.warp(block.timestamp + 5 minutes);
        raise.openGrowth(); // -> Failed
        assertEq(uint8(raise.state()), uint8(Raise.State.Failed));

        // full refunds for everyone, including carol's committed tranche
        withdrawAs(alice, 100_000e6);
        withdrawAs(bob, 60_000e6);
        withdrawAs(carol, 40_000e6);
        assertEq(usdg.balanceOf(alice), 10_000_000e6);
        assertEq(usdg.balanceOf(bob), 10_000_000e6);
        assertEq(usdg.balanceOf(carol), 10_000_000e6);
        assertEq(usdg.balanceOf(address(raise)), 0);
    }
}
