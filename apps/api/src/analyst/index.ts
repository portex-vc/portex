import { getAddress, type Address } from 'viem';
import { AttestationBoardAbi } from '../generated/abis.ts';
import { getRaise, type DB } from '../db.ts';
import type { Clients } from '../chain.ts';
import type { Config } from '../config.ts';
import { getDeployment } from '../chain.ts';
import { computeMetrics } from './metrics.ts';
import { scoreHeuristic, heuristicScorer } from './heuristic.ts';
import { makeAnthropicScorer } from './anthropic.ts';
import { panelVerdict, reportHashOf, reportPreimage } from './panel.ts';
import type { Report, Scorer, ScorerInput, ScorerResult } from './types.ts';

export class Analyst {
  constructor(
    private db: DB,
    private clients: Clients,
    private config: Config,
  ) {}

  private scorers(): Scorer[] {
    const list: Scorer[] = [heuristicScorer];
    if (this.config.anthropicApiKey) {
      list.push(makeAnthropicScorer(this.config.anthropicApiKey, this.config.analystModel));
    }
    return list;
  }

  /** Principal per current backer (net flows > 0), plus raw deposit events. */
  private collectBackers(raise: string): ScorerInput['backers'] {
    const rows = this.db.query('SELECT user, delta FROM flows WHERE raiseAddr = ? COLLATE NOCASE').all(raise) as { user: string; delta: string }[];
    const totals = new Map<string, bigint>();
    const addrOf = new Map<string, string>();
    for (const r of rows) {
      const k = r.user.toLowerCase();
      totals.set(k, (totals.get(k) ?? 0n) + BigInt(r.delta));
      addrOf.set(k, r.user);
    }
    return [...totals.entries()]
      .filter(([, v]) => v > 0n)
      .map(([k, v]) => ({ user: addrOf.get(k)!, principal: v.toString() }));
  }

  private collectDeposits(raise: string): ScorerInput['deposits'] {
    const rows = this.db.query(
      `SELECT args, timestamp FROM events WHERE raiseAddr = ? COLLATE NOCASE AND name = 'Deposited' ORDER BY blockNumber, logIndex`,
    ).all(raise) as { args: string; timestamp: number }[];
    return rows.map((r) => {
      const a = JSON.parse(r.args) as { user: string; amount: string };
      return { user: getAddress(a.user), amount: a.amount, timestamp: r.timestamp };
    });
  }

  /**
   * Funding-source clustering input: for each backer, the external sender of most of their
   * quote tokens (quote-token Transfer logs, mints from address(0) ignored). Cached in SQLite.
   */
  private async collectFunding(raise: string, backers: ScorerInput['backers']): Promise<ScorerInput['funding']> {
    const dep = getDeployment(this.config.chainId);
    const quote = dep?.mockUSDG as Address | undefined;
    const out: ScorerInput['funding'] = [];
    for (const b of backers) {
      const cached = this.db.query('SELECT funder FROM quote_funding WHERE user = ?').get(b.user.toLowerCase()) as { funder: string | null } | null;
      if (cached) {
        out.push({ user: b.user, funder: cached.funder ? getAddress(cached.funder) : null });
        continue;
      }
      let funder: string | null = null;
      if (quote) {
        try {
          const logs = await this.clients.public.getLogs({
            address: quote,
            event: {
              type: 'event', name: 'Transfer',
              inputs: [
                { type: 'address', name: 'from', indexed: true },
                { type: 'address', name: 'to', indexed: true },
                { type: 'uint256', name: 'value', indexed: false },
              ],
            } as const,
            args: { to: b.user as Address },
            fromBlock: 0n,
          });
          const bySender = new Map<string, bigint>();
          for (const l of logs) {
            const from = (l.args as { from: string }).from;
            if (from === '0x0000000000000000000000000000000000000000') continue; // mint
            const v = (l.args as { value: bigint }).value;
            bySender.set(from, (bySender.get(from) ?? 0n) + v);
          }
          let best = 0n;
          for (const [sender, total] of bySender) {
            if (total > best) { best = total; funder = sender; }
          }
        } catch { /* funding lookup failed — treat as unknown */ }
      }
      this.db.query('INSERT OR REPLACE INTO quote_funding (user, funder) VALUES (?, ?)')
        .run(b.user.toLowerCase(), funder);
      out.push({ user: b.user, funder: funder ? getAddress(funder) : null });
    }
    return out;
  }

  private collectFeedback(raise: string): ScorerInput['feedback'] {
    const rows = this.db.query(
      'SELECT author, rating, text, isBacker, createdAt FROM feedback WHERE raiseAddr = ? COLLATE NOCASE',
    ).all(raise) as { author: string; rating: number; text: string; isBacker: number; createdAt: number }[];
    return rows.map((r) => ({ author: r.author, rating: r.rating, text: r.text, isBacker: !!r.isBacker, createdAt: r.createdAt }));
  }

  /** Runs the full panel, stores the report, posts it on-chain. Returns the stored Report. */
  async analyze(raiseAddress: string): Promise<Report> {
    const row = getRaise(this.db, raiseAddress);
    if (!row) throw Object.assign(new Error('raise not indexed'), { code: 'RAISE_NOT_FOUND' });

    const backers = this.collectBackers(row.address);
    const raiseCfg = JSON.parse(row.config) as Record<string, unknown>;
    const input: ScorerInput = {
      raise: row.address,
      builder: row.builder,
      backers,
      deposits: this.collectDeposits(row.address),
      funding: await this.collectFunding(row.address, backers),
      feedback: this.collectFeedback(row.address),
      minIncubationSec: Number(raiseCfg.minIncubation ?? 0) || undefined,
      startedAtSec: row.start || undefined,
      nowSec: Math.floor(Date.now() / 1000),
    };

    const metrics = computeMetrics(input);
    const results: ScorerResult[] = [];
    for (const scorer of this.scorers()) {
      try {
        results.push(await scorer.score({ ...input, metrics } as ScorerInput));
      } catch (err) {
        // A failing scorer never blocks the panel.
        console.error(`[analyst] scorer ${scorer.name} failed:`, err instanceof Error ? err.message : err);
      }
    }
    if (results.length === 0) {
      // Should be unreachable (heuristic is deterministic), but never analyze with an empty panel.
      results.push(scoreHeuristic(input));
    }

    const verdict = panelVerdict(results);
    const findings = results.flatMap((r) => r.findings);
    const createdAt = Math.floor(Date.now() / 1000);
    const core = {
      raise: row.address,
      createdAt,
      riskScoreBps: verdict.riskScoreBps,
      veto: verdict.veto,
      findings,
      metrics: metricsToJson(metrics),
      panel: results.map((r, i) => ({
        scorer: this.scorers()[i]?.name ?? `scorer-${i}`,
        riskScoreBps: r.riskScoreBps, veto: r.veto, rationale: r.rationale,
      })),
    };
    const reportHash = reportHashOf(reportPreimage(core));
    const uri = `${this.config.publicApiUrl}/v1/raises/${row.address}/reports#${reportHash}`;

    const postedTx = await this.postOnChain(row.address, reportHash, uri, verdict);

    this.db.query(
      `INSERT INTO reports (raiseAddr, createdAt, riskScoreBps, veto, findings, metrics, panel, reportHash, uri, postedTx)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.address, createdAt, verdict.riskScoreBps, verdict.veto ? 1 : 0,
      JSON.stringify(findings), JSON.stringify(core.metrics), JSON.stringify(core.panel),
      reportHash, uri, postedTx);

    return { ...core, reportHash, uri, postedTx, builderResponse: null };
  }

  private async postOnChain(
    raise: string, reportHash: `0x${string}`, uri: string,
    verdict: { riskScoreBps: number; veto: boolean },
  ): Promise<string | null> {
    const dep = getDeployment(this.config.chainId);
    const board = dep?.attestationBoard as Address | undefined;
    const { wallet, public: publicClient } = this.clients;
    if (!board || !wallet) return null;
    try {
      const hash = await wallet.writeContract({
        address: board,
        abi: AttestationBoardAbi,
        functionName: 'postReport',
        args: [getAddress(raise), reportHash, uri, verdict.riskScoreBps, verdict.veto],
        account: wallet.account!,
        chain: wallet.chain,
      } as never);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: hash as `0x${string}` });
      return receipt.transactionHash;
    } catch (err) {
      console.error('[analyst] postReport failed:', err instanceof Error ? err.message : err);
      return null;
    }
  }
}

function metricsToJson(m: ReturnType<typeof computeMetrics>): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(m)) {
    if (typeof v === 'number' || typeof v === 'string') out[k] = v;
    else if (v === null) continue;
  }
  return out;
}

export function reportFromRow(row: {
  raiseAddr: string; createdAt: number; riskScoreBps: number; veto: number;
  findings: string; metrics: string; panel: string; reportHash: string; uri: string; postedTx: string | null;
  builderResponse?: string | null; builderResponseAt?: number | null;
}): Report {
  return {
    raise: row.raiseAddr,
    createdAt: row.createdAt,
    riskScoreBps: row.riskScoreBps,
    veto: !!row.veto,
    findings: JSON.parse(row.findings),
    metrics: JSON.parse(row.metrics),
    panel: JSON.parse(row.panel),
    reportHash: row.reportHash,
    uri: row.uri,
    postedTx: row.postedTx,
    builderResponse: row.builderResponse != null
      ? { text: row.builderResponse, createdAt: row.builderResponseAt ?? 0 }
      : null,
  };
}
