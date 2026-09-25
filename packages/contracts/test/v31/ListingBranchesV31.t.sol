// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TypesV31 as V} from "../../src/v31/TypesV31.sol";
import {StorageV31 as S} from "../../src/v31/StorageV31.sol";
import {ViewsV31} from "../../src/v31/ViewsV31.sol";
import {ProtectedSplitLib as PS} from "../../src/libraries/ProtectedSplitLib.sol";
import {ListingMathV31 as LP} from "../../src/v31/ListingMathV31.sol";
import {ReserveMarket as Market} from "../../src/v31/ReserveMarket.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

contract ListingPreviewHarnessV31 {
    S.State private s;

    function configure(uint256 escrow, uint256 inventory) external {
        s.phase = V.Phase.Stage2;
        s.deadlines.stage2Start = 1;
        s.deadlines.stage2End = 2;
        s.config.stage2Length = 1;
        s.config.quote = address(2);
        s.modules.token = address(1);
        s.modules.claims = address(this);
        s.book = PS.Book(0, escrow, inventory, 0, escrow);
        s.pEnd = 1e17;
        s.lastPrice = 2e17;
        s.liquidityReserve = 7;
    }

    function liability() external pure returns (uint256) {
        return 0;
    }

    function preview() external view returns (V.ListingPreview memory) {
        return ViewsV31.listingPreview(s);
    }
}

contract ListingBranchesV31Test is Test {
    ListingPreviewHarnessV31 internal harness = new ListingPreviewHarnessV31();

    function test_zeroQuotePositiveTokens_usesLastPositivePriceAndBurnsBothBuckets() public {
        vm.warp(100);
        harness.configure(0, 100);
        V.ListingPreview memory p = harness.preview();
        assertTrue(p.validity.available);
        assertEq(uint256(p.branch), uint256(V.Branch.ZeroQuote));
        assertEq(p.price, 2e17);
        assertEq(p.usedQuote + p.usedToken + p.liquidity, 0);
        assertEq(p.bookBurn, 100);
        assertEq(p.liquidityReserveBurn, 7);
    }

    function test_emptyBook_usesStage1EndPrice() public {
        vm.warp(100);
        harness.configure(0, 0);
        V.ListingPreview memory p = harness.preview();
        assertTrue(p.validity.available);
        assertEq(uint256(p.branch), uint256(V.Branch.Empty));
        assertEq(p.price, 1e17);
        assertEq(p.bookBurn, 0);
        assertEq(p.liquidityReserveBurn, 7);
    }

    function test_positiveQuoteWithoutTokens_isInvariantFailure() public {
        vm.warp(100);
        harness.configure(1, 0);
        V.ListingPreview memory p = harness.preview();
        assertFalse(p.validity.available);
        assertEq(uint256(p.branch), uint256(V.Branch.QuoteWithoutTokens));
        assertEq(p.usedQuote + p.usedToken, 0);
    }

    function test_failedUsageBounds_initializeOnlyAndLockAllQuote() public {
        vm.warp(100);
        harness.configure(5e35, 10000);
        V.ListingPreview memory p = harness.preview();
        assertTrue(p.validity.available);
        assertEq(uint256(p.branch), uint256(V.Branch.ZeroQuote));
        assertEq(p.usedQuote + p.usedToken + p.liquidity, 0);
        assertEq(p.quoteDust, 5e35);
        assertEq(p.bookBurn, 10000);
        assertEq(p.liquidityReserveBurn, 7);
    }

    function test_specCounterexample_representablePriceDoesNotImplyMinimumUsage() public pure {
        uint256 quote = 2.485e35;
        uint256 tokens = 8800;
        uint256 price = Math.mulDiv(quote, V.NORMALIZED_PRICE, tokens);
        for (uint256 i; i < 2; ++i) {
            bool tokenFirst = i == 0;
            assertTrue(LP.representable(price, tokenFirst));
            uint160 sqrtPrice = LP.sqrtPrice(price, tokenFirst);
            (, uint256 used0, uint256 used1) =
                LP.liquidityFor(sqrtPrice, tokenFirst ? tokens : quote, tokenFirst ? quote : tokens);
            uint256 usedToken = tokenFirst ? used0 : used1;
            assertEq(usedToken, 8798);
            assertEq(LP.minimum(tokens), 8799);
            // The implementation's native balance bound excludes this specification-level witness.
            assertFalse(Market.valid(PS.Book(quote, 0, tokens, 0, 0), tokenFirst));
        }
    }

    function testFuzz_listingLiquidityIsMaximalWithinAssetBounds(uint256 quoteSeed, uint256 tokenSeed, bool tokenFirst)
        public
        pure
    {
        _assertUsage(bound(quoteSeed, 1, V.MAX_QUOTE), bound(tokenSeed, 1, V.MAX_SUPPLY), tokenFirst);
    }

    function test_nativeBalanceBounds_cornerCases() public pure {
        uint256[8] memory values = [uint256(1), 2, 9999, 10000, 10001, 1e18, 1e30 - 1, 1e30];
        for (uint256 i; i < values.length; ++i) {
            for (uint256 j; j < values.length; ++j) {
                _assertUsage(values[i], values[j], true);
                _assertUsage(values[i], values[j], false);
            }
        }
    }

    function _assertUsage(uint256 quote, uint256 tokens, bool tokenFirst) internal pure {
        uint256 price = Math.mulDiv(quote, V.NORMALIZED_PRICE, tokens);
        uint160 sqrtPrice = LP.sqrtPrice(price, tokenFirst);
        (uint128 liquidity, uint256 used0, uint256 used1) =
            LP.liquidityFor(sqrtPrice, tokenFirst ? tokens : quote, tokenFirst ? quote : tokens);
        uint256 usedQuote = tokenFirst ? used1 : used0;
        uint256 usedToken = tokenFirst ? used0 : used1;
        assertGt(liquidity, 0);
        assertLe(usedQuote, quote);
        assertLe(usedToken, tokens);
        if (liquidity < LP.MAX_LIQUIDITY) {
            (uint256 next0, uint256 next1) = LP.amounts(sqrtPrice, liquidity + 1);
            assertTrue(next0 > (tokenFirst ? tokens : quote) || next1 > (tokenFirst ? quote : tokens));
        }
    }

    function test_oneUSDGThreshold_onlySubDollarBooksSkipMint() public {
        vm.warp(100);
        uint160 price = LP.sqrtPrice(1e30, true);
        (uint128 liquidity, uint256 used0, uint256 used1) = LP.liquidityFor(price, 999999, 999999);
        assertGt(liquidity, 0);
        assertGe(used0, LP.minimum(999999));
        assertGe(used1, LP.minimum(999999));
        harness.configure(999999, 999999);
        V.ListingPreview memory p = harness.preview();
        assertTrue(p.validity.available);
        assertEq(uint256(p.branch), uint256(V.Branch.ZeroQuote));
        assertEq(p.liquidity, 0);
        assertEq(p.quoteDust, 999999);
        harness.configure(1e6, 1e6);
        p = harness.preview();
        assertTrue(p.validity.available);
        assertEq(uint256(p.branch), uint256(V.Branch.Positive));
        assertGt(p.liquidity, 0);
        assertGe(p.usedQuote, p.minQuote);
        assertGe(p.usedToken, p.minToken);
    }

    function test_subDollarBook_initializeOnlyAtCanonicalPrice() public {
        vm.warp(100);
        harness.configure(3683, 100);
        V.ListingPreview memory p = harness.preview();
        assertTrue(p.validity.available);
        assertEq(uint256(p.branch), uint256(V.Branch.ZeroQuote));
        assertEq(p.price, Math.mulDiv(3683, V.NORMALIZED_PRICE, 100));
        assertEq(p.usedQuote + p.usedToken + p.liquidity, 0);
        assertEq(p.quoteDust, 3683);
    }
}
