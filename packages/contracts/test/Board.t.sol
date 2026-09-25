// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.sol";
import {AttestationBoard} from "../src/AttestationBoard.sol";

/// @notice AttestationBoard (§5.6): reports, veto delay, council clear + cooldown, access control.
contract BoardTest is BaseTest {
    function setUp() public override {
        super.setUp();
        createRaise();
    }

    function test_postReport_storesLatest() public {
        vm.prank(attester);
        board.postReport(address(raise), bytes32("h1"), "ipfs://1", 1234, false);
        AttestationBoard.Report memory r = board.getReport(address(raise));
        assertEq(r.reportHash, bytes32("h1"));
        assertEq(r.uri, "ipfs://1");
        assertEq(r.riskScoreBps, 1234);
        assertFalse(r.veto);
        assertFalse(board.vetoActive(address(raise)));
    }

    function test_postReport_vetoSetsVetoUntil() public {
        vm.prank(attester);
        board.postReport(address(raise), bytes32("h1"), "ipfs://1", 9000, true);
        assertEq(board.vetoUntil(address(raise)), block.timestamp + 5 minutes);
        assertTrue(board.vetoActive(address(raise)));
        vm.warp(block.timestamp + 6 minutes);
        assertFalse(board.vetoActive(address(raise)));
    }

    function test_revert_postReportNotAttester() public {
        vm.expectRevert(AttestationBoard.OnlyAttester.selector);
        vm.prank(alice);
        board.postReport(address(raise), bytes32("h"), "", 0, true);
    }

    function test_clearVeto_startsCooldown() public {
        vm.prank(attester);
        board.postReport(address(raise), bytes32("h1"), "", 9000, true);
        vm.prank(council);
        board.clearVeto(address(raise));
        assertFalse(board.vetoActive(address(raise)));
        assertEq(board.cooldownUntil(address(raise)), block.timestamp + 10 minutes);
        // during cooldown a new veto report is stored but does NOT set vetoUntil
        vm.prank(attester);
        board.postReport(address(raise), bytes32("h2"), "", 9500, true);
        assertEq(board.vetoUntil(address(raise)), 0);
        assertFalse(board.vetoActive(address(raise)));
        // after cooldown a veto works again
        vm.warp(block.timestamp + 11 minutes);
        vm.prank(attester);
        board.postReport(address(raise), bytes32("h3"), "", 9500, true);
        assertTrue(board.vetoActive(address(raise)));
    }

    function test_revert_clearVetoNotCouncil() public {
        vm.expectRevert(AttestationBoard.OnlyCouncil.selector);
        vm.prank(alice);
        board.clearVeto(address(raise));
    }

    function test_revert_setVetoParamsNotFactory() public {
        vm.expectRevert(AttestationBoard.OnlyFactory.selector);
        vm.prank(alice);
        board.setVetoParams(address(raise), 1, 1);
    }

    function test_revert_setFactoryTwice() public {
        vm.expectRevert(AttestationBoard.FactoryAlreadySet.selector);
        board.setFactory(address(this));
    }

    function test_revert_setFactoryNotDeployer() public {
        AttestationBoard b2 = new AttestationBoard(attester, council);
        vm.expectRevert(AttestationBoard.OnlyDeployer.selector);
        vm.prank(alice);
        b2.setFactory(alice);
    }

    /// @notice Invariant 5: attester and council can never move or redirect funds.
    function test_rolesHoldNoFundsAfterActivity() public {
        toGrowth();
        buyAs(whale, 10_000e6);
        vm.prank(attester);
        board.postReport(address(raise), bytes32("h"), "", 100, false);
        assertEq(usdg.balanceOf(attester), 0);
        assertEq(usdg.balanceOf(council), 0);
        assertEq(usdg.balanceOf(curator), 0);
        assertEq(token.balanceOf(attester), 0);
        assertEq(token.balanceOf(council), 0);
    }
}
