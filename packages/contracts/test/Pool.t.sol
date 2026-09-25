// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.sol";
import {Raise} from "../src/Raise.sol";
import {Stage2Pool} from "../src/Stage2Pool.sol";

/// @notice Stage2Pool (§5.3): open/convert/buy/sell math, fees, quotes, rounding, access.
contract PoolTest is BaseTest {
    function setUp() public override {
        super.setUp();
        createRaise();
    }

    // ---------------- access ----------------

    function test_revert_openOnlyRaise() public {
        vm.expectRevert(Stage2Pool.OnlyRaise.selector);
        pool.open(1, 1);
    }

    function test_revert_convertOnlyRaise() public {
        vm.expectRevert(Stage2Pool.OnlyRaise.selector);
        pool.convert(1);
    }

    function test_revert_graduateOnlyRaise() public {
        vm.expectRevert(Stage2Pool.OnlyRaise.selector);
        pool.graduate();
    }

    function test_revert_buyWhilePending() public {
        vm.expectRevert(Stage2Pool.InvalidPoolState.selector);
        pool.buy(1e6, 0);
    }

    function test_revert_sellWhilePending() public {
        vm.expectRevert(Stage2Pool.InvalidPoolState.selector);
        pool.sell(1e18, 0);
    }

    function test_revert_buyZero() public {
        toGrowth();
        vm.expectRevert(Stage2Pool.ZeroAmount.selector);
        pool.buy(0, 0);
    }

    function test_revert_convertExceedsVirtual() public {
        toGrowth(); // V = 350k after converting 50k
        vm.prank(address(raise));
        // raise escrow has enough quote, so spoof the raise and try to convert more than V
        vm.expectRevert(Stage2Pool.ConvertExceedsVirtual.selector);
        pool.convert(400_000e6);
    }

    // ---------------- buy ----------------

    function test_buy_mathAndFees() public {
        toGrowth();
        // state: T = 400k tokens, R = 50k, V = 350k, Q = 400k (b = 1 USDG/token)
        uint256 quoteIn = 100_000e6;
        (uint256 quoted, uint256 quotedFee) = pool.quoteBuy(quoteIn);
        assertEq(quotedFee, 1_000e6); // 100 bps
        uint256 out = buyAs(whale, quoteIn);
        assertEq(out, quoted); // quote matches execution
        assertEq(token.balanceOf(whale), out);

        // fee split: 40/30/30 of 1000 -> reserve 400, vault 300, builder 300
        assertEq(pool.builderAccrued(), 300e6);
        assertEq(usdg.balanceOf(address(vault)), 300e6);
        (uint256 r, uint256 v, uint256 t) = pool.reserves();
        assertEq(v, 350_000e6); // trades never touch V
        assertEq(r, 50_000e6 + 99_000e6 + 400e6);
        assertEq(t, 400_000e18 - out);
        assertEq(usdg.balanceOf(address(pool)), r + pool.builderAccrued());

        // exact constant-product: out = T - ceil(Q·T/(Q+net))
        uint256 q0 = 400_000e6;
        uint256 t0 = 400_000e18;
        uint256 netIn = 99_000e6;
        uint256 newT = (q0 * t0) / (q0 + netIn);
        if ((q0 * t0) % (q0 + netIn) != 0) newT += 1;
        assertEq(out, t0 - newT);
        // price moved up
        assertGt(pool.bookPrice(), 1e6);
    }

    function test_revert_buySlippage() public {
        toGrowth();
        (uint256 quoted,) = pool.quoteBuy(100_000e6);
        vm.startPrank(whale);
        usdg.approve(address(pool), 100_000e6);
        vm.expectRevert(Stage2Pool.Slippage.selector);
        pool.buy(100_000e6, quoted + 1);
        vm.stopPrank();
    }

    // ---------------- sell ----------------

    function test_sell_mathAndFees_roundtripLoses() public {
        toGrowth();
        uint256 out = buyAs(whale, 100_000e6);

        (uint256 quotedOut, uint256 quotedFee) = pool.quoteSell(out);
        uint256 before = usdg.balanceOf(whale);
        uint256 got = sellAs(whale, out);
        assertEq(got, quotedOut);
        assertEq(usdg.balanceOf(whale), before + got);
        // round trip: trader gets back strictly less than paid (fee + fee, rounding favours pool)
        assertLt(got, 100_000e6);
        assertGt(quotedFee, 0);

        (uint256 r, uint256 v, uint256 t) = pool.reserves();
        assertEq(t, 400_000e18); // all tokens back in the pool
        assertEq(v, 350_000e6);
        assertEq(usdg.balanceOf(address(pool)), r + pool.builderAccrued());
    }

    function test_revert_sellSlippage() public {
        toGrowth();
        uint256 out = buyAs(whale, 100_000e6);
        (uint256 quoted,) = pool.quoteSell(out);
        vm.startPrank(whale);
        token.approve(address(pool), out);
        vm.expectRevert(Stage2Pool.Slippage.selector);
        pool.sell(out, quoted + 1);
        vm.stopPrank();
    }

    function test_revert_sellZero() public {
        toGrowth();
        vm.expectRevert(Stage2Pool.ZeroAmount.selector);
        pool.sell(0, 0);
    }

    // ---------------- views ----------------

    function test_bookPriceAndRealRatio() public {
        toGrowth();
        assertEq(pool.bookPrice(), 1e6); // exactly the flat Stage 1 price b = 1 USDG/token
        assertEq(pool.realRatioBps(), 1250); // 50k / 400k
    }

    // ---------------- builder fees ----------------

    function test_claimBuilderFees() public {
        toGrowth();
        buyAs(whale, 100_000e6);
        uint256 accrued = pool.builderAccrued();
        assertEq(accrued, 300e6);
        uint256 before = usdg.balanceOf(builder);
        pool.claimBuilderFees(); // callable by anyone, pays the builder
        assertEq(usdg.balanceOf(builder) - before, accrued);
        assertEq(pool.builderAccrued(), 0);
        vm.expectRevert(Stage2Pool.NothingToClaim.selector);
        pool.claimBuilderFees();
    }

    // ---------------- rounding favours the pool ----------------

    function test_buy_roundingFavoursPool() public {
        toGrowth();
        // odd amount so Q·T/(Q+net) is not integral
        uint256 quoteIn = 12_345_679;
        uint256 out = buyAs(whale, quoteIn);
        // exact (real-valued) output would be T*net/(Q+net); integer out must be <= exact
        uint256 fee = (quoteIn * 100) / BPS;
        uint256 net = quoteIn - fee;
        // out * (Q + net) <= T * net  ⟺  out <= T*net/(Q+net)
        assertLe(out * (400_000e6 + net), 400_000e18 * net);
    }
}
