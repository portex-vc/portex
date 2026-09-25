// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseV31} from "./BaseV31.sol";
import {Vm} from "forge-std/Vm.sol";
import {TypesV31 as V} from "../../src/v31/TypesV31.sol";
import {ProjectTokenV31} from "../../src/v31/ProjectTokenV31.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

contract FollowupV31Test is BaseV31 {
    function test_stage2BuyRejectsCreatorAndDeclaredBuilders() public {
        V.Config memory c = _config(false);
        c.builders = new address[](1);
        c.builders[0] = address(0xB222);
        _createWith(c, false);
        _deposit(builder, 100e6);
        _deposit(c.builders[0], 100e6);
        _fund();
        _open();
        uint256 nonce = raise.stateNonce();
        for (uint256 i; i < 2; ++i) {
            address actor = i == 0 ? builder : c.builders[0];
            vm.expectRevert(V.Unauthorized.selector);
            vm.prank(actor);
            raise.buy(100e6, 0, nonce, vm.getBlockTimestamp());
            assertEq(raise.buyerTokens(actor), 0);
            assertEq(raise.stateNonce(), nonce);
        }
        assertGt(_buy(buyer, 100e6), 0);
    }

    function test_eligibleShares_trackAllExitsAndDrawsWithoutBuilderOrBuyerCapital() public {
        _create(true);
        (uint256 builderId,) = _deposit(builder, 1000e6);
        (uint256 extraId, uint256 extraTokens) = _deposit(backers[0], 17);
        assertEq(raise.eligibleCapital(), 17);
        _exit(extraId, extraTokens / 2, false);
        assertEq(raise.eligibleCapital(), raise.guaranteedClaim(extraId).amount);
        _exit(extraId, extraTokens - extraTokens / 2, false);
        assertEq(raise.eligibleCapital(), 0);
        _fund();
        _open();
        uint256 shares = _eligibleShares();
        assertEq(raise.eligibleCapital(), shares);
        _buy(buyer, 10000e6);
        assertEq(raise.eligibleCapital(), shares);
        _draw(123_456789);
        assertEq(_eligibleShares(), shares);
        _assertEligible();
        _exit(ids[0], raise.positionState(ids[0]).tokens / 3, true);
        _assertEligible();
        uint256 before = raise.eligibleCapital();
        _exit(builderId, raise.positionState(builderId).tokens, false);
        assertEq(raise.eligibleCapital(), before);
        for (uint256 i; i < 9; ++i) {
            _exit(ids[i], raise.positionState(ids[i]).tokens, false);
            _assertEligible();
        }
        uint256 lastTokens = raise.positionState(ids[9]).tokens;
        uint256 lastShares = raise.positionState(ids[9]).shares;
        _exit(ids[9], lastTokens / 2, false);
        _assertEligible();
        // PS §6 retains sole-claimant shares on partial exits; quorum uses the specified share/index formula.
        assertEq(raise.positionState(ids[9]).shares, lastShares);
        _exit(ids[9], lastTokens - lastTokens / 2, false);
        assertEq(raise.eligibleCapital(), 0);
        assertEq(raise.reserveState().E, 0);
    }

    function test_escrowEligibleCapital_usesScaleAndRetiresOnRefund() public {
        _create(false);
        _deposit(builder, 100e6);
        (uint256 id, uint256 quantity) = _deposit(backers[0], 1000e6);
        assertEq(raise.reserveState().J, V.SCALE);
        assertEq(raise.eligibleCapital(), 1000e6);
        _exit(id, quantity / 2, false);
        assertEq(raise.eligibleCapital(), raise.guaranteedClaim(id).amount);
        vm.warp(raise.stageDeadlines().stage1End);
        raise.advanceStage1();
        assertEq(raise.eligibleCapital(), 0);
    }

    function test_rewardNonce_checkpointsTwoClaimsAndQuotaEvents_raiseNonceFrozen() public {
        _listedWithFees();
        uint256 frozen = raise.stateNonce();
        assertEq(token.rewardNonce(), 0);
        vm.warp(token.listedAt() + 10 days);
        vm.recordLogs();
        token.checkpoint(backers[0]);
        _assertRewardEvent("RewardsCheckpointed(address,uint8,uint256,uint256,address)", 1, frozen);
        vm.recordLogs();
        vm.prank(backers[0]);
        token.claimRewards();
        _assertRewardEvent("RewardsClaimed(address,uint8,uint256,uint256,address,uint256,uint256)", 2, frozen);
        vm.warp(token.listedAt() + 20 days);
        vm.recordLogs();
        vm.prank(backers[0]);
        token.claimRewards();
        _assertRewardEvent("RewardsClaimed(address,uint8,uint256,uint256,address,uint256,uint256)", 3, frozen);
        vm.expectRevert(V.InvalidAmount.selector);
        vm.prank(backers[0]);
        token.claimRewards();
        assertEq(token.rewardNonce(), 3);
        vm.prank(backers[0]);
        token.approve(buyer, 1);
        assertEq(token.rewardNonce(), 3);
        vm.recordLogs();
        vm.prank(buyer);
        token.transferFrom(backers[0], buyer, 1);
        _assertRewardEvent("QuotaDestroyed(address,uint8,uint256,uint256,address,uint256,uint256)", 4, frozen);
        raise.claimTreasuryFees();
        assertEq(raise.stateNonce(), frozen);
        assertEq(token.rewardNonce(), 4);
    }

    function test_rewardNonce_disposalAndPullEvents_shareOuterActionNonce() public {
        _listedWithFees();
        uint256 frozen = raise.stateNonce();
        for (uint256 i; i < 10; ++i) {
            uint256 quantity = token.balanceOf(backers[i]);
            vm.recordLogs();
            vm.prank(backers[i]);
            token.transfer(buyer, quantity);
            if (i == 9) {
                _assertRewardEvent("RewardsDisposed(address,uint8,uint256,uint256,uint256,uint256)", 10, frozen);
            } else {
                vm.getRecordedLogs();
            }
        }
        assertTrue(token.disposed());
        assertGt(token.disposedQuote(), 0);
        vm.recordLogs();
        token.claimDisposed();
        _assertRewardEvent("DisposedClaimed(address,uint8,uint256,uint256,address,uint256)", 11, frozen);
        vm.expectRevert(V.InvalidAmount.selector);
        token.claimDisposed();
        assertEq(token.rewardNonce(), 11);
        assertEq(raise.stateNonce(), frozen);
    }

    function test_positionState_isFrozenAfterTransfersAndVestingClaims() public {
        _create(false);
        (uint256 builderId,) = _deposit(builder, 1000e6);
        _fund();
        _open();
        _list();
        bytes32 backerRecord = keccak256(abi.encode(raise.positionState(ids[0])));
        bytes32 builderRecord = keccak256(abi.encode(raise.positionState(builderId)));
        uint256 frozen = raise.stateNonce();
        vm.prank(backers[0]);
        token.transfer(buyer, 1e18);
        vm.warp(token.listedAt() + 31 days);
        assertGt(vesting.claim(builder), 0);
        assertEq(keccak256(abi.encode(raise.positionState(ids[0]))), backerRecord);
        assertEq(keccak256(abi.encode(raise.positionState(builderId))), builderRecord);
        assertEq(raise.positionState(ids[0]).shares, 0);
        assertEq(raise.positionState(ids[0]).quota, 0);
        assertEq(raise.stateNonce(), frozen);
    }

    function test_vetoBudget_chargesPreDeadlineGrantsWithoutEarlyClearRefund() public {
        _create(false);
        for (uint256 i; i < 3; ++i) {
            vm.prank(attester);
            raise.veto(2 days, bytes32(0));
            vm.prank(council);
            raise.clearVeto();
            vm.warp(vm.getBlockTimestamp() + 1 days);
        }
        assertLt(vm.getBlockTimestamp(), raise.stageDeadlines().stage1End);
        vm.expectRevert(V.InvalidAmount.selector);
        vm.prank(attester);
        raise.veto(2 days, bytes32(0));
        vm.prank(attester);
        raise.veto(1 days, bytes32(0));
    }

    function test_refundFunding_beneficiaryEventMaterializesOnlyOnPull() public {
        _create(false);
        (uint256 id,) = _deposit(backers[0], 1000e6);
        vm.warp(raise.stageDeadlines().stage1End);
        vm.recordLogs();
        raise.advanceStage1();
        _assertFundingEvent(address(claims), 0, "DissolutionCohort");
        assertEq(claims.liability(), 1000e6);
        vm.recordLogs();
        vm.prank(backers[0]);
        claims.claim(id);
        _assertFundingEvent(backers[0], id, "Backer");
        assertEq(claims.liability(), 0);
        assertEq(quote.balanceOf(address(claims)), 0);
    }

    function _listedWithFees() internal {
        _create(false);
        _fund();
        _open();
        _buy(buyer, 1000e6);
        _list();
    }

    function _eligibleShares() internal view returns (uint256 total) {
        for (uint256 i; i < 10; ++i) {
            total += raise.positionState(ids[i]).shares;
        }
    }

    function _assertEligible() internal view {
        assertEq(raise.eligibleCapital(), Math.mulDiv(_eligibleShares(), raise.reserveState().J, V.SCALE));
    }

    function _assertRewardEvent(string memory signature, uint256 expected, uint256 frozen) internal view {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(token) || logs[i].topics[0] != keccak256(bytes(signature))) continue;
            (V.Phase phase, uint256 nonce, uint256 localNonce) = abi.decode(logs[i].data, (V.Phase, uint256, uint256));
            assertEq(uint256(phase), uint256(V.Phase.Stage3));
            assertEq(nonce, frozen);
            assertEq(localNonce, expected);
            ++found;
        }
        assertEq(found, 1);
        assertEq(token.rewardNonce(), expected);
        assertEq(raise.stateNonce(), frozen);
    }

    function _assertFundingEvent(address beneficiary, uint256 id, bytes32 class) internal view {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 found;
        bytes32 signature =
            keccak256("ClaimVaultFunded(address,uint8,uint256,address,uint256,bytes32,address,uint256,bytes32)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(claims) || logs[i].topics[0] != signature) continue;
            assertEq(logs[i].topics[2], bytes32(uint256(uint160(beneficiary))));
            (,, uint256 eventId, bytes32 eventClass, address asset, uint256 amount, bytes32 reason) =
                abi.decode(logs[i].data, (V.Phase, uint256, uint256, bytes32, address, uint256, bytes32));
            assertEq(eventId, id);
            assertEq(eventClass, class);
            assertEq(asset, address(quote));
            assertEq(amount, 1000e6);
            assertEq(reason, bytes32("Dissolution"));
            ++found;
        }
        assertEq(found, 1);
    }
}
