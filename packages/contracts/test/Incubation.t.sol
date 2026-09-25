// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.sol";
import {Raise} from "../src/Raise.sol";
import {RaiseConfig, CommitmentGates, GraduationGates} from "../src/libraries/PortexTypes.sol";

/// @notice Stage 1 Incubation (§5.1): deposit/withdraw/startCommitment/fail/cancel + reverts.
contract IncubationTest is BaseTest {
    function setUp() public override {
        super.setUp();
        createRaise();
    }

    // ---------------- deposit ----------------

    function test_deposit_basic() public {
        depositAs(alice, 10_000e6);
        assertEq(raise.principalOf(alice), 10_000e6);
        assertEq(raise.sharesOf(alice), 10_000e6); // index = 1e27 -> 1:1
        assertEq(raise.totalPrincipal(), 10_000e6);
        assertEq(usdg.balanceOf(address(raise)), 10_000e6);
        assertEq(raise.peakPrincipal(), 10_000e6);
        // early factor for an immediate depositor is 2x (t == start)
        assertEq(raise.earlyFactorOf(alice), 2e18);
    }

    function test_deposit_earlyFactorDecaysToOne() public {
        vm.warp(block.timestamp + 15 minutes); // halfway to the 30 min deadline
        depositAs(alice, 10_000e6);
        assertEq(raise.earlyFactorOf(alice), 1.5e18);
    }

    function test_deposit_timeWeightAccumulates() public {
        depositAs(alice, 10_000e6);
        vm.warp(block.timestamp + 15 minutes);
        depositAs(alice, 10_000e6);
        // 10k at f=2 + 10k at f=1.5 -> 35k / 20k = 1.75
        assertEq(raise.earlyFactorOf(alice), 1.75e18);
        assertEq(raise.timeWeightOf(alice), 35_000e6);
    }

    function test_revert_depositZero() public {
        vm.expectRevert(Raise.ZeroAmount.selector);
        vm.prank(alice);
        raise.deposit(0);
    }

    function test_revert_depositAfterDeadline() public {
        vm.warp(block.timestamp + 31 minutes);
        vm.startPrank(alice);
        usdg.approve(address(raise), 1e6);
        vm.expectRevert(Raise.DeadlinePassed.selector);
        raise.deposit(1e6);
        vm.stopPrank();
    }

    function test_revert_depositOverHardCap() public {
        depositAs(alice, 200_000e6);
        vm.startPrank(bob);
        usdg.approve(address(raise), 1e6);
        vm.expectRevert(Raise.HardCapExceeded.selector);
        raise.deposit(1e6);
        vm.stopPrank();
    }

    function test_revert_depositAfterCommitment() public {
        toCommitment();
        vm.startPrank(alice);
        usdg.approve(address(raise), 1e6);
        vm.expectRevert(Raise.InvalidState.selector);
        raise.deposit(1e6);
        vm.stopPrank();
    }

    // ---------------- withdraw ----------------

    function test_withdraw_partialProRata() public {
        depositAs(alice, 10_000e6); // ef = 2, timeWeight = 20k
        withdrawAs(alice, 4_000e6);
        assertEq(raise.principalOf(alice), 6_000e6);
        assertEq(raise.timeWeightOf(alice), 12_000e6); // reduced pro rata
        assertEq(raise.sharesOf(alice), 6_000e6);
        assertEq(usdg.balanceOf(alice), 10_000_000e6 - 6_000e6);
    }

    function test_withdraw_full() public {
        depositAs(alice, 10_000e6);
        depositAs(bob, 5_000e6);
        withdrawAs(alice, raise.principalOf(alice));
        assertEq(raise.principalOf(alice), 0);
        assertEq(raise.sharesOf(alice), 0);
        assertEq(raise.timeWeightOf(alice), 0);
        assertEq(usdg.balanceOf(alice), 10_000_000e6);
        assertEq(usdg.balanceOf(address(raise)), 5_000e6);
    }

    function test_revert_withdrawTooMuch() public {
        depositAs(alice, 10_000e6);
        vm.expectRevert(Raise.InsufficientPrincipal.selector);
        vm.prank(alice);
        raise.withdraw(10_000e6 + 1);
    }

    function test_revert_withdrawZero() public {
        depositAs(alice, 10_000e6);
        vm.expectRevert(Raise.ZeroAmount.selector);
        vm.prank(alice);
        raise.withdraw(0);
    }

    function test_revert_withdrawInCommitment() public {
        toCommitment();
        vm.expectRevert(Raise.InvalidState.selector);
        vm.prank(alice);
        raise.withdraw(1e6);
    }

    // ---------------- startCommitment gates ----------------

    function test_startCommitment() public {
        toCommitment();
        assertEq(uint8(raise.state()), uint8(Raise.State.Commitment));
        assertEq(raise.commitPrincipalTotal(), 200_000e6);
        assertEq(raise.commitmentEnd(), raise.commitmentStart() + 5 minutes);
    }

    function test_revert_startCommitmentTooEarly() public {
        depositAs(alice, 60_000e6);
        vm.warp(block.timestamp + 9 minutes);
        vm.expectRevert(Raise.MinIncubationNotMet.selector);
        raise.startCommitment();
    }

    function test_revert_startCommitmentBelowSoftCap() public {
        depositAs(alice, 49_999e6);
        vm.warp(block.timestamp + 10 minutes);
        vm.expectRevert(Raise.SoftCapNotReached.selector);
        raise.startCommitment();
    }

    function test_revert_startCommitmentAfterDeadline() public {
        depositAs(alice, 60_000e6);
        vm.warp(block.timestamp + 31 minutes);
        vm.expectRevert(Raise.DeadlinePassed.selector);
        raise.startCommitment();
    }

    function test_revert_startCommitmentDuringVeto() public {
        depositAs(alice, 60_000e6);
        vm.warp(block.timestamp + 9 minutes);
        vm.prank(attester);
        board.postReport(address(raise), bytes32("r1"), "ipfs://r1", 9000, true);
        assertTrue(board.vetoActive(address(raise)));
        vm.warp(block.timestamp + 2 minutes); // minIncubation met, veto still active
        vm.expectRevert(Raise.VetoActive.selector);
        raise.startCommitment();
        // after the veto window passes, commitment can start (still before the deadline)
        vm.warp(block.timestamp + 4 minutes);
        raise.startCommitment();
        assertEq(uint8(raise.state()), uint8(Raise.State.Commitment));
    }

    // ---------------- fail / cancel ----------------

    function test_failAfterDeadline_refundsAll() public {
        depositAs(alice, 100_000e6);
        depositAs(bob, 60_000e6);
        vm.warp(block.timestamp + 31 minutes);
        raise.fail();
        assertEq(uint8(raise.state()), uint8(Raise.State.Failed));
        withdrawAs(alice, 100_000e6);
        withdrawAs(bob, 60_000e6);
        assertEq(usdg.balanceOf(alice), 10_000_000e6);
        assertEq(usdg.balanceOf(bob), 10_000_000e6);
        assertEq(usdg.balanceOf(address(raise)), 0);
    }

    function test_revert_failBeforeDeadline() public {
        vm.expectRevert(Raise.DeadlineNotPassed.selector);
        raise.fail();
    }

    function test_revert_failInGrowth() public {
        toGrowth();
        vm.warp(block.timestamp + 31 minutes);
        vm.expectRevert(Raise.InvalidState.selector);
        raise.fail();
    }

    function test_revert_failInCommitment_evenAfterDeadline() public {
        // Deadline falls inside the commitment window: startCommitment at t+29min, deadline at
        // t+30min, window ends at t+34min. fail() must not be able to kill a raise whose gates
        // were legitimately met — only openGrowth() (opt-in gate) or the builder's cancel() decide.
        depositAs(alice, 100_000e6);
        depositAs(bob, 60_000e6);
        vm.warp(block.timestamp + 29 minutes);
        raise.startCommitment();
        vm.warp(block.timestamp + 2 minutes); // past the deadline, inside the window
        vm.expectRevert(Raise.InvalidState.selector);
        raise.fail();
        // opt-in path still works after the deadline
        commitAs(alice, 1); // 25k committed; need 30% of 160k/4 = 12k
        vm.warp(block.timestamp + 5 minutes); // window over
        raise.openGrowth();
        assertEq(uint8(raise.state()), uint8(Raise.State.Growth));
    }

    function test_cancelInCommitment_afterDeadline() public {
        depositAs(alice, 100_000e6);
        vm.warp(block.timestamp + 29 minutes);
        raise.startCommitment();
        vm.warp(block.timestamp + 2 minutes); // past the deadline
        vm.prank(builder);
        raise.cancel(); // the builder can still end it
        assertEq(uint8(raise.state()), uint8(Raise.State.Failed));
        withdrawAs(alice, 100_000e6);
        assertEq(usdg.balanceOf(alice), 10_000_000e6);
    }

    function test_cancelByBuilder() public {
        depositAs(alice, 100_000e6);
        vm.prank(builder);
        raise.cancel();
        assertEq(uint8(raise.state()), uint8(Raise.State.Failed));
        withdrawAs(alice, 100_000e6);
        assertEq(usdg.balanceOf(alice), 10_000_000e6);
    }

    function test_cancelInCommitment_refundsCommittedToo() public {
        toCommitment();
        commitAs(alice, 1);
        vm.prank(builder);
        raise.cancel();
        withdrawAs(alice, 100_000e6); // full principal back, including the committed tranche
        assertEq(usdg.balanceOf(alice), 10_000_000e6);
    }

    function test_revert_cancelNotBuilder() public {
        vm.expectRevert(Raise.OnlyBuilder.selector);
        vm.prank(alice);
        raise.cancel();
    }

    function test_revert_cancelInGrowth() public {
        toGrowth();
        vm.expectRevert(Raise.InvalidState.selector);
        vm.prank(builder);
        raise.cancel();
    }

    // ---------------- views ----------------

    function test_views_gatesAndInfo() public {
        depositAs(alice, 60_000e6);
        CommitmentGates memory g = raise.commitmentGates();
        assertEq(g.incubationEndsAt, raise.start() + 10 minutes);
        assertFalse(g.timeMet);
        assertEq(g.principalNow, 60_000e6);
        assertEq(g.softCapRequired, 50_000e6);
        assertTrue(g.capitalMet);
        assertEq(g.deadlineTimestamp, raise.start() + 30 minutes);
        assertTrue(g.beforeDeadline);
        assertFalse(g.vetoActive);
        assertGt(g.now_, 0);

        GraduationGates memory gg = raise.graduationGates();
        assertEq(gg.epochsRequired, 4);
        assertEq(gg.minLiquidity, 20_000e6);

        (Raise.State st,,,,,,,,) = raise.raiseInfo();
        assertEq(uint8(st), uint8(Raise.State.Incubation));

        RaiseConfig memory c = raise.getConfig();
        assertEq(c.quoteAsset, address(usdg));
        assertEq(c.numTranches, 4);
    }
}
