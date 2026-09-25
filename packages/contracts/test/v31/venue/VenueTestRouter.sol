// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

/// @notice Test-only direct PoolManager router, including external liquidity to test pool contamination.
contract VenueTestRouter is IUnlockCallback {
    using SafeERC20 for IERC20;
    IPoolManager internal immutable manager;

    constructor(IPoolManager manager_) {
        manager = manager_;
    }

    function swap(PoolKey memory key, bool zeroForOne, uint256 amount) external returns (BalanceDelta) {
        return
            abi.decode(
                manager.unlock(abi.encode(msg.sender, key, true, abi.encode(zeroForOne, amount))), (BalanceDelta)
            );
    }

    function modify(PoolKey memory key, IPoolManager.ModifyLiquidityParams memory params) external {
        manager.unlock(abi.encode(msg.sender, key, false, abi.encode(params)));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager), "manager only");
        (address payer, PoolKey memory key, bool isSwap, bytes memory payload) =
            abi.decode(data, (address, PoolKey, bool, bytes));
        BalanceDelta delta;
        if (isSwap) {
            (bool zeroForOne, uint256 amount) = abi.decode(payload, (bool, uint256));
            require(amount <= uint256(type(int256).max), "amount overflow");
            delta = manager.swap(
                key,
                IPoolManager.SwapParams(
                    zeroForOne, -int256(amount), zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
                ),
                ""
            );
        } else {
            (delta,) = manager.modifyLiquidity(key, abi.decode(payload, (IPoolManager.ModifyLiquidityParams)), "");
        }
        _settle(key.currency0, payer, delta.amount0());
        _settle(key.currency1, payer, delta.amount1());
        return abi.encode(delta);
    }

    function _settle(Currency currency, address payer, int128 delta) private {
        if (delta < 0) {
            manager.sync(currency);
            IERC20(Currency.unwrap(currency)).safeTransferFrom(payer, address(manager), uint256(-int256(delta)));
            manager.settle();
        } else if (delta > 0) {
            manager.take(currency, payer, uint256(int256(delta)));
        }
    }
}
