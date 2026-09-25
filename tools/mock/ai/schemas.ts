/** Strict validators for every AI answer. Anything off-shape is rejected (the client then asks once for a repair). */
import type { Validation, Validator } from './client';

export interface Diligence {
  verdict: 'back' | 'pass' | 'watch';
  conviction: number;
  amountUsdg: number;
  rating: number;
  feedback: string;
  question?: string;
}
export interface VoteDecision {
  voter: string;
  vote: 'yes' | 'no' | 'abstain';
  reason: string;
}
export interface VoteBatch {
  votes: VoteDecision[];
}
export interface BuilderUpdateText {
  title: string;
  body: string;
}
export interface ProposalText {
  title: string;
  rationale: string;
  amountShare: number;
}
export interface Sentiment {
  sentiment: number;
  summary: string;
}

/** Words the product never uses (securities vocabulary) and link-like text that feedback must not carry. */
const BANNED = /\b(shareholders?|dividends?|equity)\b|股东|分红|股权/i;
const LINK = /https?:\/\/|www\./i;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

function text(
  o: Obj,
  key: string,
  min: number,
  max: number,
  errors: string[],
  opts: { optional?: boolean; noLinks?: boolean } = {},
): string | undefined {
  const v = o[key];
  if (v === undefined || v === null || v === '') {
    if (!opts.optional) errors.push(`${key} is required`);
    return undefined;
  }
  if (typeof v !== 'string') {
    errors.push(`${key} must be a string`);
    return undefined;
  }
  const s = v.trim();
  if (s.length < min || s.length > max) errors.push(`${key} must be ${min}-${max} characters (got ${s.length})`);
  if (BANNED.test(s))
    errors.push(`${key} uses securities vocabulary (shareholders, dividends, equity); use backers, treasury, tokens`);
  if (opts.noLinks && LINK.test(s)) errors.push(`${key} must not contain links`);
  return s;
}

function num(o: Obj, key: string, min: number, max: number, errors: string[], integer = false): number | undefined {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    errors.push(`${key} must be a number`);
    return undefined;
  }
  if (v < min || v > max) errors.push(`${key} must be between ${min} and ${max}`);
  if (integer && !Number.isInteger(v)) errors.push(`${key} must be an integer`);
  return v;
}

function onlyKeys(o: Obj, allowed: string[], errors: string[]) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) errors.push(`unexpected key ${k}`);
}

const done = <T>(errors: string[], value: T): Validation<T> =>
  errors.length ? { ok: false, errors } : { ok: true, value };

/** Due diligence: amount must be 0 unless backing, and within the persona's ticket when backing. */
export function diligenceValidator(ticket: [number, number]): Validator<Diligence> {
  return (raw) => {
    if (!isObj(raw)) return { ok: false, errors: ['answer must be a JSON object'] };
    const errors: string[] = [];
    onlyKeys(raw, ['verdict', 'conviction', 'amountUsdg', 'rating', 'feedback', 'question'], errors);
    const verdict = raw.verdict;
    if (verdict !== 'back' && verdict !== 'pass' && verdict !== 'watch')
      errors.push('verdict must be "back", "pass" or "watch"');
    const conviction = num(raw, 'conviction', 0, 1, errors);
    const amountUsdg = num(raw, 'amountUsdg', 0, ticket[1], errors);
    if (verdict === 'back' && amountUsdg !== undefined && amountUsdg < ticket[0])
      errors.push(`amountUsdg must be between ${ticket[0]} and ${ticket[1]} when backing`);
    if (verdict !== 'back' && amountUsdg !== undefined && amountUsdg !== 0)
      errors.push('amountUsdg must be 0 unless the verdict is "back"');
    const rating = num(raw, 'rating', 1, 5, errors, true);
    const feedback = text(raw, 'feedback', 20, 600, errors, { noLinks: true });
    const question = text(raw, 'question', 5, 300, errors, { optional: true, noLinks: true });
    return done(errors, {
      verdict: verdict as Diligence['verdict'],
      conviction: conviction!,
      amountUsdg: amountUsdg!,
      rating: rating!,
      feedback: feedback!,
      ...(question ? { question } : {}),
    });
  };
}

/** One decision for each named voter, exactly once. */
export function voteBatchValidator(voters: string[]): Validator<VoteBatch> {
  return (raw) => {
    if (!isObj(raw) || !Array.isArray(raw.votes)) return { ok: false, errors: ['answer must be {"votes": [...]}'] };
    const errors: string[] = [];
    onlyKeys(raw, ['votes'], errors);
    const seen = new Set<string>();
    const votes: VoteDecision[] = [];
    for (const [i, v] of raw.votes.entries()) {
      if (!isObj(v)) {
        errors.push(`votes[${i}] must be an object`);
        continue;
      }
      const voter = v.voter;
      if (typeof voter !== 'string' || !voters.includes(voter)) {
        errors.push(`votes[${i}].voter must be one of ${voters.join(', ')}`);
        continue;
      }
      if (seen.has(voter)) errors.push(`duplicate vote for ${voter}`);
      seen.add(voter);
      if (v.vote !== 'yes' && v.vote !== 'no' && v.vote !== 'abstain')
        errors.push(`votes[${i}].vote must be "yes", "no" or "abstain"`);
      const reason = text(v, 'reason', 3, 200, errors, { noLinks: true });
      votes.push({ voter, vote: v.vote as VoteDecision['vote'], reason: reason ?? '' });
    }
    for (const voter of voters) if (!seen.has(voter)) errors.push(`missing a vote for ${voter}`);
    return done(errors, { votes });
  };
}

export const builderUpdateValidator: Validator<BuilderUpdateText> = (raw) => {
  if (!isObj(raw)) return { ok: false, errors: ['answer must be a JSON object'] };
  const errors: string[] = [];
  onlyKeys(raw, ['title', 'body'], errors);
  const title = text(raw, 'title', 5, 120, errors, { noLinks: true });
  const body = text(raw, 'body', 40, 1200, errors, { noLinks: true });
  return done(errors, { title: title!, body: body! });
};

export function proposalValidator(share: [number, number]): Validator<ProposalText> {
  return (raw) => {
    if (!isObj(raw)) return { ok: false, errors: ['answer must be a JSON object'] };
    const errors: string[] = [];
    onlyKeys(raw, ['title', 'rationale', 'amountShare'], errors);
    const title = text(raw, 'title', 5, 120, errors, { noLinks: true });
    const rationale = text(raw, 'rationale', 40, 900, errors, { noLinks: true });
    const amountShare = num(raw, 'amountShare', share[0], share[1], errors);
    return done(errors, { title: title!, rationale: rationale!, amountShare: amountShare! });
  };
}

export const sentimentValidator: Validator<Sentiment> = (raw) => {
  if (!isObj(raw)) return { ok: false, errors: ['answer must be a JSON object'] };
  const errors: string[] = [];
  onlyKeys(raw, ['sentiment', 'summary'], errors);
  const sentiment = num(raw, 'sentiment', -1, 1, errors);
  const summary = text(raw, 'summary', 3, 200, errors, { noLinks: true });
  return done(errors, { sentiment: sentiment!, summary: summary! });
};
