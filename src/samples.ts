// samples/ のテスト素材を読む。画像とマスクから、アルファ付きの切り抜きを作る。
import type { Raster } from './engine/types.ts';
import { cutOut } from './cutout.ts';
import type { CutKind } from './cutout.ts';
import { clearOwn, loadOwn, saveOwn } from './store.ts';

/** scripts/lib.ts の Sample と同じ形 */
export interface Sample {
  id: string;
  set: string;
  group: string;
  label: string;
  image: string;
  mask: string | null;
  bbox: [number, number, number, number];
  source: string;
}

/** 公開してよい素材のセット。public/sets/ にあり、公開版にも入る。切り抜き済みの画像（透明つき） */
const OPEN_SETS = ['sample'];
/** 手元だけのテスト素材。samples/ にあり、リポジトリにも公開版にも入らない */
const SETS = ['celeba', 'coco', 'pets', 'ade', 'pokemon'];
/** 素材の置き場所。公開してよいセットは sets/、手元だけのものは samples/ */
const dirOf = (set: string): string => (OPEN_SETS.includes(set) ? 'sets' : 'samples');
const cutouts = new Map<string, Promise<Raster>>();
/** 置き場所。公開版は /Anyflage/ の下に置かれるので、決め打ちの / から始めない */
const BASE = import.meta.env.BASE_URL;
let ownCount = 0;

/**
 * 手元の画像を素材として足す。kind が asis なら背景除去しない。透明のある PNG は、透明でない所が切り抜きになり、
 * 透明のない画像（写真など）は四角のまま素材になる。ほかの kind は cutout.ts で背景を除く。
 * 画像はブラウザの中だけで使い、どこにも送らない。
 */
export async function addOwnImage(file: File, group: string, kind: CutKind): Promise<Sample> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url), long = Math.max(img.naturalWidth, img.naturalHeight), k = Math.min(1, SRC_MAX / long);
    const w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(img, 0, 0, w, h);
    const id = `own-${Date.now().toString(36)}-${++ownCount}`, raster: Raster = await cutOut(c, kind);
    cutouts.set(id, Promise.resolve(raster));
    void remember(id, group, file.name, raster); // ブラウザを閉じても残るように覚える。待たない
    return ownSample(id, group, file.name, raster.w, raster.h);
  } finally { URL.revokeObjectURL(url); }
}
const ownSample = (id: string, group: string, label: string, w: number, h: number): Sample => ({ id, set: 'own', group, label, image: '', mask: null, bbox: [0, 0, w, h], source: '自分で足した画像' });
/** 切り抜いたあとの画像を PNG にして、ブラウザに覚える */
async function remember(id: string, group: string, label: string, r: Raster): Promise<void> {
  const c = document.createElement('canvas'); c.width = r.w; c.height = r.h;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(r.data), r.w, r.h), 0, 0);
  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'));
  if (blob) await saveOwn({ id, group, label, w: r.w, h: r.h, blob, at: Date.now() + ownCount });
}
/** 前に足した画像を、ブラウザから読み戻す。足した順 */
export async function restoreOwnImages(): Promise<Sample[]> {
  const out: Sample[] = [];
  for (const rec of await loadOwn()) {
    const url = URL.createObjectURL(rec.blob);
    try {
      const img = await loadImage(url), c = document.createElement('canvas'); c.width = rec.w; c.height = rec.h;
      const g = c.getContext('2d', { willReadFrequently: true })!; g.drawImage(img, 0, 0);
      cutouts.set(rec.id, Promise.resolve({ w: rec.w, h: rec.h, data: g.getImageData(0, 0, rec.w, rec.h).data }));
      out.push(ownSample(rec.id, rec.group, rec.label, rec.w, rec.h));
    } catch { /* 壊れた1枚は飛ばす */ } finally { URL.revokeObjectURL(url); }
  }
  return out;
}
/** 足した画像を、ブラウザから全部消す */
export async function forgetOwnImages(): Promise<void> { await clearOwn(); for (const id of [...cutouts.keys()]) if (id.startsWith('own-')) cutouts.delete(id); }
/** 切り抜きの長辺。元の解像度をなるべく保つ。小さい素材は 512 まで拡大、大きい素材は 1024 まで */
const SRC_MIN = 512, SRC_MAX = 1024, PAD = 8;

/** あるぶんだけ読む。まだ集めていないセットは飛ばす */
export async function loadManifests(): Promise<Sample[]> {
  const lists = await Promise.all([...OPEN_SETS, ...SETS].map(async (set) => {
    try {
      const r = await fetch(`${BASE}${dirOf(set)}/${set}.json`);
      if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) return [];
      return (await r.json()) as Sample[];
    } catch { return []; }
  }));
  return lists.flat();
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error(`読めなかった: ${src}`));
    im.src = src;
  });
}


/** マスクの外接矩形で切り出し、長辺 512〜1024 の RGBA。マスクの外はアルファ 0 */
export function loadCutout(s: Sample): Promise<Raster> {
  let p = cutouts.get(s.id);
  if (!p) { p = makeCutout(s); cutouts.set(s.id, p); }
  return p;
}

async function makeCutout(s: Sample): Promise<Raster> {
  const [img, mask] = await Promise.all([loadImage(`${BASE}${dirOf(s.set)}/${s.image}`), s.mask ? loadImage(`${BASE}${dirOf(s.set)}/${s.mask}`) : null]);
  const [bx, by, bw, bh] = s.bbox, long = Math.max(bw, bh), k = (Math.min(SRC_MAX, Math.max(SRC_MIN, long)) - PAD * 2) / long;
  const w = Math.round(bw * k) + PAD * 2, h = Math.round(bh * k) + PAD * 2;
  const canvas = (): CanvasRenderingContext2D => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    return c.getContext('2d', { willReadFrequently: true })!;
  };
  const g = canvas();
  g.drawImage(img, bx, by, bw, bh, PAD, PAD, w - PAD * 2, h - PAD * 2);
  const out = g.getImageData(0, 0, w, h);
  if (mask) {
    // マスクは画像と解像度が違うことがある。画像の座標から換算する
    const mx = mask.naturalWidth / img.naturalWidth, my = mask.naturalHeight / img.naturalHeight, mg = canvas();
    mg.drawImage(mask, bx * mx, by * my, bw * mx, bh * my, PAD, PAD, w - PAD * 2, h - PAD * 2);
    const m = mg.getImageData(0, 0, w, h).data;
    for (let i = 0; i < w * h; i++) out.data[i * 4 + 3] = m[i * 4 + 3] ? m[i * 4] : 0;
  }
  return { w, h, data: out.data };
}
