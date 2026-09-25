// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PortexRegistryV31} from "./PortexRegistryV31.sol";
import {RaiseCore} from "./RaiseCore.sol";
import {ProjectTokenV31} from "./ProjectTokenV31.sol";
import {VestingVaultV31} from "./VestingVaultV31.sol";
import {GovernanceV31} from "./GovernanceV31.sol";
import {ClaimVault} from "./ClaimVault.sol";
import {TreasuryV31} from "./TreasuryV31.sol";
import {TypesV31 as V} from "./TypesV31.sol";
import {ListingMathV31} from "./ListingMathV31.sol";
import {CurveV31} from "./CurveV31.sol";

interface IRolloverRouterFactory {
    function factory() external view returns (address);
}

/// @notice Atomic EIP-1167 construction pinned to one append-only registry version (P §§1,5–7).
contract RaiseFactoryV31 is ReentrancyGuard {
    struct Reference {
        bytes32 templateId;
        uint64 version;
    }

    struct TokenMeta {
        string name;
        string symbol;
    }
    PortexRegistryV31 public immutable registry;
    mapping(address => Reference) private references;
    address[] public raises;
    event RaiseCreated(
        address indexed raise,
        address indexed builder,
        bytes32 indexed templateId,
        uint64 version,
        V.Modules modules,
        bytes32 bundleHash
    );
    event RaiseConfigured(address indexed raise, V.Config config, string name, string symbol);

    constructor(PortexRegistryV31 registry_) {
        if (address(registry_).code.length == 0) revert V.InvalidConfig();
        registry = registry_;
    }

    /// @notice Validate composition, bounds and code hashes before atomically deploying initialized clones (P §§5–7).
    /// The launch's treasury is always a fresh governed treasury clone; any treasury in `config_` is ignored.
    function createRaise(bytes32 templateId, uint64 version, V.Config calldata config_, TokenMeta calldata meta)
        external
        nonReentrant
        returns (address raise)
    {
        PortexRegistryV31.TemplateVersion memory tv = registry.getVersion(templateId, version);
        if (
            tv.implementations.raise == address(0) || tv.deprecated
                || tv.bundleHash != registry.bundleHash(tv.implementations, tv.parameters)
        ) revert V.InvalidConfig();
        V.Config memory config = config_;
        _validate(templateId, config, tv);
        _validateRollover(tv.implementations);
        raise = Clones.clone(tv.implementations.raise);
        V.Modules memory m = _cloneModules(tv.implementations);
        config.treasury = Clones.clone(tv.implementations.treasury);
        if (!ListingMathV31.representable(config.targetPrice, m.token < config.quote)) revert V.InvalidConfig();
        _initializeModules(raise, m, config, meta, tv.parameters.treasuryVesting);
        // The action/custody guard stays held across this call; authenticated callbacks cannot enter a new action (PS §2).
        // forge-lint: disable-next-line(reentrancy-no-eth)
        RaiseCore(raise).initialize(config, tv.parameters, m, msg.sender, templateId, version, tv.bundleHash);
        references[raise] = Reference(templateId, version);
        raises.push(raise);
        // The shared raise action lock covers these interactions and their resulting-nonce events (PS §§2,5).
        // forge-lint: disable-next-line(reentrancy-events)
        emit RaiseCreated(raise, msg.sender, templateId, version, m, tv.bundleHash);
        // The shared raise action lock covers these interactions and their resulting-nonce events (PS §§2,5).
        // forge-lint: disable-next-line(reentrancy-events)
        emit RaiseConfigured(raise, config, meta.name, meta.symbol);
    }

    /// @notice Immutable source template of an existing raise (P §1/I2).
    function templateOf(address raise) external view returns (Reference memory) {
        return references[raise];
    }

    /// @notice Canonical factory membership (P §1/I2).
    function isRaise(address raise) external view returns (bool) {
        return references[raise].version != 0;
    }

    /// @notice Number of deployed launches (P §1/I2).
    function raisesCount() external view returns (uint256) {
        return raises.length;
    }

    function _cloneModules(PortexRegistryV31.Implementations memory i) internal returns (V.Modules memory) {
        return V.Modules(
            Clones.clone(i.token),
            Clones.clone(i.vesting),
            Clones.clone(i.governor),
            Clones.clone(i.claims),
            i.adapter,
            i.attester,
            i.council
        );
    }

    function _initializeModules(
        address raise,
        V.Modules memory m,
        V.Config memory config,
        TokenMeta calldata meta,
        uint64 treasuryVesting
    ) internal {
        // The action/custody guard stays held across this call; authenticated callbacks cannot enter a new action (PS §2).
        // forge-lint: disable-next-line(reentrancy-no-eth)
        // Factory nonReentrant covers the entire atomic clone initialization sequence.
        // forge-lint: disable-start(reentrancy-no-eth)
        ProjectTokenV31(m.token)
            .initialize(meta.name, meta.symbol, config.supply, raise, m, config.quote, config.treasury);
        // forge-lint: disable-end(reentrancy-no-eth)
        // The action/custody guard stays held across this call; authenticated callbacks cannot enter a new action (PS §2).
        // forge-lint: disable-next-line(reentrancy-no-eth)
        VestingVaultV31(m.vesting).initialize(raise, m.token);
        // The action/custody guard stays held across this call; authenticated callbacks cannot enter a new action (PS §2).
        // forge-lint: disable-next-line(reentrancy-no-eth)
        GovernanceV31(m.governor).initialize(raise, config.treasury);
        // The action/custody guard stays held across this call; authenticated callbacks cannot enter a new action (PS §2).
        // forge-lint: disable-next-line(reentrancy-no-eth)
        TreasuryV31(config.treasury)
            .initialize(raise, m.governor, config.quote, m.token, config.supply / 10, treasuryVesting);
        // The action/custody guard stays held across this call; authenticated callbacks cannot enter a new action (PS §2).
        // forge-lint: disable-next-line(reentrancy-no-eth)
        ClaimVault(m.claims).initialize(raise, config.quote);
    }

    /// @notice The rollover authority is pinned in the raise and claim-vault bytecode. It must be one router that
    /// serves this factory (or none, disabling rollover), so a misconfigured version can never hand exits or
    /// dissolution claims to another address.
    function _validateRollover(PortexRegistryV31.Implementations memory i) internal view {
        address router = RaiseCore(i.raise).router();
        if (
            router != ClaimVault(i.claims).router()
                || (router != address(0)
                    && (router.code.length == 0 || IRolloverRouterFactory(router).factory() != address(this)))
        ) revert V.InvalidConfig();
    }

    function _validate(bytes32 templateId, V.Config memory c, PortexRegistryV31.TemplateVersion memory tv)
        internal
        view
    {
        if (
            c.quote != tv.implementations.quote || c.supply < 50 || c.supply > V.MAX_SUPPLY || c.supply % 10 != 0
                || c.targetPrice == 0 || c.targetPrice > 1e36
                || Math.mulDiv(c.targetPrice, c.supply, V.SCALE) < 100000 * V.SCALE || tv.parameters.kappaMax < 1.5e18
                || c.budgetCeiling > tv.parameters.budgetCeilingMax
                || (templateId == V.ESCROW_LAUNCH && c.budgetCeiling != 0)
        ) revert V.InvalidConfig();
        // Bound stored products; listing separately validates full-range and integer-liquidity usage.
        if (CurveV31.cost(c.targetPrice, c.supply / 5, 0, c.supply / 5) > V.MAX_QUOTE / 2) revert V.InvalidConfig();
        V.Parameters memory p = tv.parameters;
        if (
            c.stage1Length < p.stage1Min || c.stage1Length > p.stage1Max || c.stage2Length < p.stage2Min
                || c.stage2Length > p.stage2Max || c.builders.length > 32
                || (templateId == V.BUDGET_LAUNCH && c.stage2Length < uint256(p.voting) + p.dispute + p.execution)
        ) revert V.InvalidConfig();
        for (uint256 i; i < c.builders.length; ++i) {
            if (c.builders[i] == address(0) || c.builders[i] == c.quote || c.builders[i] == address(this)) {
                // Bounded search/cohort validation must reject invalid inputs rather than skip them (P §3; PS §1).
                // forge-lint: disable-next-line(require-revert-in-loop)
                revert V.InvalidConfig();
            }
        }
    }
}
