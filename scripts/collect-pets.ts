// Oxford-IIIT Pet から猫と犬を選ぶ。trimap は 1=中身、2=背景、3=境目。1と3を中身にする。
// 品種が偏らないよう、1品種1枚ずつ取る。
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RAW, SAMPLES, bboxOf, ensureDir, inside, keepLargest, readPngRed, writeManifest, writeMask } from './lib.ts';
import type { Gray, Sample } from './lib.ts';

const PETS = join(RAW, 'pets'), COUNT = 12;
const samples: Sample[] = [], seen = new Set<string>(), count: Record<string, number> = { ネコ: 0, イヌ: 0 };

// list.txt: 「Abyssinian_100 1 1 1」＝名前、クラス番号、種（1=猫、2=犬）、品種番号
for (const line of readFileSync(join(PETS, 'annotations', 'list.txt'), 'utf8').split('\n')) {
  if (!line || line.startsWith('#')) continue;
  const [name, , species] = line.split(' '), group = species === '1' ? 'ネコ' : 'イヌ', breed = name.replace(/_\d+$/, '');
  if (count[group] >= COUNT || seen.has(breed)) continue;
  const tri = join(PETS, 'annotations', 'trimaps', `${name}.png`), jpg = join(PETS, 'images', `${name}.jpg`);
  if (!existsSync(tri) || !existsSync(jpg)) continue;
  const t = readPngRed(tri), m: Gray = { w: t.w, h: t.h, data: new Uint8Array(t.w * t.h) };
  for (let i = 0; i < t.data.length; i++) m.data[i] = t.data[i] === 1 || t.data[i] === 3 ? 1 : 0;
  const frac = keepLargest(m) / (t.w * t.h), bbox = bboxOf(m);
  if (!bbox || frac < 0.15 || frac > 0.7 || !inside(bbox, t.w, t.h)) continue;
  seen.add(breed); count[group]++;
  const image = `pets/${name}.jpg`, mask = `pets/${name}.png`;
  ensureDir(join(SAMPLES, image));
  copyFileSync(jpg, join(SAMPLES, image)); writeMask(join(SAMPLES, mask), m);
  samples.push({ id: `pets-${name}`, set: 'pets', group, label: breed.replace(/_/g, ' '), image, mask, bbox, source: `Oxford-IIIT Pet ${name}` });
}
writeManifest('pets', samples);
