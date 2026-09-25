// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.sol";
import {PortexRegistry} from "../src/PortexRegistry.sol";

/// @notice PortexRegistry (§3): append-only versions, code-hash bundle, curator-only.
contract RegistryTest is BaseTest {
    function test_publish_recordsBundleHash() public view {
        PortexRegistry.TemplateVersion memory tv = registry.getVersion(ZERO_EXTRACTION, 1);
        assertEq(tv.raiseImpl, address(raiseImpl));
        assertEq(tv.poolImpl, address(poolImpl));
        assertEq(tv.vaultImpl, address(vaultImpl));
        assertEq(tv.governorImpl, address(0));
        assertEq(tv.dexAdapter, address(adapter));
        bytes32 expected = keccak256(
            abi.encodePacked(
                _codehash(address(raiseImpl)),
                _codehash(address(poolImpl)),
                _codehash(address(vaultImpl)),
                bytes32(0),
                address(adapter)
            )
        );
        assertEq(tv.bundleHash, expected);
        assertFalse(tv.deprecated);
        assertGt(tv.publishedAt, 0);
    }

    function test_revert_publishExistingVersion() public {
        vm.expectRevert(PortexRegistry.VersionExists.selector);
        vm.prank(curator);
        registry.publish(
            ZERO_EXTRACTION, 1, address(raiseImpl), address(poolImpl), address(vaultImpl), address(0), address(adapter)
        );
    }

    function test_revert_publishNotCurator() public {
        vm.expectRevert(PortexRegistry.OnlyCurator.selector);
        vm.prank(alice);
        registry.publish(
            ZERO_EXTRACTION, 2, address(raiseImpl), address(poolImpl), address(vaultImpl), address(0), address(adapter)
        );
    }

    function test_revert_publishZeroImpl() public {
        vm.expectRevert(PortexRegistry.ZeroImplementation.selector);
        vm.prank(curator);
        registry.publish(
            ZERO_EXTRACTION, 2, address(0), address(poolImpl), address(vaultImpl), address(0), address(adapter)
        );
    }

    function test_deprecate_blocksNewRaisesButVersionStaysReadable() public {
        vm.prank(curator);
        registry.deprecate(ZERO_EXTRACTION, 1);
        PortexRegistry.TemplateVersion memory tv = registry.getVersion(ZERO_EXTRACTION, 1);
        assertTrue(tv.deprecated);
        assertEq(tv.raiseImpl, address(raiseImpl)); // still readable — append-only
    }

    function test_revert_deprecateMissing() public {
        vm.expectRevert(PortexRegistry.VersionMissing.selector);
        vm.prank(curator);
        registry.deprecate(ZERO_EXTRACTION, 99);
    }

    function test_versionList() public {
        vm.startPrank(curator);
        registry.publish(
            ZERO_EXTRACTION, 2, address(raiseImpl), address(poolImpl), address(vaultImpl), address(0), address(adapter)
        );
        vm.stopPrank();
        assertEq(registry.versionCount(ZERO_EXTRACTION), 2);
        assertEq(registry.versionAt(ZERO_EXTRACTION, 0), 1);
        assertEq(registry.versionAt(ZERO_EXTRACTION, 1), 2);
        assertEq(registry.latestVersion(ZERO_EXTRACTION), 2);
    }

    function _codehash(address a) internal view returns (bytes32 h) {
        assembly {
            h := extcodehash(a)
        }
    }
}
