// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {VenueBaseV31} from "./VenueBaseV31.sol";
import {ReentrantQuote} from "./ReentrantQuote.sol";
import {Pool} from "@uniswap/v4-core/src/libraries/Pool.sol";
import {VenueTestRouter} from "./VenueTestRouter.sol";
import {TypesV31 as V} from "../../../src/v31/TypesV31.sol";
import {ListingMathV31 as LP} from "../../../src/v31/ListingMathV31.sol";
import {IDexAdapterV31} from "../../../src/v31/IDexAdapterV31.sol";
import {PortexInitHook} from "../../../src/v31/venue/PortexInitHook.sol";
import {UniswapV4Adapter} from "../../../src/v31/venue/UniswapV4Adapter.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {Position} from "@uniswap/v4-core/src/libraries/Position.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {MockUSDGV31} from "../../../src/v31/MockUSDGV31.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {console2} from "forge-std/console2.sol";

contract UniswapV4AdapterV31Test is VenueBaseV31 {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    function test_hookAddressPermissionsAndCallerAuthentication() public {
        address hook = adapter.initializeHook();
        console2.log("Mined hook address:", hook);
        console2.log("Hook flag bits:", uint256(uint160(hook) & Hooks.ALL_HOOK_MASK));
        assertEq(uint160(hook) & Hooks.ALL_HOOK_MASK, Hooks.BEFORE_INITIALIZE_FLAG);
        PortexInitHook h = PortexInitHook(hook);
        assertEq(h.adapter(), address(adapter));
        assertEq(address(h.poolManager()), address(manager));
        Hooks.Permissions memory expected;
        expected.beforeInitialize = true;
        assertEq(keccak256(abi.encode(h.getHookPermissions())), keccak256(abi.encode(expected)));
        PoolKey memory key;
        vm.expectRevert(PortexInitHook.Unauthorized.selector);
        h.beforeInitialize(address(adapter), key, 1);
        vm.expectRevert(PortexInitHook.Unauthorized.selector);
        vm.prank(address(manager));
        h.beforeInitialize(buyer, key, 1);
        vm.prank(address(manager));
        assertEq(h.beforeInitialize(address(adapter), key, 1), IHooks.beforeInitialize.selector);
        vm.expectRevert(PortexInitHook.HookNotEnabled.selector);
        h.afterInitialize(address(adapter), key, 1, 0);
    }

    function test_outsiderCannotInitializePortexKey() public {
        _pending();
        V.ListingPreview memory p = raise.listingPreview();
        PoolKey memory key = adapter.keyFor(address(token), address(quote));
        assertEq(PoolId.unwrap(key.toId()), adapter.poolKey(address(token), address(quote)));
        assertEq(key.fee, 10000);
        assertEq(key.tickSpacing, 200);
        vm.expectRevert();
        vm.prank(buyer);
        manager.initialize(key, p.sqrtPriceX96);
        (uint160 price,,,) = IPoolManager(address(manager)).getSlot0(key.toId());
        assertEq(price, 0);
        raise.list();
        _assertReceipt(p);
    }

    function test_existingSamePriceEmptyPoolAccepted() public {
        _pending();
        V.ListingPreview memory p = raise.listingPreview();
        PoolKey memory key = adapter.keyFor(address(token), address(quote));
        vm.prank(address(adapter));
        manager.initialize(key, p.sqrtPriceX96);
        raise.list();
        _assertReceipt(p);
    }

    function test_existingWrongPriceAtomicRevertAndCostExit() public {
        _pending();
        V.ListingPreview memory p = raise.listingPreview();
        PoolKey memory key = adapter.keyFor(address(token), address(quote));
        vm.prank(address(adapter));
        manager.initialize(key, p.sqrtPriceX96 + 1);
        bytes32 beforeState = _stateHash();
        vm.expectRevert(V.VenueFailure.selector);
        raise.list();
        assertEq(_stateHash(), beforeState);
        assertEq(_exit(ids[0], raise.positionState(ids[0]).tokens, false), 1500e6);
        _assertBook();
    }

    function test_existingOutOfRangeLiquidityRejectedEvenWithZeroActiveLiquidity() public {
        _pending();
        PoolKey memory key = adapter.keyFor(address(token), address(quote));
        uint160 price = raise.listingPreview().sqrtPriceX96;
        vm.prank(address(adapter));
        manager.initialize(key, price);
        VenueTestRouter router = new VenueTestRouter(manager);
        quote.mint(address(this), 1e30);
        quote.approve(address(router), type(uint256).max);
        bool tokenFirst = address(token) < address(quote);
        IPoolManager.ModifyLiquidityParams memory params = IPoolManager.ModifyLiquidityParams(
            tokenFirst ? int24(-887200) : int24(887000), tokenFirst ? int24(-887000) : int24(887200), 1e12, bytes32(0)
        );
        router.modify(key, params);
        assertEq(IPoolManager(address(manager)).getLiquidity(key.toId()), 0);
        bytes32 beforeState = _stateHash();
        vm.expectRevert(V.VenueFailure.selector);
        raise.list();
        assertEq(_stateHash(), beforeState);
    }

    function test_realSwapsFeesToTreasuryAndPrincipalPermanentlyLocked() public {
        _pending();
        raise.list();
        IDexAdapterV31.Receipt memory receipt = raise.listingRecord();
        PoolKey memory key = adapter.keyFor(address(token), address(quote));
        VenueTestRouter router = new VenueTestRouter(manager);
        quote.mint(buyer, 1000e6);
        vm.startPrank(buyer);
        quote.approve(address(router), type(uint256).max);
        token.approve(address(router), type(uint256).max);
        router.swap(key, address(quote) < address(token), 100e6);
        uint256 received = token.balanceOf(buyer);
        assertGt(received, 0);
        assertEq(quote.balanceOf(buyer), 900e6);
        router.swap(key, address(token) < address(quote), received / 2);
        vm.stopPrank();
        assertGt(quote.balanceOf(buyer), 900e6);
        assertEq(token.balanceOf(buyer), received - received / 2);
        uint256 beforeQuote = quote.balanceOf(treasury);
        uint256 beforeToken = token.balanceOf(treasury);
        uint256 nonce = raise.stateNonce();
        (uint256 q, uint256 t) = raise.collectLPFees();
        assertGt(q, 0);
        assertGt(t, 0);
        assertEq(quote.balanceOf(treasury) - beforeQuote, q);
        assertEq(token.balanceOf(treasury) - beforeToken, t);
        assertEq(raise.stateNonce(), nonce);
        assertEq(token.balanceOf(address(adapter)), 0);
        assertEq(quote.balanceOf(address(adapter)), 0);
        assertEq(keccak256(abi.encode(adapter.position(receipt.positionId))), keccak256(abi.encode(receipt)));
        bytes32 rawPosition = Position.calculatePositionKey(address(adapter), -887200, 887200, receipt.positionId);
        assertEq(IPoolManager(address(manager)).getPositionLiquidity(key.toId(), rawPosition), receipt.liquidity);
        assertEq(receipt.owner, address(raise));
        (q, t) = raise.collectLPFees();
        assertEq(q + t, 0);
        vm.expectRevert(V.Unauthorized.selector);
        adapter.collectFees(receipt.positionId, treasury);
        vm.expectRevert(V.Unauthorized.selector);
        vm.prank(address(raise));
        adapter.collectFees(receipt.positionId, buyer);
        // Another PoolManager caller cannot address the adapter's position, even with the same salt.
        vm.expectRevert();
        router.modify(key, IPoolManager.ModifyLiquidityParams(-887200, 887200, -1, receipt.positionId));
        (bool removable,) =
            address(adapter).call(abi.encodeWithSignature("removeLiquidity(bytes32)", receipt.positionId));
        assertFalse(removable);
    }

    function test_callbacksAndRequestsRejectOutsidersAndReplay() public {
        _pending();
        IDexAdapterV31.Request memory r = _request();
        vm.expectRevert(V.Unauthorized.selector);
        adapter.initializeAndMint(r);
        r.owner = buyer;
        vm.expectRevert(V.Unauthorized.selector);
        vm.prank(address(raise));
        adapter.initializeAndMint(r);
        vm.expectRevert(V.Unauthorized.selector);
        adapter.unlockCallback("");
        vm.expectRevert(V.Unauthorized.selector);
        vm.prank(address(manager));
        adapter.unlockCallback("");
        r = _request();
        raise.list();
        vm.expectRevert(V.VenueFailure.selector);
        vm.prank(address(raise));
        adapter.initializeAndMint(r);
    }

    function test_managerFailureRollsBackAndRetryWorks() public {
        _pending();
        bytes32 beforeState = _stateHash();
        bytes memory original = address(manager).code;
        vm.etch(address(manager), hex"60006000fd");
        vm.expectRevert();
        raise.list();
        assertEq(_stateHash(), beforeState);
        assertEq(_exit(ids[0], raise.positionState(ids[0]).tokens, false), 1500e6);
        vm.etch(address(manager), original);
        V.ListingPreview memory p = raise.listingPreview();
        raise.list();
        _assertReceipt(p);
        _assertBook();
    }

    function test_wrongManagerDeltaRollsBackMintCallbackBurnsAndClaims() public {
        _pending();
        bytes32 beforeState = _stateHash();
        vm.mockCall(
            address(manager),
            abi.encodeWithSelector(IPoolManager.modifyLiquidity.selector),
            abi.encode(int256(-1), int256(0))
        );
        vm.expectRevert(V.WrongAssetDelta.selector);
        raise.list();
        assertEq(_stateHash(), beforeState);
        vm.clearMockedCalls();
        V.ListingPreview memory p = raise.listingPreview();
        raise.list();
        _assertReceipt(p);
    }

    function test_failedSettlementRollsBackFundedCallbackAndPoolInitialization() public {
        _pending();
        bytes32 beforeState = _stateHash();
        bytes32 id = adapter.poolKey(address(token), address(quote));
        vm.mockCall(address(manager), abi.encodeWithSelector(IPoolManager.settle.selector), abi.encode(uint256(0)));
        vm.expectRevert(V.WrongAssetDelta.selector);
        raise.list();
        assertEq(_stateHash(), beforeState);
        assertEq(token.balanceOf(address(adapter)), 0);
        assertEq(quote.balanceOf(address(adapter)), 0);
        assertEq(quote.balanceOf(address(manager)), 0);
        (uint160 price,,,) = manager.getSlot0(PoolId.wrap(id));
        assertEq(price, 0);
        vm.clearMockedCalls();
        V.ListingPreview memory p = raise.listingPreview();
        raise.list();
        _assertReceipt(p);
    }

    function test_bothCurrencyOrdersRealMintMatchesPreview() public {
        for (uint256 order; order < 2; ++order) {
            // Force the quote address to either end, using a fresh ordinary quote and an isolated registry version.
            MockUSDGV31 original = new MockUSDGV31();
            address quoteAddress = order == 0 ? address(0x100) : address(type(uint160).max - 1);
            vm.etch(quoteAddress, address(original).code);
            quote = MockUSDGV31(quoteAddress);
            implementations.quote = quoteAddress;
            registry.whitelistQuote(quoteAddress, false, false, false, true);
            registry.publish(V.ESCROW_LAUNCH, uint64(order + 2), implementations);
            _createVersion(_config(false), false, uint64(order + 2));
            assertEq(address(token) < address(quote), order == 1);
            _fund();
            _open();
            _list();
            IDexAdapterV31.Receipt memory r = raise.listingRecord();
            bytes32 positionKey = Position.calculatePositionKey(address(adapter), -887200, 887200, r.positionId);
            assertEq(
                IPoolManager(address(manager)).getPositionLiquidity(PoolId.wrap(r.poolId), positionKey), r.liquidity
            );
        }
    }

    function test_reentrantMintAndFeeActionsBlockedDuringRealSettlement() public {
        ReentrantQuote malicious = new ReentrantQuote();
        quote = malicious;
        implementations.quote = address(quote);
        registry.whitelistQuote(address(quote), false, false, false, true);
        registry.publish(V.ESCROW_LAUNCH, 2, implementations);
        _createVersion(_config(false), false, 2);
        _fund();
        _open();
        vm.warp(raise.stageDeadlines().stage2End);
        malicious.arm(address(adapter), address(raise), _request());
        V.ListingPreview memory p = raise.listingPreview();
        raise.list();
        assertEq(malicious.blockedCalls(), 2);
        _assertReceipt(p);
    }

    function testFuzz_admissibleAmountsStayBelowRealTickCap(uint256 quoteSeed, uint256 tokenSeed, bool tokenFirst)
        public
        pure
    {
        uint256 q = bound(quoteSeed, 1, V.MAX_QUOTE);
        uint256 t = bound(tokenSeed, 1, V.MAX_SUPPLY);
        uint160 s = LP.sqrtPrice(Math.mulDiv(q, V.NORMALIZED_PRICE, t), tokenFirst);
        (uint128 liquidity, uint256 a0, uint256 a1) = LP.liquidityFor(s, tokenFirst ? t : q, tokenFirst ? q : t);
        assertLe(liquidity, Pool.tickSpacingToMaxLiquidityPerTick(200));
        assertEq(SqrtPriceMath.getAmount0Delta(s, LP.UPPER, liquidity, true), a0);
        assertEq(SqrtPriceMath.getAmount1Delta(LP.LOWER, s, liquidity, true), a1);
    }

    function test_realTickCapCannotBindAdmittedPortexBooks() public pure {
        // Core floors the negative compressed minimum tick: its divisor is 8874, versus the historical preview's 8873.
        assertEq(Pool.tickSpacingToMaxLiquidityPerTick(200), type(uint128).max / 8874);
        assertEq(LP.MAX_LIQUIDITY, type(uint128).max / 8873);
        // For s >= Q96, amount1 > L/2; for s < Q96, amount0 > L/2. Both assets are bounded by 1e30.
        assertLt(LP.LOWER, LP.Q96 / 2);
        assertGt(LP.UPPER, 2 * LP.Q96);
        assertEq(V.MAX_QUOTE, V.MAX_SUPPLY);
        assertLt(2 * V.MAX_SUPPLY, Pool.tickSpacingToMaxLiquidityPerTick(200));
    }

    function test_pinnedTicksAndIndependentV4Rounding() public pure {
        assertEq(TickMath.getSqrtPriceAtTick(-887200), LP.LOWER);
        assertEq(TickMath.getSqrtPriceAtTick(887200), LP.UPPER);
        uint160 s = LP.sqrtPrice(0.1e18, true);
        (uint128 liquidity, uint256 used0, uint256 used1) = LP.liquidityFor(s, 166666e18, 16666e6);
        assertEq(SqrtPriceMath.getAmount0Delta(s, LP.UPPER, liquidity, true), used0);
        assertEq(SqrtPriceMath.getAmount1Delta(LP.LOWER, s, liquidity, true), used1);
        // Periphery's intermediate floor can understate the exact maximal liquidity; it must not replace ListingMath.
        assertLe(LiquidityAmounts.getLiquidityForAmounts(s, LP.LOWER, LP.UPPER, 166666e18, 16666e6), liquidity);
    }

    function _pending() private {
        _create(false);
        _fund();
        _open();
        vm.warp(raise.stageDeadlines().stage2End);
    }

    function _request() private view returns (IDexAdapterV31.Request memory) {
        V.ListingPreview memory p = raise.listingPreview();
        return IDexAdapterV31.Request(
            address(token),
            address(quote),
            address(raise),
            p.sqrtPriceX96,
            p.desiredQuote,
            p.desiredToken,
            p.minQuote,
            p.minToken
        );
    }

    function _stateHash() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                raise.reserveState(),
                raise.stateNonce(),
                token.totalSupply(),
                token.burned(),
                quote.balanceOf(address(raise)),
                token.balanceOf(address(raise)),
                raise.guaranteedClaim(ids[0])
            )
        );
    }

    function test_dustBook_R121741T1_listsAndLocksQuote() public {
        V.Config memory c = _config(false);
        c.supply = 1e6;
        c.targetPrice = 1e35;
        _createWith(c, false);
        _fund();
        _open();
        // Stage 1 exits return allocation to the sale, so the dust book is reached through Stage 2 cost exits.
        for (uint256 i; i < 10; ++i) {
            _exit(ids[i], raise.positionState(ids[i]).tokens - 1, false);
        }
        for (uint256 i; i < 10; ++i) {
            _exit(ids[i], 1, false);
        }
        V.ReserveState memory b = raise.reserveState();
        V.Deadlines memory d = raise.stageDeadlines();
        while (b.T > 2) {
            uint256 target = Math.mulDiv(b.V, 3, 5);
            uint256 elapsed = Math.mulDiv(b.X0 - target, c.stage2Length, b.X0, Math.Rounding.Ceil);
            vm.warp(d.stage2Start + elapsed);
            raise.advanceDepth();
            b = raise.reserveState();
        }
        assertEq(b.T, 2);
        assertEq(_buy(buyer, 122476), 1);
        vm.warp(d.stage2End);
        raise.advanceDepth();
        b = raise.reserveState();
        assertEq(b.E + b.V, 0);
        assertEq(b.R, 121741);
        assertEq(b.T, 1);
        V.ListingPreview memory p = raise.listingPreview();
        assertTrue(p.validity.available);
        assertEq(uint256(p.branch), uint256(V.Branch.ZeroQuote));
        assertEq(p.desiredQuote, 121741);
        assertEq(p.usedQuote + p.usedToken + p.liquidity, 0);
        assertEq(p.quoteDust, 121741);
        uint256 burned = token.burned();
        raise.list();
        _assertReceipt(p);
        (uint256 q, uint256 t) = raise.collectLPFees();
        assertEq(q + t, 0);
        assertEq(uint256(raise.phase()), uint256(V.Phase.Stage3));
        assertEq(raise.listingRecord().sqrtPriceX96, p.sqrtPriceX96);
        assertEq(raise.listingRecord().liquidity, 0);
        assertEq(token.burned() - burned, p.bookBurn + p.liquidityReserveBurn + c.supply * 30 / 100);
        (,,,, uint256 dust,) = raise.accounting();
        assertEq(dust, 121741);
        assertEq(quote.balanceOf(address(adapter)), 0);
        assertEq(quote.balanceOf(treasury), 0);
        assertEq(raise.buyerTokens(buyer), 0);
        assertEq(token.balanceOf(buyer), 1);
        _assertBook();
    }
}
