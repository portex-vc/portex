import { getAddress, type Address } from 'viem';
import type { Config } from '../config.ts';
import type { Clients } from '../chain.ts';
import type { DB } from '../db.ts';
import { heuristicScorer } from '../analyst/heuristic.ts';
import { makeAnthropicScorer } from '../analyst/anthropic.ts';
import { computeMetrics } from '../analyst/metrics.ts';
import { panelVerdict, reportHashOf, reportPreimage } from '../analyst/panel.ts';
import type { Report, ScorerInput, ScorerResult } from '../analyst/types.ts';
import { RaiseCoreAbi } from '../generated/v31-abis.ts';
import { getRaiseV31, positionIds } from './db.ts';
import { LiveV31 } from './live.ts';

export class AnalystV31 {
  constructor(private db: DB, private clients: Clients, private config: Config) {}
  async analyze(address: string): Promise<Report> {
    const row = getRaiseV31(this.db, address);
    if (!row) throw new Error('v3.1 raise not indexed');
    const live = await LiveV31.atHead(this.clients.public, this.db);
    const [cfg, deadlines] = await Promise.all([live.raise(row, 'getConfig'), live.raise(row, 'stageDeadlines')]);
    const states = await Promise.all(positionIds(this.db, row.address).filter((p) => p.class === 0)
      .map((p) => live.raise(row, 'positionState', [BigInt(p.id)])));
    const totals = new Map<string, bigint>();
    for (const p of states) if (p.basis > 0n) totals.set(p.owner, (totals.get(p.owner) ?? 0n) + p.basis);
    const backers = [...totals].map(([user, principal]) => ({ user, principal: String(principal) }));
    const events = this.db.query("SELECT args,timestamp FROM v31_events WHERE raiseAddr=? AND name='Deposited' ORDER BY blockNumber,logIndex")
      .all(row.address) as { args: string; timestamp: number }[];
    const feedback = this.db.query('SELECT author,rating,text,isBacker,createdAt FROM v31_feedback WHERE raiseAddr=?').all(row.address) as ScorerInput['feedback'];
    const funding = await Promise.all(backers.map(async (b) => {
      const logs = await this.clients.public.getLogs({ address: cfg.quote as Address,
        event: { type: 'event', name: 'Transfer', inputs: [{ name: 'from', type: 'address', indexed: true }, { name: 'to', type: 'address', indexed: true }, { name: 'value', type: 'uint256' }] },
        args: { to: b.user as Address }, fromBlock: 0n, toBlock: live.blockNumber });
      const sources = new Map<string, bigint>();
      for (const log of logs) {
        const { from, value } = log.args;
        if (!from || value === undefined || /^0x0{40}$/i.test(from)) continue;
        sources.set(from, (sources.get(from) ?? 0n) + value);
      }
      const biggest = [...sources].sort((a, b) => a[1] > b[1] ? -1 : 1)[0];
      return { user: b.user, funder: biggest?.[0] ?? null };
    }));
    const input: ScorerInput = { raise: row.address, builder: row.builder, backers, funding,
      deposits: events.map((e) => { const a = JSON.parse(e.args); return { user: a.owner, amount: a.debit, timestamp: e.timestamp }; }),
      feedback: feedback.map((f) => ({ ...f, isBacker: !!f.isBacker })),
      minIncubationSec: Number(cfg.stage1Length), startedAtSec: Number(deadlines.start), nowSec: live.now };
    const scorers = [heuristicScorer, ...(this.config.anthropicApiKey ? [makeAnthropicScorer(this.config.anthropicApiKey, this.config.analystModel)] : [])];
    const results: { name: string; result: ScorerResult }[] = [];
    for (const scorer of scorers) {
      // Like the v1 analyst: model scorers get the deterministic metrics (they otherwise see an empty object).
      try { results.push({ name: scorer.name, result: await scorer.score({ ...input, metrics: computeMetrics(input) } as ScorerInput) }); }
      catch (error) { console.error(`[analyst v3.1] ${scorer.name}:`, error); }
    }
    const verdict = panelVerdict(results.map((r) => r.result));
    const metrics = Object.fromEntries(Object.entries(computeMetrics(input)).filter(([, value]) => value !== null)) as Record<string, number | string>;
    const core = { raise: row.address, createdAt: Math.floor(Date.now() / 1000), ...verdict, metrics,
      findings: results.flatMap((r) => r.result.findings),
      panel: results.map(({ name, result }) => ({ scorer: name, riskScoreBps: result.riskScoreBps, veto: result.veto, rationale: result.rationale })) };
    const reportHash = reportHashOf(reportPreimage(core));
    const uri = `${this.config.publicApiUrl}/v2/raises/${row.address}/reports#${reportHash}`;
    let postedTx: string | null = null;
    if (verdict.veto && Number(deadlines.validity.phase) === 0 && this.clients.wallet) {
      const [, parameters] = await live.raise(row, 'governanceConfig');
      try {
        const simulation = await this.clients.public.simulateContract({ address: getAddress(row.address), abi: RaiseCoreAbi,
          functionName: 'veto', args: [parameters.vetoMax, reportHash], account: this.clients.wallet.account! });
        const hash = await this.clients.wallet.writeContract({ ...simulation.request, chain: this.clients.wallet.chain });
        const receipt = await this.clients.public.waitForTransactionReceipt({ hash });
        if (receipt.status !== 'success') throw new Error(`veto reverted: ${hash}`);
        postedTx = hash;
      } catch (error) { console.warn('[analyst v3.1] veto not posted (phase, cooldown or budget):', error instanceof Error ? error.message.split('\n')[0] : error); }
    }
    this.db.query(`INSERT INTO v31_reports (raiseAddr,createdAt,riskScoreBps,veto,findings,metrics,panel,reportHash,uri,postedTx)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(row.address, core.createdAt, core.riskScoreBps, core.veto ? 1 : 0,
      JSON.stringify(core.findings), JSON.stringify(metrics), JSON.stringify(core.panel), reportHash, uri, postedTx);
    return { ...core, reportHash, uri, postedTx, builderResponse: null };
  }
}
