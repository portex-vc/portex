// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseV31} from "./BaseV31.sol";
import {TypesV31 as V} from "../../src/v31/TypesV31.sol";
import {MockUSDGV31} from "../../src/v31/MockUSDGV31.sol";
import {ProjectTokenV31} from "../../src/v31/ProjectTokenV31.sol";
import {RaiseCore} from "../../src/v31/RaiseCore.sol";

contract AdversarialUSDGV31 is MockUSDGV31 {
    address public blocked;
    address public target;
    bool public feeEnabled;
    bool public reenter;
    bool private attacking;
    bytes4 public callbackError;
    bytes public reentryData = abi.encodeCall(RaiseCore.advanceDepth, ());

    function setReentryData(bytes calldata data) external {
        reentryData = data;
    }

    function configure(address blocked_, address target_, bool fee_, bool reenter_) external {
        blocked = blocked_;
        target = target_;
        feeEnabled = fee_;
        reenter = reenter_;
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (from != address(0) && amount != 0) {
            if (to == blocked) revert("recipient rejects transfer");
            if (reenter && !attacking) {
                attacking = true;
                (bool success, bytes memory reason) = target.call(reentryData);
                require(!success, "reentry succeeded");
                callbackError = bytes4(reason);
                attacking = false;
            }
            if (feeEnabled) {
                super._update(from, to, amount - 1);
                super._update(from, address(0), 1);
                return;
            }
        }
        super._update(from, to, amount);
    }
}

contract SecurityV31Test is BaseV31 {
    AdversarialUSDGV31 internal adversarial;

    function test_wrongDepositDelta_revertsAllLedgerEffects() public {
        _adversarialCreate();
        quote.mint(backers[0], 1000e6);
        vm.prank(backers[0]);
        quote.approve(address(raise), 1000e6);
        adversarial.configure(address(0), address(raise), true, false);
        uint256 nonce = raise.stateNonce();
        vm.expectRevert(V.WrongAssetDelta.selector);
        vm.prank(backers[0]);
        raise.deposit(1000e6, 0, nonce, vm.getBlockTimestamp());
        assertEq(raise.stateNonce(), nonce);
        assertEq(raise.reserveState().E, 0);
        assertEq(quote.balanceOf(backers[0]), 1000e6);
    }

    function test_directExitFailedPayment_rollsBackNonceBurnAndBasis() public {
        _adversarialCreate();
        (uint256 id, uint256 tokens) = _deposit(backers[0], 1000e6);
        adversarial.configure(backers[0], address(raise), false, false);
        uint256 nonce = raise.stateNonce();
        vm.expectRevert();
        vm.prank(backers[0]);
        raise.exitAtCost(id, tokens, 0, nonce, vm.getBlockTimestamp());
        assertEq(raise.guaranteedClaim(id).amount, 1000e6);
        assertEq(raise.stateNonce(), nonce);
        assertEq(token.burned(), 0);
        adversarial.configure(address(0), address(raise), false, false);
        assertEq(_exit(id, tokens, false), 1000e6);
    }

    function test_failedRefundPull_doesNotBlockOtherBeneficiaries() public {
        _adversarialCreate();
        (uint256 badId,) = _deposit(backers[0], 1000e6);
        (uint256 goodId,) = _deposit(backers[1], 500e6);
        vm.warp(raise.stageDeadlines().stage1End);
        raise.advanceStage1();
        adversarial.configure(backers[0], address(raise), false, false);
        uint256 nonce = raise.stateNonce();
        vm.expectRevert();
        vm.prank(backers[0]);
        claims.claim(badId);
        assertEq(raise.stateNonce(), nonce);
        assertFalse(claims.claimed(badId));
        vm.prank(backers[1]);
        claims.claim(goodId);
        assertEq(claims.liability(), 1000e6);
        assertEq(quote.balanceOf(address(claims)), 1000e6);
        adversarial.configure(address(0), address(raise), false, false);
        vm.prank(backers[0]);
        claims.claim(badId);
        assertEq(claims.liability(), 0);
    }

    function test_quoteReentry_blockedAcrossDepositExitAndRewardClaim() public {
        _adversarialCreate();
        adversarial.configure(address(0), address(raise), false, true);
        _fund();
        _open();
        _buy(buyer, 10000e6);
        assertEq(adversarial.callbackError(), V.Reentrancy.selector);
        _exit(ids[0], 1e18, false);
        assertEq(adversarial.callbackError(), V.Reentrancy.selector);
        _list();
        vm.warp(token.listedAt() + 100 days);
        uint256 nonce = raise.stateNonce();
        adversarial.configure(address(0), address(token), false, true);
        adversarial.setReentryData(abi.encodeCall(ProjectTokenV31.checkpoint, (backers[0])));
        vm.prank(backers[0]);
        token.claimRewards();
        assertEq(raise.stateNonce(), nonce);
        assertEq(adversarial.callbackError(), V.Reentrancy.selector);
        _assertBook();
    }

    function test_adapterCallbackCannotBeReplayedOutsideListing() public {
        _adversarialCreate();
        _fund();
        _open();
        _list();
        bytes32 poolId = raise.listingRecord().poolId;
        vm.expectRevert(V.Unauthorized.selector);
        vm.prank(address(adapter));
        raise.listingCallback(poolId, 1, 1);
    }

    function test_blockedTreasury_lastQuotaHolderCanTransfer_andDisposalPullRetries() public {
        _adversarialCreate();
        _fund();
        _open();
        _buy(buyer, 10000e6);
        _list();
        vm.warp(token.listedAt() + 100 days);
        adversarial.configure(treasury, address(token), false, false);
        uint256 nonce = raise.stateNonce();
        for (uint256 i; i < 10; ++i) {
            uint256 balance = token.balanceOf(backers[i]);
            vm.prank(backers[i]);
            token.transfer(buyer, balance);
        }
        assertTrue(token.disposed());
        assertEq(token.totalQuota(), 0);
        assertEq(raise.stateNonce(), nonce);
        uint256 remainder = token.disposedQuote();
        assertGt(remainder, 0);
        (ProjectTokenV31.Stream memory ts, ProjectTokenV31.Stream memory qs) = token.rewardState();
        assertEq(token.balanceOf(address(token)), ts.credited);
        assertEq(quote.balanceOf(address(token)), qs.credited + remainder);
        (, uint256 surplus) = token.rewardSurplus();
        assertEq(surplus, 0);
        uint256 rewardNonce = token.rewardNonce();
        vm.expectRevert(bytes("recipient rejects transfer"));
        token.claimDisposed();
        assertEq(token.rewardNonce(), rewardNonce);
        assertEq(token.disposedQuote(), remainder);
        vm.prank(backers[0]);
        token.claimRewards();
        adversarial.configure(address(0), address(token), false, false);
        assertEq(token.claimDisposed(), remainder);
        assertEq(token.disposedQuote(), 0);
        assertEq(quote.balanceOf(treasury), remainder);
        vm.expectRevert(V.InvalidAmount.selector);
        token.claimDisposed();
        assertEq(raise.stateNonce(), nonce);
        _assertBook();
    }

    function test_refundRejectsSupplyOutsideRaiseCustody() public {
        _adversarialCreate();
        _deposit(backers[0], 1000e6);
        // Fault injection: simulate a future custody path moving supply before refund.
        vm.prank(address(raise));
        token.custodyMove(buyer, 1);
        vm.warp(raise.stageDeadlines().stage1End);
        uint256 nonce = raise.stateNonce();
        vm.expectRevert(V.InvariantFailure.selector);
        raise.advanceStage1();
        assertEq(uint256(raise.phase()), uint256(V.Phase.Stage1));
        assertEq(raise.stateNonce(), nonce);
        assertEq(token.totalSupply(), SUPPLY);
        assertEq(claims.liability(), 0);
    }

    function _adversarialCreate() internal {
        adversarial = new AdversarialUSDGV31();
        quote = adversarial;
        implementations.quote = address(quote);
        registry.whitelistQuote(address(quote), false, false, false, true);
        registry.publish(V.ESCROW_LAUNCH, 2, implementations);
        _createVersion(_config(false), false, 2);
    }

    function test_unsolicitedQuote_doesNotAcquireClaimsOrMigrateToTreasury() public {
        _create(false);
        quote.mint(address(raise), 77);
        assertEq(raise.custodySurplus(), 77);
        _fund();
        _open();
        _list();
        assertEq(raise.custodySurplus(), 77);
        assertEq(quote.balanceOf(treasury), 0);
        quote.mint(address(token), 99);
        (, uint256 surplus) = token.rewardSurplus();
        assertEq(surplus, 99);
        quote.mint(address(claims), 123);
        assertEq(claims.custodySurplus(), 123);
        assertEq(claims.liability(), 0);
    }
}
