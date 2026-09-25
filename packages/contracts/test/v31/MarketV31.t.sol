// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseV31} from "./BaseV31.sol";
import {TypesV31 as V} from "../../src/v31/TypesV31.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

contract MarketV31Test is BaseV31 {
    function test_buyAndSell_exactFeeAndProductInequalities() public {
        _create(false);
        _fund();
        _open();
        uint256 gross = 100_000009;
        V.ReserveState memory before = raise.reserveState();
        V.TradeQuote memory bq = raise.marketBuyQuote(gross);
        uint256 out = _buy(buyer, gross);
        V.ReserveState memory afterBuy = raise.reserveState();
        assertEq(out, bq.tokens);
        assertEq(bq.priceImpactBps, Math.mulDiv(bq.priceAfter - bq.priceBefore, 10000, bq.priceBefore));
        assertEq(bq.fees.total, gross / 100);
        assertEq(bq.fees.reserve, Math.mulDiv(gross / 100, 40, 100));
        assertEq(afterBuy.R, bq.ammAmount + bq.fees.reserve);
        assertGe((afterBuy.R + afterBuy.V) * afterBuy.T, (before.R + before.V) * before.T);
        assertLe(out * (before.R + before.V + bq.ammAmount), before.T * bq.ammAmount);
        assertLt(before.T * bq.ammAmount, (out + 1) * (before.R + before.V + bq.ammAmount));
        V.TradeQuote memory sq = raise.marketExitQuote(buyer, out);
        assertEq(sq.priceImpactBps, Math.mulDiv(sq.priceBefore - sq.priceAfter, 10000, sq.priceBefore));
        uint256 nonce = raise.stateNonce();
        vm.prank(buyer);
        uint256 paid = raise.sell(out, sq.net, nonce, vm.getBlockTimestamp());
        assertEq(paid, sq.gross - sq.fees.total);
        V.ReserveState memory afterSell = raise.reserveState();
        assertEq(afterBuy.R - afterSell.R, sq.gross - sq.fees.reserve);
        assertGe((afterSell.R + afterSell.V) * afterSell.T, (afterBuy.R + afterBuy.V) * afterBuy.T);
        assertEq(raise.buyerTokens(buyer), 0);
        assertEq(afterSell.O, 0);
        _assertBook();
    }

    function test_listingPending_buyersCanSellBeforeAndAfterFailedListing() public {
        _create(false);
        _fund();
        _open();
        uint256 bought = _buy(buyer, 10000e6);
        vm.warp(raise.stageDeadlines().stage2End);
        assertEq(uint256(raise.phase()), uint256(V.Phase.ListingPending));
        _sellPending(bought / 2);
        adapter.setFailure(true, false);
        uint256 nonce = raise.stateNonce();
        vm.expectRevert(V.VenueFailure.selector);
        raise.list();
        assertEq(raise.stateNonce(), nonce);
        _sellPending(raise.buyerTokens(buyer));
        assertEq(raise.buyerTokens(buyer), 0);
        assertEq(raise.reserveState().O, 0);
        adapter.setFailure(false, false);
        raise.list();
        _assertBook();
    }

    function _sellPending(uint256 amount) internal {
        V.TradeQuote memory q = raise.marketExitQuote(buyer, amount);
        assertTrue(q.validity.available);
        assertEq(uint256(q.validity.phase), uint256(V.Phase.ListingPending));
        assertFalse(raise.marketBuyQuote(100e6).validity.available);
        uint256 nonce = raise.stateNonce();
        vm.expectRevert(V.InvalidAmount.selector);
        vm.prank(buyer);
        raise.buy(100e6, 0, nonce, vm.getBlockTimestamp());
        uint256 before = quote.balanceOf(buyer);
        vm.prank(buyer);
        assertEq(raise.sell(amount, q.net, nonce, vm.getBlockTimestamp()), q.net);
        assertEq(quote.balanceOf(buyer) - before, q.net);
        assertEq(raise.stateNonce(), nonce + 1);
        _assertBook();
    }

    function test_lazyDecay_quoteAndExecutionUseSameStoredNonce() public {
        _create(false);
        _fund();
        _open();
        uint256 nonce = raise.stateNonce();
        vm.warp(raise.stageDeadlines().stage2Start + 7 days);
        V.TradeQuote memory q = raise.marketBuyQuote(1000e6);
        assertEq(q.validity.stateNonce, nonce);
        assertGt(q.depthBurn, 0);
        assertEq(raise.stateNonce(), nonce);
        assertEq(_buy(buyer, 1000e6), q.tokens);
        assertEq(raise.stateNonce(), nonce + 1);
        _assertBook();
    }

    function test_standaloneNoOpDecay_doesNotInvalidateQuotes() public {
        _create(false);
        _fund();
        _open();
        uint256 nonce = raise.stateNonce();
        raise.advanceDepth();
        assertEq(raise.stateNonce(), nonce);
        vm.warp(raise.stageDeadlines().stage2Start + 1 days);
        raise.advanceDepth();
        assertEq(raise.stateNonce(), nonce + 1);
        raise.advanceDepth();
        assertEq(raise.stateNonce(), nonce + 1);
    }

    function testFuzz_tradeRoundTrip_preservesBookAndAllFeeBuckets(uint256 amountSeed) public {
        _create(false);
        _fund();
        _open();
        uint256 amount = bound(amountSeed, 1, 1e15);
        uint256 tokens = _buy(buyer, amount);
        uint256 nonce = raise.stateNonce();
        vm.prank(buyer);
        uint256 paid = raise.sell(tokens, 0, nonce, vm.getBlockTimestamp());
        assertLe(paid, amount);
        _assertBook();
    }
}
