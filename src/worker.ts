// 絵を描く Worker。描く役（1つ）と、素材を準備する役（複数）の両方に同じものを使う。
import * as R from './render.ts';
import type { Job, PhaseMap } from './render.ts';
import type { MaterialOptions, Variant } from './material.ts';
import type { Swatch } from './engine/patterns.ts';
import type { Raster } from './engine/types.ts';

export type ToWorker =
  | { t: 'swatches'; list: Swatch[] }
  | { t: 'material'; id: string; raw: Raster }
  | { t: 'drop'; ids: string[] }
  | { t: 'install'; id: string; list: Variant[] }
  | { t: 'prep'; n: number; id: string; raw?: Raster; mat: MaterialOptions; method: string; mix: number; imp: number; trim: boolean }
  | { t: 'job'; n: number; job: Job };
export type FromWorker =
  | { t: 'done'; n: number; data: Uint8ClampedArray<ArrayBuffer>; W: number; H: number; blobs: number; phase?: PhaseMap }
  | { t: 'prepped'; n: number; id: string; list: Variant[] }
  | { t: 'error'; n: number; message: string };

const post = (m: FromWorker, transfer: Transferable[] = []): void => (self as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage(m, transfer);

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  try {
    if (m.t === 'swatches') R.addSwatches(m.list);
    else if (m.t === 'material') R.setMaterial(m.id, m.raw);
    else if (m.t === 'drop') R.dropMaterials(m.ids);
    else if (m.t === 'install') R.installVariants(m.id, m.list);
    else if (m.t === 'prep') {
      if (m.raw) R.setMaterial(m.id, m.raw);
      // 作った版は写しで返す（移し渡しはしない）。カービングなしの版は、もとの切り抜きと同じ画素列を指しているため
      post({ t: 'prepped', n: m.n, id: m.id, list: R.prepareMaterial(m.id, m.mat, m.method, m.mix, m.imp, m.trim) });
    } else if (m.t === 'job') {
      const r = R.run(m.job);
      post({ t: 'done', n: m.n, data: r.data, W: r.W, H: r.H, blobs: r.blobs, phase: r.phase }, [r.data.buffer]);
    }
  } catch (e) {
    if ('n' in m) post({ t: 'error', n: m.n, message: e instanceof Error ? e.message : String(e) });
    else console.error(e);
  }
};
