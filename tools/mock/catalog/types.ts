/** Catalog types and the pure sizing rules that map a catalog entry onto `RaiseFactoryV31.createRaise`. */

export type Template = 'ESCROW_LAUNCH' | 'BUDGET_LAUNCH';
export type Category =
  | 'Agents'
  | 'Developer tools'
  | 'Evaluation & safety'
  | 'Data infrastructure'
  | 'Inference & compute'
  | 'Security'
  | 'Health'
  | 'Science'
  | 'Climate'
  | 'Robotics'
  | 'Finance'
  | 'Legal'
  | 'Education'
  | 'Creative tools'
  | 'Logistics';

export interface BuilderUpdate {
  title: string;
  body: string;
  kind: 'milestone' | 'update';
}

export interface CatalogProject {
  /** URL-safe id; also the `<slug>.example` website. */
  slug: string;
  name: string;
  /** 3-5 uppercase letters, unique in the catalog. */
  ticker: string;
  category: Category;
  template: Template;
  /** One-line pitch (profile tagline, at most 200 chars). */
  pitch: string;
  /** Two to four paragraphs (profile description, at most 2000 chars once joined). */
  description: string[];
  /** Stage 1 target size in whole USDG: the escrow when the 20% sale allocation is sold out. */
  raise: number;
  /** Total token supply in whole tokens (multiple of 10). */
  supply: number;
  /** Budget Launch only: the draw ceiling as basis points of escrow (at most the pinned 30%). */
  budgetCeilingBps?: number;
  /** Two or three texts the builder posts over time. */
  updates: BuilderUpdate[];
  /** Optional mark overrides (see images/marks.ts). */
  motif?: string;
  palette?: string;
}

export const TOKEN = 10n ** 18n;
export const USDG = 10n ** 6n;
/** Normalized price scale used by the contracts: quote units per token unit times 1e30. */
export const NORMALIZED_PRICE = 10n ** 30n;
/** Minimum fully diluted valuation the factory accepts (targetPrice * supply / 1e18 >= 100000e18). */
export const MIN_FDV_USDG = 100_000;

/**
 * Stage 1 sells 20% of supply on a kappa = 3/2 curve that ends at the target price, so a sold-out Stage 1 raises
 * 5/6 of the allocation at target: escrow = FDV / 6. The catalog states the raise; FDV and price follow.
 */
export function sizing(p: Pick<CatalogProject, 'raise' | 'supply'>) {
  const fdv = p.raise * 6;
  const supply = BigInt(p.supply) * TOKEN;
  // price in quote units (6 dp) per token unit (18 dp), scaled by 1e30  =  fdv * 1e6 * 1e30 / (supply * 1e18)
  const targetPrice = (BigInt(fdv) * USDG * NORMALIZED_PRICE) / supply;
  return { fdv, supply, targetPrice, pricePerToken: fdv / p.supply };
}

/** Exact CurveV31.cost: quote units to buy `quantity` more tokens after `sold` (rounded up). */
export function curveCost(targetPrice: bigint, allocation: bigint, sold: bigint, quantity: bigint): bigint {
  if (allocation === 0n || sold > allocation || quantity > allocation - sold)
    throw new Error('curve: invalid quantity');
  const area = quantity * (4n * allocation + 2n * sold + quantity);
  const denominator = 6n * allocation * NORMALIZED_PRICE;
  const numerator = targetPrice * area;
  return (numerator + denominator - 1n) / denominator;
}

/** Quote units needed to sell out the remaining Stage 1 allocation. */
export function remainingFillCost(targetPrice: bigint, supply: bigint, sold: bigint): bigint {
  const allocation = supply / 5n;
  return sold >= allocation ? 0n : curveCost(targetPrice, allocation, sold, allocation - sold);
}

/** Mirrors the static parts of RaiseFactoryV31._validate; returns problems (empty = valid). */
export function validateEntry(p: CatalogProject): string[] {
  const problems: string[] = [];
  const { fdv, supply, targetPrice } = sizing(p);
  if (!/^[A-Z]{3,5}$/.test(p.ticker)) problems.push('ticker must be 3-5 uppercase letters');
  if (!/^[a-z0-9-]+$/.test(p.slug)) problems.push('slug must be lowercase letters, digits and dashes');
  if (p.supply % 10 !== 0 || p.supply < 50) problems.push('supply must be a multiple of 10');
  if (supply > 10n ** 30n) problems.push('supply exceeds MAX_SUPPLY');
  if (targetPrice === 0n || targetPrice > 10n ** 36n) problems.push('target price out of range');
  if ((targetPrice * supply) / TOKEN < BigInt(MIN_FDV_USDG) * TOKEN)
    problems.push(`FDV ${fdv} below the factory minimum`);
  if (p.template === 'ESCROW_LAUNCH' && p.budgetCeilingBps) problems.push('Escrow Launch cannot have a budget ceiling');
  if (p.template === 'BUDGET_LAUNCH' && !(p.budgetCeilingBps && p.budgetCeilingBps > 0 && p.budgetCeilingBps <= 3000))
    problems.push('Budget Launch needs a ceiling in (0, 3000] bps');
  if (!p.pitch || p.pitch.length > 200 || /[\r\n]/.test(p.pitch))
    problems.push('pitch must be one line of at most 200 chars');
  if (p.description.length < 2 || p.description.length > 4) problems.push('description must have 2-4 paragraphs');
  if (p.description.join('\n\n').length > 2000) problems.push('description exceeds 2000 chars');
  if (p.updates.length < 2 || p.updates.length > 3) problems.push('2-3 builder updates required');
  for (const u of p.updates)
    if (!u.title || u.title.length > 200 || !u.body || u.body.length > 5000) problems.push(`bad update: ${u.title}`);
  return problems;
}
