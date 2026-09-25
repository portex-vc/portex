// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {TypesV31 as V} from "./TypesV31.sol";

interface IRolloverRaise {
    function exitFor(
        address owner,
        uint256 id,
        uint256 q,
        uint256 minPayout,
        uint256 nonce,
        uint256 deadline,
        bool withProfit
    ) external returns (uint256);
    function depositFor(address owner, uint256 amount, uint256 minTokens, uint256 nonce, uint256 deadline)
        external
        returns (uint256 id, uint256 quantity);
    function getConfig() external view returns (V.Config memory);
    function modules() external view returns (V.Modules memory);
}

interface IRolloverClaims {
    function claimFor(address owner, uint256 id) external returns (uint256);
}

interface IRolloverFactory {
    function isRaise(address raise) external view returns (bool);
}

/// @notice Move capital between Portex launches in one transaction: exit positions at cost (or with protected
/// profit in Stage 2), or take dissolution claims, and deposit the proceeds into another launch's Stage 1.
/// Raises and claim vaults trust this contract only to act for its own caller. It holds no user funds between
/// calls: each rollover returns everything it collected and did not deposit. It has no owner and no sweep, so
/// tokens transferred to it directly (outside a rollover) cannot be recovered by anyone.
contract RolloverRouterV31 is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum SourceKind {
        CostExit,
        ProtectedExit,
        DissolutionClaim
    }

    struct Source {
        address raise;
        SourceKind kind;
        uint256 id;
        uint256 quantity;
        uint256 minPayout;
        uint256 nonce;
    }

    uint256 public constant MAX_SOURCES = 16;
    IRolloverFactory public immutable factory;

    event RolloverSourced(
        address indexed owner, address indexed source, uint256 indexed id, SourceKind kind, uint256 amount
    );
    event RolledOver(
        address indexed owner,
        address indexed target,
        uint256 indexed positionId,
        uint256 fromPositions,
        uint256 fromWallet,
        uint256 deposited,
        uint256 returned
    );

    constructor(address factory_) {
        if (factory_ == address(0)) revert V.InvalidConfig();
        factory = IRolloverFactory(factory_);
    }

    /// @notice Collect every source for the caller, add an optional wallet top-up, deposit into `target` for the
    /// caller, and return whatever the Stage 1 curve did not debit.
    function rollover(
        Source[] calldata sources,
        uint256 topUp,
        address target,
        uint256 minTokens,
        uint256 targetNonce,
        uint256 deadline
    ) external nonReentrant returns (uint256 positionId, uint256 tokens, uint256 returned) {
        if (!factory.isRaise(target) || sources.length > MAX_SOURCES || (sources.length == 0 && topUp == 0)) {
            revert V.InvalidConfig();
        }
        IERC20 quote = IERC20(IRolloverRaise(target).getConfig().quote);
        uint256 start = quote.balanceOf(address(this));
        uint256 collected;
        for (uint256 i; i < sources.length; ++i) {
            collected += _collect(sources[i], target, quote, deadline);
        }
        if (topUp != 0) quote.safeTransferFrom(msg.sender, address(this), topUp);
        (positionId, tokens) =
            _deposit(quote, target, quote.balanceOf(address(this)) - start, minTokens, targetNonce, deadline);
        returned = _settle(quote, target, start, collected, topUp, positionId);
    }

    function _settle(IERC20 quote, address target, uint256 start, uint256 collected, uint256 topUp, uint256 id)
        internal
        returns (uint256 returned)
    {
        returned = quote.balanceOf(address(this)) - start;
        if (returned != 0) quote.safeTransfer(msg.sender, returned);
        emit RolledOver(msg.sender, target, id, collected, topUp, collected + topUp - returned, returned);
    }

    function _deposit(
        IERC20 quote,
        address target,
        uint256 amount,
        uint256 minTokens,
        uint256 targetNonce,
        uint256 deadline
    ) internal returns (uint256 positionId, uint256 tokens) {
        quote.forceApprove(target, amount);
        (positionId, tokens) = IRolloverRaise(target).depositFor(msg.sender, amount, minTokens, targetNonce, deadline);
        quote.forceApprove(target, 0);
    }

    function _collect(Source calldata src, address target, IERC20 quote, uint256 deadline)
        internal
        returns (uint256 got)
    {
        if (
            src.raise == target || !factory.isRaise(src.raise)
                || IRolloverRaise(src.raise).getConfig().quote != address(quote)
        ) revert V.InvalidConfig();
        uint256 before = quote.balanceOf(address(this));
        if (src.kind == SourceKind.DissolutionClaim) {
            IRolloverClaims(IRolloverRaise(src.raise).modules().claims).claimFor(msg.sender, src.id);
        } else {
            IRolloverRaise(src.raise)
                .exitFor(
                    msg.sender,
                    src.id,
                    src.quantity,
                    src.minPayout,
                    src.nonce,
                    deadline,
                    src.kind == SourceKind.ProtectedExit
                );
        }
        got = quote.balanceOf(address(this)) - before;
        emit RolloverSourced(msg.sender, src.raise, src.id, src.kind, got);
    }
}
