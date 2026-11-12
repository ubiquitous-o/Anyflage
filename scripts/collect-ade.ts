// ADE20K（SceneParsing 版、検証2000枚）から建物を選ぶ。注釈PNGは画素ごとのクラス番号。
// 同じクラスの建物が何棟あっても1色なので、いちばん大きいかたまりだけ使う。
import { copyFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RAW, SAMPLES, bboxOf, ensureDir, inside, keepLargest, readPngRed, writeManifest, writeMask } from './lib.ts';
import type { Gray, Sample } from './lib.ts';

const ADE = join(RAW, 'ADEChallengeData2016');
const WANT: [string, number][] = [['building', 12], ['house', 8], ['skyscraper', 6], ['tower', 6]];

// objectInfo150.txt: タブ区切りで Idx, Ratio, Train, Val, Name。名前は「building, edifice」のように別名つき
const index = new Map<string, number>();
for (const line of readFileSync(join(ADE, 'objectInfo150.txt'), 'utf8').split('\n').slice(1)) {
  const cols = line.split('\t'); if (cols.length < 5) continue;
  index.set(cols[4].split(',')[0].trim(), +cols[0]);
}

interface Cand { name: string; label: string; m: Gray; bbox: [number, number, number, number]; score: number }
const cands: Cand[] = [];
const files = readdirSync(join(ADE, 'annotations', 'validation')).filter((f) => f.endsWith('.png'));
for (const f of files) {
  const ann = readPngRed(join(ADE, 'annotations', 'validation', f));
  for (const [label] of WANT) {
    const idx = index.get(label); if (idx === undefined) throw new Error(`クラスが見つからない: ${label}`);
    const m: Gray = { w: ann.w, h: ann.h, data: new Uint8Array(ann.w * ann.h) };
    let any = 0; for (let i = 0; i < ann.data.length; i++) if (ann.data[i] === idx) { m.data[i] = 1; any++; }
    if (any < ann.w * ann.h * 0.1) continue;
    const frac = keepLargest(m) / (ann.w * ann.h), bbox = bboxOf(m);
    if (!bbox || frac < 0.1 || frac > 0.7) continue;
    // 画面に収まっている建物を先に。次に大きさ
    cands.push({ name: f.replace('.png', ''), label, m, bbox, score: (inside(bbox, ann.w, ann.h) ? 10 : 0) + frac });
  }
}

const samples: Sample[] = [], used = new Set<string>();
for (const [label, count] of WANT) {
  let n = 0;
  for (const c of cands.filter((c) => c.label === label).sort((a, b) => b.score - a.score)) {
    if (n >= count) break;
    if (used.has(c.name)) continue;
    used.add(c.name); n++;
    const image = `ade/${c.name}.jpg`, mask = `ade/${c.name}-${label}.png`;
    ensureDir(join(SAMPLES, image));
    copyFileSync(join(ADE, 'images', 'validation', `${c.name}.jpg`), join(SAMPLES, image));
    writeMask(join(SAMPLES, mask), c.m);
    samples.push({ id: `ade-${c.name}-${label}`, set: 'ade', group: 'ビル', label, image, mask, bbox: c.bbox, source: `ADE20K ${c.name}` });
  }
  if (n < count) console.warn(`${label}: ${count}件ほしいが ${n}件しかない`);
}
writeManifest('ade', samples);
