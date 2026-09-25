// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.sol";
import {Raise} from "../src/Raise.sol";
import {SpendGovernor} from "../src/SpendGovernor.sol";
import {RaiseConfig, GovernorConfig, TokenMeta} from "../src/libraries/PortexTypes.sol";
import {RaiseFactory} from "../src/RaiseFactory.sol";

/// @notice Rule 2 SpendGovernor (§5.7): proposal lifecycle, voting weights, thresholds, the
///         10%-of-YES cap, withdraw locks, dispute-window exits, pro-rata spends, the cumulative
///         ceiling and proposal interval, lifecycle interaction, and the §9 S7 scenario.
contract SpendGovernorTest is BaseTest {
    uint8 internal constant PASSED = uint8(SpendGovernor.Status.Passed);
    uint8 internal constant DEFEATED = uint8(SpendGovernor.Status.Defeated);
    uint8 internal constant EXPIRED = uint8(SpendGovernor.Status.Expired);

    SpendGovernor internal governorImpl;
    SpendGovernor internal gov;

    function setUp() public override {
        super.setUp();
        governorImpl = new SpendGovernor();
        publishMilestoneFunding(address(governorImpl));
        createGovRaise();
        gov = SpendGovernor(raise.governor());
    }

    // ---------------- helpers ----------------

    function _propose(uint256 amount) internal returns (uint256 id) {
        vm.prank(builder);
        id = gov.propose(amount, "ipfs://milestone");
    }

    function _vote(address user, uint256 id, bool support) internal {
        vm.prank(user);
        gov.vote(id, support);
    }

    function _finalize(uint256 id) internal {
        uint64 votingEnds = gov.getProposal(id).votingEnds;
        if (block.timestamp < votingEnds) vm.warp(votingEnds);
        gov.finalize(id);
    }

    function _status(uint256 id) internal view returns (uint8) {
        return uint8(gov.getProposal(id).status);
    }

    // ---------------- wiring ----------------

    function test_factoryWiresGovernor() public view {
        assertEq(address(gov.raise()), address(raise));
        GovernorConfig memory g = gov.getGovernorConfig();
        assertEq(g.votingPeriod, 5 minutes);
        assertEq(g.disputeWindow, 5 minutes);
        assertEq(g.minProposalInterval, 10 minutes);
        assertEq(g.quorumBps, 4000);
        assertEq(g.approvalBps, 6000);
        assertEq(gov.proposalsCount(), 0);
        assertFalse(gov.proposalInFlight());
    }

    function test_revert_governorConfigValidation() public {
        RaiseConfig memory cfg = defaultConfig();
        cfg.governor.votingPeriod = 0;
        vm.expectRevert(RaiseFactory.DurationsInvalid.selector);
        vm.prank(builder);
        factory.createRaise(MILESTONE_FUNDING, 1, cfg, TokenMeta({name: "X", symbol: "X"}));

        cfg = defaultConfig();
        cfg.governor.quorumBps = 0;
        vm.expectRevert(RaiseFactory.BpsInvalid.selector);
        vm.prank(builder);
        factory.createRaise(MILESTONE_FUNDING, 1, cfg, TokenMeta({name: "X", symbol: "X"}));

        cfg = defaultConfig();
        cfg.governor.approvalBps = 10_001;
        vm.expectRevert(RaiseFactory.BpsInvalid.selector);
        vm.prank(builder);
        factory.createRaise(MILESTONE_FUNDING, 1, cfg, TokenMeta({name: "X", symbol: "X"}));
    }

    function test_zeroExtractionIgnoresGovernorConfig() public {
        // garbage governor config is fine when the template has no governorImpl
        RaiseConfig memory cfg = defaultConfig();
        cfg.governor =
            GovernorConfig({votingPeriod: 0, disputeWindow: 0, minProposalInterval: 0, quorumBps: 0, approvalBps: 0});
        vm.prank(builder);
        address r = factory.createRaise(ZERO_EXTRACTION, 1, cfg, TokenMeta({name: "X", symbol: "X"}));
        assertEq(Raise(payable(r)).governor(), address(0));
    }

    // ---------------- propose reverts ----------------

    function test_revert_proposeNotBuilder() public {
        vm.expectRevert(SpendGovernor.OnlyBuilder.selector);
        vm.prank(alice);
        gov.propose(1_000e6, "ipfs://x");
    }

    function test_revert_proposeZeroAmount() public {
        vm.expectRevert(SpendGovernor.ZeroAmount.selector);
        vm.prank(builder);
        gov.propose(0, "ipfs://x");
    }

    function test_revert_proposeWhileActive() public {
        depositAs(alice, 100_000e6);
        _propose(1_000e6);
        vm.expectRevert(SpendGovernor.ProposalActive.selector);
        vm.prank(builder);
        gov.propose(1_000e6, "ipfs://y");
    }

    function test_proposeIntervalEnforced() public {
        depositAs(alice, 100_000e6);
        uint256 id = _propose(1_000e6);
        _finalize(id); // no votes -> defeated
        assertEq(_status(id), DEFEATED);
        vm.expectRevert(SpendGovernor.IntervalNotElapsed.selector);
        vm.prank(builder);
        gov.propose(1_000e6, "ipfs://y");
        vm.warp(block.timestamp + 5 minutes); // 10 min since the first proposal
        _propose(1_000e6);
        assertEq(gov.proposalsCount(), 2);
    }

    function test_revert_proposeAboveCeiling() public {
        depositAs(alice, 200_000e6); // ceiling = 30% of 200k = 60k
        vm.expectRevert(SpendGovernor.CeilingExceeded.selector);
        vm.prank(builder);
        gov.propose(60_000e6 + 1, "ipfs://x");
    }

    function test_revert_proposeOutsideIncubation() public {
        depositAs(alice, 60_000e6);
        vm.warp(block.timestamp + 10 minutes);
        raise.startCommitment(); // no proposal in flight -> allowed
        vm.expectRevert(SpendGovernor.InvalidState.selector);
        vm.prank(builder);
        gov.propose(1_000e6, "ipfs://x");
    }

    // ---------------- vote reverts ----------------

    function test_revert_voteBuilder() public {
        depositAs(alice, 100_000e6);
        uint256 id = _propose(1_000e6);
        vm.expectRevert(SpendGovernor.BuilderCannotVote.selector);
        vm.prank(builder);
        gov.vote(id, true);
    }

    function test_revert_voteZeroWeight() public {
        depositAs(alice, 100_000e6);
        uint256 id = _propose(1_000e6);
        vm.expectRevert(SpendGovernor.ZeroWeight.selector);
        vm.prank(whale); // no principal
        gov.vote(id, true);
    }

    function test_revert_voteTwice() public {
        depositAs(alice, 100_000e6);
        uint256 id = _propose(1_000e6);
        _vote(alice, id, false);
        vm.expectRevert(SpendGovernor.AlreadyVoted.selector);
        vm.prank(alice);
        gov.vote(id, true);
    }

    function test_revert_voteAfterVotingEnds() public {
        depositAs(alice, 100_000e6);
        uint256 id = _propose(1_000e6);
        vm.warp(block.timestamp + 5 minutes);
        vm.expectRevert(SpendGovernor.VotingEnded.selector);
        vm.prank(alice);
        gov.vote(id, true);
    }

    function test_revert_voteNotActive() public {
        depositAs(alice, 100_000e6);
        vm.expectRevert(SpendGovernor.ProposalNotActive.selector);
        vm.prank(alice);
        gov.vote(9, true); // does not exist
        uint256 id = _propose(1_000e6);
        _finalize(id); // defeated
        vm.expectRevert(SpendGovernor.ProposalNotActive.selector);
        vm.prank(alice);
        gov.vote(id, true);
    }

    // ---------------- finalize / thresholds ----------------

    function test_revert_finalizeBeforeVotingEnds() public {
        depositAs(alice, 100_000e6);
        uint256 id = _propose(1_000e6);
        vm.expectRevert(SpendGovernor.VotingNotEnded.selector);
        gov.finalize(id);
    }

    function test_quorumNotMet_defeated() public {
        depositAs(alice, 100_000e6);
        depositAs(bob, 60_000e6);
        depositAs(carol, 40_000e6);
        uint256 id = _propose(1_000e6);
        _vote(carol, id, true); // 20% participation < 40% quorum
        _finalize(id);
        assertEq(_status(id), DEFEATED);
        assertFalse(gov.proposalInFlight());
    }

    function test_quorumExactEdge_passes() public {
        depositAs(alice, 40_000e6);
        depositAs(bob, 60_000e6);
        depositAs(carol, 60_000e6);
        depositAs(whale, 40_000e6);
        uint256 id = _propose(8_000e6);
        _vote(alice, id, true); // 40k
        _vote(whale, id, true); // 40k -> exactly 40% of 200k
        _finalize(id);
        assertEq(_status(id), PASSED); // cap: 8k == 10% of 80k
    }

    function test_approvalBelowThreshold_defeated() public {
        depositAs(alice, 100_000e6);
        depositAs(bob, 60_000e6);
        depositAs(carol, 40_000e6);
        uint256 id = _propose(1_000e6);
        _vote(alice, id, true); // 100k
        _vote(bob, id, false); // 60k
        _vote(carol, id, false); // 40k -> YES share 50% < 60%
        _finalize(id);
        assertEq(_status(id), DEFEATED);
    }

    function test_approvalExactThreshold_passes() public {
        depositAs(alice, 90_000e6);
        depositAs(bob, 60_000e6);
        uint256 id = _propose(9_000e6);
        _vote(alice, id, true); // 90k
        _vote(bob, id, false); // 60k -> YES share exactly 60%
        _finalize(id);
        assertEq(_status(id), PASSED);
    }

    function test_tenPercentCap_exactPasses_overOneWeiDefeated() public {
        depositAs(alice, 100_000e6);
        depositAs(bob, 100_000e6);
        // 1 wei over 10% of the YES principal -> defeated
        uint256 id1 = _propose(10_000e6 + 1);
        _vote(alice, id1, true); // YES 100k -> cap 10k
        _finalize(id1);
        assertEq(_status(id1), DEFEATED);
        // exactly 10% -> passes
        vm.warp(block.timestamp + 5 minutes); // interval
        uint256 id2 = _propose(10_000e6);
        _vote(alice, id2, true);
        _finalize(id2);
        assertEq(_status(id2), PASSED);
    }

    function test_weightFixedAtVoteTime() public {
        depositAs(alice, 100_000e6);
        uint256 id = _propose(12_000e6);
        _vote(alice, id, true); // weight 100k fixed
        depositAs(alice, 50_000e6); // depositing more does not raise the vote weight
        _finalize(id); // cap needs YES >= 120k; fixed weight is 100k -> defeated
        assertEq(_status(id), DEFEATED);
    }

    /// @notice Documented rule: NO capital can be moved and re-voted from fresh addresses,
    ///         multiplying counted NO weight. It can only bias toward defeat — never pass a spend.
    function test_noVoteMobility_onlyHelpsDefeat() public {
        depositAs(alice, 100_000e6);
        depositAs(bob, 100_000e6);
        uint256 id = _propose(1_000e6);
        _vote(bob, id, false); // NO 100k
        withdrawAs(bob, 100_000e6); // NO capital leaves; weight stays counted
        depositAs(whale, 100_000e6);
        _vote(whale, id, false); // same capital, second address: NO counted as 200k
        assertEq(gov.getProposal(id).noPrincipal, 200_000e6);
        _finalize(id);
        assertEq(_status(id), DEFEATED); // defeated despite (inflated) 100% participation: YES = 0
    }

    // ---------------- locks ----------------

    function test_yesLockLifecycle() public {
        depositAs(alice, 100_000e6);
        depositAs(bob, 100_000e6);
        uint256 id = _propose(10_000e6);
        _vote(alice, id, true);
        uint64 disputeEnds = gov.getProposal(id).disputeEnds;
        // YES locks cover the whole period in which execute() is possible
        assertEq(raise.withdrawLockUntil(alice), gov.lockUntil(id));
        assertGt(gov.lockUntil(id), disputeEnds);
        // locked during voting
        vm.expectRevert(Raise.WithdrawLocked.selector);
        vm.prank(alice);
        raise.withdraw(1e6);
        _finalize(id); // passes (100k YES of 200k = 50% quorum, 100% approval, cap ok)
        // locked during the dispute window
        vm.expectRevert(Raise.WithdrawLocked.selector);
        vm.prank(alice);
        raise.withdraw(1e6);
        // abstainers are never locked
        withdrawAs(bob, 100_000e6);
        // the dispute window is over but the spend has not executed: a YES voter still cannot
        // leave (this is the gap that used to let YES voters dodge the spend they approved)
        vm.warp(disputeEnds);
        vm.expectRevert(Raise.WithdrawLocked.selector);
        vm.prank(alice);
        raise.withdraw(1e6);
        gov.execute(id);
        // executed: the lock is releasable by anyone, and alice pays pro rata (100k -> 90k)
        gov.releaseLock(id, alice);
        withdrawAs(alice, 90_000e6);
        assertEq(usdg.balanceOf(alice), 10_000_000e6 - 10_000e6);
    }

    function test_revert_executeAfterLocksLapse() public {
        depositAs(alice, 100_000e6);
        uint256 id = _propose(10_000e6);
        _vote(alice, id, true);
        _finalize(id);
        // once YES locks have lapsed the spend can never execute; only expire() remains
        vm.warp(gov.lockUntil(id));
        vm.expectRevert(SpendGovernor.ExecuteWindowClosed.selector);
        gov.execute(id);
        gov.expire(id);
        withdrawAs(alice, 100_000e6); // whole: nothing was spent
    }

    function test_depositsPausedOnceVotingCloses() public {
        depositAs(alice, 100_000e6);
        uint256 id = _propose(10_000e6);
        // during voting newcomers may join (they can still vote)
        depositAs(bob, 10_000e6);
        _vote(alice, id, true);
        uint64 votingEnds = gov.getProposal(id).votingEnds;
        // voting closed, outcome pending: a newcomer could not vote, so must not be able to join
        vm.warp(votingEnds);
        assertTrue(gov.depositsPaused());
        vm.startPrank(carol);
        usdg.approve(address(raise), 1e6);
        vm.expectRevert(Raise.DepositsPaused.selector);
        raise.deposit(1e6);
        vm.stopPrank();
        // still paused through the dispute window
        gov.finalize(id);
        vm.startPrank(carol);
        vm.expectRevert(Raise.DepositsPaused.selector);
        raise.deposit(1e6);
        vm.stopPrank();
        // executed: deposits reopen, and the newcomer does not pay for the past spend
        vm.warp(gov.getProposal(id).disputeEnds);
        gov.execute(id);
        assertFalse(gov.depositsPaused());
        depositAs(carol, 50_000e6);
        // shares are floored at the lowered index: at most 1 wei of dust, in the protocol's favour
        uint256 carolPrincipal = raise.principalOf(carol);
        assertApproxEqAbs(carolPrincipal, 50_000e6, 1);
        withdrawAs(carol, carolPrincipal);
    }

    function test_revert_executeNotPassed() public {
        depositAs(alice, 100_000e6);
        uint256 id = _propose(1_000e6);
        vm.expectRevert(SpendGovernor.NotPassed.selector);
        gov.execute(id);
        _finalize(id); // no votes -> defeated
        vm.expectRevert(SpendGovernor.NotPassed.selector);
        gov.execute(id);
    }

    function test_revert_executeDuringDispute() public {
        depositAs(alice, 100_000e6);
        uint256 id = _propose(10_000e6);
        _vote(alice, id, true);
        _finalize(id);
        assertEq(_status(id), PASSED);
        vm.expectRevert(SpendGovernor.DisputeNotEnded.selector);
        gov.execute(id);
    }

    function test_expire_unblocksStuckProposal() public {
        depositAs(alice, 100_000e6);
        uint256 id = _propose(10_000e6);
        _vote(alice, id, true);
        _finalize(id);
        vm.expectRevert(SpendGovernor.ExpireTooEarly.selector);
        gov.expire(id);
        // grace = one disputeWindow past disputeEnds
        uint64 disputeEnds = gov.getProposal(id).disputeEnds;
        vm.warp(disputeEnds + 5 minutes);
        gov.expire(id);
        assertEq(_status(id), EXPIRED);
        assertFalse(gov.proposalInFlight());
        vm.expectRevert(SpendGovernor.NotPassed.selector);
        gov.execute(id);
    }

    function test_revert_releaseLockPaths() public {
        depositAs(alice, 100_000e6);
        depositAs(bob, 60_000e6);
        depositAs(carol, 40_000e6);
        uint256 id = _propose(1_000e6);
        _vote(carol, id, true); // 20% -> will be defeated on quorum
        vm.expectRevert(SpendGovernor.NotDefeated.selector);
        gov.releaseLock(id, carol);
        _finalize(id);
        assertEq(_status(id), DEFEATED);
        vm.expectRevert(SpendGovernor.NoLockToRelease.selector);
        gov.releaseLock(id, bob); // never voted
        vm.expectRevert(SpendGovernor.NoLockToRelease.selector);
        gov.releaseLock(id, alice); // never voted
        // still locked until released (the lock would lapse at disputeEnds)
        vm.expectRevert(Raise.WithdrawLocked.selector);
        vm.prank(carol);
        raise.withdraw(1e6);
        gov.releaseLock(id, carol); // permissionless
        withdrawAs(carol, 40_000e6);
        assertEq(usdg.balanceOf(carol), 10_000_000e6);
    }

    // ---------------- lifecycle interaction ----------------

    function test_startCommitment_blockedWhileInFlight() public {
        depositAs(alice, 100_000e6);
        depositAs(bob, 100_000e6);
        uint256 id = _propose(1_000e6);
        vm.warp(block.timestamp + 10 minutes); // minIncubation met; voting over, not finalized
        vm.expectRevert(Raise.ProposalInFlight.selector);
        raise.startCommitment();
        gov.finalize(id); // defeated (no votes)
        raise.startCommitment(); // works again
        assertEq(uint8(raise.state()), uint8(Raise.State.Commitment));
    }

    function test_startCommitment_blockedDuringDispute() public {
        depositAs(alice, 100_000e6);
        depositAs(bob, 100_000e6);
        vm.warp(block.timestamp + 8 minutes);
        uint256 id = _propose(10_000e6); // voting [t0+8, t0+13), dispute ends t0+18
        _vote(alice, id, true);
        _finalize(id); // passed
        vm.warp(block.timestamp + 2 minutes); // t0+15: minIncubation met, inside the dispute window
        vm.expectRevert(Raise.ProposalInFlight.selector);
        raise.startCommitment();
        uint64 disputeEnds = gov.getProposal(id).disputeEnds;
        vm.warp(disputeEnds);
        gov.execute(id);
        raise.startCommitment(); // unblocked after execution
        assertEq(uint8(raise.state()), uint8(Raise.State.Commitment));
    }

    function test_builderCancel_duringProposal_everyoneExitsWhole() public {
        depositAs(alice, 100_000e6);
        uint256 id = _propose(10_000e6);
        _vote(alice, id, true); // locked
        vm.prank(builder);
        raise.cancel();
        assertEq(uint8(raise.state()), uint8(Raise.State.Failed));
        withdrawAs(alice, 100_000e6); // locks are ignored in Failed
        assertEq(usdg.balanceOf(alice), 10_000_000e6);
    }

    // ---------------- spends ----------------

    function test_laterDepositor_doesNotPayForPastSpends() public {
        depositAs(alice, 100_000e6);
        uint256 id = _propose(10_000e6);
        _vote(alice, id, true);
        _finalize(id);
        uint64 disputeEnds = gov.getProposal(id).disputeEnds;
        vm.warp(disputeEnds);
        gov.execute(id);
        assertEq(raise.index(), 0.9e27);
        depositAs(bob, 50_000e6); // joins at the new index
        assertEq(raise.index(), 0.9e27); // unchanged by the deposit
        assertEq(raise.principalOf(bob), 50_000e6 - 1); // 1 wei floor dust
        assertEq(raise.principalOf(alice), 90_000e6);
    }

    function test_cumulativeCeiling_acrossSpends() public {
        depositAs(alice, 100_000e6);
        depositAs(bob, 60_000e6);
        depositAs(carol, 40_000e6);
        // four 15k spends pass (YES = everyone; their current principal stays >= 150k, so the
        // 10%-of-YES cap never binds); the 60k cumulative ceiling of peak 200k is hit exactly.
        for (uint256 i = 0; i < 4; ++i) {
            uint256 id = _propose(15_000e6);
            _vote(alice, id, true);
            _vote(bob, id, true);
            _vote(carol, id, true);
            _finalize(id);
            uint64 disputeEnds = gov.getProposal(id).disputeEnds;
            vm.warp(disputeEnds);
            gov.execute(id);
            vm.warp(block.timestamp + 5 minutes); // interval spacing
        }
        assertEq(raise.cumulativeSpend(), 60_000e6);
        assertEq(raise.totalPrincipal(), 140_000e6);
        // exact through spends: every deposit happened at index 1e27, so no dust exists
        assertEq(usdg.balanceOf(address(raise)), raise.escrowedPrincipal());
        // the next proposal busts the ceiling
        vm.expectRevert(SpendGovernor.CeilingExceeded.selector);
        vm.prank(builder);
        gov.propose(1, "ipfs://x");
    }

    /// @notice Whale + builder collusion: the 10%-of-YES cap bounds each spend, dissenters walk
    ///         away whole, and the cumulative ceiling bounds the total.
    function test_whaleCollusion_boundedByCap() public {
        depositAs(whale, 190_000e6);
        depositAs(alice, 10_000e6);
        // ask for 1 wei more than 10% of whale's principal -> defeated
        uint256 id1 = _propose(19_000e6 + 1);
        _vote(whale, id1, true); // 95% participation, 100% approval
        _finalize(id1);
        assertEq(_status(id1), DEFEATED); // the cap binds
        vm.warp(block.timestamp + 5 minutes);
        // exactly 10% of whale -> passes; alice does not vote YES and leaves whole
        uint256 id2 = _propose(19_000e6);
        _vote(whale, id2, true);
        _finalize(id2);
        assertEq(_status(id2), PASSED);
        withdrawAs(alice, 10_000e6); // dissenter leaves whole
        assertEq(usdg.balanceOf(alice), 10_000_000e6);
        uint64 disputeEnds = gov.getProposal(id2).disputeEnds;
        vm.warp(disputeEnds);
        uint256 builderBefore = usdg.balanceOf(builder);
        gov.execute(id2);
        assertEq(usdg.balanceOf(builder) - builderBefore, 19_000e6);
        assertEq(raise.index(), 0.9e27);
        assertEq(raise.principalOf(whale), 171_000e6); // whale pays its own pro-rata share
    }

    // ---------------- S7 (design §9) ----------------

    /// @notice S7: Rule 2 spend with dissenters — leavers whole; stayers pay pro rata; 10% cap
    ///         enforced; later depositors unaffected.
    function test_S7_rule2SpendWithDissenters() public {
        depositAs(alice, 100_000e6);
        depositAs(bob, 60_000e6);
        depositAs(carol, 40_000e6);

        // 10% cap enforced: 1 wei over alice's 10% is defeated even with her YES vote
        uint256 id1 = _propose(10_000e6 + 1);
        _vote(alice, id1, true);
        _finalize(id1);
        assertEq(_status(id1), DEFEATED);
        vm.warp(block.timestamp + 5 minutes); // minProposalInterval

        // the passing proposal: alice YES (100k), bob NO (60k), carol abstains
        uint256 id2 = _propose(10_000e6);
        _vote(alice, id2, true);
        _vote(bob, id2, false);
        _finalize(id2);
        // quorum 160k/200k = 80% >= 40%; approval 100/160 = 62.5% >= 60%; cap 10k == 10% x 100k
        assertEq(_status(id2), PASSED);

        // dispute window: everyone who did not vote YES leaves 100% whole
        withdrawAs(bob, 60_000e6);
        withdrawAs(carol, 40_000e6);
        assertEq(usdg.balanceOf(bob), 10_000_000e6);
        assertEq(usdg.balanceOf(carol), 10_000_000e6);
        // YES voter is locked until the window ends
        vm.expectRevert(Raise.WithdrawLocked.selector);
        vm.prank(alice);
        raise.withdraw(1e6);

        // execution: the builder is paid; alice (the only stayer) pays pro rata through the index
        uint64 disputeEnds = gov.getProposal(id2).disputeEnds;
        vm.warp(disputeEnds);
        uint256 builderBefore = usdg.balanceOf(builder);
        gov.execute(id2);
        assertEq(usdg.balanceOf(builder) - builderBefore, 10_000e6);
        assertEq(raise.index(), 0.9e27);
        assertEq(raise.principalOf(alice), 90_000e6);
        assertEq(raise.cumulativeSpend(), 10_000e6);

        // later depositors do not pay for past spends
        depositAs(whale, 50_000e6);
        assertEq(raise.principalOf(whale), 50_000e6 - 1); // floor dust only

        // escrow holds exactly the accounted principal plus the 1 wei of deposit dust
        assertEq(usdg.balanceOf(address(raise)), raise.escrowedPrincipal() + 1);
        // alice exits at exactly her post-spend principal
        gov.releaseLock(id2, alice);
        withdrawAs(alice, 90_000e6);
        assertEq(usdg.balanceOf(alice), 10_000_000e6 - 10_000e6);
    }

    // ---------------- H-02 (accepted design risk — disclosed bounds) ----------------

    /// @notice Auditor test 2 (H-02). The fix was NOT taken (accepted design risk, disclosed in
    ///         INTERFACES.md): a builder-linked wallet can pass a spend with its own YES capital.
    ///         This pins the disclosed bounds of that attack instead: the spend is capped at 10%
    ///         of YES principal and the cumulative ceiling, a passive stayer pays exactly pro
    ///         rata, and a dissenter who exits inside the dispute window loses nothing.
    function test_rule2_builderSybilTaxIsCappedAndDissenterExitsWhole() public {
        address sybil = makeAddr("builderSybil");
        usdg.mint(sybil, 100_000e6);
        depositAs(alice, 100_000e6); // honest, passive
        depositAs(sybil, 100_000e6); // builder-linked capital

        // the builder address itself cannot vote, but the sybil can (the accepted risk)
        uint256 id1 = _propose(10_000e6); // exactly 10% of the sybil's YES principal
        vm.expectRevert(SpendGovernor.BuilderCannotVote.selector);
        _vote(builder, id1, true);
        _vote(sybil, id1, true);
        _finalize(id1); // 50% participation >= 40% quorum, 100% YES >= 60% approval
        assertEq(_status(id1), PASSED);

        // alice does not watch governance and stays through the window: she pays exactly pro
        // rata (5k), the builder+sybil system nets exactly her loss (+10k paid, −5k own share)
        vm.warp(gov.getProposal(id1).disputeEnds);
        uint256 builderBefore = usdg.balanceOf(builder);
        gov.execute(id1);
        assertEq(usdg.balanceOf(builder) - builderBefore, 10_000e6);
        assertEq(raise.principalOf(alice), 95_000e6); // the disclosed pro-rata tax
        assertEq(raise.principalOf(sybil), 95_000e6);

        // the disclosed defence: a backer who exits during the dispute window loses nothing
        vm.warp(block.timestamp + 10 minutes); // minProposalInterval
        uint256 id2 = _propose(9_000e6); // within 10% of sybil's current 95k
        _vote(sybil, id2, true);
        _finalize(id2);
        assertEq(_status(id2), PASSED);
        withdrawAs(alice, 95_000e6); // dissenter leaves whole — her loss stays exactly the 5k
        assertEq(usdg.balanceOf(alice), 10_000_000e6 - 5_000e6);
        vm.warp(gov.getProposal(id2).disputeEnds);
        gov.execute(id2); // only the stayer (sybil) pays now
        assertEq(raise.principalOf(sybil), 86_000e6);
        assertEq(usdg.balanceOf(alice), 10_000_000e6 - 5_000e6); // unchanged by the second spend
    }
}
