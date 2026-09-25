/**
 * Render every catalog mark to PNG files for review, plus a contact sheet.
 *   bun tools/mock/images.ts [--out <dir>]      (default tools/mock/state/images, gitignored)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECTS, markSpec } from './catalog';
import { rasterMark } from './images/marks';
import { encodePng } from './images/png';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const out = resolve(
  outIndex >= 0 ? args[outIndex + 1] : resolve(dirname(fileURLToPath(import.meta.url)), 'state/images'),
);
mkdirSync(out, { recursive: true });

const cell = 256,
  cols = 6,
  pad = 8;
const rows = Math.ceil(PROJECTS.length / cols);
const W = cols * (cell + pad) + pad,
  H = rows * (cell + pad) + pad;
const sheet = new Uint8Array(W * H * 3).fill(214);
PROJECTS.forEach((project, i) => {
  const spec = markSpec(project);
  const { rgb, size } = rasterMark(spec);
  const png = encodePng(size, size, rgb);
  writeFileSync(resolve(out, `${project.ticker}.png`), png);
  const ox = pad + (i % cols) * (cell + pad),
    oy = pad + Math.floor(i / cols) * (cell + pad);
  for (let y = 0; y < cell; y++)
    for (let x = 0; x < cell; x++)
      for (let c = 0; c < 3; c++) {
        const a = (2 * y * size + 2 * x) * 3 + c,
          d = a + size * 3;
        sheet[((oy + y) * W + ox + x) * 3 + c] = (rgb[a] + rgb[a + 3] + rgb[d] + rgb[d + 3]) >> 2;
      }
  console.log(`${project.ticker.padEnd(5)} ${spec.motif.padEnd(9)} ${spec.palette.padEnd(9)} ${png.length} bytes`);
});
writeFileSync(resolve(out, 'contact-sheet.png'), encodePng(W, H, sheet));
console.log(`wrote ${PROJECTS.length} marks and contact-sheet.png to ${out}`);
