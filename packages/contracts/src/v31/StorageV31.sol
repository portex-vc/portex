// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ProtectedSplitLib as PS} from "../libraries/ProtectedSplitLib.sol";
import {TypesV31 as V} from "./TypesV31.sol";
import {IDexAdapterV31} from "./IDexAdapterV31.sol";

/// @notice Shared, non-upgradeable layout used by statically linked v3.1 libraries (P §1/I2).
library StorageV31 {
    struct State {
        V.Config config;
        V.Parameters parameters;
        V.Modules modules;
        address factory;
        address builder;
        bytes32 templateId;
        uint64 version;
        bytes32 bundleHash;
        bytes32 adapterHash;
        V.Phase phase;
        V.Deadlines deadlines;
        uint64 vetoUsed;
        uint64 cooldownUntil;
        uint256 nonce;
        bool busy;
        address activeModule;
        PS.Book book;
        uint256 sold;
        uint256 builderPurchased;
        uint256 totalBackerTokens;
        uint256 totalBuilderTokens;
        uint256 backerHolders;
        uint256 liveBackers;
        uint256 liquidityReserve;
        uint256 x0;
        uint256 lastT;
        uint256 H;
        uint256 J;
        uint256 claimCount;
        uint256 ceilingAmount;
        uint256 drawn;
        uint256 pEnd;
        uint256 lastPrice;
        uint256 rewardFees;
        uint256 treasuryFees;
        uint256 reserveFeesCumulative;
        uint256 listingDust;
        uint256 positionCount;
        mapping(uint256 => V.Position) positions;
        mapping(address => bool) isBuilder;
        mapping(address => uint256) backerTokens;
        mapping(address => uint256) backerBasis;
        mapping(address => uint256) builderTokens;
        mapping(address => uint256) buyerTokens;
        mapping(address => uint256) buyerId;
        IDexAdapterV31.Receipt listingReceipt;
        bytes32 callbackPool;
        uint256 callbackQuote;
        uint256 callbackToken;
        bool callbackPending;
        bool migrating;
        uint256 eligibleShares;
    }

    function effectivePhase(State storage s) internal view returns (V.Phase) {
        // Protocol deadlines and daily release explicitly use block time (P §§2.4,12.2).
        // forge-lint: disable-next-line(block-timestamp)
        if (s.phase == V.Phase.Stage2 && block.timestamp >= s.deadlines.stage2End) return V.Phase.ListingPending;
        return s.phase;
    }

    function budget(State storage s) internal view returns (bool) {
        return s.templateId == V.BUDGET_LAUNCH;
    }

    function time(State storage s) internal view returns (uint256) {
        uint256 start = s.deadlines.stage2Start;
        // Protocol deadlines and daily release explicitly use block time (P §§2.4,12.2).
        // forge-lint: disable-next-line(block-timestamp)
        if (start == 0 || block.timestamp <= start) return 0;
        // Protocol deadlines and daily release explicitly use block time (P §§2.4,12.2).
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= s.deadlines.stage2End) return V.SCALE;
        return Math.mulDiv(block.timestamp - start, V.SCALE, s.config.stage2Length);
    }

    function basis(State storage s, V.Position storage p) internal view returns (uint256) {
        if (p.class == V.Class.Buyer || p.tokens == 0 || s.phase == V.Phase.Stage3 || s.phase == V.Phase.Dissolved) {
            return 0;
        }
        if (!budget(s) || s.phase == V.Phase.Stage1) return p.basis;
        if (p.shares == 0) return 0;
        if (s.claimCount == 1) return s.book.E;
        return Math.mulDiv(p.shares, s.J, V.SCALE);
    }

    function reduceShares(State storage s, V.Position storage p, uint256 q, uint256 cost, uint256 liveBasis) internal {
        uint256 previous = p.shares;
        if (q == p.tokens) {
            p.shares = 0;
        } else if (budget(s) && s.phase != V.Phase.Stage1) {
            if (s.claimCount > 1 && s.J != 0) {
                p.shares = Math.mulDiv(liveBasis - cost, V.SCALE, s.J, Math.Rounding.Ceil);
            }
        } else {
            p.shares -= cost;
        }
        uint256 removed = previous - p.shares;
        s.H -= removed;
        if (p.class == V.Class.Backer && !s.isBuilder[p.owner]) s.eligibleShares -= removed;
        if (previous != 0 && p.shares == 0) --s.claimCount;
    }
}
