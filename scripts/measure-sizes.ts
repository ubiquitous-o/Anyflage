// 柄ごとの、色のかたまりの大きさを測る。src/engine/patterns.ts の SIZE_FIX を決めるための道具。
// 同じ「ブロブの大きさ」で、どの柄も標準の柄（blob）と同じくらいの大きさになるような倍率を出す。
//
// 使い方： node scripts/measure-sizes.ts
//   出てきた「今の倍率に掛ける値」が 1.00 に近ければ、そろっている。
//   離れていれば、最後に出る表を SIZE_FIX に貼り、もう一度回す（大きさと倍率は比例しない柄があるので、2〜3回で落ち着く）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pngjs from 'pngjs';
import { Kao } from '../src/engine/kao.ts';
import { PATTERNS, SIZE_FIX, swatchPattern } from '../src/engine/patterns.ts';
import { ROOT } from './lib.ts';

const dir = join(ROOT, 'public', 'swatches');
for (const meta of JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'))) {
  const img = pngjs.PNG.sync.read(readFileSync(join(dir, `${meta.id}.png`))), labels = new Uint8Array(img.width * img.height);
  for (let i = 0; i < labels.length; i++) labels[i] = Math.round(img.data[i * 4] / 40);
  PATTERNS.push(swatchPattern({ ...meta, w: img.width, h: img.height, labels }));
}
const W = 720, size = 0.17, SEEDS = [48213, 7, 999, 31337];
/** 大きさの目安。「同じ色が続く長さ」と「かたまりの太さ」の相乗平均（画素） */
function measure(id: string): number {
  const pat = PATTERNS.find((p) => p.id === id)!;
  let run = 0, thick = 0;
  for (const seed of SEEDS) {
    const c = Kao.buildCamo(W, W, { seed, size, wobble: 0.55, neck: 0, notch: 0, split: 'none', noSplit: true, layerAt: id === 'blob' ? undefined : pat.make(seed, size) });
    const L = new Uint8Array(W * W); for (let i = 0; i < W * W; i++) L[i] = c.comps.layer[c.ids[i]];
    let edges = 0; for (let y = 0; y < W; y++) for (let x = 1; x < W; x++) { if (L[y * W + x] !== L[y * W + x - 1]) edges++; if (L[x * W + y] !== L[(x - 1) * W + y]) edges++; }
    run += 2 * W * W / (edges + 2 * W);
    let s = 0; for (let i = 0; i < W * W; i++) s += c.dt[i]; thick += 4 * s / (W * W);
  }
  return Math.sqrt((run / SEEDS.length) * (thick / SEEDS.length));
}
const target = measure('blob'), next: Record<string, number> = {};
console.log(`基準（Anyflage 標準）：${target.toFixed(1)} 画素`);
for (const pat of PATTERNS) {
  if (pat.id === 'blob' || pat.id === 'tiles') continue;
  const g = measure(pat.id), now = SIZE_FIX[pat.id] || 1, mul = target / g;
  next[pat.id] = +(now * mul).toFixed(2);
  console.log(pat.id.padEnd(16), `大きさ ${g.toFixed(1).padStart(6)}`, `今の倍率 ${now.toFixed(2).padStart(6)}`, `今の倍率に掛ける値 ${mul.toFixed(2)}`);
}
console.log('\nSIZE_FIX に貼る表：\n' + JSON.stringify(next).replace(/"([a-z0-9]+)":/g, '$1: ').replace(/"(sw-[a-z0-9-]+)":/g, "'$1': ").replace(/,/g, ', '));
