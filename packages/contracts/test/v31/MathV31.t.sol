// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TypesV31 as V} from "../../src/v31/TypesV31.sol";
import {CurveV31 as Curve} from "../../src/v31/CurveV31.sol";
import {ReserveMarket as Market} from "../../src/v31/ReserveMarket.sol";
import {ListingMathV31 as LP} from "../../src/v31/ListingMathV31.sol";
import {ProtectedSplitLib as PS} from "../../src/libraries/ProtectedSplitLib.sol";

contract MathV31Test is Test {
    function test_curveFullSale_exactRationalKappa() public pure {
        assertEq(Curve.cost(1e17, 200000e18, 0, 200000e18), 16_666_666667);
        assertEq(Curve.price(10, 100, 0), 6);
        assertEq(Curve.price(10, 100, 100), 10);
        // Target not divisible by three: rounding p_start first would undercharge.
        assertEq(Curve.cost(10, 1e30, 0, 1e30), 9);
    }

    function testFuzz_curveMaximalAffordable(
        uint256 seedSupply,
        uint256 seedPrice,
        uint256 seedSold,
        uint256 seedDeposit
    ) public pure {
        uint256 allocation = bound(seedSupply, 1e18, 2e29);
        uint256 price = bound(seedPrice, 1, 1e36);
        uint256 sold = bound(seedSold, 0, allocation - 1);
        uint256 full = Curve.cost(price, allocation, sold, allocation - sold);
        uint256 deposit = bound(seedDeposit, 0, full);
        (uint256 q, uint256 debit) = Curve.purchase(price, allocation, sold, deposit);
        assertLe(debit, deposit);
        assertLe(sold + q, allocation);
        if (q < allocation - sold) assertGt(Curve.cost(price, allocation, sold, q + 1), deposit);
        assertEq(debit, Curve.cost(price, allocation, sold, q));
    }

    function testFuzz_curveCeilingInequality(uint256 sx, uint256 sq, uint256 sp) public pure {
        uint256 allocation = 200000e18;
        uint256 sold = bound(sx, 0, allocation - 1);
        uint256 q = bound(sq, 1, allocation - sold);
        uint256 price = bound(sp, 1, 1e25);
        uint256 area = q * (4 * allocation + 2 * sold + q);
        uint256 denominator = 6 * allocation * 1e30;
        uint256 floor = Math.mulDiv(price, area, denominator);
        uint256 remainder = mulmod(price, area, denominator);
        assertEq(Curve.cost(price, allocation, sold, q), floor + (remainder == 0 ? 0 : 1));
    }

    function testFuzz_feeSplitAllRemainders(uint256 gross) public pure {
        V.Fees memory f = Market.split(gross);
        assertEq(f.total, gross / 100);
        assertEq(f.reserve + f.reward + f.treasury, f.total);
        assertEq(f.reserve, Math.mulDiv(f.total, 40, 100));
        assertEq(f.reward, Math.mulDiv(f.total, 30, 100));
        assertGe(f.treasury, Math.mulDiv(f.total, 30, 100));
        assertLe(f.treasury - Math.mulDiv(f.total, 30, 100), 2);
    }

    function testFuzz_shrinkNeverRaisesPrice(uint256 se, uint256 sr, uint256 st, uint256 sc) public pure {
        uint256 e = bound(se, 1, 1e30);
        uint256 r = bound(sr, 0, 1e30);
        uint256 t = bound(st, 1, 1e30);
        uint256 cost = bound(sc, 0, e);
        uint256 qBefore = r + 2 * e;
        (PS.Book memory afterBook, uint256 burn) = Market.shrink(PS.Book(r, 2 * e, t, 0, e), cost);
        assertLe(burn * qBefore, cost * t);
        assertLt(cost * t, (burn + 1) * qBefore);
        assertLe((afterBook.R + afterBook.V) * t, qBefore * afterBook.T);
        assertEq(afterBook.V - afterBook.E, e);
    }

    function testFuzz_decayMonotoneAndNoOp(uint256 seedTime, uint256 seedE, uint256 seedT) public pure {
        uint256 e = bound(seedE, 1, 1e30);
        uint256 t = bound(seedTime, 0, 1e18);
        uint256 inventory = bound(seedT, 1, 1e30);
        (PS.Book memory b, uint256 burn, uint256 last) = Market.decay(PS.Book(0, 2 * e, inventory, 0, e), e, 0, t);
        assertEq(b.V - e, Math.mulDiv(e, V.SCALE - t, V.SCALE));
        assertLe(b.V * inventory, 2 * e * b.T);
        assertEq(b.T + burn, inventory);
        (PS.Book memory same, uint256 noBurn, uint256 sameLast) = Market.decay(b, e, last, t);
        assertEq(noBurn, 0);
        assertEq(sameLast, last);
        assertEq(keccak256(abi.encode(b)), keccak256(abi.encode(same)));
    }

    function test_zeroInventoryProtectedFallback_noMarketDivision() public pure {
        (PS.Result memory r, PS.Book memory b, uint256 burn) =
            Market.protectedQuote(PS.Book(0, 100, 0, 0, 100), PS.Position(100, 50), 50, 1e18);
        assertEq(r.payout, 100);
        assertEq(r.burn, 50);
        assertEq(r.qSold, 0);
        assertEq(b.E, 0);
        assertEq(b.V, 0);
        assertEq(burn, 0);
    }

    function test_zeroReserveAndLambdaEndpoints() public pure {
        (PS.Result memory r,,) = Market.protectedQuote(PS.Book(0, 100, 100, 0, 50), PS.Position(50, 100), 100, 1e18);
        assertEq(r.profit, 0);
        assertEq(r.qSold, 0);
        (r,,) = Market.protectedQuote(PS.Book(500, 100, 100, 0, 50), PS.Position(50, 100), 100, 0);
        assertGt(r.premium, 0);
        assertEq(r.profit, 0);
        (r,,) = Market.protectedQuote(PS.Book(500, 100, 100, 0, 50), PS.Position(50, 100), 100, 1e18);
        assertGt(r.profit, 0);
        assertLe(r.qSold, 100);
    }

    function test_sqrtFullWidth_bothOrderings_exactFloor() public pure {
        for (uint256 i; i < 2; ++i) {
            bool tokenFirst = i == 0;
            uint256 p = 1;
            uint160 sqrt = LP.sqrtPrice(p, tokenFirst);
            (uint256 n, uint256 d) = tokenFirst ? (p, uint256(1e30)) : (uint256(1e30), p);
            assertTrue(LP.squareLe(sqrt, n, d));
            assertFalse(LP.squareLe(uint256(sqrt) + 1, n, d));
            if (!tokenFirst) assertGt(sqrt, type(uint128).max);
        }
    }

    function testFuzz_sqrtFloor(uint256 priceSeed, bool tokenFirst) public pure {
        uint256 p = bound(priceSeed, 1, 1e66);
        uint160 sqrt = LP.sqrtPrice(p, tokenFirst);
        (uint256 n, uint256 d) = tokenFirst ? (p, uint256(1e30)) : (uint256(1e30), p);
        assertTrue(LP.squareLe(sqrt, n, d));
        assertFalse(LP.squareLe(uint256(sqrt) + 1, n, d));
        assertGt(sqrt, LP.LOWER);
        assertLt(sqrt, LP.UPPER);
    }

    function test_liquidityLargestIntegerAndTickCap() public pure {
        uint160 s = LP.sqrtPrice(1e30, true);
        (uint128 liquidity, uint256 a0, uint256 a1) = LP.liquidityFor(s, 1e24, 1e24);
        assertLe(a0, 1e24);
        assertLe(a1, 1e24);
        (uint256 next0, uint256 next1) = LP.amounts(s, liquidity + 1);
        assertTrue(next0 > 1e24 || next1 > 1e24);
        (liquidity,,) = LP.liquidityFor(s, 1e60, 1e60);
        assertEq(liquidity, type(uint128).max / 8873);
    }

    function test_differentialExistingProtectedSplitFixtures() public view {
        string memory json = vm.readFile("./test/fixtures/protected-split.json");
        uint256 count = vm.parseJsonUint(json, ".n");
        assertEq(count, 200);
        for (uint256 i; i < count; ++i) {
            string memory path = string.concat(".cases[", vm.toString(i), "]");
            PS.Book memory b = PS.Book(
                _read(json, path, ".in.R"),
                _read(json, path, ".in.V"),
                _read(json, path, ".in.T"),
                _read(json, path, ".in.O"),
                _read(json, path, ".in.E")
            );
            PS.Position memory p = PS.Position(_read(json, path, ".in.basis"), _read(json, path, ".in.tokens"));
            (PS.Result memory r, PS.Book memory afterBook,) =
                Market.protectedQuote(b, p, _read(json, path, ".in.q"), _read(json, path, ".in.lambdaT"));
            assertEq(r.cost, _read(json, path, ".expected.cost"));
            assertEq(r.payout, _read(json, path, ".expected.payout"));
            assertEq(r.profit, _read(json, path, ".expected.profit"));
            assertEq(r.qSold, _read(json, path, ".expected.qSold"));
            assertEq(r.cap, _read(json, path, ".expected.cap"));
            assertEq(afterBook.T, _read(json, path, ".bookAfter.T"));
            assertEq(afterBook.R, _read(json, path, ".bookAfter.R"));
            assertEq(afterBook.V, _read(json, path, ".bookAfter.V"));
        }
    }

    function _read(string memory json, string memory path, string memory suffix) internal pure returns (uint256) {
        return vm.parseJsonUint(json, string.concat(path, suffix));
    }
}
