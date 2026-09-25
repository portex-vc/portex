// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ProtectedSplitLib} from "../src/libraries/ProtectedSplitLib.sol";

/// @notice Unit (§4), fuzz (§8) and differential tests for `ProtectedSplitLib`
///         (`docs/PROTECTED_SPLIT.md`).
contract ProtectedSplitLibTest is Test {
    uint256 internal constant SCALE = 1e18;

    function _book(uint256 R, uint256 V, uint256 T, uint256 O, uint256 E)
        internal
        pure
        returns (ProtectedSplitLib.Book memory)
    {
        return ProtectedSplitLib.Book({R: R, V: V, T: T, O: O, E: E});
    }

    function _pos(uint256 basis, uint256 tokens) internal pure returns (ProtectedSplitLib.Position memory) {
        return ProtectedSplitLib.Position({basis: basis, tokens: tokens});
    }

    // ------------------------------------------------------------------ §4 units

    /// @dev §4: R == 0 ⇒ cap = 0 ⇒ π = 0 ⇒ q_sold = 0: at-cost exit with full burn.
    function test_R0_atCostFullBurn() public pure {
        (
            ProtectedSplitLib.Result memory r,
            ProtectedSplitLib.Book memory bAfter,
            ProtectedSplitLib.Position memory pAfter
        ) = ProtectedSplitLib.quote(_book(0, 100, 50, 0, 100), _pos(40, 10), 4, SCALE);
        assertEq(r.cost, 16); // floor(40·4/10)
        assertEq(r.profit, 0);
        assertEq(r.qSold, 0);
        assertEq(r.burn, 4); // full burn
        assertEq(r.payout, r.cost);
        assertEq(pAfter.basis, 24);
        assertEq(pAfter.tokens, 6);
        assertEq(bAfter.E, 84);
    }

    /// @dev §3 step 2 remainder rule + §4 last position: q == tokens ⇒ cost == basis, E → 0.
    function test_fullExitLastPosition_remainderRule() public pure {
        (
            ProtectedSplitLib.Result memory r,
            ProtectedSplitLib.Book memory bAfter,
            ProtectedSplitLib.Position memory pAfter
        ) = ProtectedSplitLib.quote(_book(50, 100, 200, 0, 100), _pos(100, 40), 40, SCALE);
        assertEq(r.cost, 100); // == basis, remainder rule
        assertEq(pAfter.basis, 0);
        assertEq(pAfter.tokens, 0);
        // E reaches 0; under the V = E policy the shrink takes V to 0 as well (§4).
        assertEq(bAfter.E, 0);
        assertEq(bAfter.V, 0);
    }

    /// @dev λ(t) == 0 ⇒ π = 0: at-cost exit even when a premium exists.
    function test_lambda0_atCostExit() public pure {
        (ProtectedSplitLib.Result memory r,,) =
            ProtectedSplitLib.quote(_book(500, 100, 100, 0, 50), _pos(50, 100), 100, SCALE);
        assertGt(r.premium, 0); // curve is above cost…
        (ProtectedSplitLib.Result memory r0,,) =
            ProtectedSplitLib.quote(_book(500, 100, 100, 0, 50), _pos(50, 100), 100, 0);
        assertEq(r0.premium, r.premium);
        assertEq(r0.profit, 0); // …but λ keeps it at cost
        assertEq(r0.qSold, 0);
        assertEq(r0.burn, 100);
        assertEq(r0.payout, r0.cost);
    }

    /// @dev §4: q_sold ≥ 1 but tiny is allowed; T grows by q_sold.
    function test_tinyQSoldAccepted() public pure {
        (ProtectedSplitLib.Result memory r, ProtectedSplitLib.Book memory bAfter,) =
            ProtectedSplitLib.quote(_book(1000, 100, 1, 0, 100), _pos(100, 100), 1, SCALE);
        assertGe(r.qSold, 1);
        assertLe(r.qSold, 1); // ceil(548·1/551) == 1
        assertEq(r.qSold, 1);
        assertEq(bAfter.T, 1 + r.qSold);
    }

    // ---------------------------------------------------------------- reverts

    function test_revert_qZero() public {
        vm.expectRevert(ProtectedSplitLib.ZeroQuantity.selector);
        this.quoteExternal(_book(1, 1, 1, 0, 1), _pos(1, 1), 0, SCALE);
    }

    function test_revert_qExceedsTokens() public {
        vm.expectRevert(ProtectedSplitLib.ExceedsPositionTokens.selector);
        this.quoteExternal(_book(1, 1, 1, 0, 1), _pos(1, 1), 2, SCALE);
    }

    function test_revert_TZero() public {
        vm.expectRevert(ProtectedSplitLib.ZeroInventory.selector);
        this.quoteExternal(_book(1, 1, 0, 0, 1), _pos(1, 1), 1, SCALE);
    }

    function test_revert_lambdaOutOfRange() public {
        vm.expectRevert(abi.encodeWithSelector(ProtectedSplitLib.LambdaOutOfRange.selector, SCALE + 1));
        this.quoteExternal(_book(1, 1, 1, 0, 1), _pos(1, 1), 1, SCALE + 1);
    }

    /// @dev §3 step 4 requires V ≥ cost (cost ≤ Q so the burn check passes first).
    function test_revert_VLessThanCost() public {
        vm.expectRevert(abi.encodeWithSelector(ProtectedSplitLib.InsufficientVirtualQuote.selector, 8, 5));
        this.quoteExternal(_book(10, 5, 1000, 0, 100), _pos(8, 10), 10, SCALE);
    }

    /// @dev §4: shrink burn b > T (cost > Q makes floor(cost·T/Q) exceed T).
    function test_revert_shrinkBurnExceedsT() public {
        // cost = 20 > Q = 5 ⇒ b = floor(20·10/5) = 40 > T = 10
        vm.expectRevert(abi.encodeWithSelector(ProtectedSplitLib.ShrinkBurnExceedsInventory.selector, 40, 10));
        this.quoteExternal(_book(0, 5, 10, 0, 100), _pos(20, 20), 20, SCALE);
    }

    /// @dev §3 step 7 precondition R·T' ≥ V'·O.
    function test_revert_insufficientSolvency() public {
        // after shrink: R·T' = 1·1 = 1 < V'·O = 8·100
        vm.expectRevert(ProtectedSplitLib.InsufficientSolvency.selector);
        this.quoteExternal(_book(1, 10, 1, 100, 10), _pos(5, 10), 5, SCALE);
    }

    /// @dev External trampoline so `expectRevert` can catch internal-library reverts.
    function quoteExternal(
        ProtectedSplitLib.Book memory book,
        ProtectedSplitLib.Position memory pos,
        uint256 q,
        uint256 lambdaT
    )
        external
        pure
        returns (ProtectedSplitLib.Result memory, ProtectedSplitLib.Book memory, ProtectedSplitLib.Position memory)
    {
        return ProtectedSplitLib.quote(book, pos, q, lambdaT);
    }

    function test_lambdaLinear() public pure {
        assertEq(ProtectedSplitLib.lambdaLinear(0, 10), 0);
        assertEq(ProtectedSplitLib.lambdaLinear(5, 10), SCALE / 2);
        assertEq(ProtectedSplitLib.lambdaLinear(10, 10), SCALE);
        assertEq(ProtectedSplitLib.lambdaLinear(11, 10), SCALE);
        assertEq(ProtectedSplitLib.lambdaLinear(7, 0), SCALE);
        assertEq(ProtectedSplitLib.lambdaLinear(3, 7), (3 * SCALE) / 7); // floor
    }

    function test_gas_quote() public {
        ProtectedSplitLib.Book memory book = _book(500e6, 350e6, 400e18, 10e18, 200e6);
        ProtectedSplitLib.Position memory pos = _pos(100e6, 50e18);
        uint256 g0 = gasleft();
        ProtectedSplitLib.quote(book, pos, 10e18, SCALE / 2);
        emit log_named_uint("quote gas", g0 - gasleft());
    }

    // ------------------------------------------------------------------- fuzz

    /// @dev §8 invariants after every call, with bounded books (R·T ≥ V·O, V ≥ E ≥ basis).
    function testFuzz_invariants(
        uint256 sTokens,
        uint256 sBasis,
        uint256 sE,
        uint256 sV,
        uint256 sT,
        uint256 sR,
        uint256 sQ,
        uint256 sO,
        uint256 sLam
    ) public pure {
        uint256 tokens = bound(sTokens, 1, 1e30);
        uint256 q = bound(sQ, 1, tokens);
        ProtectedSplitLib.Position memory pos = _pos(bound(sBasis, 0, 1e30), tokens);
        ProtectedSplitLib.Book memory book;
        {
            uint256 E = bound(sE, pos.basis, 1e30);
            uint256 V = bound(sV, E, 1e30);
            uint256 T = bound(sT, 1, 1e30);
            uint256 R = bound(sR, 0, 1e30);
            uint256 O;
            if (R == 0) O = 0; // so the step-7 precondition can hold (V'·O == 0)
            else if (V == 0) O = bound(sO, 0, 1e30);
            else O = bound(sO, 0, (R * T) / V); // I1: R·T ≥ V·O
            book = _book(R, V, T, O, E);
        }
        (
            ProtectedSplitLib.Result memory r,
            ProtectedSplitLib.Book memory bAfter,
            ProtectedSplitLib.Position memory pAfter
        ) = ProtectedSplitLib.quote(book, pos, q, bound(sLam, 0, SCALE));
        _assertInvariants(book, pos, q, r, bAfter, pAfter);
    }

    /// @dev The §8 invariant battery (split out to keep the frame small; via_ir is off).
    function _assertInvariants(
        ProtectedSplitLib.Book memory book,
        ProtectedSplitLib.Position memory pos,
        uint256 q,
        ProtectedSplitLib.Result memory r,
        ProtectedSplitLib.Book memory bAfter,
        ProtectedSplitLib.Position memory pAfter
    ) internal pure {
        // §8: payout ≥ cost and the payout split
        assertEq(r.payout, r.cost + r.profit);
        assertGe(r.payout, r.cost);
        assertLe(r.profit, r.premium);
        assertLe(r.profit, book.R);
        // §8: the pool receives exactly the tokens π buys; the rest burn
        assertLe(r.qSold, q);
        assertEq(r.burn, q - r.qSold);
        // book deltas (§3 steps 4, 11)
        assertEq(bAfter.E, book.E - r.cost);
        assertEq(bAfter.V, book.V - r.cost);
        assertEq(bAfter.R, book.R - r.profit);
        assertEq(bAfter.O, book.O);
        assertEq(pAfter.basis, pos.basis - r.cost);
        assertEq(pAfter.tokens, pos.tokens - q);
        assertLe(r.cost, pos.basis);
        // T' == T − b + qSold (step 4 burn then step 11 receipt)
        uint256 b = r.cost == 0 ? 0 : Math.mulDiv(r.cost, book.T, book.R + book.V, Math.Rounding.Floor);
        assertEq(bAfter.T, book.T - b + r.qSold);
        // §8: step 4 never raises the price, i.e. (R+V')/T' ≤ (R+V)/T ⟺ (R+V')·T ≤ (R+V)·(T−b)
        assertLe((book.R + bAfter.V) * book.T, (book.R + book.V) * (bAfter.T - r.qSold));
        // §8: R·T ≥ V·O still holds after the full split
        assertGe(bAfter.R * bAfter.T, bAfter.V * book.O);
    }

    // -------------------------------------------------------------- differential

    /// @dev Field-by-field comparison against `research/sim-two-curves/gen-fixtures.ts`.
    function test_differentialFixtures() public view {
        string memory json = vm.readFile("./test/fixtures/protected-split.json");
        uint256 n = vm.parseJsonUint(json, ".n");
        assertEq(n, 200);
        for (uint256 i = 0; i < n; ++i) {
            string memory base = string.concat(".cases[", vm.toString(i), "]");
            ProtectedSplitLib.Book memory book = _book(
                vm.parseJsonUint(json, string.concat(base, ".in.R")),
                vm.parseJsonUint(json, string.concat(base, ".in.V")),
                vm.parseJsonUint(json, string.concat(base, ".in.T")),
                vm.parseJsonUint(json, string.concat(base, ".in.O")),
                vm.parseJsonUint(json, string.concat(base, ".in.E"))
            );
            ProtectedSplitLib.Position memory pos = _pos(
                vm.parseJsonUint(json, string.concat(base, ".in.basis")),
                vm.parseJsonUint(json, string.concat(base, ".in.tokens"))
            );
            uint256 q = vm.parseJsonUint(json, string.concat(base, ".in.q"));
            uint256 lambdaT = vm.parseJsonUint(json, string.concat(base, ".in.lambdaT"));

            (
                ProtectedSplitLib.Result memory r,
                ProtectedSplitLib.Book memory bAfter,
                ProtectedSplitLib.Position memory pAfter
            ) = ProtectedSplitLib.quote(book, pos, q, lambdaT);

            string memory tag = string.concat("case ", vm.toString(i));
            assertEq(r.cost, vm.parseJsonUint(json, string.concat(base, ".expected.cost")), string.concat(tag, " cost"));
            assertEq(
                r.value, vm.parseJsonUint(json, string.concat(base, ".expected.value")), string.concat(tag, " value")
            );
            assertEq(
                r.premium,
                vm.parseJsonUint(json, string.concat(base, ".expected.premium")),
                string.concat(tag, " premium")
            );
            assertEq(r.cap, vm.parseJsonUint(json, string.concat(base, ".expected.cap")), string.concat(tag, " cap"));
            assertEq(
                r.profit, vm.parseJsonUint(json, string.concat(base, ".expected.profit")), string.concat(tag, " profit")
            );
            assertEq(
                r.qSold, vm.parseJsonUint(json, string.concat(base, ".expected.qSold")), string.concat(tag, " qSold")
            );
            assertEq(r.burn, vm.parseJsonUint(json, string.concat(base, ".expected.burn")), string.concat(tag, " burn"));
            assertEq(
                r.payout, vm.parseJsonUint(json, string.concat(base, ".expected.payout")), string.concat(tag, " payout")
            );

            assertEq(
                bAfter.R,
                vm.parseJsonUint(json, string.concat(base, ".bookAfter.R")),
                string.concat(tag, " bookAfter.R")
            );
            assertEq(
                bAfter.V,
                vm.parseJsonUint(json, string.concat(base, ".bookAfter.V")),
                string.concat(tag, " bookAfter.V")
            );
            assertEq(
                bAfter.T,
                vm.parseJsonUint(json, string.concat(base, ".bookAfter.T")),
                string.concat(tag, " bookAfter.T")
            );
            assertEq(
                bAfter.O,
                vm.parseJsonUint(json, string.concat(base, ".bookAfter.O")),
                string.concat(tag, " bookAfter.O")
            );
            assertEq(
                bAfter.E,
                vm.parseJsonUint(json, string.concat(base, ".bookAfter.E")),
                string.concat(tag, " bookAfter.E")
            );

            assertEq(
                pAfter.basis,
                vm.parseJsonUint(json, string.concat(base, ".posAfter.basis")),
                string.concat(tag, " posAfter.basis")
            );
            assertEq(
                pAfter.tokens,
                vm.parseJsonUint(json, string.concat(base, ".posAfter.tokens")),
                string.concat(tag, " posAfter.tokens")
            );
        }
    }
}
