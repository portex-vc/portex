# Portex Protocol — specification v3.1 (2026-09-22)

§11–§13 are binding and override all earlier text; every supported launch begins with the fixed Stage 1.
§13 (2026-09-23) defines the base layer every template must contain; see also `docs/BASE_LAYER.md`.

> Normative container rules and launch configurations for implementers. Arithmetic is specified in
> `docs/PROTECTED_SPLIT.md`; the audit disposition is `docs/audits/2026-09-22-spec-v3.1-delta.md`.

## 0. What the protocol is

Portex custodies token launches under pinned rules. The supported types are **Escrow Launch** and **Budget Launch**.
Every supported launch begins with **Stage 1 · Incubation**: 15–60 days, exact-cost exits, zero fees, zero spending,
non-transferable ledgers, a valuation target of at least $100,000, minimum backers, and an AI veto that can delay but
cannot reject. **Stage 2 · Series A buffer** ends in mandatory listing into **Stage 3 · Open market**.

## 1. Three protocol invariants (enforced by the container, whatever the type)

**I1 — Per-asset conservation, solvency, and unique encumbrance.**

- Reconcile each asset separately across inflows, custody, confirmed external positions, outflows, issuance and burns.
- Each enforceable claim names one backing bucket; no unit backs two claims or serves two modules simultaneously.
- Any spend, conversion or migration atomically updates its assets, liabilities and token disposition.

**I2 — Fixed semantics and truthful views.**

- Pin module code, parameters, adapters, quote asset, compatibility rules and mutable-role authorities before deposit.
- Expose executable quotes, enforceable claims and conditional bounds separately, with phase and state validity.
- An enforceable basis claim permits exit at exact cost until the listing transaction executes; Budget Launch cost
  is post-haircut basis. Listing atomically ends protection and delivers remaining tokens. Inactivity retains tokens.

The protocol pins bytecode, not the behaviour of external upgradeable tokens; admission of a quote asset is an explicit trust decision by the curator, recorded by the required `quoteFrozen` attestation (USDG on X Layer is issuer-upgradeable). A paused or fee-charging quote suspends exits until the issuer restores it; funds stay in escrow.

**I3 — Bounded authority and recovery.**

- Governance may exercise only disclosed authority, including approved Budget Launch haircuts; it cannot change exit semantics.
- Bound each veto and total veto delay; cancel proposals and release voting locks at the relevant phase deadline.
- A failed listing call reverts the entire transaction; cost exits remain open and anyone may retry.
- Mandatory external listing depends on venue availability; no external-independent listing-completion guarantee is made.
- Isolate dissolution claims and failed pull-payments in `ClaimVault`; unclaimed amounts never block other users.

## 2. Core objects

### 2.1 Pools and buckets

- Use `Escrow` for basis, `Reserve` for real quote and book tokens, `LiquidityReserve` for unseeded pool tokens,
  `TreasuryVault`, `RewardsVault`, `FeeAccrual[dest]`, and `VestingVault`; virtual quote is never a custodied asset.
- `ClaimVault` is pull-only and used only for Stage 1 refunds and failed pull-payments, never default redemption at listing.
- `ListingDust` holds unconsumed migration quote as permanently locked LP principal, never Treasury income.
- Each backing bucket covers its named liabilities; the conservation rules in ProtectedSplit §8 apply independently of representation.

### 2.2 Positions

- Position classes are `backer`, `buyer`, and `builderPurchase`; each has an owner and an immutable class.
- Backers and builder purchases have `tokens_i` and a remaining basis claim; Budget Launch claims use shares (§3).
- Buyers have `buyerTokens[owner]`, zero basis and zero Diamond Hand quota; no address-level label merges position classes.
- Before listing, `O` is the aggregate non-transferable buyer ledger balance. No participant owns or can transfer an
  ERC-20 balance. At listing, `O` is converted one-for-one into transferable ERC-20 balances and its Reserve claim is extinguished atomically.
- Cost for `q` tokens is `floor(basis_i·q/tokens_i)`; the final exit takes the position's remaining basis.
- Builder receives no free allocation. Purchases use the same Stage 1 curve, come from the 20 % sale allocation,
  are cumulatively capped at 10 % of total initial supply, do not count toward minimum backers, and have zero Diamond Hand quota.
- Only builder purchases enter `VestingVault` at listing: cliff `listedAt + 30 days`, then linear vesting over 1,095 days.
- For an initial vested grant `B`, vested tokens are `floor(B·clamp(now−cliff,0,1095 days)/(1095 days))`; claims take vested less already claimed.

### 2.3 Typed views (normative)

- Every quote returns `{available, reason, phase, stateNonce}`; unavailable quotes return no executable amount.
- `guaranteedClaim(i)` returns `{amount, validUntil: stage2End, phase, stateNonce}`; amount is live basis before listing,
  zero after listing, or the separately funded refund in the failure branch. `validUntil` is scheduled protection end;
  actual execution remains available while listing is pending. Before Stage 2 starts, `stage2End = 0` means unscheduled.
- `redeemQuote(i,q,stateNonce)` returns exact at-cost payout; `protectedExitQuote(i,q)` returns
  `{cost,value,premium,cap,π,q_sold,burn,payout}` plus the common validity fields.
- `marketBuyQuote(gross)` and `marketExitQuote(owner,q)` return gross, AMM input/output, fee split, net output and price impact;
  `marketBuyQuoteFor(buyer,gross)` is the same quote for a known buyer and is unavailable (`Unauthorized`) for builders.
- `atRiskBasis(i)` returns `max(historicalRemaining−liveBasis,0)` before listing, and historicalRemaining after listing.
- `futureClaimBounds(i,phase)` returns `{asset,lower,upper,conditions,backingBucket,stateNonce}`: current basis is the
  upper bound; Budget lower bound applies the remaining authorized ceiling and share rounding; after listing both basis bounds are zero.
- `reserveState()` returns `{E,R,V,T,O,X0,lastT,H,J,claimCount,stateNonce}`; `positionState(i)` returns owner, class, tokens, basis, shares, quota and phase.
- `feeAccruals()`, `stageDeadlines()`, and `listingPreview()` expose fee buckets, timestamps, and §12's branch, price,
  desired/actual-preview amounts, minimum-used bounds, burns, claim extinction and delivery destinations.
- `listingStatus(i)` reports live-cost eligibility and automatic token delivery/vesting; there is no election or consent view.

### 2.4 Phase machine

- The graph is `Stage1 → Stage2 → ListingPending → Stage3 | Stage1 → Refunded`.
- UI names are **Stage 1 · Incubation**, **Stage 2 · Series A buffer**, **Stage 3 · Open market**;
  implementation aliases are (`Incubation`, `Growth`, `Listed`). `ListingPending` is internal, never a fourth UI stage.
- At the Stage 1 deadline, satisfied capital/participation gates and a positive seeded book take priority over refund; an AI veto can only delay
  successful progression within its pinned budget. Missing gates, zero escrow or a rounded-zero seed cause `Refunded`, funding exact basis pull claims and burning undelivered tokens.
- At `now ≥ stage2End`, the effective state is listing-pending even without a storage write; buys, spending and profit exits stop.
  Buyer ledger sells remain executable until successful listing, including before any failed listing attempt.
- Cost exits remain executable until successful listing, including during AI delay or listing retry; transaction order decides concurrent exit/listing calls.
- Listing is permissionless at `now ≥ stage2End`; success sets `listedAt`, enables transfers and ends basis/Reserve claims atomically.
- Terminal transitions cancel outstanding proposals and release locks. Reward streams, builder vesting and LP fee collection continue independently.
- Completion of operational work does not discharge unpaid isolated refund or reward liabilities, or unlock LP principal.

## 3. Modules

| Module | Normative responsibility / dependency |
|---|---|
| **Issuance** | Fixed Stage 1, linear curve, 20 % sale cap; protocol-custodied minting and separate position classes. |
| **ExitPolicy** | `exitAtCost` for live basis; `protectedExit` for backers in Stage 2; ProtectedSplit §§2–4. |
| **ReserveMarket** | Non-transferable buyer ledger, exact buy/sell arithmetic, linear depth decay and solvency guards; ProtectedSplit §§1–3. |
| **Spending** | Disabled for Escrow Launch; Budget Launch only, disclosed immutable ceiling, voted draws and claim-share haircut. |
| **Governance** | Capital snapshot, 40 % quorum, 60 % approval, 10 %-of-YES cap, 7-day dispute, YES locks through execution. |
| **Rewards** | Original-holder quota, destroyed on transfer/sale; accumulator and zero-eligibility rules in §12. |
| **Vesting** | Builder purchases only: 30-day cliff followed by 1,095-day linear vesting. |
| **Migration** | Single direct Uniswap v4 algorithm in §12; atomic revert and permissionless retry. |
| **FeeRouter** | 1 % ordinary Stage 2 trade fee; 40/30/remainder split; ProtectedSplit §3. |
| **Attestation** | Pinned AI authority; per-veto and cumulative limits; no power to reject a successful launch. |
| **Settlement** | Stage 1 refund funding and failed pull-payment isolation; no Stage 2 refund terminal branch. |

- Let `S` be initial token supply, `A = S/5` the sale allocation, and `x` cumulative sold tokens; require `S mod 10 = 0`.
- Pin terminal target price `p_target` with `floor(p_target·S/SCALE) ≥ 100000·SCALE`; both sides are normalized 18-decimal USDG.
- The exact rational Stage 1 curve is `p(x)=p_start+(p_target−p_start)·x/A`, with `p_start=p_target/κ`, `κ=1.5`.
- Define normalized cumulative cost `F(x)=(p_start·x+(p_target−p_start)·x²/(2A))/SCALE`; native USDG due is
  `C(x,q)=ceil((F(x+q)−F(x))/10^12)`. A deposit buys the greatest integer `q` with `C(x,q) ≤ deposit` and `x+q ≤ A`;
  debit only `C`, return change, reject `q=0`, and bind `minTokens`, nonce and deadline.
- The native amount debited is basis; exits burn sold tokens and do not rewind `x` or replenish the sale cap.
- Track historicalRemaining separately, reducing it by `floor(historicalRemaining·q/tokens_i)` on exits, with the final-exit remainder rule.
- Contributions from the pinned builder addresses always create builderPurchase positions; count distinct non-builder addresses with live backer tokens and basis.
- Set `p_end=floor(p(x_end))`; reaching the terminal curve target and the minimum live non-builder backer count satisfies the Stage 1 gates.
- Minimum backers is 10; voting lasts 3 days, execution grace 2 days, each AI veto at most 2 days, cumulative veto
  at most 7 days, cooldown 1 day (implementation defaults, pinned at creation; no veto extends the 60-day maximum).
  Demo deployments (Stage 2 bounds shorter than 35 days) scale these timers so a Budget vote fits the shortest
  Stage 2, and the veto horizon is always the deployment's Stage 1 maximum.
- A YES lock locks voting weight, not cost exits: an exit cancels that vote before execution; snapshot weight cannot be counted again.
- Budget builder chooses `budgetCeiling ≤ budgetCeilingMax` at creation; the bound is configurable, initially 30 % of escrow at Stage 2 start.
- Pin and display the chosen fraction before the first deposit; set `ceilingAmount=floor(E0·budgetCeiling/SCALE)` once at Stage 2 entry.
- Every draw requires a passed vote and `draw ≤ min(E,ceilingAmount−drawn,floor(YESWeight/10))`; YES weight is native USDG capital.
- Draws affect all outstanding basis, including builder purchases, through gas-safe claim shares and the same `V/T` shrink as an equal cost outflow (ProtectedSplit §6).
- Fees use `fee=floor(gross/100)`, `reserveFee=floor(40·fee/100)`, `rewardFee=floor(30·fee/100)`,
  `treasuryFee=fee−reserveFee−rewardFee`; Treasury receives every fee-split remainder. Cost and protected exits are fee-free.

## 4. `ProtectedSplit` — the atomic exit primitive for protected market stages

- `docs/PROTECTED_SPLIT.md` is normative for state, entry points, arithmetic, ordering, rounding, degeneracies and invariants.
- Cost leaves Escrow with a `V/T` shrink; premium uses the post-shrink execution price; `π=min(floor(λ·premium/SCALE),cap)`.
- Reserve receives only `q_sold`; the unsold protected tokens burn. With no real Reserve demand, profit is zero.
- Seed `T0 := floor(V0·SCALE/p_end)` after quote normalization, and separately require `poolAllocation ≥ T0`.
- `research/sim-two-curves/RESULTS-v5.md` verifies its historical exit model and tested nonempty graduation books
  at 10/25/50 % inflow under equivalent CPMM/fee assumptions; it does not verify empty books or the new integer/v4 implementation.

## 5. Composition rules (registry checks and runtime guards)

**S** means registry/static; **R** means runtime; **S/R** requires both.

1. **[S/R]** Backing cannot be spent or migrated while its claim remains live; disclosed Budget haircuts and listing extinction must be atomic.
2. **[S]** Token vesting must have a reachable release schedule; voting locks cannot block cost exits.
3. **[S]** Reserve quote is unavailable to Spending or Treasury; only its prescribed trade, exit and listing paths may debit it.
4. **[S]** Zero-basis team, treasury and reward allocations cannot enter the protected ReserveMarket.
5. **[S/R]** Migration may pair only assets whose basis/Reserve claims are extinguished in that transaction; LP ownership cannot duplicate a live claim.
6. **[S/R]** Cost exits stay open until successful listing; no pre-list exit-window closure is allowed.
7. **[S]** Refund waterfalls fund backed claims before fees, treasury or residual.
8. **[S]** Fee destinations must exist; fee splits total 100 % with remainder assigned to Treasury.
9. **[S]** Governance cannot change existing exit rules, ceiling, settlement order or recipients.
10. **[S/R]** `voting + dispute + execution grace ≤ remaining phase time`; deadline cancels proposals and forbids later execution.
11. **[R]** Proposal quorum snapshots only eligible voting capital: backer-class, non-builder live basis. Individual vote weights are fixed at vote time, locked while counted, cancelled on exit and never counted twice.
12. **[S]** Supported launches have no demand gate; listing time is pinned, independent of demand.
13. **[S]** USDG is whitelisted; fee-on-transfer, rebasing or pausable quote assets are refused.
14. **[R]** Residual cannot bypass a backed claim; non-fee migration quote never reaches Treasury.
15. **[S/R]** Veto budgets are pinned, counted cumulatively and cannot reject a successful launch.
16. **[S/R]** No pre-list ERC-20 transfer; purchases and sales use ReserveMarket ledgers in Stage 2, and buyer ledger sells remain available while listing-pending.
17. **[S/R]** Builder purchases debit the 20 % sale allocation, respect the 10 % cap and carry no reward quota.
18. **[S/R]** Escrow Launch Spending is disabled; its Treasury accepts only fee-originated quote.
19. **[S]** Current launch types cannot enable pro-rata smoothing.
20. **[R]** Listing may inspect claims to extinguish them, but cannot migrate their backing with any such claim still live.

## 6. Fixed by the protocol vs chosen by the type

- Fixed: I1–I3, Stage 1 rules, typed views, composition rules, asset/module whitelists and explicit recovery semantics.
- Protocol bounds are configurable for future creations: `κ ≤ κ_max` (initially 2), `budgetCeiling ≤ budgetCeilingMax`
  (initially 30 %); existing raises pin their bounds and parameters.
- Both supported types pin `κ=1.5` and allocation 20/40/30/10; stage-length bounds, veto and governance windows, and the treasury unlock period are governed parameters (seconds): the curator sets them for future publications only, each published version pins them, and every raise keeps its version's values. Production defaults are Stage 1 15–60 days, Stage 2 35–70 days and a 1,825-day treasury unlock; the contracts carry no demonstration timings, and a testnet lowers them through the same setter. The registry enforces the relations that keep a launch live at any scale: a full governance cycle fits the shortest Stage 2, the veto budget fits the longest Stage 1, and each veto stays within its production cap.
- Builder choices are target valuation, lengths, and Budget ceiling within the pinned bounds; they cannot change after deposit.
- A protocol surcharge, if enabled by a future configuration, is bounded by 0.5 %; none is enabled in these configurations (implementation default).

## 7. Launch types as configurations

| | **Escrow Launch** | **Budget Launch** |
|---|---|---|
| Stage 1 · Incubation | Version-pinned bounds (production 15–60 days); exact-cost exits, no fees/spending, target ≥ $100,000, minimum backers, bounded veto | Same |
| Issuance | `LinearMint(κ=1.5)`; builder purchases from sale allocation, cap 10 % of initial supply | Same |
| Stage 2 · Series A buffer | Length pinned at creation within version-pinned bounds (production 35–70 days); linear `Decay(2E → E)`; `λ=t`; ProtectedSplit | Same |
| Draws on the raise | Disabled | Immutable chosen ceiling within `budgetCeilingMax`; every draw voted, ≤ 10 % of YES weight, share haircut |
| Treasury (base layer) | All fees and the 10 % allocation (unlocking linearly over five years from listing); every spend voted | Same |
| Governance | Stage 2: capital, 40/60, 7-day dispute, voting locks never disable cost exit. Stage 3: token holders at the end of the proposal block, 60 %, spend ≤ 5 % of YES value at min(listing, pool) price | Same |
| Dissolution | Deadline without graduation, or builder after the Stage 1 minimum; every position claims its full cost or rolls it over | Same |
| Rewards | Original-holder quota; 30 % token allocation plus Stage 2 reward fee share, daily over 1,095 days | Same |
| Allocation | Sale 20 % / pool 40 % / rewards 30 % / treasury 10 %; book gets `T0`, rest of pool allocation goes to `LiquidityReserve` | Same |
| Builder vesting | Cliff 30 days after listing, then linear 1,095 days | Same |
| Stage 3 · Open market | Mandatory direct Uniswap v4 listing; atomic claim extinction; ordinary holders liquid | Same |
| Fees | Stage 1 none; Stage 2 1 % → 40 % Reserve / 30 % Rewards / remainder Treasury; Stage 3 LP fees → Treasury | Same |

- Escrow Launch guarantees original remaining cost until listing executes; Budget Launch guarantees post-haircut basis until listing executes.
- Both end basis protection when the open market begins; remaining backers automatically hold ERC-20 tokens.

## 8. From v1 code to v3.1

| v1 | v3.1 specification target |
|---|---|
| `Raise` | `RaiseCore`: positions, buckets, phase machine, views, issuance and exits |
| `Stage2Pool` | `ReserveMarket`: buyer ledger, depth schedule, shrink, ProtectedSplit |
| `DiamondVault` | Original-holder accumulator with transfer-hook quota destruction |
| `SpendGovernor` | Governance plus disabled/Escrow-share Spending configuration |
| `AttestationBoard` | Cumulative and per-veto budgets |
| adapters | Atomic Uniswap v4 listing and permissionless retry |
| — | Refund-only ClaimVault, fee routing, vesting, pinned configuration and composition checks |

This mapping is a rebuild target, not a claim about current code. Required invariant checks are in ProtectedSplit §8.

## 9. Decision log (closed, 2026-09-22)

| # | Decision |
|---|---|
| D-1 | Stage 1 · Incubation with exact-cost exits and zero fees is fixed for every supported launch. |
| D-2 | Mandatory listing replaces the formerly proposed `Settled` branch; failed venue calls revert and may be retried. |
| D-3 | Profit follows the dampened curve; pro-rata smoothing is removed from v1. |
| D-4 | Linear `Decay(2E → E)` and `λ=t` implement gradual convergence. |
| D-5 | Escrow Launch (formerly Genesis / Sealed / `ZERO_EXTRACTION`); Budget Launch (formerly Venture / Milestone / `MILESTONE_FUNDING`). |
| D-6 | Configurable `κ_max`, initially 2; both launch types use 1.5. |

## 10. Review path

Implement the closed decisions, module interfaces and composition guards; verify against the normative arithmetic and
invariants; audit the implementation and align the UI with the three named stages. v5 is historical simulation evidence.

## 11. Founder decisions recorded 2026-09-22 (evening)

- **Incubation is the fixed first phase of every launch type** (the phase where most projects fail). Decision taken;
  the protocol fixes it.
- **No token transfers before listing, for anyone.** Backers' and Stage-2 buyers' tokens alike are ledger balances
  that can only be refunded or sold back to the protocol until `Listed`; the token contract blocks transfers until then.
  Rationale: otherwise anyone could seed a Uniswap pool early, which would amount to an unauthorised graduation.
  Consequence for `ProtectedSplit`: `O` is the ledger balance of pool-bought tokens, not ERC-20 circulation.
- **Valuation floor $100k.** Every project sets its own Incubation target as a valuation; it may not be below
  $100k; a raise that cannot reach its own target is unsuccessful and refunds everyone. The tier ladder therefore starts
  at $100k (previously $300k).
- **UI must show exactly the stages the design has** — three (Stage 1 · Incubation, Stage 2 · Series A buffer, Stage 3 ·
  Open market) plus the failure branch. "Commitment" was a stage of the retired v1 tranche design and must not appear.
- **Simulation v5 (spec-aligned, `research/sim-two-curves/RESULTS-v5.md`, reviewer re-run 3.5 s, 0 violations):** with
  the book seeded at `T0 = V0/p_end` the opening price is exactly `p_end` (v4 had 0.82/0.41) and every headline number
  returns to v3's to the second decimal (Escrow Launch median P&L 2.8/16.2/26.1 % at 0.25/1/3× demand for `Decay(2E→E)`;
  below-cost at graduation 15/0/0 % at 10/25/50 % inflow; race Gini 0.36; LP depth 9/19/31 % of ΣP; graduation impact
  ratio 1.000000). Cap exact in 31,572 binding exits. One caveat recorded honestly: the *worst* outsider mark at 0.25×
  demand for `Decay(2E→E)` reads −72.6 % vs v3's −43.1 % — a single seed that nearly drains the book, where the final
  mark price is hypersensitive; nine of ten seeds match v3 within 0.11 pt. `ProtectedSplit` §3 is now verified as
  written, including the post-shrink execution price and the `LiquidityReserve` pairing at listing.

## 12. Founder answers recorded 2026-09-22 (late)

- **Stage naming (binding for UI and documents):** Stage 1 · Incubation; Stage 2 (the dual-track dampened-curve
  period); Stage 3 · Open market. Internal identifiers may differ; user-facing text may not.
- **Stage 2 price model, in the founder's words:** a dual-track system with a dampened curve — at the first moment the
  price is exactly the Stage 1 price, at the last moment exactly the Uniswap price, in between a gradual convergence.
  Implementation: depth schedule `Decay(2E → E, linear)` plus the λ-throttled settlement (`ProtectedSplit`). This is an
  implementation choice, not a founder question.
- **Profit sharing among simultaneous sellers:** follows the curve; no pro-rata sharing rule. The solvency cap remains
  as a technical guard (first-come when it binds).
- **Curve steepness bound:** a configurable protocol parameter (set by protocol governance), not a constant; Escrow Launch/
  Budget Launch use 1.5×.
- **Stage 2 end:** listing is mandatory at the end of the builder-chosen 5–10 weeks (founder: "then it must list").
  There is no settle-at-cost branch out of Stage 2; the only failure branch is missing the Stage 1 target.
- **Launch-type names (chosen by Gemini at the founder's instruction, 2026-09-22):** **Escrow Launch** (team never
  touches the raise; formerly Genesis / Sealed / `ZERO_EXTRACTION`) and **Budget Launch** (capped, voted draws; formerly Venture /
  Milestone / `MILESTONE_FUNDING`). ZH 托管式发行 / 预算式发行; ES Lanzamiento en Custodia / Lanzamiento con Presupuesto.
- **Terminology in this document:** the phase identifiers `Incubation`, `Growth`, `Listed` are code names only. In
  anything the founder or a user reads they are **Stage 1 · Incubation**, **Stage 2 · Series A buffer** (the PRD's own
  section title) and **Stage 3 · Open market**.

### 12.1 Controller clarification — claim lifetime and listing (binding, 2026-09-22)

- The enforceable claim is exit at exact cost (post-haircut basis on Budget Launches) at any time until the listing transaction executes.
- Stage 1 also resolves as `Refunded` when `E=0` or `floor(2·E·10^30/p_end)=0`, even if the cumulative sale and participation gates pass;
  refund remaining basis exactly through ClaimVault. An AI veto cannot delay this unseedable failure branch.
- Listing extinguishes all remaining basis claims atomically and delivers each remaining backer's protected tokens as ERC-20.
- Backers who do nothing hold their tokens into Stage 3; protection ends when the open market begins, by design.
- There is no roll-or-redeem election and no ClaimVault default redemption at listing.
- The §11 v5 findings describe the historical simulation only; the integer, empty-book and v4 rules below require implementation verification.

The Uniswap v4 position is owned by the raise contract and its principal is permanently locked (protocol-owned liquidity).
LP fees route to the launch treasury; on an Escrow Launch these fees, plus the Stage 2 fee share, are the treasury's only income.
"No lockups" means no lock on any holder's tokens; builder vesting is the sole exception.

**Single atomic listing algorithm**

1. Require `now ≥ stage2End`; advance decay to `t=SCALE` (economic `t=1`) so `V=E`; close buys, spending and profit exits; retain cost exits, buyer ledger sells and listing.
2. Snapshot `E_roll=E` (all remaining escrow), `L_quote=E+R`, and `L_token=T`; exclude reward/treasury fee accruals and existing ClaimVault liabilities.
3. For positive quote and tokens, set `p_g=floor((E+R)·SCALE/T)` after normalizing quote to 18 decimals;
   in native units this is `floor((E+R)·10^12·SCALE/T)`. Do not recompute `L_token` by inverting the floored price.
4. Atomically extinguish all remaining basis and buyer Reserve claims; give ordinary backers and buyers their ledger tokens one-for-one
   as ERC-20, and move builder purchases into VestingVault. A single phase switch may expose frozen ledger credits as ERC-20 balances
   with lazy materialization (implementation default); delivery must not require a holder-count loop or an opt-in claim.
5. Initialize the v4 pool at the canonical price through the permissioned-initialize hook, which accepts only the pinned adapter;
   if already initialized, require the same price and zero preexisting liquidity or revert.
   The token blocks all public pre-list transfers; only authenticated protocol custody movements are allowed.
6. Mint full-range liquidity with desired amounts `(L_quote,L_token)`; consume actual token usage from LiquidityReserve first, then book `T`.
7. Record the position owner, liquidity, actual amounts consumed, residual quote and all existing ClaimVault liabilities before zeroing operational balances.
8. After a successful nonzero mint, burn unused book `T` and LiquidityReserve; lock unused quote in ListingDust. No principal residual goes to Treasury.
9. For a zero-quote branch, successful initialization replaces minting before the table's burns; no positive liquidity or execution-price ratio is promised.
10. Set `E=R=V=T=O=0`, cancel proposals, release voting locks, set `listedAt`, enable transfers and initialize reward quota; increment the nonce once.
11. Any venue, validation or delivery failure reverts the whole transaction, including claim extinction, burns and nonce changes; cost exits and buyer ledger sells remain open and anyone may retry.

| Final state after decay | Required action |
|---|---|
| `E+R > 0`, `T > 0` | Apply the dust-book rule below; otherwise mint using desired `(E+R,T)` at `p_g`, recording actual amounts and enforcing the bounds. |
| `E+R > 0`, `T = 0` | Invariant failure; trade guards must prevent this. Revert; never send unpaired quote to Treasury. |
| `E+R = 0`, `T > 0` | Initialize at the last valid positive canonical price, mint no liquidity, then burn `T` and LiquidityReserve. |
| `E+R = 0`, `T = 0` | Initialize at `p_end`, mint no liquidity, then burn LiquidityReserve. |
| v4 call reverts or receipt/custody validation fails | Revert atomically; effective state stays listing-pending, with cost exits, buyer ledger sells and permissionless retry. |

- Configure v4 fee `10000` pips (1 %), tick spacing `200`, full-range ticks `[-887200,887200]`, a Portex permissioned-initialize hook
  with only `beforeInitialize` enabled (all other hook flags off), and `currency0 < currency1` by address.
  The hook immutably pins and authenticates the PoolManager and accepts initialization only from the pinned adapter. Its CREATE2 address must satisfy `uint160(hook) & 0x3fff == 0x2000`; its constructor validates these exact permission bits, and all other hook callbacks are disabled. Tick limits follow [Uniswap TickMath](https://github.com/Uniswap/v4-core/blob/main/src/libraries/TickMath.sol).
- If currency0 is the project token, raw-unit ratio `ρ=p_g/(SCALE·10^12)`; otherwise `ρ=(SCALE·10^12)/p_g`.
- Set `s=sqrtPriceX96=floor(sqrt(ρ·2^192))`, so `s² ≤ ρ·2^192 < (s+1)²`; require `sqrtAtLower < s < sqrtAtUpper`.
  Flooring lowers currency1/currency0; the resulting quote/token price is lower for token-first ordering and higher for quote-first ordering.
- Let `a=sqrtAtLower`, `b=sqrtAtUpper`. Choose the largest integer liquidity `ℓ ≤ floor((2^128−1)/8873)` satisfying
  `amount0=ceil(ℓ·(b−s)·2^96/(b·s)) ≤ desired0` and `amount1=ceil(ℓ·(s−a)/2^96) ≤ desired1`;
  upward amount rounding follows [Uniswap SqrtPriceMath](https://github.com/Uniswap/v4-core/blob/main/src/libraries/SqrtPriceMath.sol).
- The liquidity ceiling is v4's per-tick bound at spacing 200; pin the adapter's matching [Pool arithmetic](https://github.com/Uniswap/v4-core/blob/main/src/libraries/Pool.sol).
- Positive-quote listing requires `ℓ≥1`, both used amounts ≥1 native unit, and
  `usedQuote ≥ max(1,floor(9999·L_quote/10000))`, `usedToken ≥ max(1,floor(9999·L_token/10000))` (implementation default).
- **Dust-book rule (controller, 2026-09-22, closes the liveness gap found in the v3.1 implementation):** if `L_quote < 10^6` native
  units (one USDG) or no `ℓ ≥ 1` satisfies the usage bounds, the launch takes the zero-quote branch instead of reverting: initialize
  the pool at the canonical price, mint nothing, burn `T` and LiquidityReserve, lock `L_quote` in ListingDust. A listing must never
  be blocked forever by rounding on a book nobody funded.
- Reconcile actual callback deltas against the computed amounts; callback authentication and reentrancy guards are mandatory.
- For `R=0,E>0`, real escrow replaces virtual quote; for `E=R=0`, listing means initialization and transferability only.
- With full 20 % sale at $100,000 terminal FDV and `κ=1.5`, no buys/exits leave about $16,666.67 and 16.667 % of supply
  for listing, with no holder election; if all basis and Reserve are exhausted, use the zero-quote branches.
- `R·T ≥ V·O` applies through all pre-list operations, then ceases to be a live ReserveMarket invariant at successful listing.

### 12.2 Controller clarification — Diamond Hand accounting (binding, 2026-09-22)

- Quota belongs to an original holder's remaining protocol-acquired backer tokens; Stage 2 buyers, builder purchases and reward receipts have zero quota.
- Before listing, each backer exit destroys quota for all exited tokens; listing initializes quota to the surviving original backer balance.
- On every transfer or sale, first checkpoint rewards, then destroy `min(senderQuota,amount)` quota; the recipient gets zero quota.
  Apply quota-first attribution to fungible mixed balances, including self-transfers (implementation default); destroyed quota never revives.
- For each reward asset `A0` (30 % token allocation or accrued reward quote), daily cumulative release is
  `released(d)=floor(A0·min(d,1095)/1095)`, `d=floor((now−listedAt)/1 day)`; release only the difference from the prior checkpoint.
- For total quota `W>0`, set `n=newRelease·SCALE+carry`, `Δacc=floor(n/W)`, `carry=n−Δacc·W`;
  add `Δacc` to the per-asset accumulator and retain `0 ≤ carry < W` for the next checkpoint.
- A holder checkpoint credits `floor((quota·(acc−paidAcc)+fraction)/SCALE)`, retaining the remainder
  `0 ≤ fraction < SCALE`; update `paidAcc` before changing quota. Claims debit credited rewards without changing quota.
- If total quota is zero at listing, burn the 30 % reward-token allocation and accrue reward quote to a Treasury-only claimable bucket in the token (implementation default).
- If quota later reaches zero, preserve already credited claims, burn unallocated reward tokens and accrue unallocated quote to the same bucket
  (implementation default); at stream end do the same with final rounding dust after all holder entitlements are accounted for.
- Transfers only checkpoint, destroy quota, accrue disposal and burn; they never push quote payments. Permissionless `claimDisposed()` pays only
  the pinned Treasury, and a failed pull leaves its exact backing and claimable amount intact.

## 13. Base layer and treasury governance (founder decisions, binding, 2026-09-23)

1. **Mandatory in every template:** a Stage 1 with zero downside (exact-cost exit until listing) and a
   governed treasury (all fee revenue flows to the launch's treasury; every spend is a proposal and a vote).
   Versions may tune parameters (thresholds, caps, unlock period) but never remove either mechanism. The full
   base-layer list, with what each template may tune, is `docs/BASE_LAYER.md`.
2. **Dissolution replaces "refund/failed".** `Phase.Dissolved` (enum position unchanged). Reached at the Stage 1
   deadline without graduation, or by `RaiseCore.dissolve()` from the builder at or after
   `start + registry.stage1Min()`. Every position claims its exact cost from `ClaimVault`.
3. **Rollover.** `RolloverRouterV31` (one per deployment, pinned as an immutable in `RaiseCore` and
   `ClaimVault`; the factory refuses to create a launch unless both name the same router and it serves that
   factory, or both disable rollover) exits positions at cost (or with protected profit in Stage 2) and takes dissolution claims for
   its caller, adds an optional wallet top-up, deposits the total into another launch's Stage 1 for the caller
   and returns the unused remainder, in one transaction.
4. **Treasury.** `TreasuryV31` clone per launch, created by the factory (any builder-supplied treasury is
   ignored). It receives Stage 2 trading fees, LP fees, retired reward quote and the 10 % allocation at listing.
   The allocation unlocks linearly over `vestingDuration`, the version's governed treasury unlock period (1,825 days in production); token
   payments never dip into the locked part. It pays only on an executed `GovernanceV31` proposal.
5. **Voting.** Stage 2 (Capital mode): as §7, for Budget draws and treasury spends of USDG fee income.
   Stage 3 (Token mode): weight = balance at the end of the proposal's block (lazy snapshot, flash loans
   excluded), builders and protocol custody excluded; passes with 60 % YES of votes cast and a token part
   ≤ `spendCapBps` (500) of YES tokens; the total value (USDG + tokens) ≤ 5 % of the YES tokens' value at
   min(listing price, pool price) is checked at execution and may be retried within the execution window.
6. **Launch-type income (copy):** an Escrow Launch team never touches the raise; it is funded by voted
   treasury budgets (fees and the treasury allocation) and by its own business revenue.

