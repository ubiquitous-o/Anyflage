// 顔（CelebAMask-HQ）とポケモン（PokeAPI の公式アートワーク）。
// 顔：samples/_raw/celeba に NNN.jpg（1024）と NNN.label（512、部位番号のグレースケールJPEG）が要る。
//   この配布元の番号は 0=背景、1=髪、4以上=肌と顔の部品（10=鼻、11〜13=口）、15あたり=首。1枚を色分けして見て決めた推定。
//   ラベルが JPEG なので境目の番号は少しずれる。マスクの縁はおおよそ。
import { copyFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RAW, SAMPLES, bboxOf, download, ensureDir, keepLargest, pool, readJpegRed, readPngRed, writeManifest, writeMask } from './lib.ts';
import type { Gray, Sample } from './lib.ts';

const faces: Sample[] = [];
const CEL = join(RAW, 'celeba');
if (existsSync(CEL)) for (const f of readdirSync(CEL).filter((f) => f.endsWith('.label')).sort()) {
  const id = f.replace('.label', ''), lab = readJpegRed(join(CEL, f)), image = `celeba/${id}.jpg`;
  ensureDir(join(SAMPLES, image)); copyFileSync(join(CEL, `${id}.jpg`), join(SAMPLES, image));
  // [まとまり, 名前, 含める部位番号の上限]
  // [まとまり, 名前, 含める番号の下限, 上限]。カオは髪と首を外す。アタマは背景以外ぜんぶ
  for (const [group, label, lo, hi] of [['カオ', 'face', 3, 13], ['アタマ', 'head', 1, 255]] as const) {
    const m: Gray = { w: lab.w, h: lab.h, data: new Uint8Array(lab.w * lab.h) };
    for (let i = 0; i < lab.data.length; i++) m.data[i] = lab.data[i] >= lo && lab.data[i] <= hi ? 1 : 0;
    keepLargest(m);
    const b = bboxOf(m); if (!b) continue;
    const mask = `celeba/${id}-${label}.png`, s = 1024 / lab.w; // マスクは512、画像は1024。外接矩形は画像の座標で書く
    writeMask(join(SAMPLES, mask), m);
    faces.push({ id: `celeba-${id}-${label}`, set: 'celeba', group, label, image, mask, bbox: [b[0] * s, b[1] * s, b[2] * s, b[3] * s], source: `CelebAMask-HQ ${id}` });
  }
}
writeManifest('celeba', faces);

// 透過PNGなので切り抜き不要。任天堂の著作物。手元のテスト専用で、リポジトリには入れない
const POKE = [1, 4, 6, 7, 9, 25, 39, 52, 54, 94, 129, 130, 131, 133, 143, 150];
const pokemon: Sample[] = [];
await pool(POKE, 4, async (n) => {
  const image = `pokemon/${n}.png`, file = join(SAMPLES, image);
  await download(`https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${n}.png`, file);
  const a = readPngRed(file, 3); for (let i = 0; i < a.data.length; i++) a.data[i] = a.data[i] > 110 ? 1 : 0;
  const bbox = bboxOf(a); if (!bbox) return;
  pokemon.push({ id: `pokemon-${n}`, set: 'pokemon', group: 'ポケモン', label: `#${n}`, image, mask: null, bbox, source: `PokeAPI official-artwork ${n}` });
});
pokemon.sort((a, b) => +a.label.slice(1) - +b.label.slice(1));
writeManifest('pokemon', pokemon);
