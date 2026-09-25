// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Pure math for the `ProtectedSplit` exit primitive
///         (`docs/PROTECTED_SPLIT.md` §3 steps 2–11, degenerate cases §4, invariants §8).
/// @dev    Steps 1 (lazy depth decay) and 12 (payment) are the caller's job: the caller passes a
///         post-decay book and performs the `cost + profit` transfer after this call. Step 8
///         (optional pro-rata smoothing) is not used and is omitted.
///         Pairwise products of book/position values (e.g. `R·T`, `V·O`, `Q·T`) must fit in
///         `uint256` (true for values up to ~1e38; the spec targets ~1e30). Ratios whose
///         numerator can overflow (`Q'·(R·T' − V'·O)`, `profit·T'`) use full-precision
///         `Math.mulDiv` and never naive `a * b / c`.
library ProtectedSplitLib {
    /// @dev Fixed-point scale for `lambdaT` (§1: unsigned fixed-point with SCALE = 1e18).
    uint256 internal constant SCALE = 1e18;

    /// @notice ReserveMarket book (§1). `E = Σ basis_i` is the escrow, `O` the outsider ledger.
    struct Book {
        uint256 R;
        uint256 V;
        uint256 T;
        uint256 O;
        uint256 E;
    }

    /// @notice A ledger position (§1): remaining escrow claim and remaining protected tokens.
    struct Position {
        uint256 basis;
        uint256 tokens;
    }

    /// @notice Full `ProtectedSplit` result (§3, §5).
    struct Result {
        uint256 cost;
        uint256 value;
        uint256 premium;
        uint256 cap;
        uint256 profit;
        uint256 qSold;
        uint256 burn;
        uint256 payout;
    }

    /// @notice §2 precondition: `q ≥ 1`.
    error ZeroQuantity();
    /// @notice §2 precondition: `q ≤ tokens_i`.
    error ExceedsPositionTokens();
    /// @notice §2 precondition: `T > 0`.
    error ZeroInventory();
    /// @notice Caller must clamp `lambdaT` to `[0, SCALE]` (§1); larger reverts.
    error LambdaOutOfRange(uint256 lambdaT);
    /// @notice §4 invariant violation: shrink burn `b > T`.
    error ShrinkBurnExceedsInventory(uint256 burn, uint256 inventory);
    /// @notice §3 step 4 requirement: `V ≥ cost`.
    error InsufficientVirtualQuote(uint256 cost, uint256 virtualQuote);
    /// @notice §3 step 7 precondition: `R·T' ≥ V'·O` (I1).
    error InsufficientSolvency();

    /// @notice Executes `ProtectedSplit` quote math: §3 steps 2–11 exactly, in that order.
    /// @param book    Post-decay book (the caller applies step 1 before calling).
    /// @param pos     The exiting position `i`.
    /// @param q       Protected tokens to exit (§2: `1 ≤ q ≤ pos.tokens`).
    /// @param lambdaT `λ(t)` already evaluated (§1), `SCALE = 1e18`, clamped to `[0, SCALE]`.
    /// @return r         Result fields per §3 (`cost`, `value`, `premium`, `cap`, `profit`,
    ///                   `qSold`, `burn = q − qSold` (§3 step 11), `payout = cost + profit`).
    /// @return bookAfter Book after steps 4 and 11: `E' = E − cost`, `V' = V − cost`,
    ///                   `T' = T − b + qSold`, `R' = R − profit`, `O` untouched.
    /// @return posAfter  Position after step 3: `basis −= cost`, `tokens −= q`.
    function quote(Book memory book, Position memory pos, uint256 q, uint256 lambdaT)
        internal
        pure
        returns (Result memory r, Book memory bookAfter, Position memory posAfter)
    {
        // §2 preconditions the pure math can enforce.
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (q == 0) revert ZeroQuantity();
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (q > pos.tokens) revert ExceedsPositionTokens();
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (book.T == 0) revert ZeroInventory();
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (lambdaT > SCALE) revert LambdaOutOfRange(lambdaT);

        // §3 step 2 — cost (remainder rule on a full position exit).
        r.cost = q == pos.tokens ? pos.basis : Math.mulDiv(pos.basis, q, pos.tokens, Math.Rounding.Floor);

        // §3 step 3 — reduce the position.
        posAfter = Position({basis: pos.basis - r.cost, tokens: pos.tokens - q});

        // §3 step 4 — price-neutral shrink (b = floor(cost·T/Q); floor keeps R·T ≥ V·O intact).
        uint256 b = 0;
        if (r.cost > 0) {
            uint256 qSum = book.R + book.V;
            if (qSum != 0) {
                b = Math.mulDiv(r.cost, book.T, qSum, Math.Rounding.Floor);
                // §4 invariant tripwire: unreachable while `V ≥ cost`, reachable when `cost > Q`.
                // forge-lint: disable-next-line(require-revert-in-loop)
                if (b > book.T) revert ShrinkBurnExceedsInventory(b, book.T);
            }
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (book.V < r.cost) revert InsufficientVirtualQuote(r.cost, book.V);
        }
        bookAfter = Book({R: book.R, V: book.V - r.cost, T: book.T - b, O: book.O, E: book.E - r.cost});

        // §3 step 5 — execution price on the post-shrink state (Q' = R + V').
        uint256 qPost = book.R + bookAfter.V;
        r.value = Math.mulDiv(qPost, q, bookAfter.T + q, Math.Rounding.Floor);

        // §3 step 6 — premium.
        r.premium = r.value > r.cost ? r.value - r.cost : 0;

        // §3 step 7 — solvency cap on the post-shrink state, clamped to [0, R].
        // rt = R·T', vo = V'·O; cap = floor(Q'·(rt − vo) / (Q'·T' − vo)) (full-precision mulDiv).
        uint256 rt = book.R * bookAfter.T;
        uint256 vo = bookAfter.V * book.O;
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (rt < vo) revert InsufficientSolvency();
        if (qPost * bookAfter.T != vo) {
            r.cap = Math.mulDiv(qPost, rt - vo, qPost * bookAfter.T - vo, Math.Rounding.Floor);
            if (r.cap > book.R) r.cap = book.R;
        } // else Q' == 0 ⇒ cap = 0 (§3 step 7).

        // §3 step 8 — optional pro-rata smoothing: omitted (module option, not used).

        // §3 step 9 — profit π = min(floor(λ·premium/SCALE), cap).
        r.profit = Math.mulDiv(lambdaT, r.premium, SCALE, Math.Rounding.Floor);
        if (r.profit > r.cap) r.profit = r.cap;

        // §3 step 10 — sold quantity q_sold = ceil(π·T'/(Q' − π)), clamped to q; 0 if π == 0.
        if (r.profit == 0) {
            r.qSold = 0;
        } else if (r.profit == qPost) {
            r.qSold = q; // clamp; unreachable while T ≥ 1 (π < value < Q')
        } else {
            r.qSold = Math.mulDiv(r.profit, bookAfter.T, qPost - r.profit, Math.Rounding.Ceil);
            if (r.qSold > q) r.qSold = q;
        }

        // §3 step 11 — effects (payment, step 12, is the caller's).
        bookAfter.R = book.R - r.profit;
        bookAfter.T = bookAfter.T + r.qSold;
        r.burn = q - r.qSold;
        r.payout = r.cost + r.profit;
    }

    /// @notice Linear `λ(t)` (§1): `min(SCALE, floor(elapsed·SCALE/length))`; `SCALE` if `length == 0`.
    function lambdaLinear(uint256 elapsed, uint256 length) internal pure returns (uint256) {
        if (length == 0) return SCALE;
        uint256 lam = Math.mulDiv(elapsed, SCALE, length, Math.Rounding.Floor);
        return lam > SCALE ? SCALE : lam;
    }
}
