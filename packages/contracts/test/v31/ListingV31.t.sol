// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseV31} from "./BaseV31.sol";
import {TypesV31 as V} from "../../src/v31/TypesV31.sol";
import {ListingMathV31 as LP} from "../../src/v31/ListingMathV31.sol";
import {ListingFixtures} from "./ListingFixtures.sol";
import {IDexAdapterV31} from "../../src/v31/IDexAdapterV31.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {RaiseFactoryV31} from "../../src/v31/RaiseFactoryV31.sol";

contract ListingV31Test is BaseV31 {
    function test_independentBigIntegerV4Fixtures_bothCurrencyOrders() public pure {
        ListingFixtures.Fixture[] memory fixtures = ListingFixtures.all();
        for (uint256 i; i < fixtures.length; ++i) {
            ListingFixtures.Fixture memory f = fixtures[i];
            assertEq(LP.sqrtPrice(f.price, f.tokenFirst), f.sqrtPrice);
            (uint128 liquidity, uint256 a0, uint256 a1) = LP.liquidityFor(f.sqrtPrice, f.desired0, f.desired1);
            assertEq(liquidity, f.liquidity);
            assertEq(a0, f.used0);
            assertEq(a1, f.used1);
        }
    }

    function test_preinitializedSamePriceZeroLiquidity_isAccepted() public {
        _pending();
        V.ListingPreview memory p = raise.listingPreview();
        vm.prank(address(adapter));
        adapter.initializePool(address(token), address(quote), p.sqrtPriceX96);
        raise.list();
        assertEq(raise.listingRecord().sqrtPriceX96, p.sqrtPriceX96);
        assertGt(raise.listingRecord().liquidity, 0);
        _assertBook();
    }

    function test_adapterInitializedWrongPrice_revertsAndLeavesCostOpen() public {
        _pending();
        V.ListingPreview memory p = raise.listingPreview();
        vm.prank(address(adapter));
        adapter.initializePool(address(token), address(quote), p.sqrtPriceX96 + 1);
        uint256 nonce = raise.stateNonce();
        uint256 supply = token.totalSupply();
        vm.expectRevert(V.VenueFailure.selector);
        raise.list();
        assertEq(raise.stateNonce(), nonce);
        assertEq(token.totalSupply(), supply);
        assertEq(_exit(ids[0], raise.positionState(ids[0]).tokens, false), 1500e6);
        _assertBook();
    }

    function test_liquidityReserveConsumedFirst_andDustNeverTreasury() public {
        _create(false);
        _fund();
        _open();
        _buy(buyer, 123456789);
        vm.warp(raise.stageDeadlines().stage2End);
        (, uint256 lr,,,,) = raise.accounting();
        V.ListingPreview memory p = raise.listingPreview();
        uint256 lrUsed = Math.min(lr, p.usedToken);
        assertEq(p.liquidityReserveBurn, lr - lrUsed);
        assertEq(p.bookBurn, p.desiredToken - (p.usedToken - lrUsed));
        uint256 burnedBefore = token.burned();
        (, uint256 rewards, uint256 treasuryFees) = raise.feeAccruals();
        raise.list();
        assertEq(token.burned() - burnedBefore, p.depthBurn + p.bookBurn + p.liquidityReserveBurn);
        assertEq(quote.balanceOf(address(raise)), p.quoteDust + treasuryFees);
        assertEq(quote.balanceOf(address(token)), rewards);
        assertEq(quote.balanceOf(treasury), 0);
        raise.claimTreasuryFees();
        assertEq(quote.balanceOf(treasury), treasuryFees);
        assertEq(quote.balanceOf(address(raise)), p.quoteDust);
        _assertBook();
    }

    function test_LPFeesOnly_principalAndOwnerRemainLocked() public {
        _pending();
        raise.list();
        IDexAdapterV31.Receipt memory receipt = raise.listingRecord();
        quote.mint(buyer, 100e6);
        vm.prank(buyer);
        quote.approve(address(adapter), 100e6);
        vm.prank(treasury);
        token.approve(address(adapter), 1e18);
        vm.prank(buyer);
        adapter.donateFees(receipt.positionId, 100e6, 0);
        vm.prank(treasury);
        adapter.donateFees(receipt.positionId, 0, 1e18);
        uint256 beforeT = token.balanceOf(treasury);
        uint256 nonce = raise.stateNonce();
        (uint256 q, uint256 t) = raise.collectLPFees();
        assertEq(q, 100e6);
        assertEq(t, 1e18);
        assertEq(raise.stateNonce(), nonce);
        assertEq(quote.balanceOf(treasury), 100e6);
        assertEq(token.balanceOf(treasury) - beforeT, 1e18);
        assertEq(quote.balanceOf(address(adapter)), receipt.usedQuote);
        assertEq(token.balanceOf(address(adapter)), receipt.usedToken);
        assertEq(keccak256(abi.encode(adapter.position(receipt.positionId))), keccak256(abi.encode(receipt)));
        vm.expectRevert(V.Unauthorized.selector);
        adapter.collectFees(receipt.positionId, buyer);
        (bool canRemove,) =
            address(adapter).call(abi.encodeWithSignature("removeLiquidity(bytes32)", receipt.positionId));
        assertFalse(canRemove);
    }

    function test_adapterChangedCode_blocksListing_withoutChangingState() public {
        _pending();
        bytes memory originalCode = address(adapter).code;
        vm.etch(address(adapter), hex"60006000fd");
        uint256 nonce = raise.stateNonce();
        vm.expectRevert(V.VenueFailure.selector);
        raise.list();
        assertEq(raise.stateNonce(), nonce);
        vm.etch(address(adapter), originalCode);
        raise.list();
    }

    function test_callbackAndModuleHooks_rejectUnauthenticatedCalls() public {
        _create(false);
        vm.expectRevert(V.Unauthorized.selector);
        raise.listingCallback(bytes32(0), 0, 0);
        vm.expectRevert(V.Unauthorized.selector);
        raise.beginModuleAction();
        vm.expectRevert(V.Unauthorized.selector);
        raise.endModuleAction();
        vm.expectRevert(V.Unauthorized.selector);
        vm.prank(address(token));
        raise.beginModuleAction();
        vm.expectRevert(V.Unauthorized.selector);
        token.custodyMove(buyer, 1);
        vm.expectRevert(V.Unauthorized.selector);
        token.custodyBurn(1, "Book");
        vm.expectRevert(V.Unauthorized.selector);
        token.vestingTransfer(buyer, 1);
        vm.expectRevert(V.Unauthorized.selector);
        token.adapterFeeTransfer(treasury, 1);
        vm.expectRevert(V.Unauthorized.selector);
        token.adapterCustodyTransfer(buyer, 1);
        vm.expectRevert(V.Unauthorized.selector);
        vm.prank(address(adapter));
        token.adapterCustodyTransfer(buyer, 1);
    }

    function test_poolSquatting_blockedByPinnedInitializeHook() public {
        _pending();
        V.ListingPreview memory p = raise.listingPreview();
        bytes32 key = adapter.poolKey(address(token), address(quote));
        (address c0, address c1) =
            address(token) < address(quote) ? (address(token), address(quote)) : (address(quote), address(token));
        assertEq(key, keccak256(abi.encode(c0, c1, uint24(10000), int24(200), adapter.initializeHook())));
        vm.expectRevert(V.Unauthorized.selector);
        vm.prank(buyer);
        adapter.initializePool(address(token), address(quote), p.sqrtPriceX96 + 1);
        (uint160 price, uint128 liquidity) = adapter.pools(key);
        assertEq(price, 0);
        assertEq(liquidity, 0);
        raise.list();
        assertEq(raise.listingRecord().sqrtPriceX96, p.sqrtPriceX96);
        assertGt(raise.listingRecord().liquidity, 0);
    }

    function _pending() internal {
        _create(false);
        _fund();
        _open();
        vm.warp(raise.stageDeadlines().stage2End);
    }

    function test_creationRejectsCapitalDomainOfFrozenListingCounterexample() public {
        V.Config memory c = _config(false);
        c.supply = 1e30;
        c.targetPrice = 1e36;
        vm.expectRevert(V.InvalidConfig.selector);
        vm.prank(builder);
        factory.createRaise(V.ESCROW_LAUNCH, 1, c, RaiseFactoryV31.TokenMeta("Bounded", "BND"));
    }

    function test_tradesRejectUnboundedQuoteEvenForValidCreation() public {
        _create(false);
        _fund();
        _open();
        uint256 nonce = raise.stateNonce();
        vm.expectRevert(V.InvalidAmount.selector);
        vm.prank(buyer);
        raise.buy(2.5e35, 0, nonce, vm.getBlockTimestamp());
        assertEq(raise.stateNonce(), nonce);
    }

    function test_dustBook_R121741T1_listsAndLocksQuote() public {
        V.Config memory c = _config(false);
        c.supply = 1e6;
        c.targetPrice = 1e35;
        _createWith(c, false);
        _fund();
        _open();
        // Stage 1 exits return allocation to the sale, so the dust book is reached through Stage 2 cost exits.
        for (uint256 i; i < 10; ++i) {
            _exit(ids[i], raise.positionState(ids[i]).tokens - 1, false);
        }
        for (uint256 i; i < 10; ++i) {
            _exit(ids[i], 1, false);
        }
        V.ReserveState memory b = raise.reserveState();
        V.Deadlines memory d = raise.stageDeadlines();
        while (b.T > 2) {
            uint256 target = Math.mulDiv(b.V, 3, 5);
            uint256 elapsed = Math.mulDiv(b.X0 - target, c.stage2Length, b.X0, Math.Rounding.Ceil);
            vm.warp(d.stage2Start + elapsed);
            raise.advanceDepth();
            b = raise.reserveState();
        }
        assertEq(b.T, 2);
        assertEq(_buy(buyer, 122476), 1);
        vm.warp(d.stage2End);
        raise.advanceDepth();
        b = raise.reserveState();
        assertEq(b.E + b.V, 0);
        assertEq(b.R, 121741);
        assertEq(b.T, 1);
        V.ListingPreview memory p = raise.listingPreview();
        assertTrue(p.validity.available);
        assertEq(uint256(p.branch), uint256(V.Branch.ZeroQuote));
        assertEq(p.desiredQuote, 121741);
        assertEq(p.usedQuote + p.usedToken + p.liquidity, 0);
        assertEq(p.quoteDust, 121741);
        uint256 burned = token.burned();
        raise.list();
        assertEq(uint256(raise.phase()), uint256(V.Phase.Stage3));
        assertEq(raise.listingRecord().sqrtPriceX96, p.sqrtPriceX96);
        assertEq(raise.listingRecord().liquidity, 0);
        assertEq(token.burned() - burned, p.bookBurn + p.liquidityReserveBurn + c.supply * 30 / 100);
        (,,,, uint256 dust,) = raise.accounting();
        assertEq(dust, 121741);
        assertEq(quote.balanceOf(address(adapter)), 0);
        assertEq(quote.balanceOf(treasury), 0);
        assertEq(raise.buyerTokens(buyer), 0);
        assertEq(token.balanceOf(buyer), 1);
        _assertBook();
    }
}
