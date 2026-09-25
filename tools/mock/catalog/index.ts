/** The mock catalog: projects, feedback texts, profile payloads and mark assignment. */
import { PROJECTS as FIRST, FEEDBACK } from './projects';
import { MORE_PROJECTS } from './projects-more';
import { validateEntry, sizing, type CatalogProject } from './types';
import { MOTIF_NAMES, PALETTES, renderMark } from '../images/marks';

/** The full catalog. New projects are only ever appended, so a running state's catalog cursor stays valid. */
export const PROJECTS = [...FIRST, ...MORE_PROJECTS];
export { FEEDBACK };
export * from './types';

export function byTicker(ticker: string): CatalogProject {
  const project = PROJECTS.find((p) => p.ticker === ticker);
  if (!project) throw new Error(`unknown catalog ticker ${ticker}`);
  return project;
}

/** Every catalog problem (duplicate tickers or slugs, factory rules, profile limits). Empty means valid. */
export function validateCatalog(projects: CatalogProject[] = PROJECTS): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const p of projects) {
    for (const key of [`ticker:${p.ticker}`, `slug:${p.slug}`, `name:${p.name.toLowerCase()}`]) {
      if (seen.has(key)) problems.push(`${p.ticker}: duplicate ${key.split(':')[0]} (also ${seen.get(key)})`);
      seen.set(key, p.ticker);
    }
    for (const problem of validateEntry(p)) problems.push(`${p.ticker}: ${problem}`);
  }
  return problems;
}

/** Deterministic, well-spread mark assignment: motifs cycle, palettes step by a coprime stride. */
export function markSpec(project: CatalogProject) {
  const i = Math.max(0, PROJECTS.indexOf(project));
  return {
    key: project.ticker,
    motif: project.motif ?? MOTIF_NAMES[i % MOTIF_NAMES.length],
    palette: project.palette ?? PALETTES[(i * 5 + 3) % PALETTES.length].name,
  };
}

export function markPng(project: CatalogProject): Uint8Array {
  return renderMark(markSpec(project));
}

/** Body for `PUT /v2/raises/:address/profile`. */
export function profileBody(project: CatalogProject, image?: string | null) {
  return {
    name: project.name,
    tagline: project.pitch,
    description: project.description.join('\n\n'),
    website: `https://${project.slug}.example`,
    twitter: '',
    github: '',
    docs: '',
    ...(image ? { image } : {}),
  };
}

export function describeSizing(project: CatalogProject): string {
  const s = sizing(project);
  return `${project.ticker} raise ${project.raise.toLocaleString('en-US')} USDG, FDV ${s.fdv.toLocaleString('en-US')} USDG, supply ${project.supply.toLocaleString('en-US')}, price ${s.pricePerToken.toPrecision(3)} USDG`;
}
