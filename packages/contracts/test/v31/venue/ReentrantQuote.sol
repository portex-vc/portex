// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MockUSDGV31} from "../../../src/v31/MockUSDGV31.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IDexAdapterV31} from "../../../src/v31/IDexAdapterV31.sol";

/// @notice Test-only quote which attempts nested adapter actions during the actual raise callback payment.
contract ReentrantQuote is MockUSDGV31 {
    address private target;
    address private payer;
    bytes private mintCall;
    bool private armed;
    uint256 public blockedCalls;

    function arm(address adapter, address raise, IDexAdapterV31.Request memory request) external {
        target = adapter;
        payer = raise;
        mintCall = abi.encodeCall(IDexAdapterV31.initializeAndMint, (request));
        armed = true;
    }

    function _update(address from, address to, uint256 amount) internal override {
        super._update(from, to, amount);
        if (armed && from == payer && to == target) {
            armed = false;
            _attempt(mintCall);
            _attempt(abi.encodeCall(IDexAdapterV31.collectFees, (bytes32(0), address(this))));
        }
    }

    function _attempt(bytes memory payload) private {
        (bool ok, bytes memory reason) = target.call(payload);
        require(
            !ok && bytes4(reason) == ReentrancyGuard.ReentrancyGuardReentrantCall.selector,
            "nested action was not guarded"
        );
        ++blockedCalls;
    }
}
