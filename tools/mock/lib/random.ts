/** Small deterministic randomness helpers (seeded PRNG, lognormal sizes, weighted picks). */

/** 53-bit string hash (cyrb53); stable across runs and platforms. */
export function hash(text: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [min, max). */
  range(min: number, max: number): number;
  /** Integer in [min, max]. */
  int(min: number, max: number): number;
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
  weighted<T>(items: readonly T[], weight: (item: T) => number): T;
  shuffle<T>(items: readonly T[]): T[];
  /** Standard normal (Box-Muller). */
  normal(): number;
  /** Lognormal with the given median and log-space sigma. */
  lognormal(median: number, sigma: number): number;
  /** Poisson-distributed count with mean `lambda` (Knuth; fine for small lambda). */
  poisson(lambda: number): number;
}

/** mulberry32 seeded from any string or number. */
export function rng(seed: string | number): Rng {
  let a = (typeof seed === 'number' ? seed : hash(seed)) >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const self: Rng = {
    next,
    range: (min, max) => min + (max - min) * next(),
    int: (min, max) => Math.floor(min + (max - min + 1) * next()),
    chance: (p) => next() < p,
    pick: (items) => items[Math.floor(next() * items.length)],
    weighted(items, weight) {
      const total = items.reduce((sum, item) => sum + Math.max(0, weight(item)), 0);
      let r = next() * total;
      for (const item of items) {
        r -= Math.max(0, weight(item));
        if (r <= 0) return item;
      }
      return items[items.length - 1];
    },
    shuffle(items) {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
    normal() {
      const u = Math.max(next(), 1e-12);
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
    },
    lognormal: (median, sigma) => median * Math.exp(sigma * self.normal()),
    poisson(lambda) {
      if (lambda <= 0) return 0;
      const limit = Math.exp(-Math.min(lambda, 30));
      let k = 0;
      let p = 1;
      do {
        k++;
        p *= next();
      } while (p > limit);
      return k - 1;
    },
  };
  return self;
}
