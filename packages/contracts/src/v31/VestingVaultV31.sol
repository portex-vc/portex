// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ProjectTokenV31} from "./ProjectTokenV31.sol";
import {IRaiseV31} from "./IRaiseV31.sol";
import {TypesV31 as V} from "./TypesV31.sol";

/// @notice Builder purchases only: 30-day cliff followed by 1095-day linear release (P §2.2).
contract VestingVaultV31 is Initializable {
    address public raise;
    ProjectTokenV31 public token;
    uint256 public totalClaimed;
    mapping(address => uint256) public claimed;
    event VestedClaimed(
        address indexed raise, V.Phase phase, uint256 stateNonce, address indexed owner, uint256 amount
    );

    constructor() {
        _disableInitializers();
    }

    /// @notice Pin the raise and sole vesting asset at clone creation (P §§1,2.2).
    function initialize(address raise_, address token_) external initializer {
        if (raise_ == address(0) || token_ == address(0)) revert V.InvalidConfig();
        raise = raise_;
        token = ProjectTokenV31(token_);
    }

    /// @notice Cumulative vesting; exactly zero at the cliff (P §2.2).
    function vested(address owner) public view returns (uint256) {
        uint256 listed = token.listedAt();
        uint256 cliff = listed + 30 days;
        // Protocol deadlines and daily release explicitly use block time (P §§2.4,12.2).
        // forge-lint: disable-next-line(block-timestamp)
        if (listed == 0 || block.timestamp <= cliff) return 0;
        return
            Math.mulDiv(IRaiseV31(raise).builderGrant(owner), Math.min(block.timestamp - cliff, 1095 days), 1095 days);
    }

    /// @notice Permissionless pull, paying only the pinned grant owner (P §2.2, PS §5).
    function claim(address owner) external returns (uint256 amount) {
        uint256 nonce = IRaiseV31(raise).beginModuleAction();
        amount = vested(owner) - claimed[owner];
        if (amount == 0) revert V.InvalidAmount();
        claimed[owner] += amount;
        totalClaimed += amount;
        token.vestingTransfer(owner, amount);
        // The shared raise action lock covers these interactions and their resulting-nonce events (PS §§2,5).
        // forge-lint: disable-next-line(reentrancy-events)
        emit VestedClaimed(raise, V.Phase.Stage3, nonce, owner, amount);
        IRaiseV31(raise).endModuleAction();
    }
}
