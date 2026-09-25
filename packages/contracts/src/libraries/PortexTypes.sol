// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Per-raise configuration. All durations are plain seconds supplied at creation
///         (see PORTEX_V1_DESIGN.md §4). `deadline` is a duration measured from raise start.
struct RaiseConfig {
    address quoteAsset; // whitelisted ERC-20 quote asset (e.g. USDG, 6 decimals)
    uint256 softCap; // capital gate to leave Incubation
    uint256 hardCap; // deposit ceiling
    uint64 minIncubation; // time gate: seconds from start before commitment may open
    uint64 deadline; // seconds from start; fail if gates unmet by start + deadline
    uint256 totalSupply; // project token supply (18 decimals), minted once to the raise
    uint256 stage1Alloc; // A1: tokens entitled to Stage 1 backers
    uint256 stage2Inventory; // T0: tokens the Stage 2 pool can sell (must be >= A1)
    uint256 vaultAlloc; // Diamond Vault token rewards (streamed after Stage 3)
    uint256 builderAlloc; // builder allocation, vests linearly after Stage 3
    uint64 commitmentWindow; // epoch 0 length, seconds
    uint64 epochLength; // seconds per Growth epoch
    uint8 numTranches; // N, 1..32
    uint16 minOptInBps; // share of tranche-1 principal that must commit in epoch 0
    uint16 swapFeeBps; // pool fee on quote volume
    uint16 feeReserveBps; // fee split: share staying in pool reserve
    uint16 feeVaultBps; // fee split: share to Diamond Vault quote rewards
    uint16 feeBuilderBps; // fee split: share to builder
    uint256 minGraduationLiquidity; // real quote needed to migrate to Stage 3
    uint16 minRealRatioBps; // R/(R+V) needed to migrate
    uint64 builderVesting; // seconds of linear vesting after migration (0 = instant)
    uint64 vaultDuration; // seconds of vault token emission after migration
    uint64 vetoMaxDelay; // AI veto delay, seconds
    uint64 vetoCooldown; // cooldown after a cleared veto, seconds
    uint16 maxCumulativeSpendBps; // Rule 2 hard ceiling of peak principal (0 under Rule 1)
    GovernorConfig governor; // Rule 2 voting parameters (ignored when the template has no governorImpl)
}

/// @notice Stage 0/1 gates with current vs required values.
struct CommitmentGates {
    uint256 now_;
    uint256 incubationEndsAt;
    bool timeMet;
    uint256 principalNow;
    uint256 softCapRequired;
    bool capitalMet;
    uint256 deadlineTimestamp;
    bool beforeDeadline;
    bool vetoActive;
    uint256 optInCommitted;
    uint256 optInRequired;
    bool optInMet;
}

/// @notice Stage 3 migration gates with current vs required values.
struct GraduationGates {
    uint256 epochNow;
    uint256 epochsRequired;
    uint256 poolR;
    uint256 minLiquidity;
    uint16 realRatioNow;
    uint16 minRealRatio;
}

/// @notice ERC-20 metadata for the per-raise project token.
struct TokenMeta {
    string name;
    string symbol;
}

/// @notice Rule 2 governor parameters for a raise (used only when the template pins a
///         governorImpl; ignored under ZERO_EXTRACTION). See SpendGovernor / design §5.7.
struct GovernorConfig {
    uint64 votingPeriod; // seconds of voting per proposal
    uint64 disputeWindow; // seconds after a pass during which non-YES voters may exit at 100%
    uint64 minProposalInterval; // seconds between successive proposals
    uint16 quorumBps; // min participation, bps of total principal at proposal creation
    uint16 approvalBps; // min YES share of votes cast, bps
}
