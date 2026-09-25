// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TypesV31 as V} from "../src/v31/TypesV31.sol";

/// @notice Deployment-time timing profiles, applied through the curator's governed-parameter setter; the contracts
/// themselves only know the production defaults. Stage lengths are chosen per launch within the bounds, so one
/// testnet deployment can run a fast bootstrap (10-minute Stage 1, 30-minute Stage 2) and later hours-long stages.
library TimingProfiles {
    /// @notice `PORTEX_TIMINGS=testnet` selects the short profile; anything else keeps production defaults.
    function isTestnet(string memory profile) internal pure returns (bool) {
        return keccak256(bytes(profile)) == keccak256("testnet");
    }

    function testnet() internal pure returns (V.Parameters memory p) {
        p = V.productionParameters();
        p.stage1Min = 10 minutes;
        p.stage2Min = 30 minutes;
        p.vetoMax = 10 minutes;
        p.vetoTotal = 30 minutes;
        p.vetoCooldown = 10 minutes;
        p.voting = 10 minutes;
        p.dispute = 10 minutes;
        p.execution = 10 minutes;
        p.proposalInterval = 10 minutes;
        p.treasuryVesting = 7 days;
    }
}
