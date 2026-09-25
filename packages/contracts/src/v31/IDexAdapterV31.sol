// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Atomic v4 listing surface, fixed fee=10000, spacing=200, ticks=+-887200, permissioned initialization (P §12.1).
interface IDexAdapterV31 {
    struct Request {
        address token;
        address quote;
        address owner;
        uint160 sqrtPriceX96;
        uint256 desiredQuote;
        uint256 desiredToken;
        uint256 minQuote;
        uint256 minToken;
    }

    struct Receipt {
        bytes32 poolId;
        bytes32 positionId;
        address owner;
        uint160 sqrtPriceX96;
        uint128 liquidity;
        uint256 usedQuote;
        uint256 usedToken;
    }
    /// @notice Initialize at the exact price, then mint; callback deltas must be authenticated (P §12.1).
    function initializeAndMint(Request calldata request) external returns (Receipt memory);
    /// @notice Read the confirmed locked position; principal has no withdrawal surface (P §12.1).
    function position(bytes32 id) external view returns (Receipt memory);
    /// @notice Collect only accrued LP fees to the raise's pinned treasury (P §12.1).
    function collectFees(bytes32 id, address treasury) external returns (uint256 quoteFees, uint256 tokenFees);
    /// @notice Portex beforeInitialize-only hook, pinned to this adapter; all other hook flags are off (P §12.1).
    function initializeHook() external view returns (address);
    /// @notice Canonical address-sorted pool identifier with all v4 parameters included (P §12.1).
    function poolKey(address token, address quote) external view returns (bytes32);
    /// @notice Current pool price as v4 sqrtPriceX96; zero when the pool does not exist.
    function spotSqrtPriceX96(bytes32 poolId) external view returns (uint160);
}
