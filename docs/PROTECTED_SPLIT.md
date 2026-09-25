# `ProtectedSplit` — normative specification (v1, aligned with protocol v3.1, 2026-09-22)

Normative arithmetic for **Stage 1 · Incubation**, **Stage 2 · Series A buffer**, and **Stage 3 · Open market**.
The binding controller decisions and the single listing algorithm are in `PORTEX_PROTOCOL.md` §12.

## 1. State it reads and writes

- Quote is USDG with 6 decimals; tokens have 18 decimals. Balances, fees and payouts use native integer units.
- `SCALE=1e18`; normalized quote `N(a)=a·10^12`. Prices are quote per token in SCALE fixed point after normalizing both sides to 18 decimals:
  `P(Q,T)=floor(N(Q)·SCALE/T)`. Normalize only for prices/seeding; reserve ratios and trade formulas use native balances.
- Every `floor(n/d)=z` means `z·d ≤ n < (z+1)·d`; every `ceil(n/d)=z` means `(z−1)·d < n ≤ z·d` for `d>0`.
  These inequalities govern every rounding in both specifications, including fees, time, shares, rewards, vesting and v4 amounts.
- Define `ceilDiv(n,d)=n/d + (n mod d != 0 ? 1 : 0)` using integer division; `ceilDiv(0,d)=0` for `d>0`.
- Use exact full-width products/mulDiv, including cap products with three factors; do not truncate intermediates.
  Reject unrepresentable stored results; never wrap, saturate or clamp an overflowing multiplication.
- Position classes are `backer`, `buyer`, `builderPurchase`; owners may have multiple separate classes.
- Backer/builder positions have `tokens_i`, `basis_i`, original remaining contribution and, on Budget Launches, `shares_i`.
  Cost is based on current basis, including executed haircuts, never historical unit price.
- Mint initial supply into protocol custody; ledgers are entitlements to these same tokens, not additional supply.
- No participant ERC-20 transfer is allowed before listing; ordinary backer/buyer balances become liquid then, and builder purchases enter VestingVault.
- `E` is escrow quote; `R` is real Reserve quote; `V` is virtual quote; `T` is actual book token inventory.
- `O=Σ buyerTokens[owner]` is the non-transferable buyer ledger, never pre-list ERC-20 circulation.
- Only ordinary buys add to `O`; ordinary sells or explicit buyer burns subtract exact token units; no basis or quota accompanies them.
- At Stage 2 start set `E0=E`, `R=0`, `V0=2E0`, `X0=V0−E0`, `lastT=0`; initialization uses §7.
- Time is `t=clamp(floor((now−stage2Start)·SCALE/stage2Length),0,SCALE)`; branch to zero before the start to avoid unsigned underflow.
- `λ(t)=t`; its boundary values are exactly `λ(0)=0`, `λ(SCALE)=SCALE`; profit multiplication is floored only after multiplying.

## 2. Preconditions (revert otherwise)

- Entry points are `exitAtCost(i,q,minPayout,stateNonce,deadline)` and `protectedExit(i,q,minPayout,stateNonce,deadline)`.
- Require caller ownership, `1 ≤ q ≤ tokens_i`, the quoted nonce, `now ≤ deadline`, sufficient Escrow and `payout ≥ minPayout`.
- Guard all mutable entry points against reentrancy; internal token/custody hooks may not reenter a public action.
- `exitAtCost` needs a live basis record; it is available in Stage 1, Stage 2 and internal listing-pending, including `T=0`.
  A rounded-zero live record may burn token dust for zero payout; after refund funding use ClaimVault, and after listing no basis exit exists.
- `protectedExit` accepts backers only during Stage 2 before `stage2End`; builder purchases have at-cost exits only.
- Profit execution requires `T>0`; with `T=0`, `protectedExit` falls back to fee-free cost payment and full burn, without evaluating market denominators.
- Validate nonce against stored state before lazy decay; the quote simulates that same decay. A timestamp change may change payout, so minimum payout and deadline still apply.
- An uninitialized Stage 1 book has no market precondition; `T`, `R` and `V` cannot disable a live cost exit.

## 3. Order of operations (normative; the simulation must match this)

**Lazy depth advance (before every Stage 2 market action, cost exit, Budget draw or listing)**

- Set `X(t)=floor(X0·(SCALE−t)/SCALE)`, `ΔV=(V−E)−X(t)`; require `t≥lastT` and `ΔV≥0`.
- With `ΔV>0` and pre-advance `Q=R+V`, burn `b=floor(ΔV·T/Q)` once, then set `V−=ΔV`, `T−=b`, `lastT=t`.
- When `ΔV=0`, burn zero, skip division and leave lastT/nonce unchanged: this is no-op decay. When `Q=0`, require `ΔV=0`.
- Cost exits and draws subtract equally from `E,V`; they do not reset `X0` or the time origin. No later call may restore decayed depth.
- Each shrink/decay with amount `a≤Q` satisfies `b·Q≤a·T<(b+1)·Q` and
  `(Q−a)·T≤Q·(T−b)`; this is the exact price-nonincreasing rounding condition, not a one-price-unit tolerance.

**Protected exit**

1. **Advance lazy state** using the rules above.
2. **Cost**: `cost=floor(basis_i·q/tokens_i)`; when `q=tokens_i`, use `cost=basis_i`, including the final-share remainder in §6.
3. **Reduce position**: remove `q` tokens and their original-holder quota; debit cost basis directly for Escrow Launch or burn shares under §6 for Budget Launch.
4. **Cost shrink**: with `Q=R+V`, burn `b=floor(cost·T/Q)`; set `E−=cost`, `V−=cost`, `T−=b`.
   Require `V≥cost` only in an initialized market; if `cost=0` or `T=0`, burn zero without division.
   In Stage 1 skip the entire book step, including its V check, and debit only E and the position.
5. **Execution value** on the post-shrink state: `Q'=R+V'`, `value=floor(Q'·q/(T'+q))`.
6. **Premium**: `premium=max(value−cost,0)`.
7. **Cap**: require `R·T'≥V'·O`; let `D=Q'·T'−V'·O`; if `D=0`, `cap=0`;
   otherwise `cap=min(R,floor(Q'·(R·T'−V'·O)/D))`. A zero denominator is possible with an empty book or zero real Reserve, not only `Q'=0`.
8. *(reserved)*
9. **Profit**: `π=min(floor(λ(t)·premium/SCALE),cap)`; the at-cost path sets `π=0` and skips steps 5–7.
10. **Sold quantity**: for `π=0`, `q_sold=0`; otherwise require `Q'>π` and set `q_sold=ceilDiv(π·T',Q'−π)`.
    Require `q_sold≤q`; do not silently clamp an inconsistent result. The bound follows from `π≤value≤Q'·q/(T'+q)`.
11. **Effects**: `R−=π`, `T+=q_sold`; burn `q−q_sold` protected tokens, separately from the book shrink burn; enforce solvency and increment nonce once.
12. **Payment last**: require `cost+π≥minPayout`, pay that quote, and emit the full result; failed direct payment reverts.
    Protected and at-cost exits charge no trading fee. The Stage 1 and zero-inventory paths burn all exited tokens.

**Ordinary Stage 2 trades (fee-bearing, buyer ledger only)**

- Signatures are `buy(gross,minTokens,stateNonce,deadline)` and `sell(q,minPayout,stateNonce,deadline)`; require Stage 2 before deadline,
  owner authority, nonzero input, nonce match, user deadline and `Q=R+V>0,T>0` after decay.
- For either trade, `fee=floor(gross/100)`, `reserveFee=floor(40·fee/100)`, `rewardFee=floor(30·fee/100)`,
  `treasuryFee=fee−reserveFee−rewardFee`; reserveFee stays in `R`, other shares enter their separate fee buckets.
- **Buy**: `ammIn=gross−fee`, `out=floor(T·ammIn/(Q+ammIn))`; require `out≥minTokens`, `out≥1`, `out<T`.
  Set `R+=ammIn+reserveFee`, `T−=out`, `buyerTokens[caller]+=out`, `O+=out`; debit gross USDG.
- **Sell**: require `q≤buyerTokens[caller]`; `gross=floor(Q·q/(T+q))`, `net=gross−fee`,
  `reserveDebit=gross−reserveFee=net+rewardFee+treasuryFee`; require `R≥reserveDebit` and `net≥minPayout`.
  Set `R−=reserveDebit`, `T+=q`, `buyerTokens[caller]−=q`, `O−=q`; pay net, never gross.
- Partial buyer sales subtract exact integer `q`; selling the whole balance clears it exactly. There is no buyer cost basis or per-token refund promise.
- Before committing each trade require resulting `R·T≥V·O`, `E+R>0 ⇒ T>0`, and a positive v4-representable canonical price.
- Enforce input/output inequalities `out·(Q+ammIn)≤T·ammIn<(out+1)·(Q+ammIn)` and
  `gross·(T+q)≤Q·q<(gross+1)·(T+q)`; fees obey §1's floor inequalities individually.
- Order is nonce/deadline checks → decay → quote/checks → ledger and fee effects → guarded transfer interactions → verify received amounts → events.
  Any wrong token delta or failed interaction reverts all effects; ReserveMarket has no public callback path.

## 4. Degenerate cases

- `R=0` implies `cap=π=q_sold=0`; pay exact cost and burn all `q`.
- `Q'=0` or `D=0` implies zero profit; never divide by a zero denominator. Other unhandled zero denominators revert.
- A zero-cost token fragment may exit with `minPayout=0`; a full exit releases the exact remaining claim and burns/removes the entire position.
- The last basis exit sets `E=0`; residual `V=X(t)` continues the same monotone decay, including its burn, until `t=SCALE`.
  Do not reset `V` without a corresponding burn or restore depth later; at listing `V=E=0`.
- `b>T`, `V<cost`, negative solvency slack or an unrepresentable result is an invariant failure, not a clamp.
- A caller with live basis can always select `exitAtCost`; optional profit and venue failures cannot force it through a failing market division.
- Positive quote with zero book tokens blocks listing as an invariant failure; zero-quote initialization follows Protocol §12.1.

## 5. User protections

- Every successful raise/governance/vault action increments the raise `stateNonce` once until listing, including deposits, trades, exits, vote changes,
  raise fee withdrawals/routing, haircuts, refund funding, refund claims and listing; nested internal updates do not increment it twice.
  After successful listing, `stateNonce` is frozen for every action, including vesting claims and fee collection; post-listing reward actions carry `rewardNonce`.
- Public token `approve`, `transfer`, `transferFrom`, `checkpoint`, `claimRewards` and `claimDisposed` use a token-local reentrancy guard;
  they never acquire the raise action lock or change its nonce. Pre-list public transfers remain forbidden.
- Buyer ledger sells remain executable while listing-pending under §3 arithmetic, overriding its Stage-2-only sell precondition; buys remain closed.
- Standalone decay increments nonce only if `V,T,lastT` change; no-op decay and reverted calls/listing attempts do not increment it.
- Quotes simulate lazy updates without mutation; all return `{available,reason,phase,stateNonce}`, with exact payout and fee fields where applicable.
- `protectedExitQuote(i,q)` returns `{cost,value,premium,cap,π,q_sold,burn,payout,stateNonce}` plus availability/phase;
  `burn=q−q_sold` and the separate book burn are exposed distinctly.
- `guaranteedClaim(i)` returns `{amount,validUntil:stage2End,phase,stateNonce}`; scheduled expiry never closes a cost exit while listing is pending.
- Protocol §2.3's normative view list also requires `redeemQuote`, `marketBuyQuote`, `marketExitQuote`, `atRiskBasis`,
  `futureClaimBounds`, `reserveState`, `positionState`, `feeAccruals`, `stageDeadlines`, `listingPreview`, `listingStatus`.
- Required on-chain events are `AtCostExited`, `ProtectedSplitExecuted`, `MarketBought`, `MarketSold`, `DepthAdvanced`,
  `FeeRouted`, `BudgetHaircutApplied`, `ListingFinalized`, `ClaimVaultFunded`, `TokensBurned`, `QuotaDestroyed`, `RewardsClaimed`.
- Protocol events include raise, phase and resulting `stateNonce`; token reward/checkpoint/quota/disposal events additionally carry the token-local `rewardNonce`.
  Each successful explicit checkpoint, reward claim or disposal pull increments `rewardNonce` once; a transfer that checkpoints nonzero sender quota also increments it once.
  Nested disposal shares its outer action's `rewardNonce`; zero-quota disposal during activation increments it once, while approvals, zero-quota transfers and reverted calls do not increment it.
  `RewardsCheckpointed` records explicit checkpoints; `RewardsDisposed` and `DisposedClaimed` record disposal accrual and its treasury pull.
  Position/trade events include owner/id, quantities, gross/net, fee split and resulting balances;
  depth events include old/new time, V and burn; haircuts include proposal, draw, cumulative draw, E and total shares;
  listing includes pool/position identifiers, price, liquidity, actual consumption, burns, residuals and delivery totals.
- `ClaimVaultFunded` identifies beneficiary/claim class, asset, amount and refund/failed-pull reason; burn events identify source bucket and amount.
- `ListingAttemptFailed` is a required client receipt record containing transaction hash and revert data: a reverted transaction cannot persist an on-chain event.
  There is no rollover-consent event because no consent/election exists.

## 6. Interaction with other modules

- **Budget shares**: at Stage 2 entry, `shares_i=basis_i`, `H=Σ shares_i=E0`, `J=SCALE`; J is the common claim index.
  Lazily materialize untouched shares from the frozen Stage 1 record (implementation default); never loop through holders on a draw.
- Maintain `claimCount` for positive-share positions; update it when shares reach zero, so the sole-claimant branch requires no holder scan.
- With multiple live claims, `basis_i=floor(shares_i·J/SCALE)`; the sole remaining claim has basis E, including all accumulated dust.
  `dust=E−Σ basis_i≥0` stays encumbered in Escrow, never Treasury; it is assigned to the last surviving claimant.
- **Budget exit**: compute cost before updates; for a partial exit with multiple claims and `J>0`, set
  `shares_i'=ceilDiv((basis_i−cost)·SCALE,J)`, and update H by the share difference; do not change J.
- Since `0<J≤SCALE`, `floor(shares_i'·J/SCALE)=basis_i−cost`; this preserves the exact remainder without weakening any other claim.
  A full exit burns all position shares; with `J=0` a partial zero-cost exit leaves shares unchanged.
- For a sole claimant, partial exits retain its shares and reduce E by cost; its final exit burns all shares and takes all E.
  Debit E exactly once in the cost-shrink step; no share update itself debits quote.
- **Budget draw**: require Protocol §3's immutable ceiling, vote, YES cap and phase gate; advance depth and require `H>0`.
  Leave shares unchanged, set `J'=min(J,floor((E−draw)·SCALE/H))`, then `E−=draw`,
  `V−=draw`, `T−=floor(draw·T/(R+V))` using pre-draw V/T/R; update cumulative drawn and nonce atomically.
- Thus every draw haircuts the same outstanding claim-share cohort proportionally, including builder purchases, in constant work;
  each integer basis is rounded down and the final surviving claimant takes residual dust (implementation default).
- `futureClaimBounds` uses `J_min=min(J,floor(max(E−remainingCeiling,0)·SCALE/H))`,
  `lower=floor(shares_i·J_min/SCALE)`, `upper=basis_i`; for a sole claimant lower is `max(E−remainingCeiling,0)`.
  Bounds are conditional on no exit/listing; with `H=0` all claim amounts are zero and division is skipped.
- **Escrow Launch**: Spending is disabled and basis is debited directly; no share haircut or draw is permitted.
- **Depth**: burn only book `T`, never protected or buyer ledger tokens; cost/draw outflows preserve the scheduled `V−E`.
- **Refund/pull failure**: Stage 1 failure moves E to ClaimVault; a failed isolated pull payment leaves its claim unspent.
  If a module isolates a failed payable, move its exact backing and liability into ClaimVault atomically; direct exits otherwise revert on failed payment.
- **Listing**: execute only Protocol §12.1's algorithm, with `E_roll=E`, quote `E+R`, LiquidityReserve-first tokens, atomic basis extinction,
  one-for-one buyer conversion and Reserve-claim extinction; clear market `O` after delivery. No default redemption occurs.
- **Vesting/rewards**: builder purchases follow Protocol §2.2; original-holder quota, accumulators, transfer destruction and zero-eligibility disposal follow §12.2.

## 7. Book seeding and the allocation constraint (revised after `RESULTS-v4.md`)

- Allocation is exactly sale 20 % / pool 40 % / rewards 30 % / treasury 10 % for both launch types; builder purchases are inside the sale allocation.
- Let `p_end` be the floored final Stage 1 marginal price. Use `T0 := floor(V0·SCALE/p_end)` after normalizing V0;
  equivalently `T0=floor(N(V0)·SCALE/p_end)` in native units. Require `T0>0` and `poolAllocation≥T0`.
- Define `p_open=P(V0,T0)`; continuity means this canonical rounded price, not real-number equality:
  `p_end·T0≤N(V0)·SCALE<p_end·(T0+1)`, `p_open·T0≤N(V0)·SCALE<(p_open+1)·T0`.
- Consequently `p_open≥p_end` and `p_open−p_end≤ceilDiv(p_end,T0)`; reject configurations whose price is not v4-representable.
- `LiquidityReserve=poolAllocation−T0`; it is outside the book until listing, consumed before book tokens, with unused tokens burned only after listing success.
- Burn unsold sale inventory at the end of Stage 1; exited tokens never reenter the sale allocation.
- v5 tested its nonempty CPMM graduation cases at 10/25/50 % inflow; it did not test empty books or prove the integer/v4 bounds here.

## 8. Invariants the tests must assert after every call

- Escrow Launch: `E=Σ basis_i`; Budget Launch: `E=Σ basis_i+claimRoundingDust`, `H=Σ shares_i`; all remaining share dust belongs to the claim cohort.
- During Stage 2 and listing-pending, `R·T≥V·O`, `V−E=X(t_last)`, `O=Σ buyerTokens[owner]`; successful listing ends these market obligations.
- Before listing and after sale inventory is closed:
  `T + LiquidityReserve + RewardsVault + TreasuryVault + Σ protectedLedger + O + builderVestingLedger + burned = initialSupply`.
- `protectedLedger` excludes builder purchases; `builderVestingLedger` names their separate custody before and after vault delivery.
  During Stage 1 add unsold sale inventory; at listing replace delivered ledger/inventory terms with ERC-20 holder/venue custody exactly once.
- Ledger-to-ERC conversion changes representation, not supply; with protocol-custodied minting `ERC20.totalSupply+burned=initialSupply` throughout.
- Quotes reconcile independently: actual quote custody equals E, R, fee accruals, Treasury, Rewards, ClaimVault and ListingDust liabilities/balances, excluding virtual V.
- For every live-basis exit `payout≥cost`, `q_sold≤q`; all required solvency checks hold after shrink and after premium.
- For protected premium execution, `(Q'−π)·(T'+q_sold)≥Q'·T'` and
  `0≤(Q'−π)·(T'+q_sold)−Q'·T'<Q'−π` when `π>0`; for zero profit the product is unchanged.
- Normal buys and sells satisfy `(R_after+V)·T_after≥(R_before+V)·T_before`; fee retention is included in R.
- Decay is monotone and applied once per advance; cost/draw burns satisfy §3's exact cross-product inequalities.
- No pre-list token transfer, builder free allocation, transferred quota, double-backed claim, or principal-to-Treasury migration is permitted.
- Listing success extinguishes all basis/Reserve claims and records external custody; any failed listing preserves the complete pre-call state.
