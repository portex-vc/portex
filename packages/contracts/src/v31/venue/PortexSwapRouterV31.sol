// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {UniswapV4Adapter} from "./UniswapV4Adapter.sol";

/// @notice Secondary-market surface for graduated (Stage 3) Portex projects.
interface IPortexSwapRouterV31 {
    event Swapped(
        address indexed trader,
        address indexed token,
        bytes32 indexed poolId,
        bool buy,
        uint256 amountIn,
        uint256 amountOut,
        address recipient
    );
    /// buy=true spends `amountIn` quote (USDG, 6 dp) for project tokens; buy=false sells `amountIn` project tokens for USDG.
    /// The pool is the Portex-listed Uniswap v4 pool for (token, quote) from the launch's adapter (fee 1%, spacing 200).
    /// The caller must have ERC20-approved the router for the input asset.
    function swapExactIn(
        address token,
        bool buy,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint256 deadline
    ) external returns (uint256 amountOut);
    /// Quote the same swap; call via eth_call / simulateContract (it is not view).
    function quoteExactIn(address token, bool buy, uint256 amountIn) external returns (uint256 amountOut);
    function quote() external view returns (address);
}

/// @notice Exact-input swaps through the Portex-listed Uniswap v4 pool of a graduated project.
/// @dev Stateless and custody-free: every swap settles inside one PoolManager unlock, pulling the input from the
///      caller and paying the output straight to the recipient. The pool key comes from the pinned adapter, so only
///      the Portex pool (fee 1%, spacing 200, Portex initialize-only hook) is reachable. No native-currency paths.
contract PortexSwapRouterV31 is IPortexSwapRouterV31, IUnlockCallback, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    error DeadlineExpired(uint256 deadline);
    error InvalidAmount();
    error InvalidRecipient();
    error PoolNotInitialized(bytes32 poolId);
    error TooLittleReceived(uint256 amountOut, uint256 minAmountOut);
    /// @notice The pool ran out of in-range liquidity before the whole input was consumed.
    error PartialFill(uint256 consumed, uint256 amountIn);
    error WrongSettlement();
    error Unauthorized();
    error InvalidConfig();
    /// @notice Carries a simulated result out of the reverted unlock; never escapes quoteExactIn.
    error QuoteResult(uint256 amountOut);

    struct Call {
        bool quoteOnly;
        address payer;
        address recipient;
        address input;
        PoolKey key;
        bool zeroForOne;
        uint256 amountIn;
        uint256 minAmountOut;
    }

    /// @notice BalanceDelta carries int128 amounts: type(int128).max.
    uint256 private constant MAX_AMOUNT = 2 ** 127 - 1;

    IPoolManager public immutable poolManager;
    UniswapV4Adapter public immutable adapter;
    address private immutable quoteAsset;

    constructor(IPoolManager manager_, UniswapV4Adapter adapter_, address quote_) {
        if (
            quote_ == address(0) || address(manager_).code.length == 0 || address(adapter_).code.length == 0
                || quote_.code.length == 0 || address(adapter_.poolManager()) != address(manager_)
        ) revert InvalidConfig();
        poolManager = manager_;
        adapter = adapter_;
        quoteAsset = quote_;
    }

    /// @inheritdoc IPortexSwapRouterV31
    function quote() external view returns (address) {
        return quoteAsset;
    }

    /// @notice The Portex pool id for a project token; the pool may still be uninitialized.
    function poolId(address token) external view returns (bytes32) {
        return PoolId.unwrap(adapter.keyFor(token, quoteAsset).toId());
    }

    /// @inheritdoc IPortexSwapRouterV31
    function swapExactIn(
        address token,
        bool buy,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint256 deadline
    ) external nonReentrant returns (uint256 amountOut) {
        // Deadlines are wall-clock bounds chosen by the trader.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > deadline) revert DeadlineExpired(deadline);
        if (recipient == address(0)) revert InvalidRecipient();
        Call memory c = _call(token, buy, amountIn);
        c.payer = msg.sender;
        c.recipient = recipient;
        c.minAmountOut = minAmountOut;
        amountOut = abi.decode(poolManager.unlock(abi.encode(c)), (uint256));
        // The whole swap ran under this call's reentrancy guard; the event reports the settled amounts.
        // forge-lint: disable-next-line(reentrancy-events)
        emit Swapped(msg.sender, token, PoolId.unwrap(c.key.toId()), buy, amountIn, amountOut, recipient);
    }

    /// @inheritdoc IPortexSwapRouterV31
    function quoteExactIn(address token, bool buy, uint256 amountIn) external nonReentrant returns (uint256 amountOut) {
        Call memory c = _call(token, buy, amountIn);
        c.quoteOnly = true;
        try poolManager.unlock(abi.encode(c)) {
            revert WrongSettlement();
        } catch (bytes memory reason) {
            // Selector comparison: the first four bytes of the revert data.
            // forge-lint: disable-next-line(unsafe-typecast)
            if (reason.length != 36 || bytes4(reason) != QuoteResult.selector) {
                assembly ("memory-safe") {
                    revert(add(reason, 32), mload(reason))
                }
            }
            assembly ("memory-safe") {
                amountOut := mload(add(reason, 36))
            }
        }
    }

    /// @notice Only this router's own unlock reaches here; PoolManager calls back its unlocker alone.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager) || !_reentrancyGuardEntered()) revert Unauthorized();
        Call memory c = abi.decode(data, (Call));
        BalanceDelta delta = poolManager.swap(
            c.key,
            IPoolManager.SwapParams({
                zeroForOne: c.zeroForOne,
                amountSpecified: -SafeCast.toInt256(c.amountIn),
                sqrtPriceLimitX96: c.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        (int128 inDelta, int128 outDelta) =
            c.zeroForOne ? (delta.amount0(), delta.amount1()) : (delta.amount1(), delta.amount0());
        // Exact input: the full amount is owed unless the pool ran out of in-range liquidity.
        uint256 consumed = inDelta < 0 ? SafeCast.toUint256(-int256(inDelta)) : 0;
        if (inDelta > 0 || consumed != c.amountIn) revert PartialFill(consumed, c.amountIn);
        uint256 amountOut = outDelta > 0 ? SafeCast.toUint256(int256(outDelta)) : 0;
        if (c.quoteOnly) revert QuoteResult(amountOut);
        if (amountOut == 0 || amountOut < c.minAmountOut) revert TooLittleReceived(amountOut, c.minAmountOut);

        Currency output = c.zeroForOne ? c.key.currency1 : c.key.currency0;
        poolManager.take(output, c.recipient, amountOut);
        poolManager.sync(Currency.wrap(c.input));
        // Project tokens apply their public-transfer rules here (checkpoint, then destroy the payer's quota).
        // The payer is always the msg.sender of swapExactIn: only this router's own unlock reaches the callback.
        // forge-lint: disable-next-line(arbitrary-send-erc20)
        IERC20(c.input).safeTransferFrom(c.payer, address(poolManager), c.amountIn);
        if (poolManager.settle() != c.amountIn) revert WrongSettlement();
        return abi.encode(amountOut);
    }

    function _call(address token, bool buy, uint256 amountIn) private view returns (Call memory c) {
        if (amountIn == 0 || amountIn > MAX_AMOUNT) revert InvalidAmount();
        c.key = adapter.keyFor(token, quoteAsset);
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(c.key.toId());
        if (sqrtPriceX96 == 0) revert PoolNotInitialized(PoolId.unwrap(c.key.toId()));
        c.input = buy ? quoteAsset : token;
        c.zeroForOne = Currency.unwrap(c.key.currency0) == c.input;
        c.amountIn = amountIn;
    }
}
