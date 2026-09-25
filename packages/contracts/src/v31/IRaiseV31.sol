// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TypesV31 as V} from "./TypesV31.sol";

interface IRaiseV31 {
    /// @notice Shared action lock; module operations increment the nonce only before listing (PS §5).
    function beginModuleAction() external returns (uint256);
    /// @notice Release the shared action lock after all interactions (PS §§2,5).
    function endModuleAction() external;
    /// @notice Effective deadline-aware phase (P §2.4).
    function phase() external view returns (V.Phase);
    /// @notice Frozen ordinary delivery and original quota (P §§12.1–12.2).
    function deliveryOf(address owner) external view returns (uint256 tokens, uint256 quota);
    /// @notice Frozen builder grant by owner (P §2.2).
    function builderGrant(address owner) external view returns (uint256);
    /// @notice Exact dissolution claim record: each position's cost (PS §6).
    function dissolutionRecord(uint256 id) external view returns (address owner, V.Class class, uint256 amount);
    /// @notice Ledger voting identity and native capital (P §§3,5.11).
    function votingPosition(uint256 id) external view returns (address owner, uint256 weight, bool eligible);
    /// @notice Pinned proposer and voting parameters (P §§3,7).
    function governanceConfig() external view returns (address builder, V.Parameters memory parameters, bool enabled);
    /// @notice Remaining phase time, capital and ceiling (P §§3,5.10).
    function governanceState() external view returns (uint64 end, uint256 escrow, uint256 remainingCeiling);
    /// @notice Execute an authenticated voted draw, within the module action (PS §6).
    function governorDraw(uint256 proposal, uint256 amount, uint256 yesWeight) external;
    /// @notice O(1) backer-class, non-builder eligible shares valued at the common index (P §5.11).
    function eligibleCapital() external view returns (uint256);
    /// @notice Authenticated exact listing payment (P §12.1).
    function listingCallback(bytes32 poolId, uint256 quoteAmount, uint256 tokenAmount) external;
    /// @notice Current action nonce (PS §5).
    function stateNonce() external view returns (uint256);
}
