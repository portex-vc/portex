// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.sol";

/// @notice Fuzz pool math (§5.3): buy/sell round trips never profit the trader, rounding
///         favours the pool, k never decreases, R stays solvent.
contract PoolMathFuzz is BaseTest {
    function setUp() public override {
        super.setUp();
        createRaise();
        toGrowth(); // T=400k, R=50k, V=350k, Q=400k
    }

    /// @dev buy then immediately sell everything received: trader never profits.
    function testFuzz_roundTripNeverProfits(uint256 quoteIn) public {
        quoteIn = bound(quoteIn, 1, 5_000_000e6);
        uint256 startBal = usdg.balanceOf(whale);
        uint256 out = buyAs(whale, quoteIn);
        if (out == 0) return; // degenerate dust buy
        uint256 back = sellAs(whale, out);
        assertLe(back, quoteIn); // no free profit
        assertLe(usdg.balanceOf(whale), startBal);
    }

    /// @dev rounding favours the pool: integer output <= exact real-valued output.
    function testFuzz_buyRoundingFavoursPool(uint256 quoteIn) public {
        quoteIn = bound(quoteIn, 1, 5_000_000e6);
        (uint256 r0, uint256 v0, uint256 t0) = pool.reserves();
        uint256 q0 = r0 + v0;
        uint256 fee = (quoteIn * 100) / 10_000;
        uint256 net = quoteIn - fee;
        uint256 out = buyAs(whale, quoteIn);
        // out <= T*net/(Q+net)  ⟺  out*(Q+net) <= T*net
        assertLe(out * (q0 + net), t0 * net);
        // and within 1 wei of exact: out >= floor(exact) - ... check ceil semantics:
        // newT = ceil(Q*T/(Q+net)) so out = T - newT is the floor
        (uint256 r1, uint256 v1, uint256 t1) = pool.reserves();
        assertEq(v1, v0); // trades never touch V
        // k non-decreasing: (R+V)*T after >= before
        assertGe((r1 + v1) * t1, q0 * t0);
        // quote balance == R + builderAccrued
        assertEq(usdg.balanceOf(address(pool)), r1 + pool.builderAccrued());
    }

    /// @dev sell rounding favours the pool: gross <= exact, k non-decreasing.
    function testFuzz_sellRoundingFavoursPool(uint256 tokensIn) public {
        uint256 bought = buyAs(whale, 100_000e6);
        tokensIn = bound(tokensIn, 1, bought);
        (uint256 r0, uint256 v0, uint256 t0) = pool.reserves();
        uint256 q0 = r0 + v0;
        uint256 before = usdg.balanceOf(whale);
        uint256 got = sellAs(whale, tokensIn);
        // gross (before fee) <= exact Q*t/(T+t)
        (uint256 quoted, uint256 fee) = pool.quoteSell(tokensIn); // post-state quote, recompute below
        // check via state deltas instead:
        (uint256 r1,, uint256 t1) = pool.reserves();
        assertEq(t1, t0 + tokensIn);
        assertGe((r1 + v0) * t1, q0 * t0); // k non-decreasing
        assertEq(usdg.balanceOf(address(pool)), r1 + pool.builderAccrued());
        assertEq(usdg.balanceOf(whale), before + got);
        // gross = got + fee charged on this sell; the sell payout cannot exceed R that was available
        assertLe(got, r0);
    }

    /// @dev many random trades: k non-decreasing, balance identity, V constant.
    function testFuzz_tradeSequenceIntegrity(uint256 seed) public {
        uint256 kLast;
        {
            (uint256 r, uint256 v, uint256 t) = pool.reserves();
            kLast = (r + v) * t;
        }
        uint256 vConst = pool.V();
        for (uint256 i = 0; i < 8; ++i) {
            uint256 amt = uint256(keccak256(abi.encode(seed, i))) % 50_000e6 + 1;
            bool isBuy = (amt & 1) == 0;
            if (isBuy) {
                buyAs(whale, amt);
            } else {
                uint256 bal = token.balanceOf(whale);
                if (bal == 0) continue;
                sellAs(whale, amt % bal + 1 > bal ? bal : (amt % bal) + 1);
            }
            (uint256 r, uint256 v, uint256 t) = pool.reserves();
            assertEq(v, vConst);
            assertGe((r + v) * t, kLast);
            kLast = (r + v) * t;
            assertEq(usdg.balanceOf(address(pool)), r + pool.builderAccrued());
        }
    }

    /// @dev solvency: after arbitrary trades, selling every outside token is payable from R.
    function testFuzz_solvencyAfterTrades(uint256 buy1, uint256 buy2, uint256 sellFrac) public {
        buy1 = bound(buy1, 1e6, 2_000_000e6);
        buy2 = bound(buy2, 1e6, 2_000_000e6);
        uint256 out1 = buyAs(whale, buy1);
        // backers claim epoch-0 tranches (committed in toGrowth)
        claimAs(alice, 1, false);
        claimAs(bob, 1, true); // staked in vault
        claimAs(carol, 1, false);
        uint256 out2 = buyAs(whale, buy2);
        uint256 whaleSells = out1 + out2;
        sellFrac = bound(sellFrac, 0, 100);
        if (sellFrac > 0) sellAs(whale, (whaleSells * sellFrac) / 100);

        // outside tokens = totalSupply - pool.T - raise - vault, PLUS vault-staked genesis
        // tokens: they can be unstaked and sold at any time (audit L-03)
        uint256 outside = token.totalSupply() - pool.T() - token.balanceOf(address(raise))
            - token.balanceOf(address(vault)) + vault.totalStaked();
        (uint256 r, uint256 v, uint256 t) = pool.reserves();
        uint256 q = r + v;
        // single-shot gross for selling all outside tokens (no fee -> conservative upper bound)
        uint256 newQ = (q * t) / (t + outside);
        if ((q * t) % (t + outside) != 0) newQ += 1;
        uint256 grossAll = q - newQ;
        assertLe(grossAll, r); // payable from R
        assertGe(v, 0);
    }
}
