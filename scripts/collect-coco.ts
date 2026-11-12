// COCO val2017 から、クラスごとに大きく写っている物を選び、画像とマスクを samples/coco に置く。
// 先に samples/_raw/annotations/ に instances_val2017.json と person_keypoints_val2017.json が要る。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RAW, SAMPLES, bboxOf, download, fillPolygons, inside, pool, writeManifest, writeMask } from './lib.ts';
import type { Sample } from './lib.ts';

interface Img { id: number; width: number; height: number; file_name: string; coco_url: string }
interface Ann { id: number; image_id: number; category_id: number; segmentation: number[][] | object; area: number; bbox: number[]; iscrowd: number; num_keypoints?: number }
interface Coco { images: Img[]; annotations: Ann[]; categories: { id: number; name: string }[] }

// [COCOのクラス名, アプリでのまとまり, 枚数]
const WANT: [string, string, number][] = [
  ['person', 'ヒト', 16],
  ['cat', 'ネコ', 10], ['dog', 'イヌ', 10],
  ['horse', 'ドウブツ', 6], ['elephant', 'ドウブツ', 6], ['giraffe', 'ドウブツ', 6], ['zebra', 'ドウブツ', 6], ['bird', 'ドウブツ', 6], ['bear', 'ドウブツ', 6],
  ['car', 'クルマ', 10],
  ['bus', 'ノリモノ', 5], ['truck', 'ノリモノ', 5], ['motorcycle', 'ノリモノ', 5], ['bicycle', 'ノリモノ', 5], ['airplane', 'ノリモノ', 5], ['train', 'ノリモノ', 5],
];

const load = (name: string): Coco => JSON.parse(readFileSync(join(RAW, 'annotations', name), 'utf8'));
const inst = load('instances_val2017.json'), kp = load('person_keypoints_val2017.json');
const images = new Map(inst.images.map((im) => [im.id, im]));
const catId = new Map(inst.categories.map((c) => [c.name, c.id]));
const used = new Set<number>(), picked: { ann: Ann; img: Img; label: string; group: string }[] = [];

for (const [label, group, count] of WANT) {
  // 人は関節の注釈から選ぶ。17点のうち16点以上が付いていれば、全身が写っている
  const pool0 = label === 'person' ? kp.annotations.filter((a) => (a.num_keypoints || 0) >= 16) : inst.annotations.filter((a) => a.category_id === catId.get(label));
  const cands = pool0.filter((a) => {
    const im = images.get(a.image_id)!, frac = a.area / (im.width * im.height);
    return !a.iscrowd && Array.isArray(a.segmentation) && frac > (label === 'person' ? 0.05 : 0.08) && frac < 0.7 && inside(a.bbox, im.width, im.height);
  }).sort((a, b) => b.area - a.area);
  let n = 0;
  for (const a of cands) {
    if (n >= count) break;
    if (used.has(a.image_id)) continue;
    used.add(a.image_id); picked.push({ ann: a, img: images.get(a.image_id)!, label, group }); n++;
  }
  if (n < count) console.warn(`${label}: ${count}件ほしいが ${n}件しかない`);
}

const samples: Sample[] = [];
await pool(picked, 4, async ({ ann, img, label, group }) => {
  await download(img.coco_url, join(SAMPLES, 'coco', img.file_name));
  const m = fillPolygons(img.width, img.height, ann.segmentation as number[][]), bbox = bboxOf(m);
  if (!bbox) return;
  const mask = `coco/${ann.id}.png`;
  writeMask(join(SAMPLES, mask), m);
  samples.push({ id: `coco-${ann.id}`, set: 'coco', group, label, image: `coco/${img.file_name}`, mask, bbox, source: `COCO val2017 ${img.file_name}` });
});
samples.sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
writeManifest('coco', samples);
