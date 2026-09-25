// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {TypesV31 as V} from "./TypesV31.sol";

/// @notice Append-only launch versions; curator authority affects only future creations (P §§1,5–7).
/// Stage lengths, veto and governance timers and treasury vesting are governed parameters: production defaults at
/// deployment, curator-settable, and pinned into each published version and from there into every raise.
contract PortexRegistryV31 {
    uint16 public constant MAX_TRADE_FEE_BPS = 100;
    uint16 public constant MAX_SURCHARGE_BPS = 50;

    struct Implementations {
        address raise;
        address token;
        address vesting;
        address governor;
        address claims;
        address adapter;
        address quote;
        address attester;
        address council;
        address treasury;
    }

    struct TemplateVersion {
        Implementations implementations;
        V.Parameters parameters;
        bytes32 bundleHash;
        uint64 publishedAt;
        bool deprecated;
    }
    /// @notice Upper bound for every stage length, so later timestamp additions stay bounded.
    uint64 public constant MAX_STAGE_LENGTH = 365 days;
    /// @notice Upper bound for the treasury schedule; the production default is five years.
    uint64 public constant MAX_TREASURY_VESTING = 3650 days;
    address public immutable curator;
    V.Parameters private parameters;
    mapping(address => bytes32) public quoteCodeHash;
    mapping(address => bool) public quoteFrozen;
    mapping(bytes32 => mapping(uint64 => TemplateVersion)) private versions;
    mapping(bytes32 => uint64[]) private versionList;
    event VersionPublished(
        bytes32 indexed templateId,
        uint64 indexed version,
        bytes32 bundleHash,
        Implementations implementations,
        V.Parameters parameters
    );
    event VersionDeprecated(bytes32 indexed templateId, uint64 indexed version);
    event ProtocolParametersUpdated(V.Parameters parameters);
    event QuoteWhitelisted(address indexed quote, bytes32 codeHash, bool quoteFrozen);

    constructor(address curator_) {
        if (curator_ == address(0)) revert V.InvalidConfig();
        curator = curator_;
        parameters = V.productionParameters();
    }
    modifier onlyCurator() {
        if (msg.sender != curator) revert V.Unauthorized();
        _;
    }

    /// @notice Whitelist audited USDG-6 bytecode; unsupported transfer/rebase/pause behavior is refused (P §5.13).
    function whitelistQuote(address, bool, bool, bool) external view onlyCurator {
        revert V.InvalidConfig();
    }

    /// @notice Curator attestation is a trust decision, not a proof of immutable external token behavior (P I2).
    function whitelistQuote(address asset, bool feeOnTransfer, bool rebasing, bool pausable, bool quoteFrozen_)
        external
        onlyCurator
    {
        if (
            !quoteFrozen_ || asset.code.length == 0 || feeOnTransfer || rebasing || pausable
                || IERC20Metadata(asset).decimals() != 6
        ) {
            revert V.InvalidConfig();
        }
        quoteCodeHash[asset] = asset.codehash;
        quoteFrozen[asset] = quoteFrozen_;
        emit QuoteWhitelisted(asset, asset.codehash, quoteFrozen_);
    }

    /// @notice Parameters for future publications only; published versions and existing raises keep theirs (P §§3,6).
    function setProtocolParameters(V.Parameters calldata p) external onlyCurator {
        _validateParameters(p);
        parameters = p;
        emit ProtocolParametersUpdated(p);
    }

    /// @notice Publish an immutable, code-hashed composition for exactly one supported launch type (P §§5–7).
    function publish(bytes32 templateId, uint64 version, Implementations calldata implementations)
        external
        onlyCurator
    {
        if (templateId != V.ESCROW_LAUNCH && templateId != V.BUDGET_LAUNCH) revert V.InvalidConfig();
        uint256 count = versionList[templateId].length;
        if (version == 0 || (count != 0 && version <= versionList[templateId][count - 1])) revert V.InvalidConfig();
        _validateImplementations(implementations);
        bytes32 hash = bundleHash(implementations, parameters);
        versions[templateId][version] =
            TemplateVersion(implementations, parameters, hash, SafeCast.toUint64(block.timestamp), false);
        versionList[templateId].push(version);
        emit VersionPublished(templateId, version, hash, implementations, parameters);
    }

    /// @notice Deprecation blocks only new raises; existing versions remain readable (P §1/I2).
    function deprecate(bytes32 templateId, uint64 version) external onlyCurator {
        TemplateVersion storage tv = versions[templateId][version];
        if (tv.implementations.raise == address(0)) revert V.InvalidConfig();
        tv.deprecated = true;
        emit VersionDeprecated(templateId, version);
    }

    /// @notice Full pinned code/parameters/authority bundle (P §1/I2).
    function getVersion(bytes32 templateId, uint64 version) external view returns (TemplateVersion memory) {
        return versions[templateId][version];
    }

    /// @notice Current bounds for future publication only (P §6).
    function protocolParameters() external view returns (V.Parameters memory) {
        return parameters;
    }

    /// @notice Append-only version enumeration (P §1/I2).
    function versionCount(bytes32 templateId) external view returns (uint256) {
        return versionList[templateId].length;
    }

    /// @notice A published version by insertion index (P §1/I2).
    function versionAt(bytes32 templateId, uint256 index) external view returns (uint64) {
        return versionList[templateId][index];
    }

    /// @notice Recompute deployed bytecode plus all pinned configuration and roles (P §§1,5).
    function bundleHash(Implementations memory i, V.Parameters memory p) public view returns (bytes32) {
        bytes32[8] memory hashes = [
            i.raise.codehash,
            i.token.codehash,
            i.vesting.codehash,
            i.governor.codehash,
            i.claims.codehash,
            i.adapter.codehash,
            i.quote.codehash,
            i.treasury.codehash
        ];
        return keccak256(abi.encode(i, p, hashes));
    }

    function _validateImplementations(Implementations calldata i) internal view {
        if (
            i.raise.code.length == 0 || i.token.code.length == 0 || i.vesting.code.length == 0
                || i.governor.code.length == 0 || i.claims.code.length == 0 || i.adapter.code.length == 0
                || i.treasury.code.length == 0 || i.attester == address(0) || i.council == address(0)
                || quoteCodeHash[i.quote] == bytes32(0) || !quoteFrozen[i.quote]
                || quoteCodeHash[i.quote] != i.quote.codehash
        ) revert V.InvalidConfig();
    }

    function _validateParameters(V.Parameters calldata p) internal pure {
        bool fixedTerms = p.kappaMax < 1.5e18 || p.budgetCeilingMax > V.SCALE || p.vetoMax == 0
            || p.vetoTotal < p.vetoMax || p.minimumBackers != 10 || p.tradeFeeBps != 100 || p.surchargeBps != 0;
        // Timings are governed, never demo-specific: production caps bound the attester's veto, and every
        // relation that keeps a launch live holds at any scale (a Budget vote fits the shortest Stage 2).
        bool stages = p.stage1Min == 0 || p.stage1Min > p.stage1Max || p.stage1Max > MAX_STAGE_LENGTH
            || p.stage2Min == 0 || p.stage2Min > p.stage2Max || p.stage2Max > MAX_STAGE_LENGTH;
        bool timers = p.vetoMax > 2 days || p.vetoTotal > 7 days || p.vetoTotal > p.stage1Max || p.vetoCooldown == 0
            || p.voting == 0 || p.dispute == 0 || p.execution == 0 || p.proposalInterval == 0
            || uint256(p.voting) + p.dispute + p.execution > p.stage2Min || p.treasuryVesting == 0
            || p.treasuryVesting > MAX_TREASURY_VESTING;
        if (fixedTerms || stages || timers) revert V.InvalidConfig();
    }
}
