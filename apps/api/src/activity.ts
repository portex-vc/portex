/**
 * Turns indexed raw events into human sentences for the activity feed.
 *
 * `summarizeActivity` returns null for internal wiring/noise events (Initialized,
 * VetoParamsSet, Converted, …) — those stay in the `events` table and in the raw `data`
 * field, but are filtered out of the default feed. All amounts are formatted with the
 * quote/token decimals and thousand separators; actors use known dev-account labels
 * (localhost) or short addresses.
 */
import { getAddress, isAddress } from 'viem';

export interface ActivityRow {
  contract: string;
  name: string;
  args: string;
  txHash: string;
  blockNumber: number;
  logIndex: number;
  timestamp: number;
}

export interface ActivityContext {
  quoteSymbol: string;
  quoteDecimals: number;
  tokenSymbol: string;
  /** lowercase address -> display label (dev accounts, the raise's builder, …). */
  labels: Record<string, string>;
  /** 1e18-scaled book price immediately before (blockNumber, logIndex), from price history. */
  priceBefore: (blockNumber: number, logIndex: number) => string | null;
}

export interface ActivitySummary {
  actor: string | null;
  summary: string;
}

// ---- formatting helpers -------------------------------------------------------

function trimZeros(s: string): string {
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '') || '0';
}

/** Smallest-unit decimal string -> grouped human amount ("20,000", "0.275"). */
export function formatAtoms(value: string | bigint, decimals: number, maxDecimals = 2): string {
  let v = BigInt(value);
  const negative = v < 0n;
  if (negative) v = -v;
  const base = 10n ** BigInt(decimals);
  const int = (v / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fracRaw = (v % base).toString().padStart(decimals, '0').slice(0, maxDecimals);
  const body = fracRaw ? trimZeros(`${int}.${fracRaw}`) : int;
  return negative ? `-${body}` : body;
}

export function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** 1e18-scaled price string -> "0.275". */
function formatPrice(p: string | null): string {
  if (p === null) return '?';
  return formatAtoms(p, 18, 4);
}

/** bps -> "31%". */
function formatBpsPct(bps: number): string {
  return trimZeros((bps / 100).toFixed(1)) + '%';
}

/** unix seconds -> "Sep 20, 09:41 UTC". */
function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  const month = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const day = d.getUTCDate();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${month} ${day}, ${hh}:${mm} UTC`;
}

const FAIL_REASONS: Record<string, string> = {
  '0': 'the deadline passed without the gates being met',
  '1': 'the builder cancelled it',
  '2': 'too few backers opted in',
};

// ---- main ----------------------------------------------------------------------

export function summarizeActivity(row: ActivityRow, ctx: ActivityContext): ActivitySummary | null {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(row.args) as Record<string, unknown>;
  } catch {
    return null;
  }

  const quote = (v: unknown) => `${formatAtoms(String(v ?? '0'), ctx.quoteDecimals)} ${ctx.quoteSymbol}`;
  const tokens = (v: unknown) => `${formatAtoms(String(v ?? '0'), 18)} ${ctx.tokenSymbol}`;
  const who = (v: unknown): string => {
    const addr = String(v ?? '');
    if (!isAddress(addr)) return 'Someone';
    const label = ctx.labels[addr.toLowerCase()];
    return label ? label[0].toUpperCase() + label.slice(1) : shortAddress(getAddress(addr));
  };
  const actorOf = (v: unknown): string | null => {
    const addr = String(v ?? '');
    return isAddress(addr) ? getAddress(addr) : null;
  };
  /** Post-event book price from pool event reserves (1e18-scaled). */
  const priceAfter = (): string | null => {
    if (args.R === undefined || args.V === undefined || args.T === undefined) return null;
    const R = BigInt(String(args.R)); const V = BigInt(String(args.V)); const T = BigInt(String(args.T));
    if (T === 0n) return null;
    return ((R + V) * 10n ** BigInt(36 - ctx.quoteDecimals) / T).toString();
  };
  const priceArrow = (): string => {
    const after = priceAfter();
    const before = ctx.priceBefore(row.blockNumber, row.logIndex);
    if (before && after) return ` (price ${formatPrice(before)} → ${formatPrice(after)})`;
    if (after) return ` (price now ${formatPrice(after)})`;
    return '';
  };

  switch (`${row.contract}:${row.name}`) {
    // ---- raise ----------------------------------------------------------------
    case 'raise:Deposited':
      return { actor: actorOf(args.user), summary: `${who(args.user)} deposited ${quote(args.amount)}` };
    case 'raise:Withdrawn':
      return { actor: actorOf(args.user), summary: `${who(args.user)} withdrew ${quote(args.amount)} (1:1, principal is never at risk in incubation)` };
    case 'raise:CommitmentStarted':
      return { actor: null, summary: `Gates passed — the commitment window opened with ${quote(args.totalPrincipal)} committed to the raise` };
    case 'raise:GrowthOpened':
      return { actor: null, summary: `Growth pool opened at the Stage 1 price: ${quote(args.committedPrincipal)} of committed principal moved into the pool` };
    case 'raise:Migrated':
      return { actor: null, summary: `Graduated to the open market: ${quote(args.quoteSeeded)} and ${tokens(args.tokensSeeded)} seeded as permanently locked DEX liquidity` };
    case 'raise:RaiseFailed':
      return { actor: null, summary: `Raise failed — ${FAIL_REASONS[String(args.reason)] ?? 'the gates were not met'}. Every backer withdraws 100% of principal` };
    case 'raise:TrancheCommitted':
      return { actor: actorOf(args.user), summary: `${who(args.user)} committed tranche ${String(args.k)}: ${quote(args.principal)} left protection and moved into the pool` };
    case 'raise:TrancheClaimed':
      return {
        actor: actorOf(args.user),
        summary: args.staked
          ? `${who(args.user)} claimed tranche ${String(args.k)}: ${tokens(args.tokens)} staked in the Diamond Vault`
          : `${who(args.user)} claimed tranche ${String(args.k)}: ${tokens(args.tokens)} to their wallet`,
      };
    case 'raise:TrancheRedeemed':
      return { actor: actorOf(args.user), summary: `${who(args.user)} redeemed tranche ${String(args.k)}: ${quote(args.principal)} back, 1:1` };
    case 'raise:BuilderVestedClaimed':
      return { actor: actorOf(args.builder), summary: `Builder claimed ${tokens(args.amount)} of vested allocation` };
    // internal mechanics, covered by the tranche/governor sentences
    case 'raise:WithdrawLockSet':
    case 'raise:GovernorSpend':
      return null;

    // ---- pool ------------------------------------------------------------------
    case 'pool:Buy':
      return { actor: actorOf(args.trader), summary: `${who(args.trader)} bought ${tokens(args.tokensOut)} for ${quote(args.quoteIn)}${priceArrow()}` };
    case 'pool:Sell':
      return { actor: actorOf(args.trader), summary: `${who(args.trader)} sold ${tokens(args.tokensIn)} for ${quote(args.quoteOut)}${priceArrow()}` };
    case 'pool:BuilderFeesClaimed':
      return { actor: actorOf(args.builder), summary: `Builder claimed ${quote(args.amount)} of pool fees` };
    // wiring / covered by GrowthOpened / Migrated
    case 'pool:PoolOpened':
    case 'pool:Converted':
    case 'pool:Graduated':
      return null;

    // ---- vault -----------------------------------------------------------------
    case 'vault:RewardsClaimed':
      return { actor: actorOf(args.user), summary: `${who(args.user)} claimed vault rewards: ${quote(args.quoteAmount)} + ${tokens(args.tokenAmount)}` };
    case 'vault:Unstaked':
      return { actor: actorOf(args.user), summary: `${who(args.user)} unstaked ${tokens(args.amount)} from the Diamond Vault (permanent — no re-entry)` };
    // covered by TrancheClaimed(staked) / pool fee flow / Migrated
    case 'vault:Staked':
    case 'vault:QuoteFeeReceived':
    case 'vault:MigrationStarted':
      return null;

    // ---- board -----------------------------------------------------------------
    case 'board:ReportPosted': {
      const risk = formatBpsPct(Number(args.riskScoreBps ?? 0));
      const vetoUntil = Number(args.vetoUntil ?? 0);
      return {
        actor: null,
        summary: args.veto
          ? `AI analyst posted a report: risk ${risk}, VETO — the commitment window cannot open until ${formatTime(vetoUntil)} or the council clears it`
          : `AI analyst posted a report: risk ${risk}, no veto`,
      };
    }
    case 'board:VetoCleared':
      return { actor: null, summary: 'The council cleared the AI veto' };
    case 'board:Initialized':
    case 'board:VetoParamsSet':
    case 'board:FactorySet':
      return null;

    // ---- factory ----------------------------------------------------------------
    case 'factory:RaiseCreated':
      return { actor: actorOf(args.builder), summary: `${who(args.builder)} created this raise` };
    case 'factory:RaiseConfigured':
    case 'factory:QuoteAssetUpdated':
    case 'factory:ProtocolFeeRecipientUpdated':
    case 'factory:OwnershipTransferred':
    case 'factory:Initialized':
      return null;

    // ---- governor (Rule 2) -------------------------------------------------------
    case 'governor:Proposed':
      return { actor: null, summary: `Builder proposed to spend ${quote(args.amount)} of escrow (milestone #${String(args.id)})` };
    case 'governor:Voted':
      return { actor: actorOf(args.voter), summary: `${who(args.voter)} voted ${args.support ? 'YES' : 'NO'} with ${quote(args.weight)} of principal` };
    case 'governor:Finalized':
      return {
        actor: null,
        summary: args.passed
          ? `Vote finalized: the spend passed (${quote(args.yesPrincipal)} YES vs ${quote(args.noPrincipal)} NO) — dispute window open`
          : `Vote finalized: defeated — no funds moved, YES locks are releasable`,
      };
    case 'governor:Executed':
      return { actor: null, summary: `Spend executed: ${quote(args.amount)} paid to the builder — everyone who stayed pays pro rata` };
    case 'governor:Expired':
      return { actor: null, summary: 'The spend proposal expired without executing — no funds moved, all locks lapsed' };
    case 'governor:VoteLockReleased':
      return { actor: actorOf(args.voter), summary: `${who(args.voter)} released their vote lock` };
    case 'governor:Initialized':
      return null;

    default:
      // Unknown event: keep it out of the default feed rather than dumping raw units.
      return null;
  }
}
