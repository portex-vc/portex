/**
 * Deterministic 512x512 project marks: restrained two- or three-tone geometric compositions rendered with
 * anti-aliased signed distance fields and encoded as PNG. Same input, same bytes.
 */
import { encodePng } from './png';
import { rng, type Rng } from '../lib/random';

export const MARK_SIZE = 512;
type Sdf = (x: number, y: number) => number;
type Rgb = [number, number, number];
interface Layer {
  color: Rgb;
  sdf: Sdf;
}
interface Palette {
  name: string;
  bg: string;
  fg: string;
  soft: string;
}

/** Muted, print-like palettes. No teal: teal is reserved for protected principal in the product. */
export const PALETTES: Palette[] = [
  { name: 'ink', bg: '15171A', fg: 'EDE9E1', soft: '6E6A63' },
  { name: 'bone', bg: 'EAE5DA', fg: '1C1D1F', soft: 'A39E92' },
  { name: 'slate', bg: '2E343B', fg: 'E8E5DE', soft: '7C858F' },
  { name: 'clay', bg: '9C5B47', fg: 'F1E8DE', soft: 'C9937F' },
  { name: 'moss', bg: '4B5642', fg: 'ECE8DB', soft: '8E9780' },
  { name: 'sand', bg: 'D9CCB2', fg: '2B2824', soft: 'A8987A' },
  { name: 'navy', bg: '1D2736', fg: 'E6E2D8', soft: '6F7C90' },
  { name: 'plum', bg: '3B2D39', fg: 'EBE3E0', soft: '8A7385' },
  { name: 'ochre', bg: 'BF9448', fg: '1F1C18', soft: '8C6A2E' },
  { name: 'stone', bg: '8D8A84', fg: 'F3F1EC', soft: 'BDB9B1' },
  { name: 'oxblood', bg: '5B2B2B', fg: 'EFE6DC', soft: '9A6A62' },
  { name: 'paper', bg: 'F3F1EC', fg: '3A3F47', soft: 'B9B5AC' },
  { name: 'graphite', bg: '3A3A3C', fg: 'D9D4CA', soft: '8A857C' },
  { name: 'rust', bg: '7A4632', fg: 'EFE3D3', soft: 'B08066' },
];

const hex = (h: string): Rgb => [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const len = (x: number, y: number) => Math.sqrt(x * x + y * y);

// ---- signed distance primitives (pixels; negative inside) ----
const circle =
  (cx: number, cy: number, r: number): Sdf =>
  (x, y) =>
    len(x - cx, y - cy) - r;
const ring =
  (cx: number, cy: number, r: number, w: number): Sdf =>
  (x, y) =>
    Math.abs(len(x - cx, y - cy) - r) - w / 2;
const box =
  (cx: number, cy: number, hw: number, hh: number, rad = 0): Sdf =>
  (x, y) => {
    const qx = Math.abs(x - cx) - hw + rad;
    const qy = Math.abs(y - cy) - hh + rad;
    return len(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rad;
  };
const capsule =
  (ax: number, ay: number, bx: number, by: number, r: number): Sdf =>
  (x, y) => {
    const pax = x - ax,
      pay = y - ay,
      bax = bx - ax,
      bay = by - ay;
    const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay || 1), 0, 1);
    return len(pax - bax * h, pay - bay * h) - r;
  };
/** Regular n-gon with circumradius r, rotated by `rot` radians. */
const polygon = (cx: number, cy: number, r: number, n: number, rot = 0): Sdf => {
  const sector = (2 * Math.PI) / n;
  const apothem = r * Math.cos(Math.PI / n);
  return (x, y) => {
    const dx = x - cx,
      dy = y - cy;
    let a = Math.atan2(dy, dx) - rot;
    a = (((a % sector) + sector * 1.5) % sector) - sector / 2;
    return len(dx, dy) * Math.cos(a) - apothem;
  };
};
/** Stroke along a circular arc from a0 to a1 (radians, clockwise in screen space) with round caps. */
const arc = (cx: number, cy: number, r: number, w: number, a0: number, a1: number): Sdf => {
  const ends = [a0, a1].map((a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  const span = (((a1 - a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return (x, y) => {
    const a = (((Math.atan2(y - cy, x - cx) - a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    if (a <= span) return Math.abs(len(x - cx, y - cy) - r) - w / 2;
    return Math.min(len(x - ends[0][0], y - ends[0][1]), len(x - ends[1][0], y - ends[1][1])) - w / 2;
  };
};
const union =
  (...parts: Sdf[]): Sdf =>
  (x, y) => {
    let d = Infinity;
    for (const p of parts) {
      const v = p(x, y);
      if (v < d) d = v;
    }
    return d;
  };
const intersect =
  (a: Sdf, b: Sdf): Sdf =>
  (x, y) =>
    Math.max(a(x, y), b(x, y));
const subtract =
  (a: Sdf, b: Sdf): Sdf =>
  (x, y) =>
    Math.max(a(x, y), -b(x, y));
/** Half plane through (px,py) whose inside is the side the unit normal (nx,ny) points away from. */
const halfPlane = (px: number, py: number, angle: number): Sdf => {
  const nx = Math.cos(angle),
    ny = Math.sin(angle);
  return (x, y) => (x - px) * nx + (y - py) * ny;
};

// ---- motifs ----
type Motif = (r: Rng, c: { fg: Rgb; soft: Rgb; bg: Rgb }) => Layer[];
const C = MARK_SIZE / 2;
const Q = Math.PI / 4;

const MOTIFS: Record<string, Motif> = {
  orbit(r, c) {
    const a = r.int(0, 7) * Q + Q / 2;
    const R = 132;
    return [
      { color: c.soft, sdf: ring(C, C, R, 12) },
      { color: c.fg, sdf: circle(C, C, r.pick([62, 72, 80])) },
      { color: c.fg, sdf: circle(C + R * Math.cos(a), C + R * Math.sin(a), 22) },
    ];
  },
  split(r, c) {
    const a = r.int(0, 7) * Q;
    const disc = circle(C, C, 142);
    return [
      { color: c.soft, sdf: disc },
      { color: c.fg, sdf: intersect(disc, halfPlane(C, C, a)) },
      {
        color: c.bg,
        sdf: capsule(
          C - 150 * Math.cos(a + Math.PI / 2),
          C - 150 * Math.sin(a + Math.PI / 2),
          C + 150 * Math.cos(a + Math.PI / 2),
          C + 150 * Math.sin(a + Math.PI / 2),
          5,
        ),
      },
    ];
  },
  stack(r, c) {
    const n = r.int(3, 5);
    const gap = 26,
      h = 30;
    const top = C - (n * h + (n - 1) * gap) / 2;
    const left = C - 140;
    return Array.from({ length: n }, (_, i) => {
      const w = i === 0 ? 280 : r.pick([120, 160, 200, 240, 280]);
      return {
        color: i === 0 ? c.fg : i % 2 ? c.soft : c.fg,
        sdf: box(left + w / 2, top + i * (h + gap) + h / 2, w / 2, h / 2, h / 2),
      };
    });
  },
  lattice(r, c) {
    const layers: Layer[] = [];
    const step = 104;
    const filled = r.shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8]).slice(0, r.int(3, 5));
    for (let i = 0; i < 9; i++) {
      const x = C + ((i % 3) - 1) * step,
        y = C + (Math.floor(i / 3) - 1) * step;
      layers.push(
        filled.includes(i) ? { color: c.fg, sdf: circle(x, y, 34) } : { color: c.soft, sdf: ring(x, y, 30, 9) },
      );
    }
    return layers;
  },
  arcs(r, c) {
    const corner = r.int(0, 3);
    const ox = C + (corner % 2 ? 96 : -96),
      oy = C + (corner < 2 ? 96 : -96);
    const facing = Math.atan2(C - oy, C - ox);
    return [
      { color: c.fg, sdf: circle(ox, oy, 30) },
      ...[92, 150, 208].map((rad, i) => ({
        color: i === 1 ? c.soft : c.fg,
        sdf: arc(ox, oy, rad, 22, facing - Q, facing + Q),
      })),
    ];
  },
  hex(r, c) {
    const rot = r.chance(0.5) ? 0 : Math.PI / 6;
    return [
      { color: c.fg, sdf: subtract(polygon(C, C, 150, 6, rot), polygon(C, C, 122, 6, rot)) },
      { color: r.chance(0.5) ? c.soft : c.fg, sdf: r.chance(0.5) ? polygon(C, C, 60, 6, rot) : circle(C, C, 52) },
    ];
  },
  chevrons(r, c) {
    const n = r.int(2, 3);
    const w = 24,
      span = 120,
      rise = 72,
      gap = 70;
    const top = C - ((n - 1) * gap) / 2 - rise / 2 + 10;
    return Array.from({ length: n }, (_, i) => {
      const y = top + i * gap;
      return {
        color: i === 0 ? c.fg : c.soft,
        sdf: union(capsule(C - span, y + rise, C, y, w), capsule(C, y, C + span, y + rise, w)),
      };
    });
  },
  nodes(r, c) {
    const n = r.int(5, 6);
    const offset = r.range(0, Math.PI);
    const pts = Array.from({ length: n }, (_, i) => {
      const a = offset + (i * 2 * Math.PI) / n;
      const rad = 128 + (i % 2 ? -18 : 12);
      return [C + rad * Math.cos(a), C + rad * Math.sin(a)] as const;
    });
    const edges = pts.map(([x, y]) => capsule(C, C, x, y, 5));
    const rim = pts
      .map(([x, y], i) => capsule(x, y, pts[(i + 1) % n][0], pts[(i + 1) % n][1], 5))
      .filter((_, i) => i % 2 === 0);
    return [
      { color: c.soft, sdf: union(...edges, ...rim) },
      ...pts.map(([x, y], i) => ({ color: i % 3 === 0 ? c.fg : c.soft, sdf: circle(x, y, 24) })),
      { color: c.fg, sdf: circle(C, C, 40) },
    ];
  },
  quarters(r, c) {
    const s = 132;
    const layers: Layer[] = [];
    for (let i = 0; i < 4; i++) {
      const cx = C + (i % 2 ? s / 2 : -s / 2),
        cy = C + (i < 2 ? -s / 2 : s / 2);
      const k = r.int(0, 3);
      const px = cx + (k % 2 ? s / 2 : -s / 2),
        py = cy + (k < 2 ? -s / 2 : s / 2);
      const cell = box(cx, cy, s / 2 - 4, s / 2 - 4);
      layers.push({ color: i === 0 || i === 3 ? c.fg : c.soft, sdf: intersect(cell, circle(px, py, s - 8)) });
    }
    return layers;
  },
  monolith(r, c) {
    const tall = box(C, C, 70, 160, 70);
    return [
      { color: c.fg, sdf: subtract(tall, circle(C, C - 70, r.pick([34, 42]))) },
      { color: c.soft, sdf: box(C, C + 196, 120, 10, 10) },
    ];
  },
  waves(r, c) {
    const amp = r.pick([22, 28, 34]);
    const k = (2 * Math.PI) / r.pick([150, 180, 210]);
    const phase = r.range(0, Math.PI);
    return [-78, 0, 78].map((dy, row) => {
      const segs: Sdf[] = [];
      let prev: [number, number] | null = null;
      for (let x = C - 150; x <= C + 150; x += 12.5) {
        const y = C + dy + amp * Math.sin(k * x + phase + row * 0.7);
        if (prev) segs.push(capsule(prev[0], prev[1], x, y, 13));
        prev = [x, y];
      }
      return { color: row === 1 ? c.fg : c.soft, sdf: union(...segs) };
    });
  },
  sun(r, c) {
    const rays = r.pick([8, 12]);
    const offset = r.chance(0.5) ? 0 : Math.PI / rays;
    const spokes = Array.from({ length: rays }, (_, i) => {
      const a = offset + (i * 2 * Math.PI) / rays;
      return capsule(C + 100 * Math.cos(a), C + 100 * Math.sin(a), C + 150 * Math.cos(a), C + 150 * Math.sin(a), 11);
    });
    return [
      { color: c.soft, sdf: union(...spokes) },
      { color: c.fg, sdf: circle(C, C, 72) },
    ];
  },
};
export const MOTIF_NAMES = Object.keys(MOTIFS);

export interface MarkSpec {
  key: string;
  motif?: string;
  palette?: string;
}

/** Rasterize a project's mark to RGB. `key` (e.g. the ticker) seeds every free parameter. */
export function rasterMark(spec: MarkSpec): { rgb: Uint8Array; size: number; motif: string; palette: string } {
  const r = rng(`portex-mark:${spec.key}`);
  const motif = spec.motif && MOTIFS[spec.motif] ? spec.motif : r.pick(MOTIF_NAMES);
  const palette = PALETTES.find((p) => p.name === spec.palette) ?? r.pick(PALETTES);
  const colors = { bg: hex(palette.bg), fg: hex(palette.fg), soft: hex(palette.soft) };
  const layers = MOTIFS[motif](r, colors);
  const size = MARK_SIZE;
  const rgb = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let [cr, cg, cb] = colors.bg;
      const px = x + 0.5,
        py = y + 0.5;
      for (const layer of layers) {
        const alpha = clamp(0.5 - layer.sdf(px, py), 0, 1);
        if (alpha <= 0) continue;
        cr += (layer.color[0] - cr) * alpha;
        cg += (layer.color[1] - cg) * alpha;
        cb += (layer.color[2] - cb) * alpha;
      }
      const o = (y * size + x) * 3;
      rgb[o] = Math.round(cr);
      rgb[o + 1] = Math.round(cg);
      rgb[o + 2] = Math.round(cb);
    }
  }
  return { rgb, size, motif, palette: palette.name };
}

/** A project's mark as PNG bytes (512x512, deterministic). */
export function renderMark(spec: MarkSpec): Uint8Array {
  const { rgb, size } = rasterMark(spec);
  return encodePng(size, size, rgb);
}
