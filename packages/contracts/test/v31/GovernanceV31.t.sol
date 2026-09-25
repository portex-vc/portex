// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseV31} from "./BaseV31.sol";
import {TypesV31 as V} from "../../src/v31/TypesV31.sol";
import {GovernanceV31} from "../../src/v31/GovernanceV31.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

contract GovernanceV31Test is BaseV31 {
    function test_escrowSpendingAlwaysDisabled() public {
        _create(false);
        _fund();
        _open();
        vm.expectRevert(V.Unauthorized.selector);
        vm.prank(builder);
        governor.propose(1, "");
        vm.expectRevert(V.Unauthorized.selector);
        raise.governorDraw(1, 1, 10);
    }

    function test_stage1_hasNoSpending() public {
        _create(true);
        _fund();
        vm.expectRevert(V.InvalidPhase.selector);
        vm.prank(builder);
        governor.propose(1, "");
    }

    function test_yesExitCancelsVote_withoutBlockingCost_andCannotRecast() public {
        _setupBudget();
        uint256 id = _propose(100e6);
        vm.prank(backers[0]);
        governor.vote(id, ids[0], true);
        assertEq(governor.lockedWeight(ids[0]), 1500e6);
        _exit(ids[0], 1, false);
        assertEq(governor.lockedWeight(ids[0]), 0);
        assertEq(governor.getProposal(id).yesWeight, 0);
        vm.expectRevert(V.InvalidPosition.selector);
        vm.prank(backers[0]);
        governor.vote(id, ids[0], true);
        _assertBook();
    }

    function test_voteWeightCannotBeCountedTwice_sameOwnerMultipleClasses() public {
        _setupBudget();
        _buy(backers[0], 500e6);
        uint256 proposal = _propose(100e6);
        vm.prank(backers[0]);
        governor.vote(proposal, ids[0], true);
        assertEq(governor.getProposal(proposal).yesWeight, 1500e6);
        vm.expectRevert(V.InvalidPosition.selector);
        vm.prank(backers[0]);
        governor.vote(proposal, ids[0], true);
        (,,,,, uint256 buyerId) = raise.accounting();
        vm.expectRevert(V.InvalidPosition.selector);
        vm.prank(backers[0]);
        governor.vote(proposal, buyerId, true);
    }

    function test_executeRechecksThresholds_afterYesExit() public {
        _setupBudget();
        uint256 proposal = _propose(1400e6);
        for (uint256 i; i < 10; ++i) {
            vm.prank(backers[i]);
            governor.vote(proposal, ids[i], true);
        }
        GovernanceV31.Proposal memory p = governor.getProposal(proposal);
        vm.warp(p.votingEnds);
        governor.finalize(proposal);
        assertTrue(governor.depositsPaused());
        _exit(ids[9], 1, false);
        vm.warp(p.disputeEnds);
        vm.expectRevert(V.InvalidAmount.selector);
        governor.execute(proposal);
        vm.warp(p.executeEnds);
        governor.expire(proposal);
        assertEq(governor.lockedWeight(ids[0]), 0);
        assertFalse(governor.depositsPaused());
    }

    function test_voteQuorumAndTenPercentCap_defeat() public {
        _setupBudget();
        uint256 proposal = _propose(100e6);
        vm.prank(backers[0]);
        governor.vote(proposal, ids[0], true);
        vm.warp(governor.getProposal(proposal).votingEnds);
        governor.finalize(proposal);
        assertEq(uint256(governor.getProposal(proposal).status), uint256(GovernanceV31.Status.Defeated));
        assertEq(governor.lockedWeight(ids[0]), 0);
        proposal = _propose(1700e6);
        for (uint256 i; i < 10; ++i) {
            vm.prank(backers[i]);
            governor.vote(proposal, ids[i], true);
        }
        vm.warp(governor.getProposal(proposal).votingEnds);
        governor.finalize(proposal);
        assertEq(uint256(governor.getProposal(proposal).status), uint256(GovernanceV31.Status.Defeated));
    }

    function test_noVotes_exitAlsoCancelsCountedWeight() public {
        _setupBudget();
        uint256 proposal = _propose(100e6);
        vm.prank(backers[0]);
        governor.vote(proposal, ids[0], false);
        _exit(ids[0], 1, false);
        assertEq(governor.getProposal(proposal).noWeight, 0);
    }

    function test_haircutPartialExit_preservesExactOtherClaimsAndRemainder() public {
        _setupBudget();
        _draw(999_999999);
        uint256 beforeBasis = raise.guaranteedClaim(ids[0]).amount;
        uint256 other = raise.guaranteedClaim(ids[1]).amount;
        uint256 tokens = raise.positionState(ids[0]).tokens;
        uint256 payout = _exit(ids[0], tokens / 3, false);
        assertEq(payout, Math.mulDiv(beforeBasis, tokens / 3, tokens));
        assertEq(raise.guaranteedClaim(ids[0]).amount, beforeBasis - payout);
        assertEq(raise.guaranteedClaim(ids[1]).amount, other);
        _assertBook();
        for (uint256 i; i < 9; ++i) {
            _exit(ids[i], raise.positionState(ids[i]).tokens, false);
        }
        uint256 escrow = raise.reserveState().E;
        assertEq(raise.reserveState().claimCount, 1);
        assertEq(raise.guaranteedClaim(ids[9]).amount, escrow);
        uint256 remaining = raise.positionState(ids[9]).tokens;
        uint256 half = _exit(ids[9], remaining / 2, false);
        assertEq(raise.guaranteedClaim(ids[9]).amount, escrow - half);
        assertEq(_exit(ids[9], remaining - remaining / 2, false), escrow - half);
        assertEq(raise.reserveState().E, 0);
        assertEq(raise.reserveState().H, 0);
        _assertBook();
    }

    function test_ceilingPinned_andFutureBoundsConservative() public {
        V.Config memory c = _config(true);
        c.budgetCeiling = 0.01e18;
        _createWith(c, true);
        _fund();
        _open();
        (,, uint256 ceiling) = raise.governanceState();
        V.Bounds memory bounds = raise.futureClaimBounds(ids[0], V.Phase.Stage2);
        assertLe(bounds.lower, bounds.upper);
        vm.expectRevert(V.InvalidAmount.selector);
        vm.prank(builder);
        governor.propose(ceiling + 1, "");
        _draw(ceiling);
        assertGe(raise.guaranteedClaim(ids[0]).amount, bounds.lower);
        (,, uint256 remaining) = raise.governanceState();
        assertEq(remaining, 0);
        assertEq(raise.futureClaimBounds(ids[0], V.Phase.Stage3).upper, 0);
        _assertBook();
    }

    function test_executionWindowAndPhaseDeadline_releaseLogicalLocks() public {
        _setupBudget();
        uint256 proposal = _propose(100e6);
        for (uint256 i; i < 10; ++i) {
            vm.prank(backers[i]);
            governor.vote(proposal, ids[i], true);
        }
        GovernanceV31.Proposal memory p = governor.getProposal(proposal);
        vm.warp(p.votingEnds);
        governor.finalize(proposal);
        vm.expectRevert(V.Expired.selector);
        governor.execute(proposal);
        vm.warp(p.executeEnds);
        assertEq(governor.lockedWeight(ids[0]), 0);
        vm.expectRevert(V.Expired.selector);
        governor.execute(proposal);
        governor.expire(proposal);
        vm.warp(raise.stageDeadlines().stage2End - 12 days + 1);
        vm.expectRevert(V.Expired.selector);
        vm.prank(builder);
        governor.propose(100e6, "");
        _list();
    }

    function test_unanimousBackersReachQuorum_despiteLargeBuilderPurchase() public {
        _create(true);
        (uint256 builderId,) = _deposit(builder, 7000e6);
        for (uint256 i; i < 9; ++i) {
            (ids[i],) = _deposit(backers[i], 500e6);
        }
        (ids[9],) = _deposit(backers[9], 100000e6);
        _open();
        for (uint256 i; i < 10; ++i) {
            _exit(ids[i], raise.positionState(ids[i]).tokens * 9 / 10, false);
        }
        uint256 capital = raise.eligibleCapital();
        assertLt(capital, raise.reserveState().E * 40 / 100);
        assertGt(raise.guaranteedClaim(builderId).amount, capital);
        uint256 proposal = _propose(capital / 10);
        assertEq(governor.getProposal(proposal).capitalSnapshot, capital);
        vm.expectRevert(V.InvalidPosition.selector);
        vm.prank(builder);
        governor.vote(proposal, builderId, true);
        for (uint256 i; i < 10; ++i) {
            vm.prank(backers[i]);
            governor.vote(proposal, ids[i], true);
        }
        assertEq(governor.getProposal(proposal).yesWeight, capital);
        GovernanceV31.Proposal memory p = governor.getProposal(proposal);
        vm.warp(p.votingEnds);
        governor.finalize(proposal);
        assertEq(uint256(governor.getProposal(proposal).status), uint256(GovernanceV31.Status.Passed));
        vm.warp(p.disputeEnds);
        governor.execute(proposal);
        _assertEligibleCapital();
        _exit(ids[0], raise.positionState(ids[0]).tokens / 3, false);
        _assertEligibleCapital();
        for (uint256 i; i < 9; ++i) {
            _exit(ids[i], raise.positionState(ids[i]).tokens, false);
        }
        _exit(builderId, raise.positionState(builderId).tokens, false);
        assertLe(raise.eligibleCapital(), raise.reserveState().E);
        _assertEligibleCapital();
        _list();
        assertEq(raise.eligibleCapital(), 0);
    }

    function _assertEligibleCapital() internal view {
        uint256 sum;
        for (uint256 i; i < 10; ++i) {
            sum += raise.positionState(ids[i]).shares;
        }
        assertEq(raise.eligibleCapital(), Math.mulDiv(sum, raise.reserveState().J, V.SCALE));
    }

    function _setupBudget() internal {
        _create(true);
        _fund();
        _open();
    }

    function _propose(uint256 amount) internal returns (uint256 id) {
        vm.prank(builder);
        id = governor.propose(amount, "ipfs://vote");
    }
}
