// 収集スクリプトの共通部品。Node 22 の型はがしでそのまま動かす（node scripts/xxx.ts）。
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import pngjs from 'pngjs';
import jpeg from 'jpeg-js';

const { PNG } = pngjs;

export const ROOT = join(import.meta.dirname, '..');
export const SAMPLES = join(ROOT, 'samples');
export const RAW = join(SAMPLES, '_raw');

/** アプリが読む1件ぶん。image と mask は samples/ からの相対パス */
export interface Sample {
  id: string;
  /** どのデータセットか */
  set: string;
  /** アプリでまとめる単位。カオ、ヒト、ネコ、イヌ、ドウブツ、クルマ、ノリモノ、ビル、ポケモン */
  group: string;
  /** データセット側のクラス名 */
  label: string;
  image: string;
  /** 白が中身のグレースケールPNG。null なら画像自身のアルファを使う */
  mask: string | null;
  /** マスクの外接矩形 [x, y, w, h] */
  bbox: [number, number, number, number];
  /** 出どころ */
  source: string;
}

export interface Gray { w: number; h: number; data: Uint8Array }

export function ensureDir(file: string): void { mkdirSync(dirname(file), { recursive: true }); }

export function writeMask(file: string, m: Gray): void {
  const png = new PNG({ width: m.w, height: m.h });
  for (let i = 0; i < m.w * m.h; i++) {
    const v = m.data[i] ? 255 : 0;
    png.data[i * 4] = png.data[i * 4 + 1] = png.data[i * 4 + 2] = v; png.data[i * 4 + 3] = 255;
  }
  ensureDir(file);
  writeFileSync(file, PNG.sync.write(png, { colorType: 0 }));
}

/** PNG を読んで、各画素の赤チャンネルだけ返す。クラス番号のPNG用 */
export function readPngRed(file: string, channel = 0): Gray {
  const png = PNG.sync.read(readFileSync(file));
  const data = new Uint8Array(png.width * png.height);
  for (let i = 0; i < data.length; i++) data[i] = png.data[i * 4 + channel];
  return { w: png.width, h: png.height, data };
}

export function readJpegRed(file: string): Gray {
  const im = jpeg.decode(readFileSync(file), { useTArray: true, maxMemoryUsageInMB: 1024 });
  const data = new Uint8Array(im.width * im.height);
  for (let i = 0; i < data.length; i++) data[i] = im.data[i * 4];
  return { w: im.width, h: im.height, data };
}

/** 多角形（[x0, y0, x1, y1, ...] の列）を偶奇規則で塗る */
export function fillPolygons(w: number, h: number, polys: number[][]): Gray {
  const data = new Uint8Array(w * h);
  for (const p of polys) {
    const n = p.length >> 1;
    let y0 = Infinity, y1 = -Infinity;
    for (let k = 0; k < n; k++) { y0 = Math.min(y0, p[k * 2 + 1]); y1 = Math.max(y1, p[k * 2 + 1]); }
    for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(h - 1, Math.ceil(y1)); y++) {
      const yc = y + 0.5, xs: number[] = [];
      for (let k = 0; k < n; k++) {
        const ax = p[k * 2], ay = p[k * 2 + 1], j = (k + 1) % n, bx = p[j * 2], by = p[j * 2 + 1];
        if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) xs.push(ax + (yc - ay) / (by - ay) * (bx - ax));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.round(xs[k])), xb = Math.min(w, Math.round(xs[k + 1]));
        for (let x = xa; x < xb; x++) data[y * w + x] = 1;
      }
    }
  }
  return { w, h, data };
}

/** いちばん大きい4連結のかたまりだけ残す。残した画素数を返す */
export function keepLargest(m: Gray): number {
  const { w, h, data } = m, n = w * h, lab = new Int32Array(n), stack = new Int32Array(n);
  let best = 0, bestN = 0, cur = 0;
  for (let i = 0; i < n; i++) {
    if (!data[i] || lab[i]) continue;
    cur++; let sp = 0, cnt = 0; stack[sp++] = i; lab[i] = cur;
    while (sp) {
      const q = stack[--sp], x = q % w; cnt++;
      if (x > 0 && data[q - 1] && !lab[q - 1]) { lab[q - 1] = cur; stack[sp++] = q - 1; }
      if (x < w - 1 && data[q + 1] && !lab[q + 1]) { lab[q + 1] = cur; stack[sp++] = q + 1; }
      if (q >= w && data[q - w] && !lab[q - w]) { lab[q - w] = cur; stack[sp++] = q - w; }
      if (q < n - w && data[q + w] && !lab[q + w]) { lab[q + w] = cur; stack[sp++] = q + w; }
    }
    if (cnt > bestN) { bestN = cnt; best = cur; }
  }
  for (let i = 0; i < n; i++) data[i] = lab[i] === best && best ? 1 : 0;
  return bestN;
}

export function bboxOf(m: Gray): [number, number, number, number] | null {
  let x0 = m.w, y0 = m.h, x1 = -1, y1 = -1;
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) if (m.data[y * m.w + x]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
}

/** 外接矩形が画像の縁に触れていないか。触れていたら、物が画面からはみ出ている */
export function inside(b: readonly number[], w: number, h: number, margin = 2): boolean {
  return b[0] > margin && b[1] > margin && b[0] + b[2] < w - margin && b[1] + b[3] < h - margin;
}

export async function download(url: string, file: string): Promise<void> {
  if (existsSync(file)) return;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${url}`);
  ensureDir(file);
  writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}

/** 同時に limit 本まで */
export async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}

export function writeManifest(set: string, samples: Sample[]): void {
  const file = join(SAMPLES, `${set}.json`);
  writeFileSync(file, JSON.stringify(samples, null, 1));
  const groups = new Map<string, number>();
  for (const s of samples) groups.set(s.group, (groups.get(s.group) || 0) + 1);
  console.log(`${set}: ${samples.length}件`, Object.fromEntries(groups));
}
