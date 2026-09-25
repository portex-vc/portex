// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseV31} from "./BaseV31.sol";
import {TypesV31 as V} from "../../src/v31/TypesV31.sol";
import {IDexAdapterV31} from "../../src/v31/IDexAdapterV31.sol";

contract ScenariosV31Test is BaseV31 {
    function test_escrow_noBuyListing_atTerminalPrice_autoDelivery() public {
        _create(false);
        _fund();
        uint256 basis = raise.reserveState().E;
        assertApproxEqAbs(basis, 16_666_666667, 10);
        _open();
        assertEq(token.balanceOf(backers[0]), 0);
        vm.warp(raise.stageDeadlines().stage2End);
        V.ListingPreview memory p = raise.listingPreview();
        assertTrue(p.validity.available);
        assertTrue(p.claimsEndOnSuccess);
        assertEq(p.price, TARGET);
        assertApproxEqAbs(p.desiredToken, SUPPLY / 6, 1e14);
        assertEq(p.desiredQuote, basis);
        uint256 nonce = raise.stateNonce();
        raise.list();
        assertEq(raise.stateNonce(), nonce + 1);
        assertEq(raise.guaranteedClaim(ids[0]).amount, 0);
        assertEq(token.balanceOf(backers[0]), raise.positionState(ids[0]).tokens);
        assertFalse(token.materialized(backers[0]));
        assertEq(token.balanceOf(address(raise)), 0);
        assertEq(token.balanceOf(treasury), SUPPLY / 10);
        assertEq(quote.balanceOf(treasury), 0);
        IDexAdapterV31.Receipt memory r = raise.listingRecord();
        assertEq(r.owner, address(raise));
        assertEq(r.usedQuote, p.usedQuote);
        assertEq(r.usedToken, p.usedToken);
        assertEq(token.balanceOf(address(adapter)), p.usedToken);
        assertEq(quote.balanceOf(address(adapter)), p.usedQuote);
        _assertBook();
    }

    function test_budget_noBuyListing_sameCanonicalAmounts() public {
        _create(true);
        _fund();
        _open();
        _list();
        assertApproxEqAbs(raise.listingRecord().usedQuote, 16_666_666667, 10);
        _assertBook();
    }

    function test_escrow_refund_exactPulls() public {
        _refundScenario(false);
    }

    function test_budget_refund_exactPulls() public {
        _refundScenario(true);
    }

    function _refundScenario(bool budget) internal {
        _create(budget);
        (uint256 id, uint256 tokens) = _deposit(backers[0], 1000e6);
        (uint256 builderId,) = _deposit(builder, 500e6);
        uint256 partialPayout = _exit(id, tokens / 3, false);
        uint256 basis = 1000e6 - partialPayout;
        vm.warp(raise.stageDeadlines().stage1End);
        raise.advanceStage1();
        assertEq(uint256(raise.phase()), uint256(V.Phase.Dissolved));
        assertEq(token.totalSupply(), 0);
        assertEq(quote.balanceOf(address(raise)), 0);
        assertEq(claims.liability(), basis + 500e6);
        assertEq(raise.guaranteedClaim(id).amount, basis);
        uint256 before = quote.balanceOf(backers[0]);
        vm.prank(backers[0]);
        claims.claim(id);
        assertEq(quote.balanceOf(backers[0]) - before, basis);
        vm.prank(builder);
        claims.claim(builderId);
        assertEq(claims.liability(), 0);
        assertEq(raise.guaranteedClaim(id).amount, 0);
        assertEq(raise.atRiskBasis(id), 0);
        assertEq(raise.atRiskBasis(builderId), 0);
        vm.expectRevert();
        vm.prank(backers[0]);
        claims.claim(id);
        _assertBook();
    }

    function test_buys_exits_protectedAndCost_thenListing() public {
        _create(false);
        _fund();
        _open();
        _buy(buyer, 100000e6);
        vm.warp(raise.stageDeadlines().stage2Start + 20 days);
        uint256 tokens = raise.positionState(ids[0]).tokens;
        V.ExitQuote memory r = raise.protectedExitQuote(ids[0], tokens);
        uint256 payout = _exit(ids[0], tokens, true);
        assertEq(payout, r.result.payout);
        assertGe(payout, 1500e6);
        assertGt(r.result.profit, 0);
        _assertBook();
        uint256 basis = raise.guaranteedClaim(ids[1]).amount;
        assertEq(_exit(ids[1], raise.positionState(ids[1]).tokens, false), basis);
        _assertBook();
        uint256 bought = raise.buyerTokens(buyer);
        uint256 nonce = raise.stateNonce();
        vm.prank(buyer);
        raise.sell(bought / 2, 0, nonce, vm.getBlockTimestamp());
        _assertBook();
        _list();
        assertEq(token.balanceOf(buyer), bought - bought / 2);
        assertEq(token.quotaOf(buyer), 0);
        assertEq(raise.buyerTokens(buyer), 0);
        _assertBook();
    }

    function test_budgetDraw_haircut_costExit_listing() public {
        _create(true);
        (uint256 builderId,) = _deposit(builder, 500e6);
        _fund();
        _open();
        uint256 initial = raise.guaranteedClaim(ids[0]).amount;
        uint256 builderBasis = raise.guaranteedClaim(builderId).amount;
        _draw(1000e6);
        assertLt(raise.guaranteedClaim(ids[0]).amount, initial);
        assertLt(raise.guaranteedClaim(builderId).amount, builderBasis);
        assertGt(raise.atRiskBasis(ids[0]), 0);
        _assertBook();
        uint256 exact = raise.guaranteedClaim(ids[0]).amount;
        assertEq(_exit(ids[0], raise.positionState(ids[0]).tokens, false), exact);
        _assertBook();
        _list();
        assertEq(raise.guaranteedClaim(builderId).amount, 0);
        assertGt(token.balanceOf(address(vesting)), 0);
        assertEq(token.balanceOf(builder), 0);
        _assertBook();
    }

    function test_listingFailure_isAtomic_costExit_thenRetry() public {
        _create(false);
        _fund();
        _open();
        _buy(buyer, 10000e6);
        vm.warp(raise.stageDeadlines().stage2End);
        bytes32 before =
            keccak256(abi.encode(raise.reserveState(), token.totalSupply(), quote.balanceOf(address(raise))));
        uint256 nonce = raise.stateNonce();
        adapter.setFailure(true, false);
        vm.expectRevert();
        raise.list();
        assertEq(
            keccak256(abi.encode(raise.reserveState(), token.totalSupply(), quote.balanceOf(address(raise)))), before
        );
        assertEq(raise.stateNonce(), nonce);
        assertEq(uint256(raise.phase()), uint256(V.Phase.ListingPending));
        assertTrue(raise.listingStatus(ids[0]).liveCostEligible);
        assertEq(_exit(ids[0], raise.positionState(ids[0]).tokens, false), 1500e6);
        adapter.setFailure(false, false);
        raise.list();
        _assertBook();
    }

    function test_listingCorruptReceipt_rollsBackCallbackBurnsAndClaims() public {
        _create(false);
        _fund();
        _open();
        vm.warp(raise.stageDeadlines().stage2End);
        V.ReserveState memory before = raise.reserveState();
        uint256 supply = token.totalSupply();
        adapter.setFailure(false, true);
        vm.expectRevert(V.VenueFailure.selector);
        raise.list();
        assertEq(keccak256(abi.encode(raise.reserveState())), keccak256(abi.encode(before)));
        assertEq(token.totalSupply(), supply);
        assertEq(token.balanceOf(address(adapter)), 0);
        assertEq(quote.balanceOf(address(adapter)), 0);
        adapter.setFailure(false, false);
        raise.list();
    }

    function test_allCostExits_zeroQuoteListing_initializesAndBurnsRewards() public {
        _create(false);
        _fund();
        _open();
        for (uint256 i; i < 10; ++i) {
            _exit(ids[i], raise.positionState(ids[i]).tokens, false);
        }
        assertEq(raise.reserveState().E, 0);
        vm.warp(raise.stageDeadlines().stage2End);
        V.ListingPreview memory p = raise.listingPreview();
        assertEq(p.desiredQuote, 0);
        assertTrue(p.validity.available);
        raise.list();
        assertEq(raise.listingRecord().liquidity, 0);
        assertEq(token.totalQuota(), 0);
        assertTrue(token.disposed());
        assertEq(token.totalSupply(), SUPPLY / 10);
        _assertBook();
    }

    function test_pending_closesBuysAndProfit_keepsBuyerSellsAndCostOpen() public {
        _create(false);
        _fund();
        _open();
        _buy(buyer, 1000e6);
        vm.warp(raise.stageDeadlines().stage2End);
        assertFalse(raise.marketBuyQuote(100e6).validity.available);
        assertTrue(raise.marketExitQuote(buyer, 1).validity.available);
        assertFalse(raise.protectedExitQuote(ids[0], 1).validity.available);
        assertTrue(raise.redeemQuote(ids[0], 1, raise.stateNonce()).validity.available);
        assertEq(_exit(ids[0], raise.positionState(ids[0]).tokens, false), 1500e6);
        _assertBook();
    }
}
