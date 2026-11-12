// 「背景」がどれだけ出るかを方式ごとに測る。
// ブロブの中で、素材が塗られず迷彩の色だけになった画素の割合を数える。
// 迷彩の色を変えて2回描き、結果が違う画素＝素材が塗られていない画素（色の混ぜ具合 tint は 0 にする）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pngjs from 'pngjs';
import jpeg from 'jpeg-js';
import { Kao } from '../src/engine/kao.ts';
import { Material } from '../src/material.ts';
import type { Method, Params, Picker, Raster, RGB } from '../src/engine/types.ts';
import { SAMPLES } from './lib.ts';
import type { Sample } from './lib.ts';

/** ブラウザ側 samples.ts と同じ切り抜きを、Node で作る（拡大縮小は最近傍） */
function cutout(s: Sample): Raster {
  const file = join(SAMPLES, s.image);
  const im = file.endsWith('.png') ? pngjs.PNG.sync.read(readFileSync(file)) : jpeg.decode(readFileSync(file), { useTArray: true, maxMemoryUsageInMB: 1024 });
  const mask = s.mask ? pngjs.PNG.sync.read(readFileSync(join(SAMPLES, s.mask))) : null;
  const [bx, by, bw, bh] = s.bbox, long = Math.max(bw, bh), k = 496 / long, w = Math.round(bw * k) + 16, h = Math.round(bh * k) + 16;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 8; y < h - 8; y++) for (let x = 8; x < w - 8; x++) {
    const sx = Math.min(im.width - 1, Math.floor(bx + (x - 8) / k)), sy = Math.min(im.height - 1, Math.floor(by + (y - 8) / k)), si = (sy * im.width + sx) * 4, o = (y * w + x) * 4;
    data[o] = im.data[si]; data[o + 1] = im.data[si + 1]; data[o + 2] = im.data[si + 2];
    if (mask) { const mx = Math.min(mask.width - 1, Math.floor(sx * mask.width / im.width)), my = Math.min(mask.height - 1, Math.floor(sy * mask.height / im.height)); data[o + 3] = mask.data[(my * mask.width + mx) * 4]; }
    else data[o + 3] = im.data[si + 3];
  }
  return { w, h, data };
}

const METHODS: Method[] = ['radial', 'harmonic', 'elastic', 'area', 'contour', 'areaharm', 'diffuse', 'energy', 'blend', 'carve'];
const A: RGB[] = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]], B: RGB[] = [[255, 0, 255], [255, 0, 255], [255, 0, 255], [255, 0, 255]];
const W = 480, H = 480;
const all: Sample[] = ['celeba', 'coco', 'pets', 'ade', 'pokemon'].flatMap((set) => JSON.parse(readFileSync(join(SAMPLES, `${set}.json`), 'utf8')));
const groups = process.argv[2] ? process.argv[2].split(',') : ['カオ', 'ヒト', 'ネコ', 'クルマ', 'ビル', 'ポケモン'];
const carve = process.argv[3] ? +process.argv[3] : 0.6;

console.log(`背景の割合（％）。シームカービング ${carve * 100}%`);
console.log('種類'.padEnd(6) + METHODS.map((m) => m.padStart(9)).join(''));
for (const g of groups) {
  const mats = all.filter((s) => s.group === g).slice(0, 6).map((s) => new Material(cutout(s)));
  const src = mats.map((m) => m.picker({ carve, protect: 0.7, fitBlob: true })).filter((p): p is Picker => !!p);
  let line = g.padEnd(6);
  for (const method of METHODS) {
    const p: Params = { seed: 48213, size: 0.17, wobble: 0.55, fit: 1, dist: 0.15, rot: 0.12, zoom: 1, tint: 0, assign: 'random', method, imp: 0, mix: 0.5, squeeze: 0.5 };
    const camo = Kao.buildCamo(W, H, p), a = new Uint8ClampedArray(W * H * 4), b = new Uint8ClampedArray(W * H * 4);
    Kao.renderCamo(a, camo, src, A, p); Kao.renderCamo(b, camo, src, B, p);
    let flat = 0; for (let i = 0; i < W * H; i++) if (a[i * 4] !== b[i * 4] || a[i * 4 + 1] !== b[i * 4 + 1]) flat++;
    line += (flat / (W * H) * 100).toFixed(1).padStart(9);
  }
  console.log(line);
}
