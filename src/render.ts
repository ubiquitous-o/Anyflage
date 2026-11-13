// 絵を描く所。DOM に触らない。Worker の中で動く（worker.ts）。
// 画面（main.ts）は「何を描くか」を Job にして送り、できた画素を受け取る。
// 計算を画面と別の場所でやるので、描いているあいだも画面は固まらない。
import { Kao } from './engine/kao.ts';
import { PATTERNS, patternById, swatchPattern } from './engine/patterns.ts';
import type { Swatch } from './engine/patterns.ts';
import { Material } from './material.ts';
import type { MaterialOptions, Variant } from './material.ts';
import type { Camo, LayerFn, Params, Picker, Raster, RGB } from './engine/types.ts';

export interface Job {
  /** one：ふつうの絵。tile：リピートできる1枚。orig：元の素材を歪めずに置いた絵 */
  kind: 'one' | 'tile' | 'orig';
  W: number; H: number;
  /** 設定。layerAt は関数で送れないので入れない。柄は p.pattern の名前から、ここで作る */
  p: Params;
  colors: number[][];
  /** 使う素材の id。この順でエンジンに渡す */
  mats: string[];
  mat: MaterialOptions;
  /** ブロブの縁をなじませる */
  soft: boolean;
  /** ブロブの境目を白い線で描く */
  edges: boolean;
  /** 迷彩を使い回す（画面用）。書き出しや比較表示では使い回さない */
  reuse: boolean;
}
export interface Result { data: Uint8ClampedArray<ArrayBuffer>; W: number; H: number; blobs: number }

const materials = new Map<string, Material>();
export function setMaterial(id: string, raw: Raster): void { if (!materials.has(id)) materials.set(id, new Material(raw)); }
export function dropMaterials(ids: string[]): void { for (const id of ids) materials.delete(id); }
export function hasMaterial(id: string): boolean { return materials.has(id); }
export function addSwatches(list: Swatch[]): void { for (const sw of list) if (!PATTERNS.some((p) => p.id === `sw-${sw.id}`)) PATTERNS.push(swatchPattern(sw)); }
/** 素材1枚ぶんの版を、この設定で全部作る（別の Worker で先に作っておく用） */
export function prepareMaterial(id: string, o: MaterialOptions, method: string, mix: number, imp: number, trim: boolean): Variant[] {
  const m = materials.get(id);
  return m ? m.prepare(o, method, mix, imp, trim) : [];
}
export function installVariants(id: string, list: Variant[]): void { materials.get(id)?.install(list); }

/** 柄の名前から、層を返す関数を作って設定に足す */
function withLayer(p: Params): Params {
  const pat = patternById(p.pattern || 'blob');
  return { ...p, layerAt: pat.id === 'blob' ? undefined : pat.make(p.seed, p.size) };
}

let camo: Camo | null = null, camoKey = '';
function getCamo(W: number, H: number, p: Params, reuse: boolean): Camo {
  const key = [W, H, p.seed, p.size, p.wobble, p.pattern, p.neck, p.notch, p.split, p.cutRef].join('|');
  if (reuse && camo && camoKey === key) return camo;
  const c = Kao.buildCamo(W, H, p);
  if (reuse) { camo = c; camoKey = key; }
  return c;
}

/**
 * ブロブの縁の、画素の段々をなじませる。
 * 縁の画素ごとに、まわり5×5のうち自分と同じブロブが占める割合を見て、縁が画素のどのあたりを通るか見積もる。
 * その割合で、隣のブロブの色を混ぜる。ブロブの形（ids）は変えない。色だけ。
 */
const SOFT_W = [1, 3, 4, 3, 1];
function softenEdges(d: Uint8ClampedArray, W: number, H: number, cam: Camo): void {
  const ids = cam.ids, src = new Uint8ClampedArray(d);
  for (let y = 0; y < H; y++) for (let x = 0, i = y * W; x < W; x++, i++) {
    const c = ids[i];
    if (!((x > 0 && ids[i - 1] !== c) || (x < W - 1 && ids[i + 1] !== c) || (y > 0 && ids[i - W] !== c) || (y < H - 1 && ids[i + W] !== c))) continue;
    let same = 0, all = 0, r = 0, g = 0, b = 0, ow = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const j = yy * W + xx, w = SOFT_W[dx + 2] * SOFT_W[dy + 2]; all += w;
      if (ids[j] === c) same += w;
      else if (dx >= -1 && dx <= 1 && dy >= -1 && dy <= 1) { r += src[j * 4] * w; g += src[j * 4 + 1] * w; b += src[j * 4 + 2] * w; ow += w; }
    }
    if (!ow) continue;
    const a = Math.min(1, Math.max(0.5, 0.5 + (same / all - 0.5) * 2.2)), o = i * 4;
    d[o] = src[o] * a + r / ow * (1 - a); d[o + 1] = src[o + 1] * a + g / ow * (1 - a); d[o + 2] = src[o + 2] * a + b / ow * (1 - a);
  }
}

/**
 * 上下左右がつながる迷彩の層。幅 tw・高さ th（画素）ごとに同じ柄がくり返す。
 * もとの柄はくり返さないので、そのまま並べると端で柄が切れる。そこで、もとの柄から2か所を切り出し、
 * 1枚目は升目の中ほどで、2枚目は升目の端のあたりで使う。2枚の境目は、同じ周期でうねる線にする。
 * 返す関数は、tw×th の升を2×2に敷いた、長辺 M2 の大きなキャンバスの座標で呼ばれる。
 */
function tileableLayer(p: Params, tw: number, th: number, M2: number): LayerFn {
  const base = p.layerAt, seed = p.seed | 0, size = p.size, f = 1 / size, wob = p.wobble * size * 0.9, Mt = Math.max(tw, th), TAU = Math.PI * 2;
  const at = (qx: number, qy: number): number => { // 升の中の画素 (qx, qy) の層。うねりも、エンジンと同じ式でここで掛ける
    const nx = qx / Mt, ny = qy / Mt;
    const wx = nx + wob * (Kao.vnoise(nx * f * 2.1, ny * f * 2.1, seed + 50) - 0.5), wy = ny + wob * (Kao.vnoise(nx * f * 2.1 + 40, ny * f * 2.1 + 40, seed + 51) - 0.5);
    if (base) return base(nx, ny, wx, wy);
    let L = 0; for (let k = 1; k < 4; k++) if (Kao.fbm(wx * f / 1.45 + k * 31.7, wy * f + k * 17.3, seed + k) > Kao.THR[k]) L = k; // Anyflage 標準
    return L;
  };
  const mod = (t: number, n: number): number => ((t % n) + n) % n;
  return (nx, ny) => {
    const px = nx * M2, py = ny * M2, u = mod(px, tw), v = mod(py, th), ub = mod(px + tw / 2, tw), vb = mod(py + th / 2, th);
    const wa = Math.min(Math.min(u, tw - u) / tw, Math.min(v, th - v) / th), wb = Math.min(Math.min(ub, tw - ub) / tw, Math.min(vb, th - vb) / th);
    const a = TAU * px / tw, b = TAU * py / th, wave = 0.05 * (Math.sin(3 * a + 1.3) * Math.cos(2 * b) + Math.sin(5 * b + 0.4) * Math.cos(4 * a + 2.1)) + 0.03 * Math.sin(7 * a + 3 * b);
    return wa + wave > wb ? at(u, v) : at(ub + tw * 1.37, vb + th * 2.11); // 2枚目は、もとの柄の離れた所から取る
  };
}

function whiteEdges(d: Uint8ClampedArray, ids: Int32Array, W: number, x0: number, y0: number, x1: number, y1: number): void {
  for (let y = y0; y < y1; y++) for (let x = x0, i = y * W + x0; x < x1; x++, i++) if (ids[i] !== ids[i + 1] || ids[i] !== ids[i + W]) { d[i * 4] = 255; d[i * 4 + 1] = 255; d[i * 4 + 2] = 255; }
}

/** 包みから、縮める前の切り抜きを引く。「元の素材と並べる」用 */
const rawOf = new WeakMap<Picker, Raster>();
function pickers(job: Job): Picker[] {
  const out: Picker[] = [];
  for (const id of job.mats) {
    const m = materials.get(id); if (!m) continue;
    const p = m.picker(job.mat);
    if (p) { out.push(p); rawOf.set(p, m.raw); }
  }
  return out;
}

function renderOne(job: Job, p: Params, src: Picker[]): Result {
  const { W, H } = job, data = new Uint8ClampedArray(W * H * 4), cam = getCamo(W, H, p, job.reuse);
  Kao.renderCamo(data, cam, src, job.colors as RGB[], p);
  if (job.soft) softenEdges(data, W, H, cam);
  if (job.edges) whiteEdges(data, cam.ids, W, 0, 0, W - 1, H - 1); // ブロブの境目を白い線で描く。どこで切れているか見る用
  return { data, W, H, blobs: cam.comps.count };
}

/**
 * リピートできる絵を1枚（W×H）作る。
 * 2×2 ぶんの大きなキャンバスで迷彩を作り、真ん中の W×H を切り出す。升の端をまたぐブロブも、欠けずに丸ごと描ける。
 * 左端をまたぐブロブと右端をまたぐブロブは、ちょうど W だけずれた同じ形になる。同じ鍵を持たせて、同じ素材・同じ向きで描く。
 */
function renderTile(job: Job, p: Params, src: Picker[]): Result {
  const { W, H } = job, W2 = W * 2, H2 = H * 2, x0 = W >> 1, y0 = H >> 1;
  // 大きすぎるブロブを割る処理は、場所によって割り方が変わるので使わない。えぐれ切りは、正方形のときだけ写しどうしで同じ所が切れる。
  // 小さい絵に合わせて切る仕組み（cutRef）も、ここでは使わない。ずらした写しどうしで同じ形にしたいので、この大きさのまま切る
  const p2: Params = { ...p, layerAt: tileableLayer(p, W, H, Math.max(W2, H2)), noSplit: true, split: 'none', notch: W === H ? p.notch : 0, flatBelow: (p.flatBelow || 0) / 4, cutRef: undefined, clip: [x0 - 1, y0 - 1, x0 + W, y0 + H] };
  const cam = Kao.buildCamo(W2, H2, p2), cm = cam.comps, keys = new Int32Array(cm.count);
  for (let c = 0; c < cm.count; c++) keys[c] = (Math.imul(cm.x0[c] % W, 73856093) ^ Math.imul(cm.y0[c] % H, 19349663) ^ Math.imul(cm.area[c], 83492791)) & 0x7fffffff;
  cam.keys = keys;
  const big = new Uint8ClampedArray(W2 * H2 * 4);
  Kao.renderCamo(big, cam, src, job.colors as RGB[], p2);
  if (job.soft) softenEdges(big, W2, H2, cam);
  if (job.edges) whiteEdges(big, cam.ids, W2, x0, y0, x0 + W, y0 + H);
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) data.set(big.subarray(((y0 + y) * W2 + x0) * 4, ((y0 + y) * W2 + x0 + W) * 4), y * W * 4);
  let blobs = 0; for (let c = 0; c < cm.count; c++) if (cm.area[c] && !(cm.x1[c] < x0 || cm.y1[c] < y0 || cm.x0[c] >= x0 + W || cm.y0[c] >= y0 + H)) blobs++;
  return { data, W, H, blobs };
}

/**
 * 押し込む前の素材を、同じブロブの場所にそのまま置いた絵。歪めない。縮めない。
 * ブロブの外接矩形に収まる大きさで中央に置き、ブロブの形で切り抜く。どの素材がどのブロブに入るか、左右の向きはエンジンと同じ決め方。
 */
function renderOriginals(job: Job, p: Params, src: Picker[]): Result {
  const { W, H } = job, d = new Uint8ClampedArray(W * H * 4), cam = getCamo(W, H, p, job.reuse), cm = cam.comps, ids = cam.ids, cols = job.colors;
  const np = src.length, pick = Kao.assignSources(cam, np, p);
  for (let c = 0; c < cm.count; c++) {
    const L = cm.layer[c], col = cols[L % cols.length], bx = cm.x0[c], by = cm.y0[c], bw = cm.x1[c] - bx + 1, bh = cm.y1[c] - by + 1;
    const raw = pick[c] < 0 ? null : rawOf.get(src[pick[c]]) || null;
    const flip = Kao.hash2(c, 37, p.seed | 0) < 0.5 ? -1 : 1, k = raw ? Math.min(bw / raw.w, bh / raw.h) : 1;
    for (let y = by; y < by + bh; y++) for (let x = bx, i = y * W + bx; x < bx + bw; x++, i++) {
      if (ids[i] !== c) continue;
      let r = col[0], g = col[1], b = col[2];
      if (raw) {
        const sx = Math.round(raw.w / 2 + (x - bx - bw / 2) * flip / k), sy = Math.round(raw.h / 2 + (y - by - bh / 2) / k), si = (sy * raw.w + sx) * 4;
        if (sx >= 0 && sy >= 0 && sx < raw.w && sy < raw.h && raw.data[si + 3] > 110) { r = raw.data[si]; g = raw.data[si + 1]; b = raw.data[si + 2]; }
      }
      d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
    }
  }
  return { data: d, W, H, blobs: cm.count };
}

export function run(job: Job): Result {
  const p = withLayer(job.p), src = pickers(job);
  return job.kind === 'tile' ? renderTile(job, p, src) : job.kind === 'orig' ? renderOriginals(job, p, src) : renderOne(job, p, src);
}
