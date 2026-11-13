// 画面の側から Worker を使う窓口。
//   描く役の Worker が1つ。迷彩と素材を持ち、絵を描く。
//   準備する役の Worker が数個。素材ごとのカービング版と、円へ写す表を、同時に作る。できたものは描く役へ渡す。
// 準備は描く役でもできる（渡さなくても絵は同じ）。先に分けて作るのは、待ち時間を縮めるためだけ。
import type { Job, Result } from './render.ts';
import type { MaterialOptions, Variant } from './material.ts';
import type { FromWorker, ToWorker } from './worker.ts';
import type { Swatch } from './engine/patterns.ts';
import type { Raster } from './engine/types.ts';

const spawn = (): Worker => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

interface Slot { w: Worker; has: Set<string>; busy: boolean }
const painter = spawn();
const POOL = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
const pool: Slot[] = [];
let swatches: Swatch[] = [];
function slot(k: number): Slot {
  if (!pool[k]) { const w = spawn(); w.onmessage = onMessage; w.onerror = onError; if (swatches.length) w.postMessage({ t: 'swatches', list: swatches } satisfies ToWorker); pool[k] = { w, has: new Set(), busy: false }; }
  return pool[k];
}

let seq = 0;
const waiting = new Map<number, { ok: (m: FromWorker) => void; no: (e: Error) => void }>();
function onMessage(ev: MessageEvent<FromWorker>): void {
  const m = ev.data, w = waiting.get(m.n); if (!w) return;
  waiting.delete(m.n);
  if (m.t === 'error') w.no(new Error(m.message)); else w.ok(m);
}
function onError(ev: ErrorEvent): void { // Worker が落ちた。待っている全員に知らせる
  const err = new Error(ev.message || '描く処理が止まった');
  for (const w of waiting.values()) w.no(err);
  waiting.clear();
}
painter.onmessage = onMessage; painter.onerror = onError;
const ask = (w: Worker, m: ToWorker & { n: number }, transfer: Transferable[] = []): Promise<FromWorker> => new Promise((ok, no) => { waiting.set(m.n, { ok, no }); w.postMessage(m, transfer); });

export function sendSwatches(list: Swatch[]): void { swatches = list; if (list.length) painter.postMessage({ t: 'swatches', list } satisfies ToWorker); }

const raws = new Map<string, Raster>(), inPainter = new Set<string>();
/** 素材を知らせる。描く役にはすぐ送る。準備する役には、仕事を頼むときに一緒に送る */
export function addMaterial(id: string, raw: Raster): void {
  raws.set(id, raw);
  if (!inPainter.has(id)) { inPainter.add(id); painter.postMessage({ t: 'material', id, raw } satisfies ToWorker); }
}
export function dropMaterials(ids: string[]): void {
  for (const id of ids) { raws.delete(id); inPainter.delete(id); prepared.delete(id); }
  painter.postMessage({ t: 'drop', ids } satisfies ToWorker);
  for (const s of pool) if (s) { s.w.postMessage({ t: 'drop', ids } satisfies ToWorker); for (const id of ids) s.has.delete(id); }
}

/** 版の中の画素列などを集める。描く役へは写さず移し渡す（同じ列を2度数えないようにする） */
function buffersOf(v: unknown, out = new Set<ArrayBuffer>()): Set<ArrayBuffer> {
  if (!v || typeof v !== 'object') return out;
  if (ArrayBuffer.isView(v)) { if (v.buffer instanceof ArrayBuffer) out.add(v.buffer); return out; }
  for (const x of Array.isArray(v) ? v : Object.values(v)) buffersOf(x, out);
  return out;
}

const prepared = new Map<string, string>();
/**
 * 素材の準備を、準備する役たちに分けて頼む。済んだものは描く役へ渡す。
 * 同じ設定で準備済みの素材は飛ばす。onProgress には（済んだ数、全部の数）が来る。
 */
export async function prepare(ids: string[], mat: MaterialOptions, method: string, mix: number, imp: number, trim: boolean, onProgress?: (done: number, total: number) => void): Promise<void> {
  const key = JSON.stringify([mat, method, mix, imp, trim]), todo = ids.filter((id) => prepared.get(id) !== key && raws.has(id));
  if (!todo.length) return;
  let done = 0, next = 0;
  onProgress?.(0, todo.length);
  const runOne = async (s: Slot): Promise<void> => {
    while (next < todo.length) {
      const id = todo[next++], n = ++seq, first = !s.has.has(id);
      s.has.add(id);
      try {
        const r = await ask(s.w, { t: 'prep', n, id, raw: first ? raws.get(id) : undefined, mat, method, mix, imp, trim });
        if (r.t === 'prepped') {
          const list: Variant[] = r.list;
          painter.postMessage({ t: 'install', id, list } satisfies ToWorker, [...buffersOf(list)]);
          prepared.set(id, key);
        }
      } catch (e) { console.warn('素材の準備を分けてできなかった。描くときに作る', id, e); }
      onProgress?.(++done, todo.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(POOL, todo.length) }, (_, k) => runOne(slot(k))));
}

/** 絵を1枚描いてもらう。頼んだ順に、1枚ずつ描く */
export async function render(job: Job): Promise<Result> {
  const r = await ask(painter, { t: 'job', n: ++seq, job });
  if (r.t !== 'done') throw new Error('描けなかった');
  return { data: r.data, W: r.W, H: r.H, blobs: r.blobs, phase: r.phase };
}
