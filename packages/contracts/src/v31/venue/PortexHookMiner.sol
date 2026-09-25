// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PortexInitHook} from "./PortexInitHook.sol";

/// @notice Mine off chain in a Foundry script; the future adapter itself is the CREATE2 deployer.
library PortexHookMiner {
    error SaltNotFound();

    function find(address adapter, IPoolManager manager) internal view returns (address hook, bytes32 salt) {
        bytes32 initCodeHash = keccak256(bytes.concat(type(PortexInitHook).creationCode, abi.encode(manager, adapter)));
        for (uint256 i; i < 1 << 20; ++i) {
            salt = bytes32(i);
            hook = predict(adapter, salt, initCodeHash);
            if (uint160(hook) & Hooks.ALL_HOOK_MASK == Hooks.BEFORE_INITIALIZE_FLAG && hook.code.length == 0) {
                return (hook, salt);
            }
        }
        revert SaltNotFound();
    }

    function predict(address deployer, bytes32 salt, bytes32 initCodeHash) internal pure returns (address) {
        // CREATE2 addresses are the low 160 bits of the specified hash.
        // forge-lint: disable-next-line(unsafe-typecast)
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash)))));
    }
}
