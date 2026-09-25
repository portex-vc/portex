// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseV31} from "./BaseV31.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TypesV31 as V} from "../../src/v31/TypesV31.sol";
import {GovernanceV31} from "../../src/v31/GovernanceV31.sol";
import {StorageV31 as S} from "../../src/v31/StorageV31.sol";
import {CurveV31} from "../../src/v31/CurveV31.sol";

/// @notice Boundary fixture for defensive gate handling; normal ten-live-backer books retain a positive seed.
contract Stage1BoundaryHarnessV31 {
    S.State private s;

    function forceSeedBoundary(uint256 basisPerPosition) external {
        s.config.targetPrice = 1e36;
        s.book.E = 10 * basisPerPosition;
        s.H = s.book.E;
        s.eligibleShares = s.book.E;
        for (uint256 id = 1; id <= 10; ++id) {
            s.positions[id].basis = basisPerPosition;
            s.positions[id].shares = basisPerPosition;
            s.positions[id].historicalRemaining = basisPerPosition;
            s.backerBasis[s.positions[id].owner] = basisPerPosition;
        }
    }
}

contract IssuanceV31Test is BaseV31 {
    function test_custodiedSupply_andPublicTransferGate() public {
        _create(false);
        (uint256 id, uint256 quantity) = _deposit(backers[0], 1000e6);
        assertEq(token.totalSupply(), SUPPLY);
        assertEq(token.balanceOf(address(raise)), SUPPLY);
        assertEq(token.balanceOf(backers[0]), 0);
        assertEq(raise.positionState(id).tokens, quantity);
        assertEq(raise.guaranteedClaim(id).validUntil, 0);
        vm.expectRevert(V.InvalidPhase.selector);
        vm.prank(backers[0]);
        token.transfer(buyer, 0);
        _assertBook();
    }

    function test_unrelatedApprovals_preserveStage1AndStage2ExitQuotes() public {
        _create(false);
        _fund();
        _approvalCannotInvalidateExit(false);
        _open();
        _approvalCannotInvalidateExit(false);
        _approvalCannotInvalidateExit(true);
    }

    function _approvalCannotInvalidateExit(bool protected) internal {
        uint256 nonce = raise.stateNonce();
        V.ExitQuote memory q =
            protected ? raise.protectedExitQuote(ids[0], 1e18) : raise.redeemQuote(ids[0], 1e18, nonce);
        vm.prank(buyer);
        token.approve(address(0xBAD), type(uint256).max);
        assertEq(raise.stateNonce(), nonce);
        vm.expectRevert(V.InvalidPhase.selector);
        vm.prank(buyer);
        token.transfer(backers[0], 0);
        vm.expectRevert(V.InvalidPhase.selector);
        vm.prank(buyer);
        token.transferFrom(backers[0], buyer, 0);
        assertEq(raise.stateNonce(), nonce);
        vm.prank(backers[0]);
        uint256 paid = protected
            ? raise.protectedExit(ids[0], 1e18, q.result.payout, nonce, vm.getBlockTimestamp())
            : raise.exitAtCost(ids[0], 1e18, q.result.payout, nonce, vm.getBlockTimestamp());
        assertEq(paid, q.result.payout);
    }

    function test_soldOutThenAllExit_refundsWithoutRevertOrResidualClaims() public {
        _create(false);
        _fund();
        for (uint256 i; i < 10; ++i) {
            uint256 basis = raise.guaranteedClaim(ids[i]).amount;
            assertEq(_exit(ids[i], raise.positionState(ids[i]).tokens, false), basis);
        }
        (uint256 sold,,,,,) = raise.accounting();
        // Every exited token went back on sale.
        assertEq(sold, 0);
        assertEq(raise.reserveState().E, 0);
        vm.warp(raise.stageDeadlines().stage1End);
        raise.advanceStage1();
        assertEq(uint256(raise.phase()), uint256(V.Phase.Dissolved));
        assertEq(token.totalSupply(), 0);
        assertEq(claims.liability(), 0);
        for (uint256 i; i < 10; ++i) {
            assertEq(claims.claimable(ids[i]), 0);
        }
        _assertBook();
    }

    function test_passingGatesWithZeroSeed_refundExactDustClaims() public {
        _forceSeedBoundary(1);
        vm.warp(raise.stageDeadlines().stage1End);
        vm.prank(attester);
        raise.veto(2 days, bytes32(0));
        raise.advanceStage1();
        assertEq(uint256(raise.phase()), uint256(V.Phase.Dissolved));
        assertEq(raise.stageDeadlines().stage2Start, 0);
        assertEq(claims.liability(), 10);
        assertEq(token.totalSupply(), 0);
        for (uint256 i; i < 10; ++i) {
            assertEq(claims.claimable(ids[i]), 1);
            uint256 before = quote.balanceOf(backers[i]);
            vm.prank(backers[i]);
            assertEq(claims.claim(ids[i]), 1);
            assertEq(quote.balanceOf(backers[i]) - before, 1);
        }
        assertEq(claims.liability(), 0);
    }

    function test_passingGatesWithZeroEscrow_refunds() public {
        _forceSeedBoundary(0);
        vm.warp(raise.stageDeadlines().stage1End);
        raise.advanceStage1();
        assertEq(uint256(raise.phase()), uint256(V.Phase.Dissolved));
        assertEq(claims.liability(), 0);
        assertEq(token.totalSupply(), 0);
    }

    function _forceSeedBoundary(uint256 basisPerPosition) internal {
        _create(false);
        _fund();
        // Inject seed arithmetic boundaries without weakening production creation/participation constraints.
        bytes memory original = address(raise).code;
        Stage1BoundaryHarnessV31 fixture = new Stage1BoundaryHarnessV31();
        vm.etch(address(raise), address(fixture).code);
        Stage1BoundaryHarnessV31(address(raise)).forceSeedBoundary(basisPerPosition);
        vm.etch(address(raise), original);
        deal(address(quote), address(raise), 10 * basisPerPosition);
    }

    function test_stage1Deposit_doesNotConsultLegacyPauseFlag() public {
        _create(false);
        vm.mockCallRevert(address(governor), abi.encodeCall(GovernanceV31.depositsPaused, ()), bytes("dead check"));
        (uint256 id, uint256 quantity) = _deposit(backers[0], 1000e6);
        assertGt(quantity, 0);
        assertEq(raise.guaranteedClaim(id).amount, 1000e6);
    }

    function test_debitsOnlyCost_returnsImplicitChange() public {
        _create(false);
        for (uint256 i; i < 9; ++i) {
            _deposit(backers[i], 1500e6);
        }
        (uint256 soldBefore,,,,,) = raise.accounting();
        uint256 remaining = SUPPLY / 5 - soldBefore;
        uint256 expected = CurveV31.cost(TARGET, SUPPLY / 5, soldBefore, remaining);
        uint256 before = quote.balanceOf(backers[9]);
        (, uint256 tokens) = _deposit(backers[9], 100000e6);
        assertEq(tokens, remaining);
        assertEq(quote.balanceOf(backers[9]) - before, 100000e6 - expected);
    }

    /// A Stage 1 exit pays the exact proportional cost and returns the exited allocation to the sale: the curve
    /// steps back, nothing burns, and the next backer can buy those tokens at the price they were sold at.
    function test_stage1Exit_returnsAllocationToSale_atProportionalCost() public {
        _create(false);
        (uint256 id, uint256 quantity) = _deposit(backers[0], 1000e6);
        (uint256 sold,,,,,) = raise.accounting();
        assertEq(sold, quantity);
        // Exit half: exactly half the cost comes back, and half the tokens return to the sale.
        uint256 half = quantity / 2;
        uint256 halfCost = Math.mulDiv(1000e6, half, quantity);
        assertEq(_exit(id, half, false), halfCost);
        (uint256 afterHalf,,,,,) = raise.accounting();
        assertEq(afterHalf, quantity - half);
        // Exit the rest: the remainder of the cost, and the curve is back at zero.
        assertEq(_exit(id, quantity - half, false) + halfCost, 1000e6);
        (uint256 afterAll,,,,,) = raise.accounting();
        assertEq(afterAll, 0);
        assertEq(token.burned(), 0);
        // The next backer buys the same tokens at the same price the first one paid.
        (, uint256 next) = _deposit(backers[1], 1000e6);
        assertEq(next, quantity);
        _assertBook();
    }

    /// Audit 2026-09-25 (H): filling the sale and then exiting down to crumbs must not graduate.
    function test_fillThenExitToCrumbs_dissolvesAtDeadline() public {
        _create(false);
        _fund();
        for (uint256 i; i < 10; ++i) {
            uint256 tokens = raise.positionState(ids[i]).tokens;
            _exit(ids[i], tokens - 1, false);
        }
        (uint256 sold,,,,,) = raise.accounting();
        assertEq(sold, 10);
        vm.warp(raise.stageDeadlines().stage1End);
        raise.advanceStage1();
        assertEq(uint256(raise.phase()), uint256(V.Phase.Dissolved));
        _assertBook();
    }

    /// The allocation returned by exits can be bought again, and a refilled sale graduates normally.
    function test_exitThenRefill_graduates() public {
        _create(false);
        _fund();
        uint256 tokens = raise.positionState(ids[0]).tokens;
        _exit(ids[0], tokens, false);
        (uint256 sold,,,,,) = raise.accounting();
        assertEq(sold, SUPPLY / 5 - tokens);
        _deposit(buyer, 100000e6);
        (sold,,,,,) = raise.accounting();
        assertEq(sold, SUPPLY / 5);
        _open();
        _assertBook();
    }

    /// One last-second exit cannot dissolve a full raise: graduation needs 95% of the sale held, not 100%.
    function test_lastSecondSmallExit_stillGraduates_unsoldBurned() public {
        _create(false);
        _fund();
        vm.warp(raise.stageDeadlines().stage1End - 1);
        uint256 q = raise.positionState(ids[0]).tokens / 4;
        _exit(ids[0], q, false);
        (uint256 sold,,,,,) = raise.accounting();
        assertEq(sold, SUPPLY / 5 - q);
        assertGt(sold * 10_000, (SUPPLY / 5) * 9500);
        uint256 burned = token.burned();
        vm.warp(raise.stageDeadlines().stage1End);
        raise.advanceStage1();
        assertEq(uint256(raise.phase()), uint256(V.Phase.Stage2));
        // The allocation nobody holds at the deadline is burned, and Stage 2 opens at the curve's last price.
        assertEq(token.burned() - burned, q);
        assertEq(raise.reserveState().E, 16666666667 - Math.mulDiv(1500e6, q, raise.positionState(ids[0]).tokens + q));
        _assertBook();
    }

    /// A large withdrawal at the deadline leaves the project short of its target, so it dissolves.
    function test_lastSecondLargeExit_dissolves() public {
        _create(false);
        _fund();
        vm.warp(raise.stageDeadlines().stage1End - 1);
        uint256 q = raise.positionState(ids[0]).tokens / 2;
        _exit(ids[0], q, false);
        (uint256 sold,,,,,) = raise.accounting();
        assertLt(sold * 10_000, (SUPPLY / 5) * 9500);
        vm.warp(raise.stageDeadlines().stage1End);
        raise.advanceStage1();
        assertEq(uint256(raise.phase()), uint256(V.Phase.Dissolved));
        _assertBook();
    }

    function test_builderPurchases_sameCurve_separateClass_noQuota() public {
        _create(false);
        (uint256 id, uint256 quantity) = _deposit(builder, 1000e6);
        V.PositionView memory p = raise.positionState(id);
        assertEq(uint256(p.class), uint256(V.Class.BuilderPurchase));
        assertEq(p.quota, 0);
        (uint256 expected,) = CurveV31.purchase(TARGET, SUPPLY / 5, 0, 1000e6);
        assertEq(quantity, expected);
        assertEq(_exit(id, quantity, false), 1000e6);
        quote.mint(builder, 20000e6);
        uint256 nonce = raise.stateNonce();
        vm.expectRevert(V.InvalidAmount.selector);
        vm.prank(builder);
        raise.deposit(20000e6, 0, nonce, vm.getBlockTimestamp());
    }

    function test_builderAddressesPinned_doNotCountForMinimum() public {
        V.Config memory c = _config(false);
        c.builders = new address[](1);
        c.builders[0] = backers[0];
        _createWith(c, false);
        _fund();
        assertEq(uint256(raise.positionState(ids[0]).class), uint256(V.Class.BuilderPurchase));
        vm.warp(raise.stageDeadlines().stage1End);
        raise.advanceStage1();
        assertEq(uint256(raise.phase()), uint256(V.Phase.Dissolved));
    }

    function test_minimumCountsDistinctLiveBackers() public {
        _create(false);
        for (uint256 i; i < 9; ++i) {
            _deposit(backers[0], 1000e6);
        }
        _deposit(backers[1], 100000e6);
        vm.warp(raise.stageDeadlines().stage1End);
        raise.advanceStage1();
        assertEq(uint256(raise.phase()), uint256(V.Phase.Dissolved));
    }

    function test_exactDeadline_successHasPriority_overRefund() public {
        _create(false);
        _fund();
        vm.warp(raise.stageDeadlines().stage1End);
        raise.advanceStage1();
        assertEq(uint256(raise.phase()), uint256(V.Phase.Stage2));
        vm.expectRevert(V.InvalidPhase.selector);
        raise.advanceStage1();
    }

    function test_vetoBounded_costExitsOpen_andCannotReject() public {
        _create(false);
        _fund();
        vm.warp(raise.stageDeadlines().stage1End);
        vm.prank(attester);
        raise.veto(2 days, keccak256("report"));
        uint256 nonce = raise.stateNonce();
        vm.expectRevert(V.Expired.selector);
        raise.advanceStage1();
        assertEq(raise.stateNonce(), nonce);
        // A cost exit stays open during the delay; this one leaves more than 95% of the sale held.
        uint256 tokens = raise.positionState(ids[0]).tokens;
        uint256 q = tokens / 4;
        assertEq(_exit(ids[0], q, false), Math.mulDiv(1500e6, q, tokens));
        vm.warp(raise.stageDeadlines().vetoUntil);
        raise.advanceStage1();
        assertEq(uint256(raise.phase()), uint256(V.Phase.Stage2));
    }

    function test_veto_cumulativeCooldownAndHardMaximum() public {
        _create(false);
        for (uint256 i; i < 3; ++i) {
            vm.prank(attester);
            raise.veto(2 days, bytes32(0));
            vm.warp(vm.getBlockTimestamp() + 3 days);
        }
        vm.expectRevert(V.InvalidAmount.selector);
        vm.prank(attester);
        raise.veto(2 days, bytes32(0));
        vm.prank(attester);
        raise.veto(1 days, bytes32(0));
        vm.expectRevert(V.InvalidPhase.selector);
        vm.prank(attester);
        raise.veto(1, bytes32(0));
        vm.prank(council);
        raise.clearVeto();
        vm.warp(raise.stageDeadlines().start + 60 days);
        vm.expectRevert(V.InvalidAmount.selector);
        vm.prank(attester);
        raise.veto(1, bytes32(0));
    }

    function test_veto_neverExtendsSixtyDays_missingGatesRefundAnyway() public {
        V.Config memory c = _config(false);
        c.stage1Length = 60 days;
        _createWith(c, false);
        vm.warp(raise.stageDeadlines().start + 59 days);
        vm.prank(attester);
        raise.veto(2 days, bytes32(0));
        assertEq(raise.stageDeadlines().vetoUntil, raise.stageDeadlines().stage1End);
        vm.warp(raise.stageDeadlines().stage1End);
        raise.advanceStage1();
        assertEq(uint256(raise.phase()), uint256(V.Phase.Dissolved));
    }

    function test_staleNonce_deadlineAndSlippage_areAtomic() public {
        _create(false);
        (uint256 id, uint256 tokens) = _deposit(backers[0], 1000e6);
        uint256 nonce = raise.stateNonce();
        vm.expectRevert(V.StaleNonce.selector);
        vm.prank(backers[0]);
        raise.exitAtCost(id, tokens, 0, nonce - 1, vm.getBlockTimestamp());
        vm.expectRevert(V.Expired.selector);
        vm.prank(backers[0]);
        raise.exitAtCost(id, tokens, 0, nonce, vm.getBlockTimestamp() - 1);
        vm.expectRevert(V.Slippage.selector);
        vm.prank(backers[0]);
        raise.exitAtCost(id, tokens, 1000e6 + 1, nonce, vm.getBlockTimestamp());
        assertEq(raise.stateNonce(), nonce);
        assertFalse(raise.redeemQuote(id, tokens, nonce - 1).validity.available);
        assertEq(raise.redeemQuote(id, tokens, nonce - 1).result.payout, 0);
    }

    function test_tinyPartialZeroCost_finalExitReturnsExactRemainder() public {
        _create(false);
        (uint256 id, uint256 tokens) = _deposit(backers[0], 1);
        assertGt(tokens, 1);
        assertEq(_exit(id, 1, false), 0);
        assertEq(_exit(id, tokens - 1, false), 1);
        assertEq(raise.reserveState().E, 0);
        _assertBook();
    }
}
