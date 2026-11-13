// 柄ごとに、ラバランプのコマを並べた見本を作る。素材は入れず、色だけ。柄の形がどう動くかを見る用。
// 1行が1つの柄。左から、時間を少しずつ進めたコマ。
//
// 使い方： node scripts/lava-sheet.ts 出力フォルダ [溶け具合 0〜1。省くと 0.5] [nocut：くびれ・えぐれで切らない]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pngjs from 'pngjs';
import { PATTERNS, swatchPattern } from '../src/engine/patterns.ts';
import { run } from '../src/render.ts';
import type { Job } from '../src/render.ts';
import { ROOT } from './lib.ts';

const dir = join(ROOT, 'public', 'swatches');
for (const meta of JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'))) {
  const img = pngjs.PNG.sync.read(readFileSync(join(dir, `${meta.id}.png`))), labels = new Uint8Array(img.width * img.height);
  for (let i = 0; i < labels.length; i++) labels[i] = Math.round(img.data[i * 4] / 40);
  PATTERNS.push(swatchPattern({ ...meta, w: img.width, h: img.height, labels }));
}
const out = process.argv[2]; if (!out) { console.error('出力フォルダを指定して'); process.exit(1); }
const amount = +(process.argv[3] || 0.5), S = 240, COLS = 6, COUNT = 24, PER = 7; // 1周 24 コマのうち、頭の 6 コマ。1枚に 7 柄
mkdirSync(out, { recursive: true });
const rgb = (h: string): number[] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
for (let page = 0; page * PER < PATTERNS.length; page++) {
  const pats = PATTERNS.slice(page * PER, page * PER + PER), png = new pngjs.PNG({ width: S * COLS, height: S * pats.length });
  pats.forEach((pat, row) => {
    for (let k = 0; k < COLS; k++) {
      const job = { kind: 'one', W: S, H: S, colors: pat.colors.map(rgb), mats: [], mat: {}, soft: false, edges: false, reuse: false,
        p: { seed: 18455, size: 0.089, wobble: 0.19, neck: process.argv[4] === 'nocut' ? 0 : 0.85, notch: process.argv[4] === 'nocut' ? 0 : 0.3, split: 'wavy', pattern: pat.id, flatLayers: pat.flatLayers, noSplit: pat.noSplit, tint: 0.8, dist: 0, rot: 0.17 },
        lava: { theta: Math.PI * 2 * k / COUNT, amount, first: true, grow: 1, dt: 0.03, pass: 'draw', index: k, count: COUNT } } as unknown as Job;
      const r = run(job);
      for (let y = 0; y < S; y++) png.data.set(r.data.subarray(y * S * 4, (y + 1) * S * 4), ((row * S + y) * S * COLS + k * S) * 4);
    }
    console.log(`${page + 1}枚目 ${row + 1}行目：${pat.id}`);
  });
  writeFileSync(join(out, `lava-${page + 1}.png`), pngjs.PNG.sync.write(png));
}
