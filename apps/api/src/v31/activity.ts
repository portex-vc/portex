import { getAddress, isAddress } from 'viem';
import { formatAtoms, shortAddress } from '../activity.ts';
import type { EventV31Row } from './db.ts';
import { PHASES } from './indexer.ts';

export function activityV31(e: EventV31Row, symbol: string, labels: Record<string, string>, all = false) {
  const a = JSON.parse(e.args);
  const address = a.owner ?? a.beneficiary ?? a.builder ?? a.destination ?? a.treasury;
  const actor = typeof address === 'string' && isAddress(address) ? getAddress(address) : null;
  const who = actor ? labels[actor.toLowerCase()] ?? shortAddress(actor) : 'The protocol';
  const q = (value: string = '0') => `${formatAtoms(value, 6)} USDG`;
  const t = (value: string = '0') => `${formatAtoms(value, 18)} ${symbol}`;
  const summaries: Record<string, () => string> = {
    RaiseCreated: () => `${who} created this raise`,
    Deposited: () => `${who} deposited ${q(a.debit)} for ${t(a.tokens)} in position #${a.id}`,
    AtCostExited: () => `${who} exited ${t(a.quantity)} at exact cost: ${q(a.result.cost)}`,
    ProtectedSplitExecuted: () => `${who} exited ${t(a.quantity)} with ${q(a.result.cost)} cost plus ${q(a.result.profit)} profit`,
    MarketBought: () => `${who} bought ${t(a.trade.tokens)} for ${q(a.trade.gross)} (including ${q(a.trade.fees.total)} fees)`,
    MarketSold: () => `${who} sold ${t(a.trade.tokens)} for ${q(a.trade.net)} after fees`,
    DepthAdvanced: () => `Virtual depth decreased from ${q(a.oldV)} to ${q(a.newV)}`,
    BudgetHaircutApplied: () => `Proposal #${a.proposal} paid ${q(a.draw)} to the builder; all outstanding basis claims were reduced pro rata`,
    PhaseChanged: () => Number(a.phase) === 4 ? 'The project dissolved; every position can take back its full cost or move it into another project' : `The raise entered ${PHASES[Number(a.phase)]}`,
    DissolvedByBuilder: () => 'The team chose to dissolve the project after the Stage 1 minimum',
    VetoChanged: () => Number(a.vetoUntil) ? `The analyst delayed Stage 1 progression until chain timestamp ${a.vetoUntil}` : 'The council cleared the veto',
    FeeRouted: () => `${q(a.amount)} of fees routed to ${who}`,
    ListingFinalized: () => `Listed at ${formatAtoms(a.migration.price, 18, 8)} USDG per token; protection ended and tokens were delivered automatically`,
    SpendProposed: () => Number(a.kind) === 0
      ? `Builder proposed a ${q(a.quoteAmount)} draw from escrow (#${a.proposal})`
      : `Builder proposed a treasury spend of ${[BigInt(a.quoteAmount) > 0n ? q(a.quoteAmount) : '', BigInt(a.tokenAmount) > 0n ? t(a.tokenAmount) : ''].filter(Boolean).join(' and ')} (#${a.proposal})`,
    VoteChanged: () => `Position #${a.position} ${a.cancelled ? 'cancelled its' : 'cast a'} ${a.support ? 'YES' : 'NO'} vote with ${q(a.weight)} of capital`,
    TokenVoteCast: () => `${labels[String(a.voter).toLowerCase()] ?? shortAddress(getAddress(a.voter))} voted ${a.support ? 'YES' : 'NO'} with ${t(a.weight)}`,
    TreasurySpent: () => `Treasury paid ${[BigInt(a.quoteAmount) > 0n ? q(a.quoteAmount) : '', BigInt(a.tokenAmount) > 0n ? t(a.tokenAmount) : ''].filter(Boolean).join(' and ')} to ${labels[String(a.recipient).toLowerCase()] ?? shortAddress(getAddress(a.recipient))} (proposal #${a.proposal})`,
    RolledOver: () => `${who} rolled ${q(a.deposited)} into this project in one transaction`,
    RolloverSourced: () => `${who} moved ${q(a.amount)} out of this project into another in one transaction`,
    ProposalResolved: () => `Proposal #${a.proposal}: ${['None', 'Active', 'Passed', 'Defeated', 'Executed', 'Cancelled', 'Expired'][Number(a.status)]}`,
    TokenActivated: () => `Public token transfers opened with ${t(a.quota)} of Diamond Hand quota`,
    RewardsClaimed: () => `${who} claimed ${t(a.tokenAmount)} and ${q(a.quoteAmount)} in Diamond Hand rewards`,
    TokensBurned: () => `${t(a.amount)} burned from protocol custody`,
    QuotaDestroyed: () => `${who} permanently lost ${t(a.quantity ?? a.amount)} of Diamond Hand quota`,
    DissolutionFunded: () => `${q(a.amount)} set aside so every position can claim its full cost`,
    DissolutionClaimed: () => `${who} claimed ${q(a.amount)} for position #${a.id}`,
    VestedClaimed: () => `${who} claimed ${t(a.amount)} of vested builder purchases`,
    RewardsCheckpointed: () => `${who}'s Diamond Hand rewards were checkpointed`,
    RewardsDisposed: () => `Unallocated rewards retired: ${t(a.tokenBurn)} burned and ${q(a.quoteAmount)} reserved for treasury`,
    DisposedClaimed: () => `Treasury pulled ${q(a.quoteAmount)} of retired reward quote`,
  };
  const render = summaries[e.name];
  if (!render && !all) return null;
  return { kind: e.name, contract: e.contract, actor, summary: render ? render() : `${e.contract}: ${e.name}`,
    data: a, txHash: e.txHash, blockNumber: e.blockNumber, logIndex: e.logIndex, timestamp: e.timestamp };
}
