// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseV31} from "./BaseV31.sol";
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
        assertEq(sold, SUPPLY / 5);
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

    function test_stage1Exit_doesNotRewindCurveOrSaleCap() public {
        _create(false);
        (uint256 id, uint256 quantity) = _deposit(backers[0], 1000e6);
        (uint256 sold,,,,,) = raise.accounting();
        assertEq(_exit(id, quantity, false), 1000e6);
        (uint256 afterSold,,,,,) = raise.accounting();
        assertEq(afterSold, sold);
        (, uint256 next) = _deposit(backers[1], 1000e6);
        assertLt(next, quantity);
        assertEq(token.burned(), quantity);
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
        uint256 q = raise.positionState(ids[0]).tokens / 2;
        assertEq(_exit(ids[0], q, false), 750e6);
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
