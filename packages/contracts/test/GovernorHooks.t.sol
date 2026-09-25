// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.sol";
import {Raise} from "../src/Raise.sol";
import {MockDexAdapter} from "../src/mocks/MockDexAdapter.sol";
import {RaiseConfig, TokenMeta, GovernorConfig} from "../src/libraries/PortexTypes.sol";

/// @notice Minimal forwarding governor used to test the Raise governor hooks without the
///         Rule 2 SpendGovernor voting logic (added by a later work package).
contract MockGovernor {
    /// @dev The factory initializes every governor clone; the mock ignores it.
    function initialize(address, GovernorConfig calldata) external {}

    /// @dev The mock never has a proposal in flight, so startCommitment is never blocked.
    function proposalInFlight() external pure returns (bool) {
        return false;
    }

    function depositsPaused() external pure returns (bool) {
        return false;
    }

    function spend(address raise, uint256 amount, address to) external {
        Raise(payable(raise)).governorSpend(amount, to);
    }

    function lock(address raise, address user, uint64 until) external {
        Raise(payable(raise)).setWithdrawLock(user, until);
    }
}

/// @notice Governor hooks (WP-A1 requirement 3): only-governor, Incubation-only, hard ceiling
///         of maxCumulativeSpendBps of peak principal, pro-rata index lowering, withdraw locks.
contract GovernorHooksTest is BaseTest {
    MockGovernor internal governorImpl;

    function setUp() public override {
        super.setUp();
        governorImpl = new MockGovernor();
        publishMilestoneFunding(address(governorImpl));
    }

    function _createGovernedRaise(uint16 spendCapBps) internal returns (Raise r) {
        RaiseConfig memory cfg = defaultConfig();
        cfg.maxCumulativeSpendBps = spendCapBps;
        vm.prank(builder);
        address addr = factory.createRaise(MILESTONE_FUNDING, 1, cfg, TokenMeta({name: "G", symbol: "G"}));
        r = Raise(payable(addr));
        raise = r;
        pool = r.pool();
        vault = r.vault();
        token = r.token();
    }

    function test_zeroExtraction_governorIsZeroAndUnreachable() public {
        createRaise();
        assertEq(raise.governor(), address(0));
        vm.expectRevert(Raise.OnlyGovernor.selector);
        vm.prank(alice);
        raise.governorSpend(1, alice);
        vm.expectRevert(Raise.OnlyGovernor.selector);
        vm.prank(alice);
        raise.setWithdrawLock(alice, 1);
    }

    function test_governorSpend_lowersIndexProRata() public {
        Raise r = _createGovernedRaise(3000); // 30% ceiling
        address gov = r.governor();
        assertTrue(gov != address(0));

        depositAs(alice, 100_000e6);
        depositAs(bob, 100_000e6);

        MockGovernor(gov).spend(address(r), 10_000e6, builder);
        // index = 1e27 * 190k/200k
        assertEq(r.index(), 0.95e27);
        assertEq(r.principalOf(alice), 95_000e6);
        assertEq(r.principalOf(bob), 95_000e6);
        assertEq(usdg.balanceOf(builder), 10_000_000e6 + 10_000e6);
        assertEq(r.cumulativeSpend(), 10_000e6);
        // escrow still equals total principal under floor rounding (exact here)
        assertEq(usdg.balanceOf(address(r)), r.totalPrincipal());
    }

    function test_governorSpend_lateDepositorDoesNotPayForPastSpends() public {
        Raise r = _createGovernedRaise(3000);
        address gov = r.governor();
        depositAs(alice, 100_000e6);
        MockGovernor(gov).spend(address(r), 10_000e6, builder); // index 0.9e27
        depositAs(bob, 50_000e6);
        // bob joined at the new index and does not pay for the past spend; 1 wei of
        // rounding dust is absorbed by bob (rounding favours the protocol)
        assertEq(r.principalOf(bob), 50_000e6 - 1);
        assertEq(r.principalOf(alice), 90_000e6);
    }

    function test_governorSpend_hardCeilingEnforced() public {
        Raise r = _createGovernedRaise(3000);
        address gov = r.governor();
        depositAs(alice, 200_000e6); // peak = 200k, ceiling = 60k
        MockGovernor(gov).spend(address(r), 60_000e6, builder);
        vm.expectRevert(Raise.SpendCeilingExceeded.selector);
        MockGovernor(gov).spend(address(r), 1, builder);
    }

    function test_governorSpend_ceilingUsesPeakPrincipal() public {
        Raise r = _createGovernedRaise(3000);
        address gov = r.governor();
        depositAs(alice, 200_000e6); // peak 200k
        withdrawAs(alice, 150_000e6); // principal now 50k, ceiling still 30% of 200k = 60k
        vm.expectRevert(Raise.InsufficientPrincipal.selector); // can't spend more than escrow
        MockGovernor(gov).spend(address(r), 60_000e6, builder);
        MockGovernor(gov).spend(address(r), 50_000e6, builder); // <= 60k ceiling, == escrow
        assertEq(r.totalPrincipal(), 0);
    }

    function test_revert_governorSpendNotGovernor() public {
        Raise r = _createGovernedRaise(3000);
        depositAs(alice, 10_000e6);
        vm.expectRevert(Raise.OnlyGovernor.selector);
        vm.prank(alice);
        r.governorSpend(1, alice);
    }

    function test_revert_governorSpendOutsideIncubation() public {
        Raise r = _createGovernedRaise(3000);
        address gov = r.governor();
        depositAs(alice, 100_000e6);
        vm.warp(block.timestamp + 10 minutes);
        r.startCommitment();
        vm.expectRevert(Raise.InvalidState.selector);
        MockGovernor(gov).spend(address(r), 1_000e6, builder);
    }

    function test_setWithdrawLock() public {
        Raise r = _createGovernedRaise(3000);
        address gov = r.governor();
        depositAs(alice, 10_000e6);
        MockGovernor(gov).lock(address(r), alice, uint64(block.timestamp + 100));
        vm.expectRevert(Raise.WithdrawLocked.selector);
        vm.prank(alice);
        r.withdraw(1e6);
        vm.warp(block.timestamp + 101);
        withdrawAs(alice, 10_000e6); // lock expired
        assertEq(usdg.balanceOf(alice), 10_000_000e6);
    }

    function test_withdrawLockNotEnforcedInFailed() public {
        Raise r = _createGovernedRaise(3000);
        address gov = r.governor();
        depositAs(alice, 10_000e6);
        MockGovernor(gov).lock(address(r), alice, uint64(block.timestamp + 10_000));
        vm.warp(block.timestamp + 31 minutes);
        r.fail();
        withdrawAs(alice, 10_000e6); // Failed raises are always exitable
        assertEq(usdg.balanceOf(alice), 10_000_000e6);
    }

    function test_revert_governorSpendZeroCap() public {
        // governor set but ceiling 0: any spend reverts
        Raise r = _createGovernedRaise(0);
        address gov = r.governor();
        depositAs(alice, 10_000e6);
        vm.expectRevert(Raise.SpendCeilingExceeded.selector);
        MockGovernor(gov).spend(address(r), 1, builder);
    }

    /// @notice Review fix: under a lowered index the per-tranche ceil share burn can overshoot
    ///         the user's shares by a few wei. Redeeming EVERY tranche must still succeed for
    ///         every user, and each user must receive exactly the sum of their tranche principals.
    function test_redeemAllTranches_underLoweredIndex() public {
        Raise r = _createGovernedRaise(3000);
        address gov = r.governor();
        depositAs(alice, 100_000e6);
        depositAs(bob, 60_000e6);
        depositAs(carol, 33_333e6);
        // non-divisible index: per-tranche ceil burns overshoot by wei amounts
        MockGovernor(gov).spend(address(r), 30_000e6, builder);
        vm.warp(block.timestamp + 10 minutes);
        r.startCommitment();

        address[3] memory users = [alice, bob, carol];
        for (uint256 i = 0; i < users.length; ++i) {
            address u = users[i];
            uint256 expected = r.principalOf(u); // == the lazily cached commitment snapshot
            uint256 balBefore = usdg.balanceOf(u);
            for (uint8 k = 1; k <= 4; ++k) {
                vm.prank(u);
                r.redeem(k); // must not revert, including the last tranche
            }
            assertEq(usdg.balanceOf(u) - balBefore, expected, "user must receive exactly the tranche principal sum");
            assertEq(r.sharesOf(u), 0, "all shares burned");
        }
        assertEq(r.totalShares(), 0);
        assertEq(r.totalPrincipal(), 0);
        // escrow never dips below the accounted obligation (dust stays in the raise)
        assertGe(usdg.balanceOf(address(r)), r.escrowedPrincipal());
    }

    /// @notice Audit L-02: under a lowered index, mixed commit/redeem rounding (per-tranche ceil
    ///         share burns) can push committedPrincipal a few wei above totalPrincipal().
    ///         escrowedPrincipal() must saturate at 0 instead of reverting, so the invariant
    ///         suites' use of it (balance >= escrowedPrincipal()) stays green.
    function test_escrowedPrincipal_saturatesWhenCommittedExceedsTotal() public {
        Raise r = _createGovernedRaise(3000);
        address gov = r.governor();
        address dusty = makeAddr("dusty");
        usdg.mint(dusty, 100);

        depositAs(alice, 100_000e6); // 100_000_000_000 wei
        depositAs(dusty, 100); // 100 wei -> snapshot principal 90 after the spend
        MockGovernor(gov).spend(address(r), 10_000_000_010, builder); // index = 0.9 exactly
        assertEq(r.index(), 0.9e27);

        vm.warp(block.timestamp + 10 minutes);
        r.startCommitment();
        commitAs(alice, 1); // 22_500_000_000
        commitAs(dusty, 1); // 22 (tranches of 90: 22/22/22/24)
        vm.warp(block.timestamp + 5 minutes);
        r.openGrowth();

        // redeem every other tranche: ceil share burns overshoot the accounted principal
        for (uint8 k = 2; k <= 4; ++k) {
            redeemAs(alice, k);
            redeemAs(dusty, k);
        }

        // the underflow condition is really driven (22_500_000_020 < 22_500_000_022) ...
        assertLt(r.totalPrincipal(), r.committedPrincipal());
        assertEq(r.committedPrincipal() - r.totalPrincipal(), 2);
        // ... yet the view saturates at 0, and the drained escrow keeps the invariant green
        assertEq(r.escrowedPrincipal(), 0);
        assertEq(usdg.balanceOf(address(r)), 0);
        assertGe(usdg.balanceOf(address(r)), r.escrowedPrincipal());
    }

    /// @notice Review fix: the early factor is share-denominated, so a governor spend (which
    ///         moves the index, never shares) cannot inflate it beyond [1e18, 2e18].
    function test_earlyFactor_stableAcrossSpend() public {
        Raise r = _createGovernedRaise(3000);
        address gov = r.governor();
        depositAs(alice, 100_000e6); // f = 2 (t == start)
        vm.warp(block.timestamp + 15 minutes);
        depositAs(bob, 100_000e6); // f = 1.5 (halfway to the deadline)
        assertEq(r.earlyFactorOf(alice), 2e18);
        assertEq(r.earlyFactorOf(bob), 1.5e18);

        MockGovernor(gov).spend(address(r), 50_000e6, builder); // index 0.75e27
        assertEq(r.index(), 0.75e27);
        assertEq(r.earlyFactorOf(alice), 2e18, "spend must not change early factors");
        assertEq(r.earlyFactorOf(bob), 1.5e18, "spend must not change early factors");

        // a deposit at the lowered index also stays within bounds
        depositAs(carol, 50_000e6);
        uint256 efCarol = r.earlyFactorOf(carol);
        assertGe(efCarol, 1e18);
        assertLe(efCarol, 2e18);
        assertGt(efCarol, 1.49e18); // ~1.5 (halfway factor), dust rounding only

        // partial withdraw under the lowered index keeps the factor stable too (dust rounding only)
        withdrawAs(bob, 20_000e6);
        assertApproxEqAbs(r.earlyFactorOf(bob), 1.5e18, 1e7);
    }
}
