import { getAddress, type Address } from 'viem';
import type { Config } from '../config.ts';
import type { Clients } from '../chain.ts';
import type { DB } from '../db.ts';
import { heuristicScorer } from '../analyst/heuristic.ts';
import { makeAnthropicScorer } from '../analyst/anthropic.ts';
import { computeMetrics } from '../analyst/metrics.ts';
import { panelVerdict, reportHashOf, reportPreimage } from '../analyst/panel.ts';
import type { Report, Scorer, ScorerInput, ScorerResult } from '../analyst/types.ts';
import { RaiseCoreAbi } from '../generated/v31-abis.ts';
import { getRaiseV31 } from './db.ts';
import { historySynced, stateRow, stateRows } from './state-db.ts';

/** The analysis inputs are not indexed yet; retry shortly (the API answers 503 INDEXING). */
export class AnalysisPending extends Error {}

export class AnalystV31 {
  /**
   * Reads only the indexer's database; the one chain interaction is the optional on-chain veto post (a signed write,
   * needs the attester key). `scorers` replaces the model scorer (tests inject a mock); the heuristic always runs.
   */
  constructor(private db: DB, private clients: Clients, private config: Config, private modelScorers?: Scorer[]) {}
  async analyze(address: string): Promise<Report> {
    const row = getRaiseV31(this.db, address);
    if (!row) throw new Error('v3.1 raise not indexed');
    // Everything comes from the indexer's database: materialized views and indexed quote-token transfers.
    const stored = stateRow(this.db, 'raise', row.address);
    if (!stored) throw new AnalysisPending('v3.1 raise state is still being indexed');
    // Funding sources come from indexed quote-token transfers: wait for their one-time backfill after an upgrade.
    if (!historySynced(this.db)) throw new AnalysisPending('quote-token history is still being indexed');
    const data = JSON.parse(stored.data);
    const cfg = data.config, deadlines = data.deadlines;
    const now = (this.db.query('SELECT MAX(timestamp) AS t FROM v31_blocks').get() as { t: number | null }).t ?? Math.floor(Date.now() / 1000);
    const states = stateRows(this.db, 'position', row.address).map((r) => JSON.parse(r.data).positionState)
      .filter((p) => p && Number(p.class) === 0);
    const totals = new Map<string, bigint>();
    for (const p of states) if (BigInt(p.basis) > 0n) totals.set(p.owner, (totals.get(p.owner) ?? 0n) + BigInt(p.basis));
    const backers = [...totals].map(([user, principal]) => ({ user, principal: String(principal) }));
    const events = this.db.query("SELECT args,timestamp FROM v31_events WHERE raiseAddr=? AND name='Deposited' ORDER BY blockNumber,logIndex")
      .all(row.address) as { args: string; timestamp: number }[];
    const feedback = this.db.query('SELECT author,rating,text,isBacker,createdAt FROM v31_feedback WHERE raiseAddr=?').all(row.address) as ScorerInput['feedback'];
    const funding = backers.map((b) => {
      const logs = this.db.query("SELECT args FROM v31_events WHERE contract='quote' AND name='Transfer' AND address=? AND lower(json_extract(args,'$.to'))=?")
        .all(cfg.quote, b.user.toLowerCase()) as { args: string }[];
      const sources = new Map<string, bigint>();
      for (const log of logs) {
        const { from, value } = JSON.parse(log.args);
        if (!from || value === undefined || /^0x0{40}$/i.test(from)) continue;
        sources.set(from, (sources.get(from) ?? 0n) + BigInt(value));
      }
      const biggest = [...sources].sort((a, b) => a[1] > b[1] ? -1 : 1)[0];
      return { user: b.user, funder: biggest?.[0] ?? null };
    });
    const input: ScorerInput = { raise: row.address, builder: row.builder, backers, funding,
      deposits: events.map((e) => { const a = JSON.parse(e.args); return { user: a.owner, amount: a.debit, timestamp: e.timestamp }; }),
      feedback: feedback.map((f) => ({ ...f, isBacker: !!f.isBacker })),
      minIncubationSec: Number(cfg.stage1Length), startedAtSec: Number(deadlines.start), nowSec: now };
    const scorers = [heuristicScorer, ...(this.modelScorers ?? (this.config.anthropicApiKey ? [makeAnthropicScorer(this.config.anthropicApiKey, this.config.analystModel)] : []))];
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
      const parameters = data.governanceConfig[1];
      try {
        const simulation = await this.clients.public.simulateContract({ address: getAddress(row.address), abi: RaiseCoreAbi,
          functionName: 'veto', args: [BigInt(parameters.vetoMax), reportHash], account: this.clients.wallet.account! });
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
