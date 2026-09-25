// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IDexAdapterV31} from "../IDexAdapterV31.sol";
import {IRaiseV31} from "../IRaiseV31.sol";
import {ProjectTokenV31} from "../ProjectTokenV31.sol";
import {ListingMathV31} from "../ListingMathV31.sol";
import {TypesV31 as V} from "../TypesV31.sol";
import {PortexInitHook} from "./PortexInitHook.sol";

/// @notice Immutable v4 custody for Portex raises. Only positive mints and fee pokes exist; principal cannot be removed.
/// @dev PoolManager keys positions by this adapter and a raise-specific salt. Receipt.owner is the permanent beneficiary.
contract UniswapV4Adapter is IDexAdapterV31, IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint24 public constant FEE = 10000;
    int24 public constant TICK_SPACING = 200;
    int24 public constant TICK_LOWER = -887200;
    int24 public constant TICK_UPPER = 887200;

    enum Action {
        Mint,
        Collect
    }

    struct Assets {
        address token;
        address quote;
    }

    IPoolManager public immutable poolManager;
    address public immutable initializeHook;
    mapping(bytes32 => Receipt) private positions;
    mapping(bytes32 => Assets) private assets;
    bytes32 private pendingCallback;

    constructor(IPoolManager manager_, bytes32 hookSalt) {
        if (address(manager_).code.length == 0) revert V.InvalidConfig();
        poolManager = manager_;
        initializeHook = address(new PortexInitHook{salt: hookSalt}(manager_, address(this)));
    }

    /// @notice The token pins its own raise, quote and adapter at factory initialization.
    function initializeAndMint(Request calldata r) external nonReentrant returns (Receipt memory) {
        ProjectTokenV31 token = ProjectTokenV31(r.token);
        if (
            msg.sender != token.raise() || r.owner != msg.sender || token.adapter() != address(this)
                || token.quote() != r.quote
        ) {
            revert V.Unauthorized();
        }
        return abi.decode(_unlock(abi.encode(Action.Mint, abi.encode(r))), (Receipt));
    }

    function position(bytes32 id) external view returns (Receipt memory) {
        return positions[id];
    }

    /// @notice IDexAdapterV31 uses the hash; keyFor exposes the complete v4 key to routers and indexers.
    function poolKey(address token, address quote) public view returns (bytes32) {
        return PoolId.unwrap(keyFor(token, quote).toId());
    }

    /// @notice Current pool price read from PoolManager slot0; zero when uninitialized.
    function spotSqrtPriceX96(bytes32 poolId) external view returns (uint160 sqrtPriceX96) {
        (sqrtPriceX96,,,) = poolManager.getSlot0(PoolId.wrap(poolId));
    }

    function keyFor(address token, address quote) public view returns (PoolKey memory key) {
        if (token == address(0) || quote == address(0) || token == quote) revert V.InvalidConfig();
        (address c0, address c1) = token < quote ? (token, quote) : (quote, token);
        key = PoolKey(Currency.wrap(c0), Currency.wrap(c1), FEE, TICK_SPACING, IHooks(initializeHook));
    }

    function collectFees(bytes32 id, address to) external nonReentrant returns (uint256 quoteFees, uint256 tokenFees) {
        Receipt memory receipt = positions[id];
        if (
            receipt.owner == address(0) || msg.sender != receipt.owner
                || to != ProjectTokenV31(assets[id].token).treasury()
        ) {
            revert V.Unauthorized();
        }
        // v4 cannot poke a position which was initialized without any liquidity.
        if (receipt.liquidity == 0) return (0, 0);
        return abi.decode(_unlock(abi.encode(Action.Collect, abi.encode(id, to))), (uint256, uint256));
    }

    /// @notice Accept exactly one callback for the active request, while the outer action lock remains held.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (
            msg.sender != address(poolManager) || !_reentrancyGuardEntered() || pendingCallback == bytes32(0)
                || keccak256(data) != pendingCallback
        ) revert V.Unauthorized();
        // A single-use callback latch, not an authority change; the raise emits the listing/fee event.
        // forge-lint: disable-next-line(missing-events-access-control)
        delete pendingCallback;
        (Action action, bytes memory payload) = abi.decode(data, (Action, bytes));
        if (action == Action.Mint) return abi.encode(_mint(abi.decode(payload, (Request))));
        (bytes32 id, address to) = abi.decode(payload, (bytes32, address));
        return _collect(id, to);
    }

    function _unlock(bytes memory data) private returns (bytes memory result) {
        pendingCallback = keccak256(data);
        result = poolManager.unlock(data);
        if (pendingCallback != bytes32(0)) revert V.VenueFailure();
    }

    // Every interaction below runs under the outer nonReentrant action and a consumed callback latch.
    // forge-lint: disable-start(reentrancy-no-eth)
    function _mint(Request memory r) private returns (Receipt memory receipt) {
        PoolKey memory key = keyFor(r.token, r.quote);
        receipt.poolId = PoolId.unwrap(key.toId());
        receipt.positionId = keccak256(abi.encode(receipt.poolId, r.owner));
        if (positions[receipt.positionId].owner != address(0)) revert V.VenueFailure();
        receipt.owner = r.owner;
        receipt.sqrtPriceX96 = r.sqrtPriceX96;
        // Also validates initialize-only prices against the Portex full range.
        ListingMathV31.amounts(r.sqrtPriceX96, 0);
        _initialize(key, r.sqrtPriceX96);
        if (r.desiredQuote != 0) {
            bool tokenFirst = r.token < r.quote;
            (receipt.liquidity, receipt.usedToken, receipt.usedQuote) = ListingMathV31.liquidityFor(
                r.sqrtPriceX96,
                tokenFirst ? r.desiredToken : r.desiredQuote,
                tokenFirst ? r.desiredQuote : r.desiredToken
            );
            if (!tokenFirst) (receipt.usedToken, receipt.usedQuote) = (receipt.usedQuote, receipt.usedToken);
            if (
                receipt.liquidity == 0 || receipt.usedQuote == 0 || receipt.usedToken == 0
                    || receipt.usedQuote < r.minQuote || receipt.usedToken < r.minToken
            ) revert V.VenueFailure();
            (BalanceDelta delta, BalanceDelta fees) =
                poolManager.modifyLiquidity(key, _params(receipt.positionId, int256(uint256(receipt.liquidity))), "");
            if (BalanceDelta.unwrap(fees) != 0) revert V.VenueFailure();
            uint256 used0 = _debt(delta.amount0());
            uint256 used1 = _debt(delta.amount1());
            if (
                used0 != (tokenFirst ? receipt.usedToken : receipt.usedQuote)
                    || used1 != (tokenFirst ? receipt.usedQuote : receipt.usedToken)
            ) revert V.WrongAssetDelta();
            _fundAndSettle(r, receipt);
        }
        positions[receipt.positionId] = receipt;
        assets[receipt.positionId] = Assets(r.token, r.quote);
    }

    function _initialize(PoolKey memory key, uint160 price) private {
        PoolId id = key.toId();
        (uint160 existing,,,) = poolManager.getSlot0(id);
        if (existing == 0) {
            // The canonical sqrt price is already validated; the returned tick is not needed for custody.
            // forge-lint: disable-next-line(unused-return)
            poolManager.initialize(key, price);
        } else {
            if (existing != price || poolManager.getLiquidity(id) != 0) revert V.VenueFailure();
            // Active liquidity alone misses out-of-range positions. Check every usable tick bitmap word.
            for (int16 word = -18; word <= 17; ++word) {
                // Reject any populated word; skipping it would accept an occupied pool.
                // forge-lint: disable-next-line(require-revert-in-loop)
                if (poolManager.getTickBitmap(id, word) != 0) revert V.VenueFailure();
            }
        }
    }

    // Require exact per-call changes; unsolicited starting balances cancel out and stay locked.
    // forge-lint: disable-start(incorrect-strict-equality)
    function _fundAndSettle(Request memory r, Receipt memory receipt) private {
        uint256 quoteBefore = IERC20(r.quote).balanceOf(address(this));
        uint256 tokenBefore = IERC20(r.token).balanceOf(address(this));
        IRaiseV31(r.owner).listingCallback(receipt.poolId, receipt.usedQuote, receipt.usedToken);
        if (
            IERC20(r.quote).balanceOf(address(this)) - quoteBefore != receipt.usedQuote
                || IERC20(r.token).balanceOf(address(this)) - tokenBefore != receipt.usedToken
        ) revert V.WrongAssetDelta();

        poolManager.sync(Currency.wrap(r.quote));
        IERC20(r.quote).safeTransfer(address(poolManager), receipt.usedQuote);
        if (poolManager.settle() != receipt.usedQuote) revert V.WrongAssetDelta();
        poolManager.sync(Currency.wrap(r.token));
        ProjectTokenV31(r.token).adapterCustodyTransfer(address(poolManager), receipt.usedToken);
        if (poolManager.settle() != receipt.usedToken) revert V.WrongAssetDelta();
        if (
            IERC20(r.quote).balanceOf(address(this)) != quoteBefore
                || IERC20(r.token).balanceOf(address(this)) != tokenBefore
        ) revert V.WrongAssetDelta();
    }

    // forge-lint: disable-end(incorrect-strict-equality)
    // forge-lint: disable-end(reentrancy-no-eth)

    function _collect(bytes32 id, address to) private returns (bytes memory) {
        Assets memory a = assets[id];
        (BalanceDelta delta, BalanceDelta fees) =
            poolManager.modifyLiquidity(keyFor(a.token, a.quote), _params(id, 0), "");
        if (BalanceDelta.unwrap(delta) != BalanceDelta.unwrap(fees) || delta.amount0() < 0 || delta.amount1() < 0) {
            revert V.VenueFailure();
        }
        uint256 quoteFees = SafeCast.toUint256(int256(a.token < a.quote ? delta.amount1() : delta.amount0()));
        uint256 tokenFees = SafeCast.toUint256(int256(a.token < a.quote ? delta.amount0() : delta.amount1()));
        if (quoteFees != 0) poolManager.take(Currency.wrap(a.quote), to, quoteFees);
        if (tokenFees != 0) {
            poolManager.take(Currency.wrap(a.token), address(this), tokenFees);
            ProjectTokenV31(a.token).adapterFeeTransfer(to, tokenFees);
        }
        return abi.encode(quoteFees, tokenFees);
    }

    function _params(bytes32 salt, int256 liquidityDelta)
        private
        pure
        returns (IPoolManager.ModifyLiquidityParams memory)
    {
        return IPoolManager.ModifyLiquidityParams(TICK_LOWER, TICK_UPPER, liquidityDelta, salt);
    }

    function _debt(int128 delta) private pure returns (uint256) {
        if (delta >= 0) revert V.WrongAssetDelta();
        return SafeCast.toUint256(-int256(delta));
    }
}
