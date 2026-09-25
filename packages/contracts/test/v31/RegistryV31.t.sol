// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseV31} from "./BaseV31.sol";
import {TreasuryV31} from "../../src/v31/TreasuryV31.sol";
import {TypesV31 as V} from "../../src/v31/TypesV31.sol";
import {RaiseFactoryV31} from "../../src/v31/RaiseFactoryV31.sol";
import {PortexRegistryV31} from "../../src/v31/PortexRegistryV31.sol";
import {RaiseCore} from "../../src/v31/RaiseCore.sol";

contract RegistryV31Test is BaseV31 {
    function test_quoteWhitelistRequiresExplicitFrozenAttestation() public {
        PortexRegistryV31 fresh = new PortexRegistryV31(address(this));
        vm.expectRevert(V.InvalidConfig.selector);
        fresh.whitelistQuote(address(quote), false, false, false, false);
        vm.expectRevert(V.InvalidConfig.selector);
        fresh.whitelistQuote(address(quote), false, false, false);
        assertFalse(fresh.quoteFrozen(address(quote)));
        assertEq(fresh.quoteCodeHash(address(quote)), bytes32(0));
        vm.expectRevert(V.Unauthorized.selector);
        vm.prank(builder);
        fresh.whitelistQuote(address(quote), false, false, false, true);
        fresh.whitelistQuote(address(quote), false, false, false, true);
        assertTrue(fresh.quoteFrozen(address(quote)));
        assertEq(fresh.quoteCodeHash(address(quote)), address(quote).codehash);
        fresh.publish(V.ESCROW_LAUNCH, 1, implementations);
    }

    function test_clonesArePinned_andInitializedAtomically() public {
        _create(false);
        assertEq(address(raise).code.length, 45);
        assertEq(address(token).code.length, 45);
        assertTrue(factory.isRaise(address(raise)));
        assertEq(factory.raisesCount(), 1);
        (bytes32 templateId, uint64 version, bytes32 hash) = raise.template();
        assertEq(templateId, V.ESCROW_LAUNCH);
        assertEq(version, 1);
        assertEq(hash, registry.getVersion(templateId, version).bundleHash);
        V.Parameters memory parameters = registry.protocolParameters();
        V.Modules memory m = raise.modules();
        vm.expectRevert();
        raise.initialize(_config(false), parameters, m, builder, templateId, 1, hash);
    }

    function test_implementationsCannotBeInitialized() public {
        V.Parameters memory parameters = registry.protocolParameters();
        vm.expectRevert();
        RaiseCore(implementations.raise)
            .initialize(
                _config(false),
                parameters,
                V.Modules(address(0), address(0), address(0), address(0), address(0), address(0), address(0)),
                builder,
                V.ESCROW_LAUNCH,
                1,
                bytes32(0)
            );
    }

    function test_appendOnlyAndDeprecation_preserveExistingExits() public {
        _create(false);
        (uint256 id, uint256 tokens) = _deposit(backers[0], 1000e6);
        vm.expectRevert(V.InvalidConfig.selector);
        registry.publish(V.ESCROW_LAUNCH, 1, implementations);
        registry.publish(V.ESCROW_LAUNCH, 2, implementations);
        assertEq(registry.versionCount(V.ESCROW_LAUNCH), 2);
        assertEq(registry.versionAt(V.ESCROW_LAUNCH, 1), 2);
        registry.deprecate(V.ESCROW_LAUNCH, 1);
        _expectInvalid(_config(false), false, 1);
        assertEq(_exit(id, tokens, false), 1000e6);
    }

    function test_futureBoundsDoNotChangePinnedRaisesOrVersions() public {
        _create(true);
        (, V.Parameters memory pinned,) = raise.governanceConfig();
        V.Parameters memory next = registry.protocolParameters();
        next.kappaMax = 3e18;
        next.budgetCeilingMax = 0.5e18;
        registry.setProtocolParameters(next);
        registry.publish(V.BUDGET_LAUNCH, 2, implementations);
        (, V.Parameters memory stillPinned,) = raise.governanceConfig();
        assertEq(stillPinned.kappaMax, pinned.kappaMax);
        assertEq(stillPinned.budgetCeilingMax, 0.3e18);
        V.Config memory c = _config(true);
        c.budgetCeiling = 0.4e18;
        _expectInvalid(c, true, 1);
        _createVersion(c, true, 2);
        assertEq(raise.getConfig().budgetCeiling, 0.4e18);
    }

    function test_factoryRejectsChangedImplementationCode() public {
        vm.etch(implementations.token, hex"60006000fd");
        _expectInvalid(_config(false), false, 1);
    }

    function test_quoteWhitelistRejectsUnsupportedBehaviorAndDecimals() public {
        vm.expectRevert(V.InvalidConfig.selector);
        registry.whitelistQuote(address(quote), true, false, false, true);
        vm.expectRevert(V.InvalidConfig.selector);
        registry.whitelistQuote(address(quote), false, true, false, true);
        vm.expectRevert(V.InvalidConfig.selector);
        registry.whitelistQuote(address(quote), false, false, true, true);
        vm.expectRevert(V.InvalidConfig.selector);
        registry.whitelistQuote(implementations.token, false, false, false, true);
    }

    function test_registryRejectsMissingModulesAndUnsupportedTypes() public {
        PortexRegistryV31.Implementations memory bad = implementations;
        bad.governor = address(0);
        vm.expectRevert(V.InvalidConfig.selector);
        registry.publish(V.ESCROW_LAUNCH, 2, bad);
        vm.expectRevert(V.InvalidConfig.selector);
        registry.publish(keccak256("SMOOTHED"), 1, implementations);
        vm.expectRevert(V.Unauthorized.selector);
        vm.prank(builder);
        registry.publish(V.ESCROW_LAUNCH, 2, implementations);
    }

    function test_feeAndVetoBoundsCannotWeakenComposition() public {
        V.Parameters memory p = registry.protocolParameters();
        p.tradeFeeBps = 101;
        vm.expectRevert(V.InvalidConfig.selector);
        registry.setProtocolParameters(p);
        p = registry.protocolParameters();
        p.surchargeBps = 1;
        vm.expectRevert(V.InvalidConfig.selector);
        registry.setProtocolParameters(p);
        p = registry.protocolParameters();
        p.vetoTotal = 8 days;
        vm.expectRevert(V.InvalidConfig.selector);
        registry.setProtocolParameters(p);
        p = registry.protocolParameters();
        p.kappaMax = 1.49e18;
        vm.expectRevert(V.InvalidConfig.selector);
        registry.setProtocolParameters(p);
        assertEq(registry.MAX_SURCHARGE_BPS(), 50);
    }

    function test_factoryValidatesValuationAllocationsDurationsAndCeiling() public {
        V.Config memory c = _config(false);
        c.targetPrice = TARGET - 1;
        _expectInvalid(c, false, 1);
        c = _config(false);
        c.supply = SUPPLY + 1;
        _expectInvalid(c, false, 1);
        c = _config(false);
        c.stage1Length = 15 days - 1;
        _expectInvalid(c, false, 1);
        c.stage1Length = 60 days + 1;
        _expectInvalid(c, false, 1);
        c = _config(false);
        c.stage2Length = 35 days - 1;
        _expectInvalid(c, false, 1);
        c.stage2Length = 70 days + 1;
        _expectInvalid(c, false, 1);
        c = _config(false);
        c.budgetCeiling = 1;
        _expectInvalid(c, false, 1);
        c = _config(true);
        c.budgetCeiling = 0.3e18 + 1;
        _expectInvalid(c, true, 1);
        c = _config(false);
        c.quote = address(0);
        _expectInvalid(c, false, 1);
    }

    function test_treasuryIsAlwaysAFreshGovernedClone() public {
        V.Config memory c = _config(false);
        c.treasury = builder;
        _createWith(c, false);
        address pinned = raise.getConfig().treasury;
        assertTrue(pinned != builder && pinned.code.length != 0);
        assertEq(TreasuryV31(pinned).raise(), address(raise));
        assertEq(TreasuryV31(pinned).governor(), address(governor));
        assertEq(TreasuryV31(pinned).allocation(), SUPPLY / 10);
        assertEq(token.treasury(), pinned);
        assertEq(governor.treasury(), pinned);
        // A builder listed as a co-builder can never be the treasury either.
        c.builders = new address[](1);
        c.builders[0] = address(0xBEEF);
        _createWith(c, false);
        assertTrue(raise.getConfig().treasury != pinned);
    }

    function test_productionStageBoundsAndInclusiveEndpoints() public {
        V.Parameters memory b = registry.getVersion(V.ESCROW_LAUNCH, 1).parameters;
        assertEq(b.stage1Min, 15 days);
        assertEq(b.stage1Max, 60 days);
        assertEq(b.stage2Min, 35 days);
        assertEq(b.stage2Max, 70 days);
        _create(false);
        V.Config memory c = _config(true);
        c.stage1Length = b.stage1Max;
        c.stage2Length = b.stage2Max;
        _createWith(c, true);
    }

    function test_customStageBoundsValidateBothTypesAndRemainImmutable() public {
        _useTimings(_shortTimings());
        for (uint256 i; i < 2; ++i) {
            bool budget = i == 1;
            V.Config memory c = _config(budget);
            _expectInvalid(c, budget, 1);
            c.stage1Length = 1 hours;
            c.stage2Length = 2 hours;
            _createWith(c, budget);
            assertEq(raise.stageDeadlines().stage1End - raise.stageDeadlines().start, 1 hours);
            c.stage1Length--;
            _expectInvalid(c, budget, 1);
            c.stage1Length = 48 hours + 1;
            _expectInvalid(c, budget, 1);
            c.stage1Length = 48 hours;
            c.stage2Length = 2 hours - 1;
            _expectInvalid(c, budget, 1);
            c.stage2Length = 72 hours + 1;
            _expectInvalid(c, budget, 1);
            c.stage2Length = 72 hours;
            _createWith(c, budget);
        }
        bytes32 hash = registry.getVersion(V.ESCROW_LAUNCH, 1).bundleHash;
        V.Parameters memory p = registry.protocolParameters();
        p.kappaMax = 3e18;
        registry.setProtocolParameters(p);
        registry.publish(V.ESCROW_LAUNCH, 2, implementations);
        assertEq(registry.getVersion(V.ESCROW_LAUNCH, 2).parameters.stage1Min, 1 hours);
        assertEq(registry.getVersion(V.ESCROW_LAUNCH, 2).parameters.stage2Max, 72 hours);
        assertEq(registry.getVersion(V.ESCROW_LAUNCH, 1).bundleHash, hash);
    }

    function test_stageBoundsRejectZeroAndInvertedRanges() public {
        V.Parameters memory p = _shortTimings();
        p.stage1Min = 0;
        vm.expectRevert(V.InvalidConfig.selector);
        registry.setProtocolParameters(p);
        p = _shortTimings();
        p.stage1Min = p.stage1Max + 1;
        vm.expectRevert(V.InvalidConfig.selector);
        registry.setProtocolParameters(p);
        p = _shortTimings();
        p.stage2Min = 0;
        vm.expectRevert(V.InvalidConfig.selector);
        registry.setProtocolParameters(p);
        p = _shortTimings();
        p.stage2Min = p.stage2Max + 1;
        vm.expectRevert(V.InvalidConfig.selector);
        registry.setProtocolParameters(p);
    }

    function _expectInvalid(V.Config memory c, bool budget, uint64 version) internal {
        vm.expectRevert(V.InvalidConfig.selector);
        vm.prank(builder);
        factory.createRaise(
            budget ? V.BUDGET_LAUNCH : V.ESCROW_LAUNCH, version, c, RaiseFactoryV31.TokenMeta("Invalid", "BAD")
        );
    }
}
