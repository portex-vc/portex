// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ListingMathV31 as LP} from "../../src/v31/ListingMathV31.sol";
import {SqrtPriceMath} from "./reference-v4/SqrtPriceMath.sol";

contract V4DifferentialV31Test is Test {
    function testFuzz_amountsMatchPinnedV4SqrtPriceMath(uint160 priceSeed, uint128 liquiditySeed) public pure {
        uint160 price = SafeCast.toUint160(bound(priceSeed, uint256(LP.LOWER) + 1, uint256(LP.UPPER) - 1));
        uint128 liquidity = SafeCast.toUint128(bound(liquiditySeed, 0, LP.MAX_LIQUIDITY));
        _assertAmounts(price, liquidity);
    }

    function test_v4AmountBoundaries_zeroLiquidityAndTickCap() public pure {
        uint160[3] memory prices = [LP.LOWER + 1, uint160(1 << 96), LP.UPPER - 1];
        uint128[4] memory liquidities = [uint128(0), 1, LP.MAX_LIQUIDITY - 1, LP.MAX_LIQUIDITY];
        for (uint256 i; i < prices.length; ++i) {
            for (uint256 j; j < liquidities.length; ++j) {
                _assertAmounts(prices[i], liquidities[j]);
            }
        }
    }

    function _assertAmounts(uint160 price, uint128 liquidity) internal pure {
        (uint256 amount0, uint256 amount1) = LP.amounts(price, liquidity);
        assertEq(amount0, SqrtPriceMath.getAmount0Delta(price, LP.UPPER, liquidity, true));
        assertEq(amount1, SqrtPriceMath.getAmount1Delta(LP.LOWER, price, liquidity, true));
    }
}
