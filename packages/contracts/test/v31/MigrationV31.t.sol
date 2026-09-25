// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {StdAssertions} from "forge-std/StdAssertions.sol";
import {BaseV31} from "./BaseV31.sol";
import {TypesV31 as V} from "../../src/v31/TypesV31.sol";
import {RaiseCore} from "../../src/v31/RaiseCore.sol";
import {ProjectTokenV31} from "../../src/v31/ProjectTokenV31.sol";
import {IDexAdapterV31} from "../../src/v31/IDexAdapterV31.sol";
import {ListingMathV31 as LP} from "../../src/v31/ListingMathV31.sol";

/// @notice Adversarial read-only observer before and after authenticated listing settlement.
contract MigrationObserverV31 is StdAssertions, IDexAdapterV31 {
    address public immutable initializeHook = address(this);
    address public holder;
    uint256 public id;
    uint256 public observations;
    bool public failAfterCallback;
    Receipt private receipt;

    function configure(address holder_, uint256 id_, bool fail_) external {
        holder = holder_;
        id = id_;
        failAfterCallback = fail_;
    }

    function poolKey(address token, address quote) public view returns (bytes32) {
        return keccak256(abi.encode(token, quote, initializeHook));
    }

    function spotSqrtPriceX96(bytes32) external pure returns (uint160) {
        return 0;
    }

    function initializeAndMint(Request calldata r) external returns (Receipt memory result) {
        RaiseCore source = RaiseCore(msg.sender);
        _observe(source, ProjectTokenV31(r.token));
        ++observations;
        result.poolId = poolKey(r.token, r.quote);
        result.positionId = keccak256(abi.encode(result.poolId, msg.sender));
        result.owner = r.owner;
        result.sqrtPriceX96 = r.sqrtPriceX96;
        if (r.desiredQuote != 0) {
            bool tokenFirst = r.token < r.quote;
            (result.liquidity, result.usedToken, result.usedQuote) = LP.liquidityFor(
                r.sqrtPriceX96,
                tokenFirst ? r.desiredToken : r.desiredQuote,
                tokenFirst ? r.desiredQuote : r.desiredToken
            );
            if (!tokenFirst) (result.usedToken, result.usedQuote) = (result.usedQuote, result.usedToken);
            source.listingCallback(result.poolId, result.usedQuote, result.usedToken);
            assertEq(ProjectTokenV31(r.token).balanceOf(address(this)), result.usedToken);
        }
        _observe(source, ProjectTokenV31(r.token));
        ++observations;
        if (failAfterCallback) revert V.VenueFailure();
        receipt = result;
    }

    function position(bytes32) external view returns (Receipt memory) {
        _observe(RaiseCore(receipt.owner), ProjectTokenV31(RaiseCore(receipt.owner).modules().token));
        return receipt;
    }

    function collectFees(bytes32, address) external pure returns (uint256, uint256) {
        return (0, 0);
    }

    function _observe(RaiseCore source, ProjectTokenV31 asset) internal view {
        assertTrue(source.migrating());
        _unavailable(source.guaranteedClaim(id).validity);
        _unavailable(source.redeemQuote(id, 1, type(uint256).max).validity);
        _unavailable(source.protectedExitQuote(id, 1).validity);
        _unavailable(source.marketBuyQuote(1e6).validity);
        _unavailable(source.marketExitQuote(holder, 1).validity);
        _unavailable(source.futureClaimBounds(id, V.Phase.Stage3).validity);
        _unavailable(source.reserveState().validity);
        _unavailable(source.positionState(id).validity);
        _unavailable(source.stageDeadlines().validity);
        _unavailable(source.listingPreview().validity);
        _unavailable(source.listingStatus(id).validity);
        assertEq(source.guaranteedClaim(id).amount, 0);
        (uint256 delivered, uint256 quota) = source.deliveryOf(holder);
        assertEq(delivered + quota, 0);
        assertEq(asset.balanceOf(holder), 0);
        assertEq(source.custodySurplus(), 0);
        assertEq(source.eligibleCapital(), 0);
        assertEq(source.listingStatus(id).liquidTokens, 0);
    }

    function _unavailable(V.Validity memory v) internal pure {
        assertFalse(v.available);
        assertEq(uint256(v.reason), uint256(V.Reason.Migrating));
    }
}

contract MigrationV31Test is BaseV31 {
    MigrationObserverV31 private observer;

    function _pendingObserved() internal {
        observer = new MigrationObserverV31();
        implementations.adapter = address(observer);
        registry.publish(V.ESCROW_LAUNCH, 2, implementations);
        _createVersion(_config(false), false, 2);
        _fund();
        _open();
        _buy(buyer, 1000e6);
        vm.warp(raise.stageDeadlines().stage2End);
        observer.configure(backers[0], ids[0], false);
    }

    function test_listingCallback_allTypedViewsUnavailableUntilAtomicDelivery() public {
        _pendingObserved();
        uint256 delivery = raise.positionState(ids[0]).tokens;
        assertGt(raise.guaranteedClaim(ids[0]).amount, 0);
        assertEq(token.balanceOf(backers[0]), 0);
        raise.list();
        assertEq(observer.observations(), 2);
        assertFalse(raise.migrating());
        assertTrue(raise.guaranteedClaim(ids[0]).validity.available);
        assertEq(raise.guaranteedClaim(ids[0]).amount, 0);
        (uint256 delivered, uint256 quota) = raise.deliveryOf(backers[0]);
        assertEq(delivered, delivery);
        assertEq(quota, delivery);
        assertEq(token.balanceOf(backers[0]), delivery);
        assertTrue(raise.reserveState().validity.available);
        assertTrue(raise.positionState(ids[0]).validity.available);
        assertEq(raise.custodySurplus(), 0);
    }

    function test_failedMigration_restoresFlagClaimsDeliveryAndNonce_thenRetries() public {
        _pendingObserved();
        observer.configure(backers[0], ids[0], true);
        uint256 nonce = raise.stateNonce();
        uint256 basis = raise.guaranteedClaim(ids[0]).amount;
        vm.expectRevert(V.VenueFailure.selector);
        raise.list();
        assertFalse(raise.migrating());
        assertEq(raise.stateNonce(), nonce);
        assertEq(raise.guaranteedClaim(ids[0]).amount, basis);
        assertTrue(raise.redeemQuote(ids[0], 1, nonce).validity.available);
        assertEq(token.balanceOf(backers[0]), 0);
        assertEq(token.listedAt(), 0);
        assertEq(raise.custodySurplus(), 0);
        observer.configure(backers[0], ids[0], false);
        raise.list();
        assertFalse(raise.migrating());
        assertGt(token.balanceOf(backers[0]), 0);
    }
}
