// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IDexAdapterV31} from "./IDexAdapterV31.sol";
import {IRaiseV31} from "./IRaiseV31.sol";
import {ProjectTokenV31} from "./ProjectTokenV31.sol";
import {ListingMathV31} from "./ListingMathV31.sol";
import {TypesV31 as V} from "./TypesV31.sol";

/// @notice Local model of the beforeInitialize-only permission; real v4 also validates hook address flag bits.
contract MockInitializeHookV31 {
    address public immutable adapter;

    constructor(address adapter_) {
        if (adapter_ == address(0)) revert V.InvalidConfig();
        adapter = adapter_;
    }

    /// @notice The mock venue authenticates the caller and forwards the actual initialization sender.
    function beforeInitialize(address sender) external view {
        if (msg.sender != adapter || sender != adapter) revert V.Unauthorized();
    }
}

/// @notice Local arithmetic-faithful v4 listing mock; principal remains locked forever (P §12.1).
contract MockV4Adapter is IDexAdapterV31, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Pool {
        uint160 sqrtPriceX96;
        uint128 liquidity;
    }

    struct Assets {
        address token;
        address quote;
        uint256 tokenFees;
        uint256 quoteFees;
    }
    address public immutable controller;
    address public immutable initializeHook;
    bool public failListing;
    bool public corruptReceipt;
    mapping(bytes32 => Pool) public pools;
    mapping(bytes32 => Receipt) private positions;
    mapping(bytes32 => Assets) private assets;

    constructor() {
        controller = msg.sender;
        initializeHook = address(new MockInitializeHookV31(address(this)));
    }

    /// @notice Local fault injection, restricted to the mock deployer (P §12.1 retry testing).
    function setFailure(bool fail, bool corrupt) external {
        if (msg.sender != controller) revert V.Unauthorized();
        failListing = fail;
        corruptReceipt = corrupt;
    }

    /// @notice Model venue initialization through the pinned beforeInitialize hook (P §12.1 step 5).
    function initializePool(address token, address quote, uint160 sqrtPriceX96) external {
        MockInitializeHookV31(initializeHook).beforeInitialize(msg.sender);
        bytes32 key = poolKey(token, quote);
        if (
            pools[key].sqrtPriceX96 != 0 || sqrtPriceX96 <= ListingMathV31.LOWER || sqrtPriceX96 >= ListingMathV31.UPPER
        ) revert V.VenueFailure();
        pools[key].sqrtPriceX96 = sqrtPriceX96;
    }

    /// @notice Authenticate the raise, mint exact upward-rounded amounts and confirm callback deltas (P §12.1).
    function initializeAndMint(Request calldata r) external nonReentrant returns (Receipt memory receipt) {
        if (failListing) revert V.VenueFailure();
        if (
            msg.sender != ProjectTokenV31(r.token).raise() || r.owner != msg.sender
                || ProjectTokenV31(r.token).adapter() != address(this) || ProjectTokenV31(r.token).quote() != r.quote
        ) revert V.Unauthorized();
        bytes32 key = poolKey(r.token, r.quote);
        Pool storage pool = pools[key];
        if (pool.liquidity != 0 || (pool.sqrtPriceX96 != 0 && pool.sqrtPriceX96 != r.sqrtPriceX96)) {
            revert V.VenueFailure();
        }
        // The outer nonReentrant action stays held; the self-call authenticates the initialization sender.
        // forge-lint: disable-next-line(reentrancy-no-eth)
        if (pool.sqrtPriceX96 == 0) this.initializePool(r.token, r.quote, r.sqrtPriceX96);
        receipt.poolId = key;
        receipt.positionId = keccak256(abi.encode(key, msg.sender));
        if (positions[receipt.positionId].owner != address(0)) revert V.VenueFailure();
        receipt.owner = r.owner;
        receipt.sqrtPriceX96 = r.sqrtPriceX96;
        if (r.desiredQuote != 0) _mint(r, receipt);
        else ListingMathV31.amounts(r.sqrtPriceX96, 0);
        pool.liquidity = receipt.liquidity;
        positions[receipt.positionId] = receipt;
        assets[receipt.positionId] = Assets(r.token, r.quote, 0, 0);
        if (corruptReceipt) receipt.usedQuote += 1;
    }

    /// @notice Confirm external locked custody and position ownership (P §12.1 step 7).
    function position(bytes32 id) external view returns (Receipt memory) {
        return positions[id];
    }

    /// @notice Address-sorted v4 key with fee, spacing and hook included (P §12.1).
    function poolKey(address token, address quote) public view returns (bytes32) {
        (address c0, address c1) = token < quote ? (token, quote) : (quote, token);
        return keccak256(abi.encode(c0, c1, uint24(10000), int24(200), initializeHook));
    }

    /// @notice Current modelled pool price (P §12.1).
    function spotSqrtPriceX96(bytes32 poolId) external view returns (uint160) {
        return pools[poolId].sqrtPriceX96;
    }

    /// @notice Local-only market movement for tests and demos; restricted to the mock deployer.
    function setSpotPrice(bytes32 poolId, uint160 sqrtPriceX96) external {
        if (msg.sender != controller || pools[poolId].sqrtPriceX96 == 0) revert V.Unauthorized();
        pools[poolId].sqrtPriceX96 = sqrtPriceX96;
    }

    /// @notice Simulate earned fees by funding them separately from LP principal (P §12.1).
    function donateFees(bytes32 id, uint256 quoteAmount, uint256 tokenAmount) external nonReentrant {
        Assets storage a = assets[id];
        if (positions[id].liquidity == 0) revert V.InvalidPosition();
        a.quoteFees += quoteAmount;
        a.tokenFees += tokenAmount;
        if (quoteAmount != 0) _pull(a.quote, quoteAmount);
        if (tokenAmount != 0) _pull(a.token, tokenAmount);
    }

    /// @notice Only fee balances can leave, always to the pinned treasury (P §12.1).
    function collectFees(bytes32 id, address treasury)
        external
        nonReentrant
        returns (uint256 quoteFees, uint256 tokenFees)
    {
        Receipt memory receipt = positions[id];
        Assets storage a = assets[id];
        if (msg.sender != receipt.owner || treasury != ProjectTokenV31(a.token).treasury()) revert V.Unauthorized();
        quoteFees = a.quoteFees;
        tokenFees = a.tokenFees;
        a.quoteFees = 0;
        a.tokenFees = 0;
        if (quoteFees != 0) IERC20(a.quote).safeTransfer(treasury, quoteFees);
        // The action/custody guard stays held across this call; authenticated callbacks cannot enter a new action (PS §2).
        // forge-lint: disable-next-line(reentrancy-no-eth)
        if (tokenFees != 0) IERC20(a.token).safeTransfer(treasury, tokenFees);
    }

    function _mint(Request calldata r, Receipt memory receipt) internal {
        bool tokenFirst = r.token < r.quote;
        (receipt.liquidity, receipt.usedToken, receipt.usedQuote) = ListingMathV31.liquidityFor(
            r.sqrtPriceX96, tokenFirst ? r.desiredToken : r.desiredQuote, tokenFirst ? r.desiredQuote : r.desiredToken
        );
        if (!tokenFirst) (receipt.usedToken, receipt.usedQuote) = (receipt.usedQuote, receipt.usedToken);
        if (
            receipt.liquidity == 0 || receipt.usedQuote == 0 || receipt.usedToken == 0 || receipt.usedQuote < r.minQuote
                || receipt.usedToken < r.minToken
        ) revert V.VenueFailure();
        uint256 quoteBefore = IERC20(r.quote).balanceOf(address(this));
        uint256 tokenBefore = IERC20(r.token).balanceOf(address(this));
        // The action/custody guard stays held across this call; authenticated callbacks cannot enter a new action (PS §2).
        // forge-lint: disable-next-line(reentrancy-no-eth)
        IRaiseV31(msg.sender).listingCallback(receipt.poolId, receipt.usedQuote, receipt.usedToken);
        if (
            // Exact per-call asset deltas are mandatory; unsolicited preexisting balances cancel out (PS §3).
            // forge-lint: disable-next-line(incorrect-strict-equality)
            IERC20(r.quote).balanceOf(address(this)) - quoteBefore != receipt.usedQuote
                // Exact per-call asset deltas are mandatory; unsolicited preexisting balances cancel out (PS §3).
                // forge-lint: disable-next-line(incorrect-strict-equality)
                || IERC20(r.token).balanceOf(address(this)) - tokenBefore != receipt.usedToken
        ) {
            revert V.WrongAssetDelta();
        }
    }

    function _pull(address asset, uint256 amount) internal {
        uint256 beforeBalance = IERC20(asset).balanceOf(address(this));
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        // Exact per-call asset deltas are mandatory; unsolicited preexisting balances cancel out (PS §3).
        // forge-lint: disable-next-line(incorrect-strict-equality)
        if (IERC20(asset).balanceOf(address(this)) - beforeBalance != amount) revert V.WrongAssetDelta();
    }
}
