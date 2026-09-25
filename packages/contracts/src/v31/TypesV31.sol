// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ProtectedSplitLib} from "../libraries/ProtectedSplitLib.sol";

/// @notice P = PORTEX_PROTOCOL v3.1; PS = PROTECTED_SPLIT. Native quote is USDG-6.
library TypesV31 {
    uint256 internal constant SCALE = 1e18;
    uint256 internal constant NORMALIZED_PRICE = 1e30;
    uint256 internal constant MAX_SUPPLY = 1e30;
    uint256 internal constant MAX_QUOTE = 1e30;
    bytes32 internal constant ESCROW_LAUNCH = keccak256("ESCROW_LAUNCH");
    bytes32 internal constant BUDGET_LAUNCH = keccak256("BUDGET_LAUNCH");
    /// @notice Published-template default: a Stage 3 spend is worth at most 5% of the YES tokens' market value.
    uint16 internal constant SPEND_CAP_BPS = 500;
    /// @notice Published-template default: the 10% treasury allocation unlocks linearly over five years.
    uint64 internal constant TREASURY_VESTING = 1825 days;

    enum Phase {
        Stage1,
        Stage2,
        ListingPending,
        Stage3,
        Dissolved
    }
    enum Class {
        Backer,
        Buyer,
        BuilderPurchase
    }
    enum Reason {
        None,
        PhaseClosed,
        InvalidPosition,
        InvalidQuantity,
        StaleNonce,
        EmptyBook,
        Insolvent,
        PriceInvalid,
        VenueUnavailable,
        Migrating,
        Unauthorized
    }
    enum Branch {
        Positive,
        QuoteWithoutTokens,
        ZeroQuote,
        Empty
    }

    struct Config {
        address quote;
        address treasury;
        uint256 supply;
        uint256 targetPrice;
        uint256 budgetCeiling;
        uint64 stage1Length;
        uint64 stage2Length;
        address[] builders;
    }

    struct Parameters {
        uint256 kappaMax;
        uint256 budgetCeilingMax;
        uint64 vetoMax;
        uint64 vetoTotal;
        uint64 vetoCooldown;
        uint64 voting;
        uint64 dispute;
        uint64 execution;
        uint64 proposalInterval;
        uint16 minimumBackers;
        uint16 tradeFeeBps;
        uint16 surchargeBps;
        // Governed timings, pinned per published version and from there into every raise (P §6).
        uint64 stage1Min;
        uint64 stage1Max;
        uint64 stage2Min;
        uint64 stage2Max;
        uint64 treasuryVesting;
    }

    /// @notice Production defaults. Testnets lower the timings through the curator's `setProtocolParameters`.
    function productionParameters() internal pure returns (Parameters memory) {
        return Parameters(
            2e18,
            0.3e18,
            2 days,
            7 days,
            1 days,
            3 days,
            7 days,
            2 days,
            1 days,
            10,
            100,
            0,
            15 days,
            60 days,
            35 days,
            70 days,
            TREASURY_VESTING
        );
    }

    struct Modules {
        address token;
        address vesting;
        address governor;
        address claims;
        address adapter;
        address attester;
        address council;
    }

    struct Position {
        address owner;
        Class class;
        uint256 tokens;
        uint256 basis;
        uint256 shares;
        uint256 historicalRemaining;
    }

    struct Validity {
        bool available;
        Reason reason;
        Phase phase;
        uint256 stateNonce;
    }

    struct Claim {
        Validity validity;
        uint256 amount;
        uint64 validUntil;
        Phase phase;
        uint256 stateNonce;
    }

    struct ExitQuote {
        Validity validity;
        ProtectedSplitLib.Result result;
        uint256 bookBurn;
        uint256 depthBurn;
    }

    struct Fees {
        uint256 total;
        uint256 reserve;
        uint256 reward;
        uint256 treasury;
    }

    struct TradeQuote {
        Validity validity;
        uint256 gross;
        uint256 ammAmount;
        uint256 tokens;
        uint256 net;
        Fees fees;
        uint256 priceBefore;
        uint256 priceAfter;
        uint256 priceImpactBps;
        uint256 depthBurn;
    }

    struct PositionView {
        Validity validity;
        address owner;
        Class class;
        uint256 tokens;
        uint256 basis;
        uint256 shares;
        uint256 quota;
        Phase phase;
    }

    struct ReserveState {
        Validity validity;
        uint256 E;
        uint256 R;
        uint256 V;
        uint256 T;
        uint256 O;
        uint256 X0;
        uint256 lastT;
        uint256 H;
        uint256 J;
        uint256 claimCount;
        uint256 stateNonce;
    }

    struct Bounds {
        Validity validity;
        address asset;
        uint256 lower;
        uint256 upper;
        bytes32 conditions;
        bytes32 backingBucket;
        uint256 stateNonce;
    }

    struct Deadlines {
        Validity validity;
        uint64 start;
        uint64 stage1End;
        uint64 vetoUntil;
        uint64 stage2Start;
        uint64 stage2End;
        uint64 listedAt;
    }

    struct ListingStatus {
        Validity validity;
        bool liveCostEligible;
        uint256 basis;
        uint256 liquidTokens;
        uint256 vestedTokens;
        address destination;
    }

    struct ListingPreview {
        Validity validity;
        Branch branch;
        uint256 price;
        uint160 sqrtPriceX96;
        uint256 escrowRolled;
        uint256 desiredQuote;
        uint256 desiredToken;
        uint256 usedQuote;
        uint256 usedToken;
        uint256 minQuote;
        uint256 minToken;
        uint128 liquidity;
        uint256 bookBurn;
        uint256 liquidityReserveBurn;
        uint256 depthBurn;
        uint256 quoteDust;
        uint256 backerDelivery;
        uint256 buyerDelivery;
        uint256 builderDelivery;
        address ordinaryDestination;
        address builderDestination;
        uint256 claimLiabilities;
        bool claimsEndOnSuccess;
    }

    error Unauthorized();
    error InvalidConfig();
    error InvalidPhase();
    error InvalidAmount();
    error InvalidPosition();
    error StaleNonce();
    error Expired();
    error Slippage();
    error InvariantFailure();
    error WrongAssetDelta();
    error Reentrancy();
    error VenueFailure();
}
