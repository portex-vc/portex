// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice DEX adapter used at Stage 3 migration. The Stage 2 pool seeds full-range liquidity
///         whose LP position is locked forever; afterwards anyone can trade on the pair.
///         MockDexAdapter implements this on localhost; a UniswapV4Adapter implements it later.
///         Every adapter MUST keep two rules (audit M-03):
///         1. `seedLiquidity` is callable only by the token's canonical Stage2Pool
///            (`IProjectToken(token).pool() == msg.sender`) — a stranger can never pre-create
///            or skew the migration pair.
///         2. Pairs are keyed by `(token, quote)` — a pair against a different quote asset can
///            never affect the canonical one, so the migration price equals the pool's book price.
///         `swap*` stays permissionless.
interface IDexAdapter {
    /// @notice Seed a new pair for `token` against `quoteAsset`. Pulls both assets via
    ///         transferFrom. Callable once per token, by the token's canonical Stage2Pool only
    ///         (rule 1 above). The resulting liquidity is locked forever.
    function seedLiquidity(address quoteAsset, address token, uint256 quoteAmount, uint256 tokenAmount) external;

    /// @notice Swap an exact amount of quote asset for project tokens. Pulls quote via transferFrom.
    function swapExactQuoteForTokens(address token, uint256 quoteIn, uint256 minTokensOut, address to)
        external
        returns (uint256 tokensOut);

    /// @notice Swap an exact amount of project tokens for quote asset. Pulls tokens via transferFrom.
    function swapExactTokensForQuote(address token, uint256 tokensIn, uint256 minQuoteOut, address to)
        external
        returns (uint256 quoteOut);

    /// @notice Current reserves of the pair for `token`.
    function getReserves(address token) external view returns (uint256 quoteReserve, uint256 tokenReserve);
}
