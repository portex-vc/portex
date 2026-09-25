# Portex base layer (2026-09-23)

The protocol is a set of composable mechanisms, and launch types are configurations of them. A few
mechanisms are not optional: every template, now and in future versions, must contain them. This page lists
them, says what a template may still tune, and points to where each rule is enforced.

Founder decisions of 2026-09-23 made the first two items mandatory. The rest follow from the same promise to
backers; they were already enforced and are now named as base layer. GPT-5.6 Sol proposed a similar list
independently (`docs/audits/2026-09-23-sol-base-layer-review.md`).

| # | Base-layer rule | A template may tune | Enforced by |
|---|---|---|---|
| 1 | **Stage 1 · Incubation carries no downside.** Every position can exit at its exact cost, with zero fees, until the listing transaction. | Stage lengths within the version's governed bounds, valuation target (at least $100,000), curve steepness up to the protocol maximum | `RaiseCore.exitAtCost`, `LedgerV31`, version-pinned bounds |
| 2 | **A treasury governed by vote.** Every fee (Stage 2 trading fees, LP fees, retired reward quote) and the 10% treasury allocation go to the launch's own treasury. Nothing leaves without a proposal that passes a vote. | Spend cap (default 5% of the YES tokens' market value), unlock period of the allocation (default five years), voting windows | `TreasuryV31`, `GovernanceV31`, factory always creates the treasury |
| 3 | **Dissolution returns everything.** A project that does not graduate is dissolved and every position claims its full cost. After the Stage 1 minimum the team may dissolve early. | Nothing | `LifecycleV31._dissolve`, `RaiseCore.dissolve`, `ClaimVault` |
| 4 | **Capital moves between projects in one transaction.** Positions in projects that have not listed, and dissolution claims, can be moved straight into another project's Stage 1. | Nothing | `RolloverRouterV31` (pinned in every raise and claim vault) |
| 5 | **Terms are pinned at creation.** Code, parameters, adapters, quote asset and roles are fixed by an append-only version commitment; no one can upgrade a live launch. | Future versions only | `PortexRegistryV31.bundleHash`, EIP-1167 clones |
| 6 | **Principal never mixes with anything else.** Escrow, reserve, fees, rewards and claims sit in separate buckets with exact-transfer and solvency checks. | Nothing | `RaiseCore`, `ReserveMarket`, invariant tests |
| 7 | **Founders buy on the same terms.** No free allocation; team purchases follow the public curve, are capped at 10% of supply and vest for three years after a one-month cliff. | Nothing | `LedgerV31.deposit`, `VestingVaultV31` |
| 8 | **Graduation ends in a real, locked market.** Every graduating project lists on Uniswap; the liquidity it adds can never be withdrawn and only its fees are collected, to the treasury. | Nothing | `LifecycleV31.list`, adapters |
| 9 | **Every step has a deadline and anyone can move it forward.** Stages, vetoes and proposals time out; advancing, finalizing and expiring are permissionless. The AI analyst can only delay, within a fixed budget. | Veto budget within protocol bounds | `RaiseCore.advanceStage1`, `GovernanceV31.expire`, veto limits |

## Treasury rules in detail

- **Before listing (Stage 2):** proposals are voted by contributed capital, one vote weight per backer
  position, never by tokens. Quorum 40% of eligible capital, approval 60%, and a spend is at most 10% of YES
  capital. Budget Launch draws on the raise use the same vote. Exits cancel votes; voting never blocks an exit.
- **After listing (Stage 3):** proposals are voted by token holders, weighted by their balances at the end of
  the proposal's block (flash loans never count). Approval 60%. A spend may not exceed 5% of the market value
  of the tokens voting YES, valued at the lower of the listing price and the current pool price, so a pumped
  pool can never enlarge it. Listed builder addresses cannot vote.
- **Allocation schedule:** the 10% treasury allocation arrives at listing and unlocks on a straight line over
  five years (about 2% of supply a year). Locked tokens can never be spent; fee income is spendable by vote as
  it arrives.
- **Words:** treasury, proposal, vote, quorum, timelock. The treasury is a Web3 treasury governed by token and
  capital holders, not a company paying shareholders.

## Known limits (stated, not hidden)

- Token voting cannot bind identity: a builder who moves vested tokens to another wallet can vote with them.
  The 5% cap still means any spend needs YES holdings worth twenty times the spend. A minimum turnout for
  Stage 3 votes can be added as a template parameter if wanted.
- Tokens sent directly to the rollover router outside a rollover cannot be recovered; the router has no owner
  by design.
