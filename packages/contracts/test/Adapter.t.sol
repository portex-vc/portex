// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.sol";
import {Raise} from "../src/Raise.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {MockDexAdapter} from "../src/mocks/MockDexAdapter.sol";

/// @dev Stand-in project token for adapter unit tests: exposes the canonical `pool()` the
///      adapter consults before seeding (real ProjectToken records it via `setPool`).
contract MockPairToken is MockUSDG {
    address public pool;

    function setPool(address pool_) external {
        pool = pool_;
    }
}

/// @notice MockDexAdapter: constant-product pair per (token, quote), seeded only by the token's
///         canonical Stage2Pool, LP locked forever, public swap. Unit tests use a MockPairToken
///         with `pool = alice` (the adapter is unit-agnostic).
contract AdapterTest is BaseTest {
    MockPairToken internal tok;

    function setUp() public override {
        super.setUp();
        tok = new MockPairToken();
        tok.setPool(alice); // alice acts as the token's canonical pool in the unit tests
        tok.mint(alice, 10_000e6);
        usdg.mint(alice, 10_000e6);
    }

    function _seed() internal {
        vm.startPrank(alice);
        usdg.approve(address(adapter), 10_000e6);
        tok.approve(address(adapter), 10_000e6);
        adapter.seedLiquidity(address(usdg), address(tok), 10_000e6, 10_000e6);
        vm.stopPrank();
    }

    /// @notice Audit M-03 residual: only the token's canonical pool may seed — a stranger can
    ///         neither create the pair nor add to an existing one.
    function test_revert_seedLiquidity_notCanonicalPool() public {
        vm.startPrank(bob);
        usdg.approve(address(adapter), 1e6);
        tok.approve(address(adapter), 1e6);
        vm.expectRevert(MockDexAdapter.OnlyCanonicalPool.selector);
        adapter.seedLiquidity(address(usdg), address(tok), 1e6, 1e6);
        vm.stopPrank();
        assertFalse(adapter.pairExists(address(tok)));

        _seed(); // alice is the canonical pool
        vm.expectRevert(MockDexAdapter.OnlyCanonicalPool.selector);
        vm.prank(bob);
        adapter.seedLiquidity(address(usdg), address(tok), 1e6, 1e6);
    }

    /// @notice A same-quote re-seed by the canonical pool ADDS both amounts in full at the
    ///         caller's implied price (unbalanced add).
    function test_seedLiquidity_addsToExistingPair() public {
        _seed();
        tok.mint(alice, 2_500e6); // _seed drained alice's initial 10k
        vm.startPrank(alice);
        usdg.approve(address(adapter), 5_000e6);
        tok.approve(address(adapter), 2_500e6);
        adapter.seedLiquidity(address(usdg), address(tok), 5_000e6, 2_500e6);
        vm.stopPrank();
        (uint256 q, uint256 t) = adapter.getReserves(address(tok));
        assertEq(q, 15_000e6); // both sides pulled in full
        assertEq(t, 12_500e6);
        assertEq(adapter.quoteOf(address(tok)), address(usdg));
        assertTrue(adapter.pairExists(address(tok)));
    }

    /// @notice One quote asset per token: even the canonical pool cannot re-bind the pair to a
    ///         different quote asset.
    function test_revert_seedExistingPairDifferentQuote() public {
        _seed();
        MockUSDG otherQuote = new MockUSDG();
        otherQuote.mint(alice, 1e6);
        vm.startPrank(alice);
        otherQuote.approve(address(adapter), 1e6);
        tok.approve(address(adapter), 1e6);
        vm.expectRevert(MockDexAdapter.PairExists.selector);
        adapter.seedLiquidity(address(otherQuote), address(tok), 1e6, 1e6);
        vm.stopPrank();
    }

    /// @notice Audit M-03 residual: (a) a stranger pre-creating a pair — even with a different
    ///         quote — reverts and so cannot affect `graduate()`; (b) the migration pair holds
    ///         exactly the graduate seed, so its price equals the pool's book price (no mixing).
    function test_strangerPreSeed_reverts_andGraduateSeedsExactBookPrice() public {
        createRaise();
        toGrowth(); // T=400k, R=50k, V=350k

        // the attacker holds tokens and tries to pre-create the pair, same quote or foreign one
        uint256 attackerTokens = buyAs(whale, 10_000e6);
        assertGt(attackerTokens, 1e18);
        MockUSDG otherQuote = new MockUSDG();
        otherQuote.mint(whale, 100e6);
        vm.startPrank(whale);
        usdg.approve(address(adapter), 100e6);
        otherQuote.approve(address(adapter), 100e6);
        token.approve(address(adapter), 1e18);
        vm.expectRevert(MockDexAdapter.OnlyCanonicalPool.selector);
        adapter.seedLiquidity(address(usdg), address(token), 100e6, 1e18);
        vm.expectRevert(MockDexAdapter.OnlyCanonicalPool.selector);
        adapter.seedLiquidity(address(otherQuote), address(token), 100e6, 1e18);
        vm.stopPrank();
        assertFalse(adapter.pairExists(address(token)));

        // full commit + demand -> graduation gates met
        uint64 g0 = raise.growthStart();
        for (uint8 k = 2; k <= 4; ++k) {
            vm.warp(g0 + (k - 2) * 5 minutes);
            commitAs(alice, k);
            commitAs(bob, k);
            commitAs(carol, k);
        }
        buyAs(whale, 50_000e6);
        (uint256 rPre, uint256 vPre, uint256 tPre) = pool.reserves();
        uint256 bookBefore = pool.bookPrice();
        vm.warp(g0 + 20 minutes);
        raise.graduate();
        assertEq(uint8(raise.state()), uint8(Raise.State.Migrated));

        // the pair holds exactly the graduate seed (the auditor's worked example:
        // ~259,640 USDG / ~196,737.588 tokens -> ~1.319727 USDG/token)
        (uint256 qRes, uint256 tRes) = adapter.getReserves(address(token));
        uint256 expectedTokens = (rPre * tPre) / (rPre + vPre); // T' = floor(R·T/Q)
        assertEq(qRes, rPre);
        assertEq(tRes, expectedTokens);
        assertEq(adapter.quoteOf(address(token)), address(usdg));
        assertApproxEqAbs(qRes, 259_640e6, 1e6);
        // migration price == the pre-migration book price (up to the T' floor dust)
        uint256 pairPrice = (qRes * 1e18) / tRes;
        assertApproxEqRel(pairPrice, bookBefore, 1e12);
        assertApproxEqAbs(pairPrice, 1_319_727, 100); // 1.319727 USDG/token ± 0.0001

        // the migration pair trades permissionlessly
        vm.startPrank(bob);
        usdg.approve(address(adapter), 1_000e6);
        uint256 out = adapter.swapExactQuoteForTokens(address(token), 1_000e6, 0, bob);
        assertGt(out, 0);
        vm.stopPrank();
    }

    function test_swapRoundTrip() public {
        _seed();
        // bob buys with 1k USDG
        vm.startPrank(bob);
        usdg.approve(address(adapter), 1000e6);
        uint256 out = adapter.swapExactQuoteForTokens(address(tok), 1000e6, 0, bob);
        assertGt(out, 0);
        assertLt(out, 1000e6); // slippage: out < in at equal reserves
        // sell back -> strictly less than 1k USDG (rounding favours the pair)
        tok.approve(address(adapter), out);
        uint256 back = adapter.swapExactTokensForQuote(address(tok), out, 0, bob);
        assertLt(back, 1000e6);
        vm.stopPrank();

        (uint256 q, uint256 t) = adapter.getReserves(address(tok));
        assertEq(q, 11_000e6 - back);
        assertEq(t, 10_000e6);
        // LP locked forever: reserves stay in the adapter, no removal function exists.
        assertEq(usdg.balanceOf(address(adapter)), q);
        assertEq(tok.balanceOf(address(adapter)), t);
    }

    function test_revert_swapMissingPair() public {
        vm.expectRevert(MockDexAdapter.PairMissing.selector);
        adapter.swapExactQuoteForTokens(address(tok), 1e6, 0, alice);
        vm.expectRevert(MockDexAdapter.PairMissing.selector);
        adapter.swapExactTokensForQuote(address(tok), 1e6, 0, alice);
    }

    function test_revert_seedZero() public {
        vm.expectRevert(MockDexAdapter.ZeroAmount.selector);
        vm.prank(alice);
        adapter.seedLiquidity(address(usdg), address(tok), 0, 1);
    }

    function test_revert_swapSlippage() public {
        _seed();
        vm.startPrank(bob);
        usdg.approve(address(adapter), 1000e6);
        vm.expectRevert(MockDexAdapter.Slippage.selector);
        adapter.swapExactQuoteForTokens(address(tok), 1000e6, 1000e6, bob);
        vm.stopPrank();
    }
}
