// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Shared board for AI analyst reports and vetoes (§5.6). The attester's only power is to
///         delay: a veto sets vetoUntil = now + vetoMaxDelay, which makes Raise.startCommitment()
///         revert while active. The council can clear a veto, starting a cooldown during which the
///         attester cannot veto again. Neither role can move or redirect funds.
///         Veto bounds (vetoMaxDelay, vetoCooldown) are per-raise, set once by the factory at
///         raise creation from the raise config.
contract AttestationBoard {
    struct Report {
        bytes32 reportHash;
        string uri;
        uint16 riskScoreBps;
        uint64 timestamp;
        bool veto;
    }

    address public immutable attester;
    address public immutable council;
    address public immutable deployer;
    address public factory;

    mapping(address raise => Report) internal reports;
    mapping(address raise => bool) public hasReport;
    mapping(address raise => uint64) public vetoUntil;
    mapping(address raise => uint64) public cooldownUntil;
    mapping(address raise => uint64) public vetoMaxDelayOf;
    mapping(address raise => uint64) public vetoCooldownOf;

    event VetoParamsSet(address indexed raise, uint64 vetoMaxDelay, uint64 vetoCooldown);
    event ReportPosted(
        address indexed raise, bytes32 indexed reportHash, string uri, uint16 riskScoreBps, bool veto, uint64 vetoUntil
    );
    event VetoCleared(address indexed raise, uint64 cooldownUntil);
    event FactorySet(address indexed factory);

    error OnlyAttester();
    error OnlyCouncil();
    error OnlyFactory();
    error OnlyDeployer();
    error FactoryAlreadySet();
    error ZeroAddress();

    modifier onlyAttester() {
        if (msg.sender != attester) revert OnlyAttester();
        _;
    }

    constructor(address attester_, address council_) {
        if (attester_ == address(0) || council_ == address(0)) revert ZeroAddress();
        attester = attester_;
        council = council_;
        deployer = msg.sender;
    }

    /// @notice One-time wiring: the factory is the only caller allowed to set per-raise veto params.
    function setFactory(address factory_) external {
        if (msg.sender != deployer) revert OnlyDeployer();
        if (factory != address(0)) revert FactoryAlreadySet();
        if (factory_ == address(0)) revert ZeroAddress();
        factory = factory_;
        emit FactorySet(factory_);
    }

    /// @notice Called by the factory at raise creation. Veto bounds live in the raise config.
    function setVetoParams(address raise, uint64 vetoMaxDelay, uint64 vetoCooldown) external {
        if (msg.sender != factory) revert OnlyFactory();
        vetoMaxDelayOf[raise] = vetoMaxDelay;
        vetoCooldownOf[raise] = vetoCooldown;
        emit VetoParamsSet(raise, vetoMaxDelay, vetoCooldown);
    }

    /// @notice Post the latest analyst report for a raise. With veto=true and no active cooldown,
    ///         sets vetoUntil = now + vetoMaxDelay. The report is stored either way.
    function postReport(address raise, bytes32 reportHash, string calldata uri, uint16 riskScoreBps, bool veto)
        external
        onlyAttester
    {
        uint64 newVetoUntil = vetoUntil[raise];
        if (veto && block.timestamp >= cooldownUntil[raise]) {
            newVetoUntil = uint64(block.timestamp) + vetoMaxDelayOf[raise];
            vetoUntil[raise] = newVetoUntil;
        }
        reports[raise] = Report({
            reportHash: reportHash, uri: uri, riskScoreBps: riskScoreBps, timestamp: uint64(block.timestamp), veto: veto
        });
        hasReport[raise] = true;
        emit ReportPosted(raise, reportHash, uri, riskScoreBps, veto, newVetoUntil);
    }

    /// @notice Clear an active veto and start the cooldown during which the attester cannot veto again.
    function clearVeto(address raise) external {
        if (msg.sender != council) revert OnlyCouncil();
        vetoUntil[raise] = 0;
        uint64 cd = uint64(block.timestamp) + vetoCooldownOf[raise];
        cooldownUntil[raise] = cd;
        emit VetoCleared(raise, cd);
    }

    function vetoActive(address raise) external view returns (bool) {
        return block.timestamp < vetoUntil[raise];
    }

    function getReport(address raise) external view returns (Report memory) {
        return reports[raise];
    }
}
