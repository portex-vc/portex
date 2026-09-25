// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseV31} from "./BaseV31.sol";
import {TypesV31 as V} from "../../src/v31/TypesV31.sol";
import {ProjectTokenV31} from "../../src/v31/ProjectTokenV31.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

contract RewardsV31Test is BaseV31 {
    function test_lazyMaterialization_preservesSupplyAndVisibleBalances() public {
        _setupListed();
        uint256 supply = token.totalSupply();
        uint256 original = token.balanceOf(backers[0]);
        uint256 pending = token.pendingDelivery();
        uint256 buyerBefore = token.balanceOf(buyer);
        uint256 nonce = raise.stateNonce();
        vm.prank(backers[0]);
        token.transfer(buyer, original / 2);
        assertEq(token.balanceOf(backers[0]), original - original / 2);
        assertEq(token.balanceOf(buyer), buyerBefore + original / 2);
        assertEq(token.pendingDelivery(), pending - original);
        assertEq(token.totalSupply(), supply);
        assertEq(token.balanceOf(address(raise)), 0);
        assertEq(raise.stateNonce(), nonce);
        _assertBook();
    }

    function test_transferCheckpointThenDestroy_recipientGetsZeroQuota() public {
        _setupListed();
        vm.warp(token.listedAt() + 10 days);
        uint256 quota = token.quotaOf(backers[0]);
        (uint256 expectedTokens, uint256 expectedQuote) = token.pendingRewards(backers[0]);
        uint256 weight = token.totalQuota();
        vm.prank(backers[0]);
        token.transfer(buyer, quota);
        assertEq(token.quotaOf(backers[0]), 0);
        assertEq(token.quotaOf(buyer), 0);
        assertEq(token.totalQuota(), weight - quota);
        vm.warp(token.listedAt() + 20 days);
        (uint256 earnedTokens, uint256 earnedQuote) = token.pendingRewards(backers[0]);
        assertEq(earnedTokens, expectedTokens);
        assertEq(earnedQuote, expectedQuote);
        vm.prank(backers[0]);
        token.claimRewards();
        assertEq(token.quotaOf(backers[0]), 0);
        assertEq(token.balanceOf(backers[0]), expectedTokens);
    }

    function test_selfTransfer_destroysQuotaEvenWithMixedReceipts() public {
        _setupListed();
        uint256 initialQuota = token.quotaOf(backers[0]);
        vm.prank(treasury);
        token.transfer(backers[0], 100e18);
        assertEq(token.quotaOf(backers[0]), initialQuota);
        uint256 balance = token.balanceOf(backers[0]);
        vm.prank(backers[0]);
        token.transfer(backers[0], 50e18);
        assertEq(token.quotaOf(backers[0]), initialQuota - 50e18);
        assertEq(token.balanceOf(backers[0]), balance);
        vm.prank(backers[0]);
        token.transfer(buyer, 100e18);
        assertEq(token.quotaOf(backers[0]), initialQuota - 150e18);
        assertEq(token.quotaOf(buyer), 0);
    }

    function test_transferFrom_quotaFirstAndRaiseNonceUnchanged() public {
        _setupListed();
        uint256 quota = token.quotaOf(backers[0]);
        uint256 nonce = raise.stateNonce();
        vm.prank(backers[0]);
        token.approve(buyer, 1e18);
        assertEq(raise.stateNonce(), nonce);
        vm.prank(buyer);
        token.transferFrom(backers[0], buyer, 1e18);
        assertEq(raise.stateNonce(), nonce);
        assertEq(token.quotaOf(backers[0]), quota - 1e18);
        assertEq(token.quotaOf(buyer), 0);
    }

    function test_buyerAndBackerAtSameAddress_keepClassesSeparate() public {
        _create(false);
        _fund();
        _open();
        uint256 original = raise.positionState(ids[0]).tokens;
        uint256 bought = _buy(backers[0], 1000e6);
        _list();
        assertEq(token.balanceOf(backers[0]), original + bought);
        assertEq(token.quotaOf(backers[0]), original);
        vm.prank(backers[0]);
        token.transfer(buyer, 1e18);
        assertEq(token.quotaOf(backers[0]), original - 1e18);
    }

    function test_dailyRelease_beforeDayBoundaryAndAtEnd() public {
        _setupListed();
        vm.warp(token.listedAt() + 1 days - 1);
        (uint256 a, uint256 q) = token.pendingRewards(backers[0]);
        assertEq(a, 0);
        assertEq(q, 0);
        vm.warp(token.listedAt() + 1 days);
        token.checkpoint(backers[0]);
        (ProjectTokenV31.Stream memory ts, ProjectTokenV31.Stream memory qs) = token.rewardState();
        assertEq(ts.released, Math.mulDiv(ts.allocation, 1, 1095));
        assertEq(qs.released, Math.mulDiv(qs.allocation, 1, 1095));
        vm.warp(token.listedAt() + 1095 days);
        token.checkpoint(backers[0]);
        (ts, qs) = token.rewardState();
        assertEq(ts.released, ts.allocation);
        assertEq(qs.released, qs.allocation);
    }

    function test_rewardClaims_leaveQuotaUnchanged_andDoNotMint() public {
        _setupListed();
        vm.warp(token.listedAt() + 100 days);
        uint256 quota = token.quotaOf(backers[0]);
        uint256 supply = token.totalSupply();
        uint256 weight = token.totalQuota();
        (uint256 tokens, uint256 usd) = token.pendingRewards(backers[0]);
        uint256 beforeT = token.balanceOf(backers[0]);
        uint256 beforeQ = quote.balanceOf(backers[0]);
        uint256 nonce = raise.stateNonce();
        vm.prank(backers[0]);
        token.claimRewards();
        assertEq(token.balanceOf(backers[0]) - beforeT, tokens);
        assertEq(quote.balanceOf(backers[0]) - beforeQ, usd);
        assertEq(token.quotaOf(backers[0]), quota);
        assertEq(token.totalQuota(), weight);
        assertEq(token.totalSupply(), supply);
        assertEq(raise.stateNonce(), nonce);
        _assertBook();
    }

    function test_zeroQuotaAtListing_burnAllocation_routeOnlyRewardFees() public {
        _create(false);
        _fund();
        _open();
        _buy(buyer, 10000e6);
        for (uint256 i; i < 10; ++i) {
            _exit(ids[i], raise.positionState(ids[i]).tokens, false);
        }
        (, uint256 rewards, uint256 treasuryFees) = raise.feeAccruals();
        assertGt(rewards, 0);
        _list();
        assertTrue(token.disposed());
        assertEq(token.balanceOf(address(token)), 0);
        assertEq(quote.balanceOf(treasury), 0);
        assertEq(token.disposedQuote(), rewards);
        assertEq(token.claimDisposed(), rewards);
        assertEq(quote.balanceOf(treasury), rewards);
        raise.claimTreasuryFees();
        assertEq(quote.balanceOf(treasury), rewards + treasuryFees);
        _assertBook();
    }

    function test_quotaLaterZero_preservesAllCreditedClaims() public {
        _setupListed();
        vm.warp(token.listedAt() + 100 days);
        for (uint256 i; i < 10; ++i) {
            uint256 balance = token.balanceOf(backers[i]);
            vm.prank(backers[i]);
            token.transfer(buyer, balance);
        }
        assertTrue(token.disposed());
        assertEq(token.totalQuota(), 0);
        (ProjectTokenV31.Stream memory ts, ProjectTokenV31.Stream memory qs) = token.rewardState();
        assertEq(ts.remaining, ts.credited);
        assertEq(qs.remaining, qs.credited);
        for (uint256 i; i < 10; ++i) {
            vm.prank(backers[i]);
            token.claimRewards();
        }
        assertEq(token.balanceOf(address(token)), 0);
        if (token.disposedQuote() != 0) token.claimDisposed();
        assertEq(quote.balanceOf(address(token)), 0);
        _assertBook();
    }

    function test_finalDust_waitsForAllOriginalHolderEntitlements() public {
        _setupListed();
        vm.warp(token.listedAt() + 1095 days);
        for (uint256 i; i < 9; ++i) {
            token.checkpoint(backers[i]);
        }
        assertFalse(token.disposed());
        (uint256 expectedT, uint256 expectedQ) = token.pendingRewards(backers[9]);
        token.checkpoint(backers[9]);
        assertTrue(token.disposed());
        (uint256 afterT, uint256 afterQ) = token.pendingRewards(backers[9]);
        assertEq(afterT, expectedT);
        assertEq(afterQ, expectedQ);
        for (uint256 i; i < 10; ++i) {
            vm.prank(backers[i]);
            token.claimRewards();
        }
        assertEq(token.balanceOf(address(token)), 0);
        if (token.disposedQuote() != 0) token.claimDisposed();
        assertEq(quote.balanceOf(address(token)), 0);
        _assertBook();
    }

    function test_carryChangingQuota_denominatorAndFinalCheckpointEpoch() public {
        _create(false);
        _fund();
        _open();
        for (uint256 i; i < 10; ++i) {
            uint256 tokens = raise.positionState(ids[i]).tokens;
            _exit(ids[i], i < 2 ? tokens - (i + 2) : tokens, false);
        }
        _list();
        assertEq(token.totalQuota(), 5);
        vm.warp(token.listedAt() + 1 days);
        token.checkpoint(backers[0]);
        vm.prank(backers[1]);
        token.transfer(buyer, 2);
        (ProjectTokenV31.Stream memory ts,) = token.rewardState();
        assertLt(ts.carry, token.totalQuota());
        vm.warp(token.listedAt() + 1095 days);
        token.checkpoint(backers[0]);
        vm.prank(backers[1]);
        token.transfer(buyer, 1);
        if (!token.disposed()) token.checkpoint(backers[0]);
        assertTrue(token.disposed());
        vm.prank(backers[0]);
        token.claimRewards();
        vm.prank(backers[1]);
        token.claimRewards();
        assertEq(token.balanceOf(address(token)), 0);
        _assertBook();
    }

    function test_builderVesting_exactCliffLinearAndFinalRemainder() public {
        _create(false);
        (uint256 builderId,) = _deposit(builder, 1000e6);
        _fund();
        _open();
        _list();
        uint256 grant = raise.positionState(builderId).tokens;
        uint256 cliff = uint256(token.listedAt()) + 30 days;
        vm.warp(cliff);
        assertEq(vesting.vested(builder), 0);
        vm.expectRevert(V.InvalidAmount.selector);
        vesting.claim(builder);
        vm.warp(cliff + 1 days);
        uint256 expected = Math.mulDiv(grant, 1, 1095);
        uint256 nonce = raise.stateNonce();
        assertEq(vesting.claim(builder), expected);
        assertEq(token.balanceOf(builder), expected);
        assertEq(token.quotaOf(builder), 0);
        assertEq(raise.stateNonce(), nonce);
        vm.warp(cliff + 1095 days);
        assertEq(vesting.claim(builder), grant - expected);
        assertEq(token.balanceOf(builder), grant);
        assertEq(token.balanceOf(address(vesting)), 0);
        _assertBook();
    }

    function test_postListTransfer_gasUnder110k_andWorksDuringRaiseAction() public {
        _setupListed();
        uint256 nonce = raise.stateNonce();
        vm.prank(address(governor));
        raise.beginModuleAction();
        vm.cool(address(token));
        vm.cool(address(raise));
        vm.prank(treasury);
        uint256 before = gasleft();
        token.transfer(buyer, 1e18);
        uint256 used = before - gasleft();
        emit log_named_uint("Post-list transfer gas (cold token/raise)", used);
        assertLt(used, 110000);
        vm.cool(address(token));
        vm.cool(address(raise));
        vm.prank(treasury);
        before = gasleft();
        token.transfer(buyer, 1e18);
        used = before - gasleft();
        emit log_named_uint("Repeated post-list transfer gas (cold token/raise)", used);
        assertLt(used, 80000);
        assertEq(raise.stateNonce(), nonce);
        vm.prank(address(governor));
        raise.endModuleAction();
        assertEq(token.quotaOf(buyer), 0);
        _assertBook();
    }

    function _setupListed() internal {
        _create(false);
        _fund();
        _open();
        _buy(buyer, 10000e6);
        _list();
    }

    function test_independentIntegerOracle_checkpointTransferClaimSequence() public {
        _create(false);
        _fund();
        _open();
        _buy(buyer, 10000e6);
        uint256[3] memory remaining = [uint256(2), 3, 5];
        for (uint256 i; i < 10; ++i) {
            uint256 tokens = raise.positionState(ids[i]).tokens;
            _exit(ids[i], i < 3 ? tokens - remaining[i] : tokens, false);
        }
        _list();
        vm.warp(token.listedAt() + 1 days);
        token.checkpoint(backers[0]);
        _assertPending(backers[0], 54794520547945205479, 5479);
        vm.prank(backers[1]);
        token.transfer(buyer, 1);
        _assertPending(backers[1], 82191780821917808219, 8219);
        vm.warp(token.listedAt() + 17 days);
        _assertPending(backers[2], 2572298325722983257229, 257229);
        vm.prank(backers[2]);
        token.claimRewards();
        vm.warp(token.listedAt() + 20 days);
        vm.prank(backers[0]);
        token.transfer(backers[0], 1);
        _assertPending(backers[0], 1211567732115677321156, 121156);
        _assertPending(backers[1], 1238964992389649923896, 123896);
        _assertPending(backers[2], 456621004566210045662, 45662);
        vm.warp(token.listedAt() + 1095 days);
        for (uint256 i; i < 3; ++i) {
            token.checkpoint(backers[i]);
        }
        _assertPending(backers[0], 38026636225266362252663, 3802663);
        _assertPending(backers[1], 74869101978691019786910, 7486910);
        _assertPending(backers[2], 184531963470319634703197, 18453197);
        assertTrue(token.disposed());
    }

    function _assertPending(address owner, uint256 expectedToken, uint256 expectedQuote) internal view {
        (uint256 t, uint256 q) = token.pendingRewards(owner);
        assertEq(t, expectedToken);
        assertEq(q, expectedQuote);
    }
}
