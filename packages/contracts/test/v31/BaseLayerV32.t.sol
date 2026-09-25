// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseV31} from "./BaseV31.sol";
import {TypesV31 as V} from "../../src/v31/TypesV31.sol";
import {RaiseCore} from "../../src/v31/RaiseCore.sol";
import {ClaimVault} from "../../src/v31/ClaimVault.sol";
import {GovernanceV31} from "../../src/v31/GovernanceV31.sol";
import {ProjectTokenV31} from "../../src/v31/ProjectTokenV31.sol";
import {TreasuryV31} from "../../src/v31/TreasuryV31.sol";
import {RolloverRouterV31} from "../../src/v31/RolloverRouterV31.sol";
import {RaiseFactoryV31} from "../../src/v31/RaiseFactoryV31.sol";

/// @notice Base-layer mechanisms added on 2026-09-23: builder dissolution, one-transaction rollover between
/// launches, and the governed treasury (capital votes in Stage 2, token votes with a market-value cap in Stage 3).
contract BaseLayerV32Test is BaseV31 {
    address internal recipient = address(0x5EED);

    // ---------------------------------------------------------------- dissolution

    function test_builderDissolve_onlyAfterStage1Minimum_andOnlyBuilder() public {
        _create(false);
        _deposit(backers[0], 1_000e6);
        uint64 start = raise.stageDeadlines().start;
        vm.warp(uint256(start) + 15 days - 1);
        vm.prank(builder);
        vm.expectRevert(V.InvalidPhase.selector);
        raise.dissolve();
        vm.warp(uint256(start) + 15 days);
        vm.prank(backers[0]);
        vm.expectRevert(V.Unauthorized.selector);
        raise.dissolve();
        vm.expectEmit(address(raise));
        emit RaiseCore.DissolvedByBuilder(address(raise), raise.stateNonce() + 1, builder);
        vm.prank(builder);
        raise.dissolve();
        assertEq(uint256(raise.phase()), uint256(V.Phase.Dissolved));
    }

    function test_builderDissolve_everyPositionClaimsExactCost() public {
        _create(false);
        (uint256 a,) = _deposit(backers[0], 1_000e6);
        (uint256 b,) = _deposit(backers[1], 2_500e6);
        uint256 costA = raise.positionState(a).basis;
        uint256 costB = raise.positionState(b).basis;
        vm.warp(uint256(raise.stageDeadlines().start) + 20 days);
        vm.prank(builder);
        raise.dissolve();
        assertEq(claims.liability(), costA + costB);
        assertEq(token.totalSupply(), 0);
        vm.prank(backers[0]);
        assertEq(claims.claim(a), costA);
        vm.prank(backers[1]);
        assertEq(claims.claim(b), costB);
        assertEq(claims.liability(), 0);
    }

    function test_dissolve_notAvailableOnceStage2Opens() public {
        _create(false);
        _fund();
        _open();
        vm.prank(builder);
        vm.expectRevert(V.InvalidPhase.selector);
        raise.dissolve();
    }

    // ---------------------------------------------------------------- rollover

    function test_rollover_stage1PositionIntoAnotherLaunch_inOneTransaction() public {
        (RaiseCore from, RaiseCore to) = _twoLaunches();
        (uint256 id,) = _depositInto(from, backers[0], 3_000e6);
        uint256 cost = from.positionState(id).basis;
        uint256 walletBefore = quote.balanceOf(backers[0]);
        RolloverRouterV31.Source[] memory sources = new RolloverRouterV31.Source[](1);
        sources[0] = RolloverRouterV31.Source(
            address(from),
            RolloverRouterV31.SourceKind.CostExit,
            id,
            from.positionState(id).tokens,
            cost,
            from.stateNonce()
        );
        uint256 toNonce = to.stateNonce();
        vm.prank(backers[0]);
        (uint256 newId, uint256 tokens, uint256 returned) =
            router.rollover(sources, 0, address(to), 1, toNonce, block.timestamp);
        assertEq(from.positionState(id).tokens, 0);
        V.PositionView memory p = to.positionState(newId);
        assertEq(p.owner, backers[0]);
        assertEq(p.tokens, tokens);
        assertEq(p.basis + returned, cost);
        assertEq(quote.balanceOf(backers[0]), walletBefore + returned);
        assertEq(quote.balanceOf(address(router)), 0);
    }

    function test_rollover_dissolutionClaimPlusWalletTopUp() public {
        _create(false);
        RaiseCore from = raise;
        (uint256 id,) = _depositInto(from, backers[1], 2_000e6);
        uint256 cost = from.positionState(id).basis;
        vm.warp(uint256(from.stageDeadlines().start) + 16 days);
        vm.prank(builder);
        from.dissolve();
        _create(false);
        RaiseCore to = raise;
        ClaimVault vault = ClaimVault(from.modules().claims);
        assertEq(vault.claimable(id), cost);
        quote.mint(backers[1], 500e6);
        vm.prank(backers[1]);
        quote.approve(address(router), 500e6);
        RolloverRouterV31.Source[] memory sources = new RolloverRouterV31.Source[](1);
        sources[0] = RolloverRouterV31.Source(address(from), RolloverRouterV31.SourceKind.DissolutionClaim, id, 0, 0, 0);
        uint256 toNonce = to.stateNonce();
        vm.prank(backers[1]);
        (uint256 newId,, uint256 returned) = router.rollover(sources, 500e6, address(to), 1, toNonce, block.timestamp);
        assertTrue(vault.claimed(id));
        assertEq(vault.liability(), 0);
        assertEq(to.positionState(newId).basis + returned, cost + 500e6);
        assertEq(quote.balanceOf(address(router)), 0);
    }

    function test_rollover_cannotMoveSomeoneElsesPosition() public {
        (RaiseCore from, RaiseCore to) = _twoLaunches();
        (uint256 id,) = _depositInto(from, backers[0], 1_000e6);
        RolloverRouterV31.Source[] memory sources = new RolloverRouterV31.Source[](1);
        sources[0] = RolloverRouterV31.Source(
            address(from),
            RolloverRouterV31.SourceKind.CostExit,
            id,
            from.positionState(id).tokens,
            0,
            from.stateNonce()
        );
        uint256 toNonce = to.stateNonce();
        vm.prank(backers[5]);
        vm.expectRevert(V.Unauthorized.selector);
        router.rollover(sources, 0, address(to), 1, toNonce, block.timestamp);
    }

    function test_rollover_hooksOnlyAcceptTheRouter_andTargetsMustBeLaunches() public {
        (RaiseCore from, RaiseCore to) = _twoLaunches();
        (uint256 id,) = _depositInto(from, backers[0], 1_000e6);
        uint256 nonce = from.stateNonce();
        vm.prank(backers[0]);
        vm.expectRevert(V.Unauthorized.selector);
        from.exitFor(backers[0], id, 1, 0, nonce, block.timestamp, false);
        uint256 toNonce = to.stateNonce();
        vm.expectRevert(V.Unauthorized.selector);
        to.depositFor(backers[0], 1_000e6, 1, toNonce, block.timestamp);
        ClaimVault vault = ClaimVault(from.modules().claims);
        vm.expectRevert(V.Unauthorized.selector);
        vault.claimFor(backers[0], id);
        RolloverRouterV31.Source[] memory sources = new RolloverRouterV31.Source[](1);
        sources[0] = RolloverRouterV31.Source(
            address(from), RolloverRouterV31.SourceKind.CostExit, id, from.positionState(id).tokens, 0, nonce
        );
        vm.prank(backers[0]);
        vm.expectRevert(V.InvalidConfig.selector);
        router.rollover(sources, 0, address(0xDEAD), 1, 0, block.timestamp);
        vm.prank(backers[0]);
        vm.expectRevert(V.InvalidConfig.selector);
        router.rollover(sources, 0, address(from), 1, nonce, block.timestamp);
    }

    function test_rollover_stage2ProtectedExitIntoStage1Launch() public {
        _create(false);
        _fund();
        _open();
        RaiseCore from = raise;
        _buy(buyer, 50_000e6);
        vm.warp(block.timestamp + 10 days);
        _create(false);
        RaiseCore to = raise;
        V.ExitQuote memory q = from.protectedExitQuote(ids[0], from.positionState(ids[0]).tokens);
        assertTrue(q.validity.available);
        RolloverRouterV31.Source[] memory sources = new RolloverRouterV31.Source[](1);
        sources[0] = RolloverRouterV31.Source(
            address(from),
            RolloverRouterV31.SourceKind.ProtectedExit,
            ids[0],
            from.positionState(ids[0]).tokens,
            q.result.payout,
            from.stateNonce()
        );
        uint256 toNonce = to.stateNonce();
        vm.prank(backers[0]);
        (uint256 newId,, uint256 returned) = router.rollover(sources, 0, address(to), 1, toNonce, block.timestamp);
        assertEq(to.positionState(newId).basis + returned, q.result.payout);
        assertGt(q.result.payout, q.result.cost);
    }

    // ---------------------------------------------------------------- treasury: Stage 2 (capital votes)

    function test_stage2FeesReachTreasury_spendNeedsCapitalVote() public {
        _create(false);
        _fund();
        _open();
        _buy(buyer, 80_000e6);
        (,, uint256 pending) = raise.feeAccruals();
        assertGt(pending, 0);
        assertEq(treasuryVault.availableQuote(), pending);
        vm.prank(builder);
        vm.expectRevert(V.InvalidAmount.selector);
        governor.proposeSpend(recipient, 0, 1e18, "ipfs://tokens-before-listing");
        uint256 amount = pending / 2;
        vm.prank(builder);
        uint256 id = governor.proposeSpend(recipient, amount, 0, "ipfs://tooling");
        GovernanceV31.Proposal memory p = governor.getProposal(id);
        assertEq(uint256(p.mode), uint256(GovernanceV31.Mode.Capital));
        for (uint256 i; i < 10; ++i) {
            vm.prank(backers[i]);
            governor.vote(id, ids[i], true);
        }
        vm.warp(p.votingEnds);
        governor.finalize(id);
        vm.warp(p.disputeEnds);
        governor.execute(id);
        assertEq(quote.balanceOf(recipient), amount);
        assertEq(quote.balanceOf(treasury), pending - amount);
        (,, pending) = raise.feeAccruals();
        assertEq(pending, 0);
    }

    function test_treasuryPaysOnlyTheGovernor() public {
        _create(false);
        vm.expectRevert(V.Unauthorized.selector);
        treasuryVault.spend(1, recipient, 1, 0);
        vm.prank(builder);
        vm.expectRevert(V.Unauthorized.selector);
        treasuryVault.spend(1, recipient, 1, 0);
    }

    // ---------------------------------------------------------------- treasury: allocation schedule

    function test_treasuryAllocation_unlocksLinearlyOverFiveYears() public {
        _create(false);
        _fund();
        _open();
        _list();
        uint256 allocation = SUPPLY / 10;
        assertEq(token.balanceOf(treasury), allocation);
        assertEq(treasuryVault.lockedTokens(), allocation);
        assertEq(treasuryVault.spendableTokens(), 0);
        vm.warp(block.timestamp + 365 days);
        assertEq(treasuryVault.lockedTokens(), allocation - allocation * 365 / 1825);
        assertEq(treasuryVault.spendableTokens(), allocation / 5);
        vm.warp(block.timestamp + 4 * 365 days);
        assertEq(treasuryVault.lockedTokens(), 0);
        assertEq(treasuryVault.spendableTokens(), allocation);
    }

    // ---------------------------------------------------------------- treasury: Stage 3 (token votes)

    function test_stage3Spend_tokenVote_passesWithinCapOfYesTokens() public {
        uint256 yes = _listedWithUnlockedTreasury();
        // The spend is 4% of the YES tokens: inside the 5% cap.
        uint256 amount = yes * 4 / 100;
        vm.prank(builder);
        uint256 id = governor.proposeSpend(recipient, 0, amount, "ipfs://grants");
        _voteAllBackers(id, true);
        GovernanceV31.Proposal memory p = governor.getProposal(id);
        assertEq(p.yesWeight, yes);
        vm.warp(p.votingEnds);
        governor.finalize(id);
        vm.warp(p.disputeEnds);
        governor.execute(id);
        assertEq(token.balanceOf(recipient), amount);
    }

    function test_stage3Spend_aboveCapIsDefeated() public {
        uint256 yes = _listedWithUnlockedTreasury();
        uint256 amount = yes * 6 / 100;
        vm.prank(builder);
        uint256 id = governor.proposeSpend(recipient, 0, amount, "ipfs://too-much");
        _voteAllBackers(id, true);
        GovernanceV31.Proposal memory p = governor.getProposal(id);
        vm.warp(p.votingEnds);
        governor.finalize(id);
        assertEq(uint256(governor.getProposal(id).status), uint256(GovernanceV31.Status.Defeated));
    }

    function test_stage3Spend_usdgValuedAtLowerOfListingAndPoolPrice() public {
        uint256 yes = _listedWithUnlockedTreasury();
        uint256 capacity = governor.quoteValue(yes) * V.SPEND_CAP_BPS / 10_000;
        assertGt(capacity, 0);
        // Business income paid into the treasury: enough that the value cap, not the balance, binds.
        quote.mint(treasury, capacity * 2);
        vm.prank(builder);
        uint256 id = governor.proposeSpend(recipient, capacity * 9 / 10, 0, "ipfs://usdg");
        _voteAllBackers(id, true);
        GovernanceV31.Proposal memory p = governor.getProposal(id);
        vm.warp(p.votingEnds);
        governor.finalize(id);
        assertEq(uint256(governor.getProposal(id).status), uint256(GovernanceV31.Status.Passed));
        // A pumped pool never enlarges the cap; a fallen price shrinks it and blocks execution.
        bytes32 pool = raise.listingRecord().poolId;
        uint160 listing = raise.listingRecord().sqrtPriceX96;
        bool tokenFirst = address(token) < address(quote);
        adapter.setSpotPrice(pool, tokenFirst ? listing * 2 : listing / 2);
        assertEq(governor.quoteValue(yes), _valueAt(yes, listing, tokenFirst));
        adapter.setSpotPrice(pool, tokenFirst ? listing / 2 : listing * 2);
        vm.warp(p.disputeEnds);
        vm.expectRevert(V.InvalidAmount.selector);
        governor.execute(id);
    }

    function test_stage3_buildersAndCustodyCannotVote_andSnapshotIgnoresLaterTransfers() public {
        _listedWithUnlockedTreasury();
        vm.prank(builder);
        uint256 id = governor.proposeSpend(recipient, 0, 1e18, "ipfs://snapshot");
        vm.roll(block.number + 1);
        vm.prank(builder);
        vm.expectRevert(V.Unauthorized.selector);
        governor.voteWithTokens(id, true);
        assertFalse(governor.canVoteWithTokens(treasury));
        // Tokens moved after the snapshot vote nowhere new: the sender keeps its snapshot weight.
        uint256 weight = token.balanceOf(backers[9]);
        address fresh = address(0xF4E5);
        vm.prank(backers[9]);
        token.transfer(fresh, weight / 2);
        assertEq(governor.votingPower(id, fresh), 0);
        assertEq(governor.votingPower(id, backers[9]), weight);
        vm.prank(fresh);
        vm.expectRevert(V.InvalidPosition.selector);
        governor.voteWithTokens(id, true);
        vm.prank(backers[9]);
        governor.voteWithTokens(id, true);
        assertEq(governor.getProposal(id).yesWeight, weight);
    }

    function test_stage3_lockedAllocationCannotBeProposed() public {
        _create(false);
        _fund();
        _open();
        _list();
        vm.warp(block.timestamp + 30 days);
        uint256 spendable = treasuryVault.spendableTokensAt(block.timestamp + 10 days);
        vm.prank(builder);
        vm.expectRevert(V.InvalidAmount.selector);
        governor.proposeSpend(recipient, 0, spendable + 1e24, "ipfs://locked");
    }

    // ---------------------------------------------------------------- helpers

    function _twoLaunches() internal returns (RaiseCore from, RaiseCore to) {
        _create(false);
        from = raise;
        _create(false);
        to = raise;
    }

    function _depositInto(RaiseCore target, address actor, uint256 amount)
        internal
        returns (uint256 id, uint256 tokens)
    {
        quote.mint(actor, amount);
        vm.prank(actor);
        quote.approve(address(target), type(uint256).max);
        uint256 nonce = target.stateNonce();
        vm.prank(actor);
        return target.deposit(amount, 1, nonce, block.timestamp);
    }

    /// Lists a funded escrow launch with Stage 2 fees in the treasury and one year of allocation unlocked; returns
    /// the backers' combined voting tokens.
    function _listedWithUnlockedTreasury() internal returns (uint256 yes) {
        _create(false);
        _fund();
        _open();
        _buy(buyer, 60_000e6);
        _list();
        raise.claimTreasuryFees();
        vm.warp(block.timestamp + 365 days);
        for (uint256 i; i < 10; ++i) {
            yes += token.balanceOf(backers[i]);
        }
    }

    function _voteAllBackers(uint256 id, bool support) internal {
        // The snapshot measures the end of the proposal's block; votes start in the next block.
        vm.roll(block.number + 1);
        for (uint256 i; i < 10; ++i) {
            if (governor.votingPower(id, backers[i]) == 0) continue;
            vm.prank(backers[i]);
            governor.voteWithTokens(id, support);
        }
    }

    function _valueAt(uint256 tokens, uint160 sqrtPriceX96, bool tokenFirst) internal pure returns (uint256) {
        uint256 q96 = 2 ** 96;
        if (tokenFirst) return tokens * sqrtPriceX96 / q96 * sqrtPriceX96 / q96;
        return tokens * q96 / sqrtPriceX96 * q96 / sqrtPriceX96;
    }

    // N-H1: tokens held only inside the proposal's block (a flash loan) carry no voting weight.
    function test_stage3_flashBorrowedTokensInTheProposalBlockDoNotVote() public {
        _listedWithUnlockedTreasury();
        address helper = address(0xF1A5);
        uint256 weight = token.balanceOf(backers[9]);
        vm.prank(backers[9]);
        token.transfer(helper, weight);
        vm.prank(builder);
        uint256 id = governor.proposeSpend(recipient, 0, 1e18, "ipfs://flash");
        // Still the proposal block: nothing can vote yet, and the "loan" is repaid.
        assertEq(governor.votingPower(id, helper), 0);
        vm.prank(helper);
        token.transfer(backers[9], weight);
        vm.roll(block.number + 1);
        assertEq(governor.votingPower(id, helper), 0);
        vm.prank(helper);
        vm.expectRevert(V.InvalidPosition.selector);
        governor.voteWithTokens(id, true);
        // The holder at the end of the block votes with its full balance, even after moving tokens later.
        vm.prank(backers[9]);
        token.transfer(helper, weight);
        assertEq(governor.votingPower(id, backers[9]), weight);
        assertEq(governor.votingPower(id, helper), 0);
    }

    // N-M2: a momentary price dip at finalize cannot defeat a spend; the value cap is checked at execution.
    function test_stage3_priceDipAtFinalizeIsNotTerminal() public {
        uint256 yes = _listedWithUnlockedTreasury();
        uint256 capacity = governor.quoteValue(yes) * V.SPEND_CAP_BPS / 10_000;
        quote.mint(treasury, capacity * 2);
        vm.prank(builder);
        uint256 id = governor.proposeSpend(recipient, capacity * 9 / 10, 0, "ipfs://dip");
        _voteAllBackers(id, true);
        GovernanceV31.Proposal memory p = governor.getProposal(id);
        bytes32 pool = raise.listingRecord().poolId;
        uint160 listing = raise.listingRecord().sqrtPriceX96;
        bool tokenFirst = address(token) < address(quote);
        vm.warp(p.votingEnds);
        adapter.setSpotPrice(pool, tokenFirst ? listing / 10 : listing * 10);
        governor.finalize(id);
        assertEq(uint256(governor.getProposal(id).status), uint256(GovernanceV31.Status.Passed));
        vm.warp(p.disputeEnds);
        vm.expectRevert(V.InvalidAmount.selector);
        governor.execute(id);
        adapter.setSpotPrice(pool, listing);
        governor.execute(id);
        assertEq(quote.balanceOf(recipient), capacity * 9 / 10);
    }
}
