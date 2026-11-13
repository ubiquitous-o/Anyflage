// 背景除去。手元の画像から、人や物だけを切り抜く。
// 計算はブラウザの中だけ。画像はどこにも送らない。モデルと動かす部品も、このサイトと同じ場所から読む。
//   人：MediaPipe の自撮り用・多クラス分割（Apache 2.0）。画素ごとに 背景・髪・体の肌・顔の肌・服・小物 の度合いを出す
//   物：U²-Net の小型版 u2netp（Apache 2.0）。目立つ物の度合いを出す
// どちらも、種類を選んだときに初めて読む。
import type { Raster } from './engine/types.ts';

/** セットの種類。asis は切り抜き済み（背景除去しない） */
export type CutKind = 'asis' | 'skin' | 'face' | 'person' | 'object';
export const CUT_LABELS: Record<CutKind, string> = { asis: '切り抜き済み（背景除去しない）', skin: '人の顔だけ（髪なし）', face: '人の顔と髪', person: '人の全身', object: 'もの・キャラ' };

const BASE = import.meta.env.BASE_URL;

/** 小さいマスク（mw×mh、0〜1）を、画像の大きさ（w×h）へなめらかに広げる */
function upscale(m: Float32Array, mw: number, mh: number, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(mh - 1.001, Math.max(0, (y + 0.5) * mh / h - 0.5)), iy = fy | 0, ty = fy - iy;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(mw - 1.001, Math.max(0, (x + 0.5) * mw / w - 0.5)), ix = fx | 0, tx = fx - ix, a = iy * mw + ix;
      out[y * w + x] = (m[a] * (1 - tx) + m[a + 1] * tx) * (1 - ty) + (m[a + mw] * (1 - tx) + m[a + mw + 1] * tx) * ty;
    }
  }
  return out;
}

// ---- 人：MediaPipe ----
type Segmenter = { segment(image: HTMLCanvasElement): { confidenceMasks?: { width: number; height: number; getAsFloat32Array(): Float32Array; close(): void }[]; close(): void } };
let personSeg: Promise<Segmenter> | null = null;
function loadPerson(): Promise<Segmenter> {
  return personSeg || (personSeg = (async () => {
    const { FilesetResolver, ImageSegmenter } = await import('@mediapipe/tasks-vision');
    const files = await FilesetResolver.forVisionTasks(`${BASE}vendor/mediapipe`);
    return await ImageSegmenter.createFromOptions(files, {
      baseOptions: { modelAssetPath: `${BASE}models/selfie_multiclass_256x256.tflite`, delegate: 'CPU' },
      runningMode: 'IMAGE', outputCategoryMask: false, outputConfidenceMasks: true,
    }) as unknown as Segmenter;
  })().catch((e) => { personSeg = null; throw e; }));
}
/** 層の番号：0 背景、1 髪、2 体の肌、3 顔の肌、4 服、5 小物 */
async function personMask(canvas: HTMLCanvasElement, part: 'skin' | 'face' | 'person'): Promise<Float32Array> {
  const seg = await loadPerson(), res = seg.segment(canvas), ms = res.confidenceMasks;
  if (!ms || ms.length < 4) { res.close(); throw new Error('人の切り抜きに失敗した'); }
  const mw = ms[0].width, mh = ms[0].height, bg = ms[0].getAsFloat32Array(), hair = ms[1].getAsFloat32Array(), face = ms[3].getAsFloat32Array(), m = new Float32Array(mw * mh);
  // skin：顔の肌だけ。face：顔の肌と髪。person：背景以外の全部
  for (let i = 0; i < m.length; i++) m[i] = part === 'skin' ? face[i] : part === 'face' ? hair[i] + face[i] : 1 - bg[i];
  res.close();
  return upscale(m, mw, mh, canvas.width, canvas.height);
}

// ---- 物：u2netp ----
type Ort = typeof import('onnxruntime-web');
let objectSeg: Promise<{ ort: Ort; session: import('onnxruntime-web').InferenceSession }> | null = null;
function loadObject(): Promise<{ ort: Ort; session: import('onnxruntime-web').InferenceSession }> {
  return objectSeg || (objectSeg = (async () => {
    const ort = (await import('onnxruntime-web/wasm')) as unknown as Ort;
    // 動かす部品（JS と wasm）は、ビルドのときにこのアプリと一緒に束ねられる。外からは読まない
    ort.env.wasm.numThreads = 1; // GitHub Pages では複数スレッドを使えない
    const session = await ort.InferenceSession.create(`${BASE}models/u2netp.onnx`, { executionProviders: ['wasm'] });
    return { ort, session };
  })().catch((e) => { objectSeg = null; throw e; }));
}
const U2 = 320, MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
async function objectMask(canvas: HTMLCanvasElement): Promise<Float32Array> {
  const { ort, session } = await loadObject();
  const c = document.createElement('canvas'); c.width = U2; c.height = U2;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.fillStyle = '#fff'; g.fillRect(0, 0, U2, U2); // 透明な所は白地として見せる
  g.drawImage(canvas, 0, 0, U2, U2);
  const d = g.getImageData(0, 0, U2, U2).data, n = U2 * U2, input = new Float32Array(3 * n);
  let mx = 1; for (let i = 0; i < n * 4; i++) if ((i & 3) !== 3 && d[i] > mx) mx = d[i];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) input[k * n + i] = (d[i * 4 + k] / mx - MEAN[k]) / STD[k];
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, U2, U2]) });
  const raw = out[session.outputNames[0]].data as Float32Array, m = new Float32Array(n);
  let lo = Infinity, hi = -Infinity; for (let i = 0; i < n; i++) { if (raw[i] < lo) lo = raw[i]; if (raw[i] > hi) hi = raw[i]; }
  for (let i = 0; i < n; i++) m[i] = (raw[i] - lo) / (hi - lo || 1);
  return upscale(m, U2, U2, canvas.width, canvas.height);
}

/**
 * 画像を切り抜く。kind が asis ならそのまま返す。
 * 返すのは、残った所の外接矩形で切り出した RGBA。残す所はアルファ 255 寄り、消す所は 0。
 * 何も残らなかったら、元の画像をそのまま返す（真っ白な素材を作らない）。
 */
export async function cutOut(canvas: HTMLCanvasElement, kind: CutKind): Promise<Raster> {
  const w = canvas.width, h = canvas.height, g = canvas.getContext('2d', { willReadFrequently: true })!, img = g.getImageData(0, 0, w, h);
  if (kind === 'asis') return { w, h, data: img.data };
  const m = kind === 'object' ? await objectMask(canvas) : await personMask(canvas, kind);
  const d = img.data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
    // 0.5 を境に、少しだけ幅を持たせて切る。もとから透明だった所は透明のまま
    const a = Math.min(1, Math.max(0, (m[i] - 0.35) / 0.3)) * d[i * 4 + 3];
    d[i * 4 + 3] = a;
    if (a > 110) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0 || (x1 - x0) * (y1 - y0) < 400) return { w, h, data: g.getImageData(0, 0, w, h).data };
  const pad = 4; x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1, out = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) out.set(d.subarray(((y0 + y) * w + x0) * 4, ((y0 + y) * w + x0 + cw) * 4), y * cw * 4);
  return { w: cw, h: ch, data: out };
}
