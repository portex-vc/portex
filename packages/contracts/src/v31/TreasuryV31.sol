// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TypesV31 as V} from "./TypesV31.sol";

interface ITreasuryRaise {
    function feeAccruals() external view returns (uint256 reserveRetained, uint256 rewards, uint256 treasury);
}

interface ITreasuryToken {
    function listedAt() external view returns (uint64);
    function balanceOf(address owner) external view returns (uint256);
}

/// @notice Base-layer treasury of one launch. It receives every fee stream and the 10% treasury allocation, and
/// pays out only on an executed governance proposal. The allocation unlocks linearly from listing over
/// `vestingDuration` (the version's governed parameter, five years in production); fee income is spendable by vote
/// as it arrives.
contract TreasuryV31 is Initializable {
    using SafeERC20 for IERC20;

    address public raise;
    address public governor;
    IERC20 public quote;
    ITreasuryToken public token;
    /// @notice Treasury token allocation delivered at listing (supply / 10).
    uint256 public allocation;
    uint256 public spentQuote;
    uint256 public spentTokens;
    /// @notice Linear unlock period of the treasury token allocation, pinned from the version at clone creation.
    uint64 public vestingDuration;

    event TreasurySpent(
        address indexed raise,
        uint256 indexed proposal,
        address indexed recipient,
        uint256 quoteAmount,
        uint256 tokenAmount,
        uint256 lockedTokens
    );

    constructor() {
        _disableInitializers();
    }

    /// @notice Pin the launch, its governor, both assets, the allocation and its unlock period at clone creation.
    function initialize(
        address raise_,
        address governor_,
        address quote_,
        address token_,
        uint256 allocation_,
        uint64 vestingDuration_
    ) external initializer {
        if (
            raise_ == address(0) || governor_ == address(0) || quote_ == address(0) || token_ == address(0)
                || vestingDuration_ == 0
        ) {
            revert V.InvalidConfig();
        }
        raise = raise_;
        governor = governor_;
        quote = IERC20(quote_);
        token = ITreasuryToken(token_);
        allocation = allocation_;
        vestingDuration = vestingDuration_;
    }

    /// @notice Allocation still locked at `time`: all of it before listing, then a straight line to zero.
    function lockedTokensAt(uint256 time) public view returns (uint256) {
        uint256 listed = token.listedAt();
        // Unlocking follows the pinned block-time schedule from listing.
        // forge-lint: disable-next-line(block-timestamp)
        if (listed == 0 || time <= listed) return allocation;
        uint256 elapsed = time - listed;
        if (elapsed >= vestingDuration) return 0;
        return allocation - Math.mulDiv(allocation, elapsed, vestingDuration);
    }

    /// @notice Allocation still locked now.
    function lockedTokens() public view returns (uint256) {
        return lockedTokensAt(block.timestamp);
    }

    /// @notice Project tokens a proposal could pay at `time`: holdings above the locked allocation. Fee tokens
    /// (LP fees in project tokens) are never locked.
    function spendableTokensAt(uint256 time) public view returns (uint256) {
        uint256 balance = token.balanceOf(address(this));
        uint256 locked = lockedTokensAt(time);
        return balance > locked ? balance - locked : 0;
    }

    /// @notice Project tokens a proposal could pay now.
    function spendableTokens() external view returns (uint256) {
        return spendableTokensAt(block.timestamp);
    }

    /// @notice USDG a proposal could pay: the treasury balance plus trading fees still held by the raise.
    function availableQuote() external view returns (uint256) {
        (,, uint256 pending) = ITreasuryRaise(raise).feeAccruals();
        return quote.balanceOf(address(this)) + pending;
    }

    /// @notice Pay an executed proposal. Only the pinned governor can call; token payments never dip into the
    /// still-locked allocation.
    function spend(uint256 proposal, address to, uint256 quoteAmount, uint256 tokenAmount) external {
        if (msg.sender != governor) revert V.Unauthorized();
        if (to == address(0) || to == address(this)) revert V.InvalidConfig();
        uint256 locked = lockedTokens();
        if (tokenAmount != 0) {
            if (token.balanceOf(address(this)) < locked + tokenAmount) revert V.InvalidAmount();
            spentTokens += tokenAmount;
            IERC20(address(token)).safeTransfer(to, tokenAmount);
        }
        if (quoteAmount != 0) {
            spentQuote += quoteAmount;
            quote.safeTransfer(to, quoteAmount);
        }
        // Only the governor reaches this point, inside its own action; the event records the settled payment.
        // forge-lint: disable-next-line(reentrancy-events)
        emit TreasurySpent(raise, proposal, to, quoteAmount, tokenAmount, locked);
    }
}
