// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TypesV31 as V} from "../src/v31/TypesV31.sol";

/// @notice Deployment-time timing profiles, applied through the curator's governed-parameter setter; the contracts
/// themselves only know the production defaults. Stage lengths are chosen per launch within the bounds, so one
/// testnet deployment can run a fast bootstrap (5-minute Stage 1, 10-minute Stage 2) and later hours-long stages.
library TimingProfiles {
    /// @notice `PORTEX_TIMINGS=testnet` selects the short profile; anything else keeps production defaults.
    function isTestnet(string memory profile) internal pure returns (bool) {
        return keccak256(bytes(profile)) == keccak256("testnet");
    }

    function testnet() internal pure returns (V.Parameters memory p) {
        p = V.productionParameters();
        p.stage1Min = 5 minutes;
        p.stage2Min = 10 minutes;
        p.vetoMax = 5 minutes;
        p.vetoTotal = 15 minutes;
        p.vetoCooldown = 5 minutes;
        p.voting = 3 minutes;
        p.dispute = 3 minutes;
        p.execution = 3 minutes;
        p.proposalInterval = 3 minutes;
        p.treasuryVesting = 7 days;
    }
}
