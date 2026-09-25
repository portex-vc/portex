// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Append-only registry of rule-template versions (§3). A published version can never be
///         edited or removed; it can only be flagged `deprecated`, which blocks new raises.
///         bundleHash = keccak256 of the deployed code hashes plus the pinned DEX adapter address,
///         so anyone can verify source ↔ address. Only the curator publishes.
///         The curator cannot touch user funds.
contract PortexRegistry {
    struct TemplateVersion {
        address raiseImpl;
        address poolImpl;
        address vaultImpl;
        address governorImpl; // address(0) for ZERO_EXTRACTION (Rule 1)
        address dexAdapter; // DEX adapter pinned to this version (migration target; never mutable)
        bytes32 bundleHash; // keccak256 of the four implementations' code hashes + the adapter address
        uint64 publishedAt;
        bool deprecated;
    }

    address public immutable curator;

    mapping(bytes32 templateId => mapping(uint64 version => TemplateVersion)) internal versions;
    mapping(bytes32 templateId => uint64[]) internal versionList;

    event VersionPublished(
        bytes32 indexed templateId,
        uint64 indexed version,
        address raiseImpl,
        address poolImpl,
        address vaultImpl,
        address governorImpl,
        address dexAdapter,
        bytes32 bundleHash
    );
    event VersionDeprecated(bytes32 indexed templateId, uint64 indexed version);

    error OnlyCurator();
    error VersionExists();
    error VersionMissing();
    error ZeroImplementation();

    modifier onlyCurator() {
        if (msg.sender != curator) revert OnlyCurator();
        _;
    }

    constructor(address curator_) {
        curator = curator_;
    }

    /// @notice Publish a new immutable template version. Reverts if (templateId, version) exists.
    ///         The DEX adapter is pinned here (and inside bundleHash): where a raise's liquidity
    ///         migrates to is part of the code-backed promise, not factory-owner config. Swapping
    ///         adapters means publishing a new version. A zero adapter is publishable but
    ///         RaiseFactory refuses to create raises from such a version.
    function publish(
        bytes32 templateId,
        uint64 version,
        address raiseImpl,
        address poolImpl,
        address vaultImpl,
        address governorImpl,
        address dexAdapter
    ) external onlyCurator {
        if (raiseImpl == address(0) || poolImpl == address(0) || vaultImpl == address(0)) {
            revert ZeroImplementation();
        }
        TemplateVersion storage tv = versions[templateId][version];
        if (tv.raiseImpl != address(0)) revert VersionExists();

        bytes32 bundleHash = keccak256(
            abi.encodePacked(
                _codehash(raiseImpl), _codehash(poolImpl), _codehash(vaultImpl), _codehash(governorImpl), dexAdapter
            )
        );
        tv.raiseImpl = raiseImpl;
        tv.poolImpl = poolImpl;
        tv.vaultImpl = vaultImpl;
        tv.governorImpl = governorImpl;
        tv.dexAdapter = dexAdapter;
        tv.bundleHash = bundleHash;
        tv.publishedAt = uint64(block.timestamp);
        versionList[templateId].push(version);
        emit VersionPublished(templateId, version, raiseImpl, poolImpl, vaultImpl, governorImpl, dexAdapter, bundleHash);
    }

    /// @notice Flag a version deprecated. It stays readable forever but blocks new raises.
    function deprecate(bytes32 templateId, uint64 version) external onlyCurator {
        TemplateVersion storage tv = versions[templateId][version];
        if (tv.raiseImpl == address(0)) revert VersionMissing();
        tv.deprecated = true;
        emit VersionDeprecated(templateId, version);
    }

    function getVersion(bytes32 templateId, uint64 version) external view returns (TemplateVersion memory) {
        return versions[templateId][version];
    }

    function versionCount(bytes32 templateId) external view returns (uint256) {
        return versionList[templateId].length;
    }

    function versionAt(bytes32 templateId, uint256 index) external view returns (uint64) {
        return versionList[templateId][index];
    }

    function latestVersion(bytes32 templateId) external view returns (uint64) {
        uint256 n = versionList[templateId].length;
        return n == 0 ? 0 : versionList[templateId][n - 1];
    }

    function _codehash(address a) internal view returns (bytes32) {
        if (a == address(0)) return bytes32(0);
        bytes32 h;
        assembly {
            h := extcodehash(a)
        }
        return h;
    }
}
