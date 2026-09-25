// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IDexAdapter} from "../interfaces/IDexAdapter.sol";

interface IProjectToken {
    function pool() external view returns (address);
}

/// @notice Minimal constant-product pair per (token, quote), seeded against the project token's
///         raise quote asset. Liquidity is locked forever: there is no removal function.
///         Zero swap fee (mock). Rounding favours the pair.
///         Two rules keep migration grief-proof (audit M-03):
///         1. Only the token's canonical Stage2Pool may seed (`IProjectToken(token).pool() ==
///            msg.sender`), so a stranger can never pre-create or skew a pair.
///         2. Pairs are keyed by (token, quote), so no pair against a different quote asset can
///            ever affect the canonical one. The migration pair therefore holds exactly the
///            graduate seed, and its price equals the pool's book price (§5.4 continuity).
///         Swaps stay permissionless.
contract MockDexAdapter is IDexAdapter, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Math for uint256;

    struct Pair {
        uint256 quoteReserve;
        uint256 tokenReserve;
        bool exists;
    }

    mapping(address token => mapping(address quote => Pair)) internal pairs;
    /// @dev The token's single bound quote asset, set at the first seed (one quote per token).
    mapping(address token => IERC20) internal pairQuote;

    event LiquiditySeeded(
        address indexed token, address indexed quote, uint256 quoteAmount, uint256 tokenAmount, address indexed seeder
    );
    event Swap(
        address indexed token,
        address indexed trader,
        uint256 quoteIn,
        uint256 tokensIn,
        uint256 quoteOut,
        uint256 tokensOut,
        uint256 quoteReserve,
        uint256 tokenReserve
    );

    error OnlyCanonicalPool();
    error PairExists();
    error PairMissing();
    error ZeroAmount();
    error Slippage();

    /// @notice Seed liquidity for `token` against `quoteAsset`. Only the token's canonical
    ///         Stage2Pool may call this (`IProjectToken(token).pool() == msg.sender`; the raise
    ///         records it via `ProjectToken.setPool` at creation), so a stranger can never
    ///         pre-create a pair to block or skew `Stage2Pool.graduate()` (audit M-03). Pairs are
    ///         keyed by (token, quote); the first seed binds the token's quote asset, and a later
    ///         seed against a DIFFERENT quote asset reverts `PairExists` (one quote per token).
    ///         A same-quote re-seed ADDS both amounts in full at the caller's implied price.
    function seedLiquidity(address quoteAsset, address token, uint256 quoteAmount, uint256 tokenAmount)
        external
        override
        nonReentrant
    {
        if (quoteAmount == 0 || tokenAmount == 0) revert ZeroAmount();
        if (IProjectToken(token).pool() != msg.sender) revert OnlyCanonicalPool();
        IERC20 bound = pairQuote[token];
        if (address(bound) == address(0)) {
            pairQuote[token] = IERC20(quoteAsset); // first seed binds the quote asset
        } else if (address(bound) != quoteAsset) {
            revert PairExists(); // one quote per token
        }
        Pair storage p = pairs[token][quoteAsset];
        p.exists = true;
        p.quoteReserve += quoteAmount;
        p.tokenReserve += tokenAmount;
        IERC20(quoteAsset).safeTransferFrom(msg.sender, address(this), quoteAmount);
        IERC20(token).safeTransferFrom(msg.sender, address(this), tokenAmount);
        emit LiquiditySeeded(token, quoteAsset, quoteAmount, tokenAmount, msg.sender);
    }

    function swapExactQuoteForTokens(address token, uint256 quoteIn, uint256 minTokensOut, address to)
        external
        override
        nonReentrant
        returns (uint256 tokensOut)
    {
        IERC20 q = pairQuote[token];
        Pair storage p = pairs[token][address(q)];
        if (!p.exists) revert PairMissing();
        if (quoteIn == 0) revert ZeroAmount();
        uint256 qRes = p.quoteReserve;
        uint256 tRes = p.tokenReserve;
        // tokensOut = t - ceil(q*t / (q + quoteIn))  -> floor, favours the pair
        uint256 newT = Math.mulDiv(qRes, tRes, qRes + quoteIn, Math.Rounding.Ceil);
        tokensOut = tRes - newT;
        if (tokensOut < minTokensOut) revert Slippage();
        p.quoteReserve = qRes + quoteIn;
        p.tokenReserve = newT;
        q.safeTransferFrom(msg.sender, address(this), quoteIn);
        IERC20(token).safeTransfer(to, tokensOut);
        emit Swap(token, msg.sender, quoteIn, 0, 0, tokensOut, p.quoteReserve, newT);
    }

    function swapExactTokensForQuote(address token, uint256 tokensIn, uint256 minQuoteOut, address to)
        external
        override
        nonReentrant
        returns (uint256 quoteOut)
    {
        IERC20 q = pairQuote[token];
        Pair storage p = pairs[token][address(q)];
        if (!p.exists) revert PairMissing();
        if (tokensIn == 0) revert ZeroAmount();
        uint256 qRes = p.quoteReserve;
        uint256 tRes = p.tokenReserve;
        // quoteOut = q - ceil(q*t / (t + tokensIn))  -> floor, favours the pair
        uint256 newQ = Math.mulDiv(qRes, tRes, tRes + tokensIn, Math.Rounding.Ceil);
        quoteOut = qRes - newQ;
        if (quoteOut < minQuoteOut) revert Slippage();
        p.quoteReserve = newQ;
        p.tokenReserve = tRes + tokensIn;
        IERC20(token).safeTransferFrom(msg.sender, address(this), tokensIn);
        q.safeTransfer(to, quoteOut);
        emit Swap(token, msg.sender, 0, tokensIn, quoteOut, 0, newQ, p.tokenReserve);
    }

    function getReserves(address token) external view override returns (uint256 quoteReserve, uint256 tokenReserve) {
        Pair storage p = pairs[token][address(pairQuote[token])];
        return (p.quoteReserve, p.tokenReserve);
    }

    function quoteOf(address token) external view returns (address) {
        return address(pairQuote[token]);
    }

    function pairExists(address token) external view returns (bool) {
        return pairs[token][address(pairQuote[token])].exists;
    }
}
