// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseV31} from "./BaseV31.sol";
import {GovernanceV31} from "../../src/v31/GovernanceV31.sol";

/// @notice The historical positions are real deposits/exits; setup is outside proposal gas measurement.
contract ProposalGasV31Test is BaseV31 {
    function setUp() public override {
        super.setUp();
        _create(true);
        address dustOwner = address(0xD057);
        quote.mint(dustOwner, 1);
        // Setup spans 40,000 historical actions; only the later proposal is block-gas bounded.
        vm.pauseGasMetering();
        vm.startPrank(dustOwner);
        quote.approve(address(raise), type(uint256).max);
        for (uint256 i; i < 20_000; ++i) {
            (uint256 id, uint256 quantity) = raise.deposit(1, 1, raise.stateNonce(), vm.getBlockTimestamp());
            raise.exitAtCost(id, quantity, 1, raise.stateNonce(), vm.getBlockTimestamp());
        }
        vm.stopPrank();
        vm.resumeGasMetering();
        assertEq(quote.balanceOf(dustOwner), 1);
        (,,,,, uint256 count) = raise.accounting();
        assertEq(count, 20_000);
        assertEq(raise.eligibleCapital(), 0);
        _deposit(builder, 1000e6);
        _fund();
        _open();
        _buy(buyer, 500e6);
        _exit(ids[0], raise.positionState(ids[0]).tokens / 2, false);
    }

    function test_profilePropose_20000ExitedPositions() public {
        vm.cool(address(raise));
        vm.cool(address(governor));
        vm.prank(builder);
        uint256 before = gasleft();
        governor.propose(100e6, "ipfs://dust");
        emit log_named_uint(
            "GovernanceV31.propose gas (20,000 exited positions; cold raise/governor)", before - gasleft()
        );
    }

    function test_proposeAfter20000DustCycles_fits30MAndUsesLiveEligibleCapital() public {
        uint256 liveCapital;
        for (uint256 i; i < 10; ++i) {
            liveCapital += raise.guaranteedClaim(ids[i]).amount;
        }
        vm.cool(address(raise));
        vm.cool(address(governor));
        vm.prank(builder);
        uint256 proposal = governor.propose{gas: 30_000_000}(100e6, "ipfs://dust");
        assertEq(governor.getProposal(proposal).capitalSnapshot, liveCapital);
        for (uint256 i; i < 10; ++i) {
            vm.prank(backers[i]);
            governor.vote(proposal, ids[i], true);
        }
        vm.warp(governor.getProposal(proposal).votingEnds);
        governor.finalize(proposal);
        assertEq(uint256(governor.getProposal(proposal).status), uint256(GovernanceV31.Status.Passed));
    }
}
