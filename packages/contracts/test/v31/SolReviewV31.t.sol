// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseV31} from "./BaseV31.sol";
import {TypesV31 as V} from "../../src/v31/TypesV31.sol";
import {PortexRegistryV31} from "../../src/v31/PortexRegistryV31.sol";
import {RaiseFactoryV31} from "../../src/v31/RaiseFactoryV31.sol";
import {GovernanceV31} from "../../src/v31/GovernanceV31.sol";
import {RaiseCore} from "../../src/v31/RaiseCore.sol";
import {TreasuryV31} from "../../src/v31/TreasuryV31.sol";
import {ClaimVault} from "../../src/v31/ClaimVault.sol";
import {RolloverRouterV31} from "../../src/v31/RolloverRouterV31.sol";

/// @notice Regressions for docs/audits/2026-09-22-sol-full-review.md, contract findings C-M1 and C-L1–C-L3.
contract SolReviewV31Test is BaseV31 {
    function _shortConfig(bool budget) internal view returns (V.Config memory c) {
        c = _config(budget);
        c.stage1Length = 1 hours;
        c.stage2Length = 2 hours;
    }

    // Timings are governed parameters: production defaults at deployment, never demo constants in the contracts.
    function test_registry_defaultsAreProductionTimings() public {
        PortexRegistryV31 fresh = new PortexRegistryV31(address(this));
        V.Parameters memory p = fresh.protocolParameters();
        assertEq(p.stage1Min, 15 days);
        assertEq(p.stage1Max, 60 days);
        assertEq(p.stage2Min, 35 days);
        assertEq(p.stage2Max, 70 days);
        assertEq(p.treasuryVesting, 1825 days);
        assertEq(p.voting, 3 days);
        assertEq(p.dispute, 7 days);
        assertEq(p.execution, 2 days);
        assertLe(uint256(p.voting) + p.dispute + p.execution, p.stage2Min);
    }

    // C-M1: a Budget vote must fit the shortest Stage 2 at any scale.
    function test_shortTimings_rejectTimersLongerThanStage2() public {
        V.Parameters memory p = _shortTimings();
        p.voting = 3 days;
        vm.expectRevert(V.InvalidConfig.selector);
        registry.setProtocolParameters(p);
        p = V.productionParameters();
        p.stage2Min = 7 days;
        vm.expectRevert(V.InvalidConfig.selector);
        registry.setProtocolParameters(p);
    }

    function test_registry_rejectsTimingsThatCouldOverflowOrStall() public {
        V.Parameters memory p = _shortTimings();
        p.stage1Max = 400 days;
        vm.expectRevert(V.InvalidConfig.selector);
        registry.setProtocolParameters(p);
        p = _shortTimings();
        (p.stage1Min, p.stage1Max) = (2 hours, 1 hours);
        vm.expectRevert(V.InvalidConfig.selector);
        registry.setProtocolParameters(p);
        p = _shortTimings();
        p.stage2Min = 0;
        vm.expectRevert(V.InvalidConfig.selector);
        registry.setProtocolParameters(p);
        p = _shortTimings();
        p.treasuryVesting = 0;
        vm.expectRevert(V.InvalidConfig.selector);
        registry.setProtocolParameters(p);
        p = _shortTimings();
        p.treasuryVesting = 3651 days;
        vm.expectRevert(V.InvalidConfig.selector);
        registry.setProtocolParameters(p);
        p = _shortTimings();
        p.vetoTotal = 49 hours;
        vm.expectRevert(V.InvalidConfig.selector);
        registry.setProtocolParameters(p);
        p = _shortTimings();
        p.vetoMax = 3 days;
        p.vetoTotal = 3 days;
        vm.expectRevert(V.InvalidConfig.selector);
        registry.setProtocolParameters(p);
        vm.prank(builder);
        vm.expectRevert(V.Unauthorized.selector);
        registry.setProtocolParameters(_shortTimings());
    }

    function test_shortBudgetLaunch_voteFitsItsStage2() public {
        _useTimings(_shortTimings());
        _createWith(_shortConfig(true), true);
        _fund();
        _open();
        vm.prank(builder);
        uint256 id = governor.propose(100e6, "ipfs://short-budget");
        GovernanceV31.Proposal memory p = governor.getProposal(id);
        assertLe(p.executeEnds, raise.stageDeadlines().stage2End);
    }

    function test_vetoHorizon_isTheVersionStage1Maximum() public {
        _useTimings(_shortTimings());
        _createWith(_shortConfig(false), false);
        uint64 start = raise.stageDeadlines().start;
        // Within the horizon a veto is capped at start + stage1Max (48 h), never beyond it.
        vm.warp(uint256(start) + 47 hours + 30 minutes);
        vm.prank(attester);
        raise.veto(1 hours, bytes32("report"));
        assertEq(raise.stageDeadlines().vetoUntil, uint256(start) + 48 hours);
        // Past the horizon (and past the 30-minute cooldown) no further veto is accepted.
        vm.warp(uint256(start) + 48 hours + 31 minutes);
        vm.prank(attester);
        vm.expectRevert(V.InvalidAmount.selector);
        raise.veto(1 hours, bytes32("late"));
    }

    // Later parameter changes reach only new publications: a version, and every raise created from it, keeps the
    // bounds, dissolve minimum, veto horizon and treasury schedule it was created with.
    function test_timingsArePinnedPerVersionAndRaise() public {
        _useTimings(_shortTimings());
        V.Config memory c = _shortConfig(false);
        c.stage1Length = 5 hours;
        _createWith(c, false);
        RaiseCore pinned = raise;
        assertEq(TreasuryV31(pinned.getConfig().treasury).vestingDuration(), 7 days);
        V.Parameters memory next = _shortTimings();
        (next.stage1Min, next.stage2Min) = (3 hours, 4 hours);
        next.treasuryVesting = 30 days;
        registry.setProtocolParameters(next);
        registry.publish(V.ESCROW_LAUNCH, 2, implementations);
        // Version 1 still admits its own minimum; version 2 does not.
        _createWith(_shortConfig(false), false);
        vm.prank(builder);
        vm.expectRevert(V.InvalidConfig.selector);
        factory.createRaise(V.ESCROW_LAUNCH, 2, _shortConfig(false), RaiseFactoryV31.TokenMeta("Next", "NEXT"));
        // The first raise's builder may dissolve after its pinned 1-hour minimum, not the new 3-hour one.
        vm.warp(uint256(pinned.stageDeadlines().start) + 1 hours);
        vm.prank(builder);
        pinned.dissolve();
        assertEq(uint256(pinned.phase()), uint256(V.Phase.Dissolved));
        assertEq(TreasuryV31(pinned.getConfig().treasury).vestingDuration(), 7 days);
    }

    function test_treasuryVesting_isRequiredAtInitialization() public {
        TreasuryV31 impl = new TreasuryV31();
        vm.expectRevert();
        impl.initialize(address(1), address(2), address(3), address(4), 1, 7 days);
    }

    // Audit 2026-09-25 H1: the rollover authority pinned in the implementations must be one router serving this
    // factory, or none; anything else could take exits and dissolution claims.
    function test_rolloverAuthority_mustBeThisFactorysRouter() public {
        address other = address(new RolloverRouterV31(address(new RaiseFactoryV31(registry))));
        address[3] memory bad = [address(0xBAD), other, address(0)];
        for (uint256 k; k < 3; ++k) {
            PortexRegistryV31.Implementations memory i = _implementations(bad[k]);
            // A zero router is allowed only when both implementations agree on it.
            if (bad[k] == address(0)) i.claims = address(new ClaimVault(address(router)));
            registry.publish(V.ESCROW_LAUNCH, uint64(2 + k), i);
            vm.prank(builder);
            vm.expectRevert(V.InvalidConfig.selector);
            factory.createRaise(V.ESCROW_LAUNCH, uint64(2 + k), _config(false), RaiseFactoryV31.TokenMeta("Bad", "BAD"));
        }
        // Mismatched routers between the raise and the claim vault are refused too.
        PortexRegistryV31.Implementations memory mixed = _implementations(address(router));
        mixed.claims = address(new ClaimVault(other));
        registry.publish(V.ESCROW_LAUNCH, 5, mixed);
        vm.prank(builder);
        vm.expectRevert(V.InvalidConfig.selector);
        factory.createRaise(V.ESCROW_LAUNCH, 5, _config(false), RaiseFactoryV31.TokenMeta("Mixed", "MIX"));
        // Rollover disabled in both implementations remains a valid composition.
        registry.publish(V.ESCROW_LAUNCH, 6, _implementations(address(0)));
        vm.prank(builder);
        factory.createRaise(V.ESCROW_LAUNCH, 6, _config(false), RaiseFactoryV31.TokenMeta("Solo", "SOLO"));
    }

    // C-L1: a builder's buy quote is not executable, so it must not say it is.
    function test_builderBuyQuote_isUnauthorized() public {
        _create(false);
        _fund();
        _open();
        V.TradeQuote memory forBuilder = raise.marketBuyQuoteFor(builder, 100e6);
        assertFalse(forBuilder.validity.available);
        assertEq(uint256(forBuilder.validity.reason), uint256(V.Reason.Unauthorized));
        assertTrue(raise.marketBuyQuoteFor(buyer, 100e6).validity.available);
    }

    // C-L3: nonexistent positions report InvalidPosition in every typed view.
    function test_nonexistentPosition_isInvalidInTypedViews() public {
        _create(false);
        _fund();
        V.Claim memory c = raise.guaranteedClaim(999_999);
        assertFalse(c.validity.available);
        assertEq(uint256(c.validity.reason), uint256(V.Reason.InvalidPosition));
        V.PositionView memory p = raise.positionState(999_999);
        assertFalse(p.validity.available);
        assertEq(uint256(p.validity.reason), uint256(V.Reason.InvalidPosition));
    }

    // C-L2: a zero-amount transfer on listing day changes no reward state and no reward nonce.
    function test_zeroTransferOnListingDay_keepsRewardNonce() public {
        _create(false);
        _fund();
        _open();
        _list();
        uint256 before = token.rewardNonce();
        vm.prank(backers[0]);
        token.transfer(backers[0], 0);
        assertEq(token.rewardNonce(), before);
    }
}
