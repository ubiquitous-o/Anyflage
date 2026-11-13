// public/swatches の見本タイルを読み、柄の一覧に足す。
import { PATTERNS, swatchPattern } from './engine/patterns.ts';
import type { Swatch } from './engine/patterns.ts';

/** 層の番号は、PNG の画素値 ÷ 40 */
async function loadLabels(id: string, w: number, h: number): Promise<Uint8Array> {
  const im = new Image();
  await new Promise<void>((resolve, reject) => { im.onload = () => resolve(); im.onerror = () => reject(new Error(`読めなかった: swatches/${id}.png`)); im.src = `${import.meta.env.BASE_URL}swatches/${id}.png`; });
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(im, 0, 0);
  const d = g.getImageData(0, 0, w, h).data, labels = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) labels[i] = Math.round(d[i * 4] / 40);
  return labels;
}

/** 見本を読んで柄の一覧に足し、読んだ見本を返す。見本がなければ何も足さない */
export async function loadSwatches(): Promise<Swatch[]> {
  let list: Omit<Swatch, 'labels'>[];
  try {
    const r = await fetch(`${import.meta.env.BASE_URL}swatches/index.json`);
    if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) return [];
    list = await r.json();
  } catch { return []; }
  const out: Swatch[] = [];
  for (const s of list) { const sw: Swatch = { ...s, labels: await loadLabels(s.id, s.w, s.h) }; PATTERNS.push(swatchPattern(sw)); out.push(sw); }
  return out; // 絵を描く Worker にも同じ見本を渡す
}
