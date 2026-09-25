// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IDexAdapter} from "./interfaces/IDexAdapter.sol";

interface IRaise {
    function builder() external view returns (address);
}

interface IProjectToken {
    function burn(uint256 amount) external;
}

interface IVault {
    function notifyQuoteReward(uint256 amount) external;
}

/// @notice Stage 2 Growth pool (§5.3): constant-product on (Q, T) where Q = R + V,
///         R = real quote, V = virtual quote. Opens exactly at the Stage 1 flat price:
///         T = T0, R = 0, V = V0 = P_tot·T0/A1. Committed principal converts V into R without
///         moving the price. Fees are in quote and split reserve / vault / builder.
///         All rounding favours the pool. Sells are paid from R only (guarded).
contract Stage2Pool is Initializable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;
    using Math for uint256;

    uint256 internal constant BPS = 10_000;

    enum PoolState {
        Pending, // initialised, waiting for the raise to open it
        Open,
        Migrated
    }

    address public raise;
    IERC20 public token;
    IERC20 public quote;
    address public vault;
    IDexAdapter public dexAdapter;
    uint16 public swapFeeBps;
    uint16 public feeReserveBps;
    uint16 public feeVaultBps;
    uint16 public feeBuilderBps;

    PoolState public poolState;
    uint256 public T; // tokens in the pool
    uint256 public R; // real quote reserve
    uint256 public V; // virtual quote reserve
    uint256 public builderAccrued; // builder-claimable quote (excluded from R)

    event PoolOpened(uint256 T0, uint256 V0);
    event Converted(uint256 amount, uint256 R, uint256 V, uint256 T);
    event Buy(
        address indexed trader,
        uint256 quoteIn,
        uint256 tokensOut,
        uint256 feeReserve,
        uint256 feeVault,
        uint256 feeBuilder,
        uint256 R,
        uint256 V,
        uint256 T
    );
    event Sell(
        address indexed trader,
        uint256 tokensIn,
        uint256 quoteOut,
        uint256 feeReserve,
        uint256 feeVault,
        uint256 feeBuilder,
        uint256 R,
        uint256 V,
        uint256 T
    );
    event Graduated(uint256 quoteSeeded, uint256 tokensSeeded, uint256 tokensBurned);
    event BuilderFeesClaimed(address indexed builder, uint256 amount);

    error OnlyRaise();
    error InvalidPoolState();
    error ZeroAmount();
    error Slippage();
    error InsufficientReserve();
    error ConvertExceedsVirtual();
    error NothingToClaim();

    modifier onlyRaise() {
        if (msg.sender != raise) revert OnlyRaise();
        _;
    }

    constructor() {
        _disableInitializers();
    }

    /// @notice Called once by the factory, right after cloning. Approvals to the DEX adapter
    ///         are granted here so migration can seed without further transactions.
    function initialize(
        address raise_,
        address token_,
        address quote_,
        address vault_,
        address dexAdapter_,
        uint16 swapFeeBps_,
        uint16 feeReserveBps_,
        uint16 feeVaultBps_,
        uint16 feeBuilderBps_
    ) external initializer {
        __ReentrancyGuard_init();
        raise = raise_;
        token = IERC20(token_);
        quote = IERC20(quote_);
        vault = vault_;
        dexAdapter = IDexAdapter(dexAdapter_);
        swapFeeBps = swapFeeBps_;
        feeReserveBps = feeReserveBps_;
        feeVaultBps = feeVaultBps_;
        feeBuilderBps = feeBuilderBps_;
        if (dexAdapter_ != address(0)) {
            token.approve(dexAdapter_, type(uint256).max);
            quote.approve(dexAdapter_, type(uint256).max);
        }
    }

    /// @notice Open the pool at the Stage 1 price. Pulls T0 tokens from the raise.
    ///         T = T0, R = 0, V = V0 (= P_tot·T0/A1, computed by the raise with mulDiv).
    function open(uint256 t0, uint256 v0) external onlyRaise nonReentrant {
        if (poolState != PoolState.Pending) revert InvalidPoolState();
        poolState = PoolState.Open;
        T = t0;
        V = v0;
        token.safeTransferFrom(raise, address(this), t0);
        emit PoolOpened(t0, v0);
    }

    /// @notice Convert committed principal from virtual into real reserve. Price does not move.
    ///         Pulls the quote from the raise's escrow.
    function convert(uint256 amount) external onlyRaise nonReentrant {
        if (poolState != PoolState.Open) revert InvalidPoolState();
        if (amount == 0) revert ZeroAmount();
        if (amount > V) revert ConvertExceedsVirtual();
        R += amount;
        V -= amount;
        quote.safeTransferFrom(raise, address(this), amount);
        emit Converted(amount, R, V, T);
    }

    /// @notice Buy new tokens from pool inventory along the curve. Fee in quote.
    function buy(uint256 quoteIn, uint256 minTokensOut) external nonReentrant returns (uint256 tokensOut) {
        if (poolState != PoolState.Open) revert InvalidPoolState();
        if (quoteIn == 0) revert ZeroAmount();
        uint256 fee = (quoteIn * swapFeeBps) / BPS;
        uint256 netIn = quoteIn - fee;
        (uint256 feeReserve, uint256 feeVault, uint256 feeBuilder) = _splitFee(fee);

        uint256 q = R + V;
        // tokensOut = T - ceil(Q·T / (Q + netIn))  -> floor, favours the pool
        uint256 newT = q.mulDiv(T, q + netIn, Math.Rounding.Ceil);
        tokensOut = T - newT;
        if (tokensOut < minTokensOut) revert Slippage();

        T = newT;
        R += netIn + feeReserve;
        builderAccrued += feeBuilder;

        quote.safeTransferFrom(msg.sender, address(this), quoteIn);
        if (feeVault > 0) {
            quote.safeTransfer(vault, feeVault);
            IVault(vault).notifyQuoteReward(feeVault);
        }
        token.safeTransfer(msg.sender, tokensOut);
        emit Buy(msg.sender, quoteIn, tokensOut, feeReserve, feeVault, feeBuilder, R, V, newT);
    }

    /// @notice Sell tokens back to the pool; paid from R only. Fee in quote.
    function sell(uint256 tokensIn, uint256 minQuoteOut) external nonReentrant returns (uint256 quoteOut) {
        if (poolState != PoolState.Open) revert InvalidPoolState();
        if (tokensIn == 0) revert ZeroAmount();

        uint256 feeReserve;
        uint256 feeVault;
        uint256 feeBuilder;
        {
            uint256 q = R + V;
            uint256 newT = T + tokensIn;
            // gross = Q - ceil(Q·T / (T + tokensIn))  -> floor, favours the pool
            uint256 gross = q - q.mulDiv(T, newT, Math.Rounding.Ceil);
            uint256 fee = (gross * swapFeeBps) / BPS;
            quoteOut = gross - fee;
            (feeReserve, feeVault, feeBuilder) = _splitFee(fee);
            uint256 rDelta = gross - feeReserve; // what leaves R: payout + vault + builder shares
            if (rDelta > R) revert InsufficientReserve();
            if (quoteOut < minQuoteOut) revert Slippage();

            T = newT;
            R -= rDelta;
            builderAccrued += feeBuilder;
        }

        token.safeTransferFrom(msg.sender, address(this), tokensIn);
        if (feeVault > 0) {
            quote.safeTransfer(vault, feeVault);
            IVault(vault).notifyQuoteReward(feeVault);
        }
        quote.safeTransfer(msg.sender, quoteOut);
        emit Sell(msg.sender, tokensIn, quoteOut, feeReserve, feeVault, feeBuilder, R, V, T);
    }

    /// @notice Migration to Stage 3 (§5.4), called by Raise.graduate(). Sends R quote and
    ///         T' = R/p tokens to the DEX adapter as locked full-range liquidity and burns the
    ///         pool's remaining tokens. Price is continuous: the DEX pair starts at p.
    function graduate() external onlyRaise nonReentrant returns (uint256 quoteSeeded, uint256 tokensSeeded) {
        if (poolState != PoolState.Open) revert InvalidPoolState();
        poolState = PoolState.Migrated;
        uint256 q = R + V;
        // T' = R/p = R·T/Q, floor (dust stays out of the seed and is burned)
        tokensSeeded = q == 0 ? 0 : R.mulDiv(T, q, Math.Rounding.Floor);
        quoteSeeded = R;
        uint256 leftover = T - tokensSeeded;
        T = 0;
        R = 0;
        if (address(dexAdapter) != address(0) && quoteSeeded > 0 && tokensSeeded > 0) {
            dexAdapter.seedLiquidity(address(quote), address(token), quoteSeeded, tokensSeeded);
        }
        if (leftover > 0) {
            IProjectToken(address(token)).burn(leftover);
        }
        emit Graduated(quoteSeeded, tokensSeeded, leftover);
    }

    /// @notice Pay accrued builder fee share to the builder. Callable by anyone; funds only
    ///         ever go to the builder.
    function claimBuilderFees() external nonReentrant {
        uint256 amount = builderAccrued;
        if (amount == 0) revert NothingToClaim();
        builderAccrued = 0;
        address builder = IRaise(raise).builder();
        quote.safeTransfer(builder, amount);
        emit BuilderFeesClaimed(builder, amount);
    }

    // ---------------- views ----------------

    /// @notice Book price p = Q/T in quote units per whole token (scaled by 1e18).
    function bookPrice() external view returns (uint256) {
        if (T == 0) return 0;
        return ((R + V) * 1e18) / T;
    }

    /// @notice R/(R+V) in basis points — the real share of reserves.
    function realRatioBps() external view returns (uint16) {
        uint256 q = R + V;
        if (q == 0) return 0;
        return uint16((R * BPS) / q);
    }

    /// @notice Quote a buy: tokens out and total fee for `quoteIn` quote in. (0,0) when not Open.
    function quoteBuy(uint256 quoteIn) external view returns (uint256 tokensOut, uint256 fee) {
        if (poolState != PoolState.Open) return (0, 0);
        fee = (quoteIn * swapFeeBps) / BPS;
        uint256 q = R + V;
        uint256 newT = q.mulDiv(T, q + (quoteIn - fee), Math.Rounding.Ceil);
        tokensOut = T - newT;
    }

    /// @notice Quote a sell: quote out (net of fee) and total fee for `tokensIn`. (0,0) when not Open.
    function quoteSell(uint256 tokensIn) external view returns (uint256 quoteOut, uint256 fee) {
        if (poolState != PoolState.Open) return (0, 0);
        uint256 q = R + V;
        uint256 newQ = q.mulDiv(T, T + tokensIn, Math.Rounding.Ceil);
        uint256 gross = q - newQ;
        fee = (gross * swapFeeBps) / BPS;
        quoteOut = gross - fee;
    }

    function reserves() external view returns (uint256 r, uint256 v, uint256 t) {
        return (R, V, T);
    }

    // ---------------- internals ----------------

    /// @dev Split a fee into reserve / vault / builder shares. Rounding dust goes to reserve
    ///      (favours the pool). The split sums exactly to `fee`.
    function _splitFee(uint256 fee)
        internal
        view
        returns (uint256 reserveShare, uint256 vaultShare, uint256 builderShare)
    {
        vaultShare = (fee * feeVaultBps) / BPS;
        builderShare = (fee * feeBuilderBps) / BPS;
        reserveShare = fee - vaultShare - builderShare;
    }
}
