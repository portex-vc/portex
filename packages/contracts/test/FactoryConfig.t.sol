// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.sol";
import {RaiseConfig, TokenMeta} from "../src/libraries/PortexTypes.sol";
import {RaiseFactory} from "../src/RaiseFactory.sol";
import {Raise} from "../src/Raise.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";

/// @notice Every creation-time validation in design §4 + factory access/config behaviour.
contract FactoryConfigTest is BaseTest {
    TokenMeta internal meta = TokenMeta({name: "X", symbol: "X"});

    function _create(RaiseConfig memory cfg) internal returns (bool ok) {
        vm.prank(builder);
        try factory.createRaise(ZERO_EXTRACTION, 1, cfg, meta) returns (address) {
            ok = true;
        } catch {
            ok = false;
        }
    }

    function test_createRaise_happyPath() public {
        vm.prank(builder);
        address r = factory.createRaise(ZERO_EXTRACTION, 1, defaultConfig(), meta);
        assertTrue(r != address(0));
        (bytes32 tid, uint64 ver) = factory.templateOf(r);
        assertEq(tid, ZERO_EXTRACTION);
        assertEq(ver, 1);
        assertTrue(factory.isRaise(r));
        assertEq(factory.raisesCount(), 1);
        assertEq(factory.raiseAt(0), r);
        Raise rr = Raise(payable(r));
        assertEq(rr.builder(), builder);
        assertEq(address(rr.governor()), address(0));
        assertEq(rr.token().totalSupply(), defaultConfig().totalSupply);
        assertEq(rr.token().balanceOf(r), defaultConfig().totalSupply);
        // veto params wired to the board
        assertEq(board.vetoMaxDelayOf(r), defaultConfig().vetoMaxDelay);
        assertEq(board.vetoCooldownOf(r), defaultConfig().vetoCooldown);
    }

    function test_revert_allocationsMismatch() public {
        RaiseConfig memory cfg = defaultConfig();
        cfg.builderAlloc -= 1;
        vm.expectRevert(RaiseFactory.AllocationsMismatch.selector);
        vm.prank(builder);
        factory.createRaise(ZERO_EXTRACTION, 1, cfg, meta);
    }

    function test_revert_inventoryBelowAlloc() public {
        RaiseConfig memory cfg = defaultConfig();
        uint256 newT0 = cfg.stage1Alloc - 1;
        cfg.builderAlloc += cfg.stage2Inventory - newT0; // keep the allocation sum valid
        cfg.stage2Inventory = newT0;
        vm.expectRevert(RaiseFactory.InventoryBelowAlloc.selector);
        vm.prank(builder);
        factory.createRaise(ZERO_EXTRACTION, 1, cfg, meta);
    }

    function test_revert_softCapZero() public {
        RaiseConfig memory cfg = defaultConfig();
        cfg.softCap = 0;
        vm.expectRevert(RaiseFactory.CapsInvalid.selector);
        vm.prank(builder);
        factory.createRaise(ZERO_EXTRACTION, 1, cfg, meta);
    }

    function test_revert_softCapAboveHardCap() public {
        RaiseConfig memory cfg = defaultConfig();
        cfg.softCap = cfg.hardCap + 1;
        vm.expectRevert(RaiseFactory.CapsInvalid.selector);
        vm.prank(builder);
        factory.createRaise(ZERO_EXTRACTION, 1, cfg, meta);
    }

    function test_revert_minIncubationNotBelowDeadline() public {
        RaiseConfig memory cfg = defaultConfig();
        cfg.minIncubation = cfg.deadline;
        vm.expectRevert(RaiseFactory.DurationsInvalid.selector);
        vm.prank(builder);
        factory.createRaise(ZERO_EXTRACTION, 1, cfg, meta);
    }

    function test_revert_zeroDurations() public {
        RaiseConfig memory cfg = defaultConfig();
        cfg.commitmentWindow = 0;
        vm.expectRevert(RaiseFactory.DurationsInvalid.selector);
        vm.prank(builder);
        factory.createRaise(ZERO_EXTRACTION, 1, cfg, meta);
        cfg = defaultConfig();
        cfg.epochLength = 0;
        vm.expectRevert(RaiseFactory.DurationsInvalid.selector);
        vm.prank(builder);
        factory.createRaise(ZERO_EXTRACTION, 1, cfg, meta);
        cfg = defaultConfig();
        cfg.vaultDuration = 0;
        vm.expectRevert(RaiseFactory.DurationsInvalid.selector);
        vm.prank(builder);
        factory.createRaise(ZERO_EXTRACTION, 1, cfg, meta);
    }

    function test_revert_feeSplitNot100() public {
        RaiseConfig memory cfg = defaultConfig();
        cfg.feeBuilderBps = 3001;
        vm.expectRevert(RaiseFactory.FeeSplitInvalid.selector);
        vm.prank(builder);
        factory.createRaise(ZERO_EXTRACTION, 1, cfg, meta);
    }

    function test_revert_bpsBounds() public {
        RaiseConfig memory cfg = defaultConfig();
        cfg.swapFeeBps = 10_001;
        vm.expectRevert(RaiseFactory.BpsInvalid.selector);
        vm.prank(builder);
        factory.createRaise(ZERO_EXTRACTION, 1, cfg, meta);
        cfg = defaultConfig();
        cfg.minOptInBps = 10_001;
        vm.expectRevert(RaiseFactory.BpsInvalid.selector);
        vm.prank(builder);
        factory.createRaise(ZERO_EXTRACTION, 1, cfg, meta);
        cfg = defaultConfig();
        cfg.minRealRatioBps = 10_001;
        vm.expectRevert(RaiseFactory.BpsInvalid.selector);
        vm.prank(builder);
        factory.createRaise(ZERO_EXTRACTION, 1, cfg, meta);
        cfg = defaultConfig();
        cfg.maxCumulativeSpendBps = 10_001;
        vm.expectRevert(RaiseFactory.BpsInvalid.selector);
        vm.prank(builder);
        factory.createRaise(ZERO_EXTRACTION, 1, cfg, meta);
    }

    /// @notice Audit M-02: minRealRatioBps == BPS is unattainable (V >= b·(T0−A1) > 0 while
    ///         T0 > A1), so the factory rejects it; the largest attainable boundary passes.
    function test_minRealRatioBoundary() public {
        RaiseConfig memory cfg = defaultConfig();
        cfg.minRealRatioBps = 10_000;
        vm.expectRevert(RaiseFactory.BpsInvalid.selector);
        vm.prank(builder);
        factory.createRaise(ZERO_EXTRACTION, 1, cfg, meta);

        cfg = defaultConfig();
        cfg.minRealRatioBps = 9_999;
        assertTrue(_create(cfg));
    }

    function test_revert_tranchesBounds() public {
        RaiseConfig memory cfg = defaultConfig();
        cfg.numTranches = 0;
        vm.expectRevert(RaiseFactory.TranchesInvalid.selector);
        vm.prank(builder);
        factory.createRaise(ZERO_EXTRACTION, 1, cfg, meta);
        cfg = defaultConfig();
        cfg.numTranches = 33;
        vm.expectRevert(RaiseFactory.TranchesInvalid.selector);
        vm.prank(builder);
        factory.createRaise(ZERO_EXTRACTION, 1, cfg, meta);
    }

    function test_tranchesBoundary32() public {
        RaiseConfig memory cfg = defaultConfig();
        cfg.numTranches = 32;
        assertTrue(_create(cfg));
    }

    function test_revert_quoteNotWhitelisted() public {
        RaiseConfig memory cfg = defaultConfig();
        cfg.quoteAsset = address(new MockUSDG());
        vm.expectRevert(RaiseFactory.NotWhitelisted.selector);
        vm.prank(builder);
        factory.createRaise(ZERO_EXTRACTION, 1, cfg, meta);
    }

    function test_revert_versionMissing() public {
        vm.expectRevert(RaiseFactory.VersionMissing.selector);
        vm.prank(builder);
        factory.createRaise(ZERO_EXTRACTION, 99, defaultConfig(), meta);
    }

    function test_revert_versionDeprecated() public {
        vm.prank(curator);
        registry.deprecate(ZERO_EXTRACTION, 1);
        vm.expectRevert(RaiseFactory.VersionDeprecated.selector);
        vm.prank(builder);
        factory.createRaise(ZERO_EXTRACTION, 1, defaultConfig(), meta);
    }

    function test_revert_zeroStage1Alloc() public {
        RaiseConfig memory cfg = defaultConfig();
        cfg.builderAlloc += cfg.stage1Alloc;
        cfg.stage1Alloc = 0;
        vm.expectRevert(RaiseFactory.ZeroAmount.selector);
        vm.prank(builder);
        factory.createRaise(ZERO_EXTRACTION, 1, cfg, meta);
    }

    function test_onlyOwnerGuards() public {
        vm.expectRevert(RaiseFactory.OnlyOwner.selector);
        vm.prank(alice);
        factory.setQuoteAsset(address(usdg), false);

        vm.expectRevert(RaiseFactory.OnlyOwner.selector);
        vm.prank(alice);
        factory.setProtocolFeeRecipient(alice);

        vm.expectRevert(RaiseFactory.OnlyOwner.selector);
        vm.prank(alice);
        factory.transferOwnership(alice);
    }

    function test_ownerConfigUpdates() public {
        vm.startPrank(curator);
        factory.setQuoteAsset(address(usdg), false);
        assertFalse(factory.quoteWhitelist(address(usdg)));
        factory.setQuoteAsset(address(usdg), true);
        factory.setProtocolFeeRecipient(alice);
        assertEq(factory.protocolFeeRecipient(), alice);
        factory.transferOwnership(bob);
        assertEq(factory.owner(), bob);
        vm.stopPrank();
    }

    function test_dexAdapterPinnedFromVersion() public {
        vm.prank(builder);
        address r = factory.createRaise(ZERO_EXTRACTION, 1, defaultConfig(), meta);
        assertEq(address(Raise(payable(r)).pool().dexAdapter()), address(adapter));
    }

    function test_revert_versionWithZeroAdapter() public {
        // a published version without a pinned adapter cannot spawn raises
        vm.prank(curator);
        registry.publish(
            ZERO_EXTRACTION, 2, address(raiseImpl), address(poolImpl), address(vaultImpl), address(0), address(0)
        );
        vm.expectRevert(RaiseFactory.ZeroAddress.selector);
        vm.prank(builder);
        factory.createRaise(ZERO_EXTRACTION, 2, defaultConfig(), meta);
    }

    function test_rolesMirroredFromBoard() public view {
        assertEq(factory.attester(), attester);
        assertEq(factory.council(), council);
        assertEq(registry.curator(), curator);
    }
}
