// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {VenueBaseV31} from "./VenueBaseV31.sol";
import {TypesV31 as V} from "../../../src/v31/TypesV31.sol";
import {MockUSDGV31} from "../../../src/v31/MockUSDGV31.sol";
import {UniswapV4Adapter} from "../../../src/v31/venue/UniswapV4Adapter.sol";
import {PortexSwapRouterV31, IPortexSwapRouterV31} from "../../../src/v31/venue/PortexSwapRouterV31.sol";

/// @notice Test-only quote asset which re-enters the router while the router pulls a payment.
contract ReentrantRouterQuote is MockUSDGV31 {
    PortexSwapRouterV31 private router;
    address private projectToken;
    address private payer;
    bool private armed;
    uint256 public blockedCalls;

    function arm(PortexSwapRouterV31 router_, address token_, address payer_) external {
        router = router_;
        projectToken = token_;
        payer = payer_;
        armed = true;
    }

    function _update(address from, address to, uint256 amount) internal override {
        super._update(from, to, amount);
        if (armed && from == payer) {
            armed = false;
            _attempt(abi.encodeCall(router.swapExactIn, (projectToken, true, 1e6, 0, payer, type(uint256).max)));
            _attempt(abi.encodeCall(router.quoteExactIn, (projectToken, true, 1e6)));
        }
    }

    function _attempt(bytes memory payload) private {
        (bool ok, bytes memory reason) = address(router).call(payload);
        require(
            !ok && bytes4(reason) == ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector,
            "nested router call was not guarded"
        );
        ++blockedCalls;
    }
}

contract PortexSwapRouterV31Test is VenueBaseV31 {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    event Swapped(
        address indexed trader,
        address indexed token,
        bytes32 indexed poolId,
        bool buy,
        uint256 amountIn,
        uint256 amountOut,
        address recipient
    );

    bytes32 internal constant POOL_SWAP_TOPIC =
        keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");

    PortexSwapRouterV31 internal router;
    address internal trader = address(0x7EAD);
    address internal payee = address(0xFA11);

    function setUp() public override {
        super.setUp();
        router = new PortexSwapRouterV31(manager, adapter, address(quote));
    }

    // ------------------------------------------------------------------ setup helpers

    function _listed() internal {
        _create(false);
        _fund();
        _open();
        _list();
    }

    /// @dev Relist a fresh raise whose quote sits at a chosen end of the address space, so both v4 currency orders run.
    function _listedWithQuoteOrder(bool tokenFirst, uint64 version) internal {
        MockUSDGV31 original = new MockUSDGV31();
        address quoteAddress = tokenFirst ? address(type(uint160).max - 1) : address(0x100);
        vm.etch(quoteAddress, address(original).code);
        quote = MockUSDGV31(quoteAddress);
        implementations.quote = quoteAddress;
        registry.whitelistQuote(quoteAddress, false, false, false, true);
        registry.publish(V.ESCROW_LAUNCH, version, implementations);
        _createVersion(_config(false), false, version);
        assertEq(address(token) < address(quote), tokenFirst);
        _fund();
        _open();
        _list();
        router = new PortexSwapRouterV31(manager, adapter, address(quote));
    }

    function _pool() internal view returns (PoolId) {
        return adapter.keyFor(address(token), address(quote)).toId();
    }

    function _sqrtPrice() internal view returns (uint160 sqrtPriceX96) {
        (sqrtPriceX96,,,) = manager.getSlot0(_pool());
    }

    function _fundTrader(address who, uint256 amount) internal {
        quote.mint(who, amount);
        vm.startPrank(who);
        quote.approve(address(router), type(uint256).max);
        token.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    function _poolBuy(address who, uint256 amountIn) internal returns (uint256 out) {
        vm.prank(who);
        out = router.swapExactIn(address(token), true, amountIn, 0, who, block.timestamp);
    }

    function _poolSell(address who, uint256 amountIn) internal returns (uint256 out) {
        vm.prank(who);
        out = router.swapExactIn(address(token), false, amountIn, 0, who, block.timestamp);
    }

    function _assertRouterEmpty() internal view {
        assertEq(quote.balanceOf(address(router)), 0);
        assertEq(token.balanceOf(address(router)), 0);
        assertEq(address(router).balance, 0);
    }

    // ------------------------------------------------------------------ construction

    function test_constructorPinsVenueAndRejectsMismatches() public {
        assertEq(router.quote(), address(quote));
        assertEq(address(router.poolManager()), address(manager));
        assertEq(address(router.adapter()), address(adapter));
        vm.expectRevert(PortexSwapRouterV31.InvalidConfig.selector);
        new PortexSwapRouterV31(IPoolManager(address(0xdead)), adapter, address(quote));
        vm.expectRevert(PortexSwapRouterV31.InvalidConfig.selector);
        new PortexSwapRouterV31(manager, adapter, address(0xbeef));
        // An adapter bound to another PoolManager is refused.
        vm.mockCall(address(adapter), abi.encodeWithSignature("poolManager()"), abi.encode(address(quote)));
        vm.expectRevert(PortexSwapRouterV31.InvalidConfig.selector);
        new PortexSwapRouterV31(manager, adapter, address(quote));
    }

    // ------------------------------------------------------------------ real listed raise: buy and sell

    function test_buyThenSell_realListedRaise_quoteEqualsExecution() public {
        _listed();
        _fundTrader(trader, 1000e6);
        bytes32 id = PoolId.unwrap(_pool());
        assertEq(router.poolId(address(token)), id);
        assertEq(id, raise.listingRecord().poolId);
        uint160 before = _sqrtPrice();

        uint256 quoted = router.quoteExactIn(address(token), true, 100e6);
        assertGt(quoted, 0);
        // Quoting is a pure simulation: no price, balance or allowance moved.
        assertEq(_sqrtPrice(), before);
        assertEq(quote.balanceOf(trader), 1000e6);

        vm.recordLogs();
        vm.expectEmit(true, true, true, true, address(router));
        emit Swapped(trader, address(token), id, true, 100e6, quoted, trader);
        vm.prank(trader);
        uint256 bought = router.swapExactIn(address(token), true, 100e6, quoted, trader, block.timestamp);
        assertEq(bought, quoted);
        assertEq(token.balanceOf(trader), bought);
        assertEq(quote.balanceOf(trader), 900e6);
        _assertPoolSwapLog(vm.getRecordedLogs(), id, true, 100e6, bought);
        // Buying the project token raises its USDG price.
        bool tokenFirst = address(token) < address(quote);
        assertTrue(tokenFirst ? _sqrtPrice() > before : _sqrtPrice() < before);

        uint256 half = bought / 2;
        uint256 quotedBack = router.quoteExactIn(address(token), false, half);
        vm.expectEmit(true, true, true, true, address(router));
        emit Swapped(trader, address(token), id, false, half, quotedBack, trader);
        vm.prank(trader);
        uint256 received = router.swapExactIn(address(token), false, half, quotedBack, trader, block.timestamp);
        assertEq(received, quotedBack);
        assertEq(quote.balanceOf(trader), 900e6 + received);
        assertEq(token.balanceOf(trader), bought - half);
        // Two 1% fees and impact: the round trip returns less than half of what was spent.
        assertLt(received, 50e6);
        assertGt(received, 47e6);
        _assertRouterEmpty();

        // LP fees from router flow accrue to the protocol-owned position and are swept to the pinned treasury.
        uint256 treasuryQuote = quote.balanceOf(treasury);
        (uint256 q, uint256 t) = raise.collectLPFees();
        assertGt(q, 0);
        assertGt(t, 0);
        assertEq(quote.balanceOf(treasury) - treasuryQuote, q);
        // Principal liquidity is untouched by trading.
        assertEq(manager.getLiquidity(_pool()), raise.listingRecord().liquidity);
    }

    function test_recipientReceivesOutputWhileTraderPays() public {
        _listed();
        _fundTrader(trader, 500e6);
        vm.expectEmit(true, true, true, false, address(router));
        emit Swapped(trader, address(token), PoolId.unwrap(_pool()), true, 200e6, 0, payee);
        vm.prank(trader);
        uint256 out = router.swapExactIn(address(token), true, 200e6, 1, payee, block.timestamp);
        assertEq(token.balanceOf(payee), out);
        assertEq(token.balanceOf(trader), 0);
        assertEq(quote.balanceOf(trader), 300e6);
        _assertRouterEmpty();
    }

    function test_bothCurrencyOrders_buyAndSellMoveTheRightWay() public {
        for (uint256 order; order < 2; ++order) {
            _listedWithQuoteOrder(order == 1, uint64(order + 2));
            address who = address(uint160(0xA000 + order));
            _fundTrader(who, 10_000e6);
            uint160 start = _sqrtPrice();
            uint256 quoted = router.quoteExactIn(address(token), true, 2500e6);
            uint256 bought = _poolBuy(who, 2500e6);
            assertEq(bought, quoted);
            assertEq(token.balanceOf(who), bought);
            assertEq(quote.balanceOf(who), 7500e6);
            uint160 afterBuy = _sqrtPrice();
            assertTrue(order == 1 ? afterBuy > start : afterBuy < start);
            quoted = router.quoteExactIn(address(token), false, bought);
            uint256 received = _poolSell(who, bought);
            assertEq(received, quoted);
            assertEq(token.balanceOf(who), 0);
            assertEq(quote.balanceOf(who), 7500e6 + received);
            assertLt(received, 2500e6);
            uint160 afterSell = _sqrtPrice();
            assertTrue(order == 1 ? afterSell < afterBuy : afterSell > afterBuy);
            _assertRouterEmpty();
        }
    }

    // ------------------------------------------------------------------ protected quota and lazy delivery

    function test_sellingQuotaCarryingTokens_destroysQuotaThroughTokenRules() public {
        _listed();
        address holder = backers[9];
        uint256 balance = token.balanceOf(holder);
        uint256 quota = token.quotaOf(holder);
        uint256 totalQuota = token.totalQuota();
        assertGt(quota, 0);
        assertGe(balance, quota);
        // Tokens are still lazily delivered: the router's pull is the holder's first public transfer.
        assertFalse(token.materialized(holder));
        vm.prank(holder);
        token.approve(address(router), type(uint256).max);

        uint256 amount = quota / 4;
        uint256 quoteBefore = quote.balanceOf(holder);
        uint256 quoted = router.quoteExactIn(address(token), false, amount);
        vm.expectEmit(true, true, false, false, address(token));
        emit QuotaDestroyed(address(raise), V.Phase.Stage3, 0, 0, holder, amount, quota - amount);
        vm.prank(holder);
        uint256 received = router.swapExactIn(address(token), false, amount, quoted, holder, block.timestamp);
        assertEq(received, quoted);
        assertTrue(token.materialized(holder));
        assertEq(token.balanceOf(holder), balance - amount);
        assertEq(token.quotaOf(holder), quota - amount);
        assertEq(token.totalQuota(), totalQuota - amount);
        assertEq(quote.balanceOf(holder) - quoteBefore, received);

        // Days later the sale also checkpoints accrued Diamond Hand rewards before destroying more quota.
        vm.warp(block.timestamp + 3 days);
        uint256 remaining = token.quotaOf(holder);
        uint256 rest = token.balanceOf(holder);
        quoted = router.quoteExactIn(address(token), false, rest);
        vm.prank(holder);
        received = router.swapExactIn(address(token), false, rest, quoted, holder, block.timestamp);
        assertEq(received, quoted);
        assertEq(token.quotaOf(holder), 0);
        assertEq(token.totalQuota(), totalQuota - amount - remaining);
        assertEq(token.balanceOf(holder), 0);
        (uint256 pendingTokens,) = token.pendingRewards(holder);
        assertGt(pendingTokens, 0);
        _assertRouterEmpty();
    }

    event QuotaDestroyed(
        address indexed raise,
        V.Phase phase,
        uint256 stateNonce,
        uint256 rewardNonce,
        address indexed owner,
        uint256 amount,
        uint256 remainingQuota
    );

    function test_buyingDoesNotGrantQuota() public {
        _listed();
        _fundTrader(trader, 1000e6);
        uint256 total = token.totalQuota();
        _poolBuy(trader, 1000e6);
        assertEq(token.quotaOf(trader), 0);
        assertEq(token.totalQuota(), total);
    }

    // ------------------------------------------------------------------ guards

    function test_slippageRevertsAtomically() public {
        _listed();
        _fundTrader(trader, 1000e6);
        uint256 quoted = router.quoteExactIn(address(token), true, 100e6);
        uint160 before = _sqrtPrice();
        vm.expectRevert(abi.encodeWithSelector(PortexSwapRouterV31.TooLittleReceived.selector, quoted, quoted + 1));
        vm.prank(trader);
        router.swapExactIn(address(token), true, 100e6, quoted + 1, trader, block.timestamp);
        assertEq(_sqrtPrice(), before);
        assertEq(quote.balanceOf(trader), 1000e6);
        // A front-run between quote and execution trips the same guard.
        _fundTrader(buyer, 5000e6);
        _poolBuy(buyer, 5000e6);
        vm.expectRevert();
        vm.prank(trader);
        router.swapExactIn(address(token), true, 100e6, quoted, trader, block.timestamp);
        assertEq(quote.balanceOf(trader), 1000e6);
        assertLt(router.quoteExactIn(address(token), true, 100e6), quoted);
    }

    function test_deadlineReverts() public {
        _listed();
        _fundTrader(trader, 1000e6);
        uint256 deadline = block.timestamp - 1;
        vm.expectRevert(abi.encodeWithSelector(PortexSwapRouterV31.DeadlineExpired.selector, deadline));
        vm.prank(trader);
        router.swapExactIn(address(token), true, 100e6, 0, trader, deadline);
        // The deadline is inclusive.
        vm.prank(trader);
        router.swapExactIn(address(token), true, 100e6, 0, trader, block.timestamp);
    }

    function test_uninitializedPoolReverts() public {
        _create(false);
        _fund();
        _open();
        bytes32 id = adapter.poolKey(address(token), address(quote));
        vm.expectRevert(abi.encodeWithSelector(PortexSwapRouterV31.PoolNotInitialized.selector, id));
        router.quoteExactIn(address(token), true, 100e6);
        _fundTrader(trader, 1000e6);
        vm.expectRevert(abi.encodeWithSelector(PortexSwapRouterV31.PoolNotInitialized.selector, id));
        vm.prank(trader);
        router.swapExactIn(address(token), true, 100e6, 0, trader, block.timestamp);
        // Not a Portex token at all: no pool either.
        MockUSDGV31 stranger = new MockUSDGV31();
        vm.expectRevert(
            abi.encodeWithSelector(
                PortexSwapRouterV31.PoolNotInitialized.selector, adapter.poolKey(address(stranger), address(quote))
            )
        );
        router.quoteExactIn(address(stranger), false, 1e18);
    }

    function test_invalidInputsRevert() public {
        _listed();
        _fundTrader(trader, 1000e6);
        vm.startPrank(trader);
        vm.expectRevert(PortexSwapRouterV31.InvalidAmount.selector);
        router.swapExactIn(address(token), true, 0, 0, trader, block.timestamp);
        vm.expectRevert(PortexSwapRouterV31.InvalidAmount.selector);
        router.quoteExactIn(address(token), true, uint256(uint128(type(int128).max)) + 1);
        vm.expectRevert(PortexSwapRouterV31.InvalidRecipient.selector);
        router.swapExactIn(address(token), true, 1e6, 0, address(0), block.timestamp);
        vm.expectRevert(V.InvalidConfig.selector);
        router.swapExactIn(address(quote), true, 1e6, 0, trader, block.timestamp);
        vm.expectRevert(V.InvalidConfig.selector);
        router.quoteExactIn(address(0), true, 1e6);
        vm.stopPrank();
    }

    function test_dustOutputReverts() public {
        _listed();
        _fundTrader(trader, 1000e6);
        // One micro-USDG buys less than one token wei after the 1% fee rounds up: nothing would be delivered.
        uint256 quoted = router.quoteExactIn(address(token), true, 1);
        if (quoted == 0) {
            vm.expectRevert(abi.encodeWithSelector(PortexSwapRouterV31.TooLittleReceived.selector, 0, 0));
            vm.prank(trader);
            router.swapExactIn(address(token), true, 1, 0, trader, block.timestamp);
        }
        // Selling a single token wei returns zero USDG and is refused rather than silently burned into the pool.
        _poolBuy(trader, 10e6);
        assertEq(router.quoteExactIn(address(token), false, 1), 0);
        vm.expectRevert(abi.encodeWithSelector(PortexSwapRouterV31.TooLittleReceived.selector, 0, 0));
        vm.prank(trader);
        router.swapExactIn(address(token), false, 1, 0, trader, block.timestamp);
    }

    function test_missingAllowanceOrBalanceRevertsWithoutState() public {
        _listed();
        quote.mint(trader, 100e6);
        uint160 before = _sqrtPrice();
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(router), 0, 100e6)
        );
        vm.prank(trader);
        router.swapExactIn(address(token), true, 100e6, 0, trader, block.timestamp);
        vm.prank(trader);
        quote.approve(address(router), type(uint256).max);
        vm.expectRevert();
        vm.prank(trader);
        router.swapExactIn(address(token), true, 101e6, 0, trader, block.timestamp);
        assertEq(_sqrtPrice(), before);
        assertEq(quote.balanceOf(trader), 100e6);
    }

    function test_exhaustedRangeRevertsAsPartialFill() public {
        _listed();
        uint256 huge = uint256(uint128(type(int128).max));
        _fundTrader(trader, huge);
        vm.expectRevert();
        router.quoteExactIn(address(token), true, huge);
        vm.expectRevert();
        vm.prank(trader);
        router.swapExactIn(address(token), true, huge, 0, trader, block.timestamp);
        assertEq(quote.balanceOf(trader), huge);
        (bool ok, bytes memory reason) =
            address(router).call(abi.encodeCall(router.quoteExactIn, (address(token), true, huge)));
        assertFalse(ok);
        assertEq(bytes4(reason), PortexSwapRouterV31.PartialFill.selector);
    }

    function test_callbackRejectsOutsidersAndNativeCurrency() public {
        _listed();
        vm.expectRevert(PortexSwapRouterV31.Unauthorized.selector);
        router.unlockCallback("");
        // PoolManager itself cannot drive the callback outside the router's own unlock.
        vm.prank(address(manager));
        vm.expectRevert(PortexSwapRouterV31.Unauthorized.selector);
        router.unlockCallback("");
        vm.deal(trader, 1 ether);
        vm.prank(trader);
        (bool ok,) = address(router).call{value: 1}("");
        assertFalse(ok);
    }

    function test_reentrantQuotePaymentIsBlocked() public {
        ReentrantRouterQuote malicious = new ReentrantRouterQuote();
        quote = malicious;
        implementations.quote = address(malicious);
        registry.whitelistQuote(address(malicious), false, false, false, true);
        registry.publish(V.ESCROW_LAUNCH, 2, implementations);
        _createVersion(_config(false), false, 2);
        _fund();
        _open();
        _list();
        router = new PortexSwapRouterV31(manager, adapter, address(malicious));
        _fundTrader(trader, 1000e6);
        malicious.arm(router, address(token), trader);
        uint256 quoted = router.quoteExactIn(address(token), true, 100e6);
        assertEq(_poolBuy(trader, 100e6), quoted);
        assertEq(malicious.blockedCalls(), 2);
        _assertRouterEmpty();
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_quoteEqualsExecution(uint256 buySeed, uint256 sellSeed, uint256 buySeed2) public {
        _listed();
        uint256 buyAmount = bound(buySeed, 1e6, 500_000e6);
        _fundTrader(trader, 1_000_000e6);
        uint256 quotedBuy = router.quoteExactIn(address(token), true, buyAmount);
        uint256 bought = _poolBuy(trader, buyAmount);
        assertEq(bought, quotedBuy);
        assertEq(token.balanceOf(trader), bought);

        uint256 sellAmount = bound(sellSeed, 1, bought);
        uint256 quotedSell = router.quoteExactIn(address(token), false, sellAmount);
        uint256 balanceBefore = quote.balanceOf(trader);
        if (quotedSell == 0) {
            vm.expectRevert(abi.encodeWithSelector(PortexSwapRouterV31.TooLittleReceived.selector, 0, 0));
            vm.prank(trader);
            router.swapExactIn(address(token), false, sellAmount, 0, trader, block.timestamp);
        } else {
            assertEq(_poolSell(trader, sellAmount), quotedSell);
            assertEq(quote.balanceOf(trader) - balanceBefore, quotedSell);
        }
        // Round trips never create value: selling everything bought returns less than was spent.
        uint256 rest = token.balanceOf(trader);
        if (rest > 0) {
            uint256 back = router.quoteExactIn(address(token), false, rest);
            if (back > 0) _poolSell(trader, rest);
        }
        assertLt(quote.balanceOf(trader), 1_000_000e6);

        uint256 buyAmount2 = bound(buySeed2, 1e6, 100_000e6);
        uint256 quoted2 = router.quoteExactIn(address(token), true, buyAmount2);
        vm.prank(trader);
        assertEq(router.swapExactIn(address(token), true, buyAmount2, quoted2, trader, block.timestamp), quoted2);
        _assertRouterEmpty();
        assertEq(manager.getLiquidity(_pool()), raise.listingRecord().liquidity);
    }

    function testFuzz_holderSellQuotesMatch(uint256 holderSeed, uint256 fraction, uint256 dayOffset) public {
        _listed();
        address holder = backers[bound(holderSeed, 0, 9)];
        vm.warp(block.timestamp + bound(dayOffset, 0, 40 days));
        uint256 balance = token.balanceOf(holder);
        uint256 quota = token.quotaOf(holder);
        uint256 amount = bound(fraction, 1e17, balance);
        vm.prank(holder);
        token.approve(address(router), type(uint256).max);
        uint256 quoted = router.quoteExactIn(address(token), false, amount);
        vm.prank(holder);
        uint256 received = router.swapExactIn(address(token), false, amount, quoted, holder, block.timestamp);
        assertEq(received, quoted);
        assertEq(token.balanceOf(holder), balance - amount);
        assertEq(token.quotaOf(holder), quota - (amount < quota ? amount : quota));
        _assertRouterEmpty();
    }

    // ------------------------------------------------------------------ log helpers

    function _assertPoolSwapLog(Vm.Log[] memory logs, bytes32 id, bool buy, uint256 amountIn, uint256 amountOut)
        internal
        view
    {
        bool found;
        bool quoteIsZero = address(quote) < address(token);
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(manager) || logs[i].topics[0] != POOL_SWAP_TOPIC) continue;
            assertEq(logs[i].topics[1], id);
            assertEq(address(uint160(uint256(logs[i].topics[2]))), address(router));
            (int128 amount0, int128 amount1,,,,) =
                abi.decode(logs[i].data, (int128, int128, uint160, uint128, int24, uint24));
            (int128 quoteDelta, int128 tokenDelta) = quoteIsZero ? (amount0, amount1) : (amount1, amount0);
            if (buy) {
                assertEq(quoteDelta, -int128(int256(amountIn)));
                assertEq(tokenDelta, int128(int256(amountOut)));
            } else {
                assertEq(tokenDelta, -int128(int256(amountIn)));
                assertEq(quoteDelta, int128(int256(amountOut)));
            }
            found = true;
        }
        assertTrue(found);
    }
}
