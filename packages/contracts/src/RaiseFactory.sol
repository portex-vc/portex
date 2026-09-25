// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {RaiseConfig, GovernorConfig, TokenMeta} from "./libraries/PortexTypes.sol";
import {PortexRegistry} from "./PortexRegistry.sol";
import {AttestationBoard} from "./AttestationBoard.sol";
import {Raise} from "./Raise.sol";
import {Stage2Pool} from "./Stage2Pool.sol";
import {DiamondVault} from "./DiamondVault.sol";
import {ProjectToken} from "./ProjectToken.sol";
import {SpendGovernor} from "./SpendGovernor.sol";

/// @notice Deploys raises as EIP-1167 clones of an exact published registry version (§3).
///         A raise is pinned to its version for life — including the DEX adapter its liquidity
///         will migrate to (pinned in the registry version, not factory config). The factory
///         holds protocol config: quote-asset whitelist, protocol fee recipient, and mirrors
///         attester / council from the AttestationBoard. No factory function can move or
///         redirect user funds.
contract RaiseFactory {
    uint256 internal constant BPS = 10_000;
    uint8 internal constant MAX_TRANCHES = 32;

    struct TemplateRef {
        bytes32 templateId;
        uint64 version;
    }

    PortexRegistry public immutable registry;
    AttestationBoard public immutable board;
    address public immutable tokenImpl;
    address public owner;
    address public protocolFeeRecipient; // reserved for future fee templates; unused in v1

    mapping(address asset => bool) public quoteWhitelist;
    mapping(address raise => TemplateRef) internal templates;
    address[] public allRaises;

    /// @dev The full config is emitted in RaiseConfigured (same transaction, adjacent log):
    ///      encoding a 25-field struct alongside 8 other fields overflows the legacy codegen stack.
    event RaiseCreated(
        address indexed raise,
        address indexed builder,
        bytes32 indexed templateId,
        uint64 version,
        address token,
        address pool,
        address vault,
        address governor
    );
    event RaiseConfigured(address indexed raise, RaiseConfig cfg, string tokenName, string tokenSymbol);
    event QuoteAssetUpdated(address indexed asset, bool allowed);
    event ProtocolFeeRecipientUpdated(address indexed recipient);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error OnlyOwner();
    error NotWhitelisted();
    error VersionMissing();
    error VersionDeprecated();
    error AllocationsMismatch();
    error InventoryBelowAlloc();
    error CapsInvalid();
    error DurationsInvalid();
    error FeeSplitInvalid();
    error BpsInvalid();
    error TranchesInvalid();
    error ZeroAmount();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    constructor(
        PortexRegistry registry_,
        AttestationBoard board_,
        address tokenImpl_,
        address protocolFeeRecipient_,
        address owner_
    ) {
        registry = registry_;
        board = board_;
        tokenImpl = tokenImpl_;
        protocolFeeRecipient = protocolFeeRecipient_;
        owner = owner_;
    }

    /// @notice Create a raise pinned to (templateId, version). Reverts unless the config passes
    ///         every creation-time validation in design §4.
    function createRaise(bytes32 templateId, uint64 version, RaiseConfig calldata cfg, TokenMeta calldata tokenMeta)
        external
        returns (address raiseAddr)
    {
        _validateConfig(cfg);
        raiseAddr = _deployAndInit(templateId, version, cfg, tokenMeta, msg.sender);
        templates[raiseAddr] = TemplateRef({templateId: templateId, version: version});
        allRaises.push(raiseAddr);
    }

    function _deployAndInit(
        bytes32 templateId,
        uint64 version,
        RaiseConfig calldata cfg,
        TokenMeta calldata tokenMeta,
        address builder
    ) internal returns (address raiseAddr) {
        PortexRegistry.TemplateVersion memory tv = registry.getVersion(templateId, version);
        if (tv.raiseImpl == address(0)) revert VersionMissing();
        if (tv.deprecated) revert VersionDeprecated();
        if (tv.dexAdapter == address(0)) revert ZeroAddress(); // the version must pin a migration target
        if (tv.governorImpl != address(0)) _validateGovernorConfig(cfg.governor);

        (Raise raise, Stage2Pool pool, DiamondVault vault, ProjectToken token, address governor) = _deployClones(tv);
        raiseAddr = address(raise);
        if (governor != address(0)) SpendGovernor(governor).initialize(raiseAddr, cfg.governor);

        token.initialize(tokenMeta.name, tokenMeta.symbol, cfg.totalSupply, raiseAddr);
        vault.initialize(raiseAddr, address(token), cfg.quoteAsset, cfg.vaultDuration, address(pool));
        _initPool(pool, raiseAddr, token, vault, cfg, tv.dexAdapter);
        _initRaise(raise, cfg, builder, governor, token, pool, vault);

        emit RaiseCreated(
            raiseAddr, builder, templateId, version, address(token), address(pool), address(vault), governor
        );
        emit RaiseConfigured(raiseAddr, cfg, tokenMeta.name, tokenMeta.symbol);
    }

    function _deployClones(PortexRegistry.TemplateVersion memory tv)
        internal
        returns (Raise raise, Stage2Pool pool, DiamondVault vault, ProjectToken token, address governor)
    {
        raise = Raise(payable(Clones.clone(tv.raiseImpl)));
        pool = Stage2Pool(Clones.clone(tv.poolImpl));
        vault = DiamondVault(Clones.clone(tv.vaultImpl));
        token = ProjectToken(Clones.clone(tokenImpl));
        governor = tv.governorImpl == address(0) ? address(0) : Clones.clone(tv.governorImpl);
    }

    function _initRaise(
        Raise raise,
        RaiseConfig calldata cfg,
        address builder,
        address governor,
        ProjectToken token,
        Stage2Pool pool,
        DiamondVault vault
    ) internal {
        raise.initialize(cfg, builder, governor, token, pool, vault);
        raise.wire(board);
        board.setVetoParams(address(raise), cfg.vetoMaxDelay, cfg.vetoCooldown);
    }

    function _initPool(
        Stage2Pool pool,
        address raiseAddr,
        ProjectToken token,
        DiamondVault vault,
        RaiseConfig calldata cfg,
        address dexAdapter
    ) internal {
        pool.initialize(
            raiseAddr,
            address(token),
            cfg.quoteAsset,
            address(vault),
            dexAdapter,
            cfg.swapFeeBps,
            cfg.feeReserveBps,
            cfg.feeVaultBps,
            cfg.feeBuilderBps
        );
    }

    // ---------------- protocol config (no path to user funds) ----------------

    function setQuoteAsset(address asset, bool allowed) external onlyOwner {
        quoteWhitelist[asset] = allowed;
        emit QuoteAssetUpdated(asset, allowed);
    }

    function setProtocolFeeRecipient(address recipient) external onlyOwner {
        protocolFeeRecipient = recipient;
        emit ProtocolFeeRecipientUpdated(recipient);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ---------------- views ----------------

    /// @notice The (templateId, version) a raise is pinned to for life.
    function templateOf(address raise) external view returns (bytes32 templateId, uint64 version) {
        TemplateRef memory ref = templates[raise];
        return (ref.templateId, ref.version);
    }

    function isRaise(address raise) external view returns (bool) {
        return templates[raise].templateId != bytes32(0);
    }

    function raisesCount() external view returns (uint256) {
        return allRaises.length;
    }

    function raiseAt(uint256 i) external view returns (address) {
        return allRaises[i];
    }

    /// @notice Canonical protocol roles, mirrored from the board (single source of truth).
    function attester() external view returns (address) {
        return board.attester();
    }

    function council() external view returns (address) {
        return board.council();
    }

    // ---------------- internals ----------------

    /// @dev Governor params are validated only for governed templates; under ZERO_EXTRACTION
    ///      the governor field is ignored (and may hold anything).
    function _validateGovernorConfig(GovernorConfig calldata g) internal pure {
        if (g.votingPeriod == 0 || g.disputeWindow == 0) revert DurationsInvalid();
        if (g.quorumBps == 0 || g.quorumBps > BPS) revert BpsInvalid();
        if (g.approvalBps == 0 || g.approvalBps > BPS) revert BpsInvalid();
    }

    function _validateConfig(RaiseConfig calldata cfg) internal view {
        if (!quoteWhitelist[cfg.quoteAsset]) revert NotWhitelisted();
        if (cfg.stage1Alloc + cfg.stage2Inventory + cfg.vaultAlloc + cfg.builderAlloc != cfg.totalSupply) {
            revert AllocationsMismatch();
        }
        if (cfg.stage2Inventory < cfg.stage1Alloc) revert InventoryBelowAlloc();
        if (cfg.softCap == 0 || cfg.softCap > cfg.hardCap) revert CapsInvalid();
        if (cfg.minIncubation >= cfg.deadline) revert DurationsInvalid();
        if (cfg.commitmentWindow == 0 || cfg.epochLength == 0 || cfg.vaultDuration == 0) revert DurationsInvalid();
        if (cfg.numTranches == 0 || cfg.numTranches > MAX_TRANCHES) revert TranchesInvalid();
        if (uint256(cfg.feeReserveBps) + cfg.feeVaultBps + cfg.feeBuilderBps != BPS) revert FeeSplitInvalid();
        if (cfg.swapFeeBps > BPS) revert BpsInvalid();
        if (cfg.minOptInBps > BPS) revert BpsInvalid();
        // minRealRatioBps == BPS is mathematically unattainable while T0 > A1: the real ratio
        // R/(R+V) can only approach 1, since V >= b·(T0−A1) > 0 and trades never change V
        // (audit M-02). Rejecting >= BPS keeps graduate() reachable for every created raise.
        if (cfg.minRealRatioBps >= BPS) revert BpsInvalid();
        if (cfg.maxCumulativeSpendBps > BPS) revert BpsInvalid();
        if (cfg.stage1Alloc == 0) revert ZeroAmount();
        // a zero liquidity gate would let graduate() burn the pool inventory without seeding a pair
        if (cfg.minGraduationLiquidity == 0) revert ZeroAmount();
    }
}
