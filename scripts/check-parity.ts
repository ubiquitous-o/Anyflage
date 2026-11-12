// 移植の確かめ。試作のエンジン（JS）と src/engine（TS）に同じ入力を渡し、出力の画素が全部同じか比べる。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pngjs from 'pngjs';
import { Kao } from '../src/engine/kao.ts';
import { withShape } from '../src/material.ts';
import type { Method, Params, RGB, Source } from '../src/engine/types.ts';
import { ROOT, SAMPLES } from './lib.ts';

// 試作は CommonJS の書き方。このパッケージは ESM なので、中身を関数として読む
const Old: typeof Kao = new Function('module', readFileSync(join(ROOT, 'prototype', 'anyflage.engine.js'), 'utf8') + '\nreturn Kao;')({});

const METHODS: Method[] = ['radial', 'harmonic', 'elastic', 'area', 'contour', 'areaharm', 'diffuse', 'energy', 'blend'];
const COLORS: RGB[] = [[194, 178, 128], [75, 93, 42], [90, 64, 40], [28, 31, 24]];
const W = 300, H = 240;

function sources(engine: typeof Kao): Source[] {
  return [25, 130, 143].map((n) => {
    const png = pngjs.PNG.sync.read(readFileSync(join(SAMPLES, 'pokemon', `${n}.png`)));
    const carved = engine.carve(new Uint8ClampedArray(png.data), png.width, png.height, { amount: 0.6, aspect: 0.8, protect: 0.7 });
    const s = withShape(carved); if (!s) throw new Error('形を取れない');
    return s;
  });
}

let bad = 0;
for (const method of METHODS) {
  const p: Params = { seed: 48213, size: 0.17, wobble: 0.55, fit: 1, dist: 0.15, rot: 0.12, zoom: 1, tint: 0.4, assign: 'random', method, imp: 0.3, mix: 0.5, squeeze: 0.5 };
  const a = new Uint8ClampedArray(W * H * 4), b = new Uint8ClampedArray(W * H * 4);
  Old.renderCamo(a, Old.buildCamo(W, H, p), sources(Old), COLORS, p);
  Kao.renderCamo(b, Kao.buildCamo(W, H, p), sources(Kao), COLORS, p);
  let diff = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
  console.log(`${method.padEnd(9)} ${diff === 0 ? '同じ' : `違う画素値 ${diff}`}`);
  if (diff) bad++;
}
process.exit(bad ? 1 : 0);
