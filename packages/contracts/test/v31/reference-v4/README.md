# Pinned Uniswap v4 arithmetic reference

Test-only upstream reference for reviewers of finding F-7. `V4DifferentialV31.t.sol` compares
Portex listing deltas with the actual `SqrtPriceMath` implementation, including zero liquidity,
full-range endpoints and the Portex liquidity cap.

Source: [Uniswap/v4-core, commit 46c6834698c48bc4a463a86d8420f4eb1d7f3b75](https://github.com/Uniswap/v4-core/tree/46c6834698c48bc4a463a86d8420f4eb1d7f3b75/src/libraries).
The six MIT-licensed source files retain their SPDX headers and upstream behavior. Only Foundry
formatting is applied locally; `upstream.json` records SHA-256 hashes of the original downloads.
These files are never linked into deployed Portex modules. Tests use no network, RPC or fork.
