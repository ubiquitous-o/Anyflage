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
  /** リピートの絵（kind が tile）で、ブロブ分けを決める升の大きさ [幅, 高さ]。画面用と書き出し用で同じ値を渡すと、同じ絵になる */
  tileRef?: [number, number];
  /** ブロブごとの位相の地図も返す（絵を動かすときの「呼吸」用） */
  phase?: boolean;
  /** ラバランプの1コマ。kind が one のときだけ効く */
  lava?: Lava;
}
/** ラバランプの1コマ。theta は1周の中の位置（0〜2π）、amount は溶け具合（0〜1）。コマは順に頼む。first は1コマ目（前のコマとのつながりを切る） */
export interface Lava {
  theta: number; amount: number; first: boolean;
  /** 侵食の早さ。絵が1コマに広がる距離を、ブロブの大きさを 1 として */
  grow: number;
  /** 1コマの時間（秒）。絵を読む位置をならす強さを決める */
  dt: number;
  /**
   * 何をするコマか。
   *   f：鍵を前向きにたどる（0 コマ目から順に）。絵は描かない。コマごとの鍵を覚える
   *   b：鍵を後ろ向きにたどる（0 コマ目、最後のコマ、その前…の順に）。絵は描かない。コマごとの鍵を覚える
   *   draw：覚えた鍵で絵を描く
   */
  pass: 'f' | 'b' | 'draw';
  /** 何コマ目か（0 から count-1）と、1周のコマ数 */
  index: number; count: number;
}
/** ブロブごとに決めた位相 φ の、cos と sin を並べた粗い地図（0〜255。128 が 0）。ぼかして使う */
export interface PhaseMap { data: Uint8Array<ArrayBuffer>; w: number; h: number }
export interface Result { data: Uint8ClampedArray<ArrayBuffer>; W: number; H: number; blobs: number; phase?: PhaseMap }

/** 絵の窓 (x0, y0, w, h) を粗く見て、画素ごとに「そこのブロブの位相」を書く。位相はブロブの鍵（なければ番号）から決める */
function phaseMap(cam: Camo, x0: number, y0: number, w: number, h: number, seed: number): PhaseMap {
  const k = 192 / Math.max(w, h), pw = Math.max(2, Math.round(w * k)), ph = Math.max(2, Math.round(h * k)), data = new Uint8Array(pw * ph * 2);
  for (let j = 0; j < ph; j++) for (let i = 0; i < pw; i++) {
    const x = x0 + Math.min(w - 1, Math.floor((i + 0.5) * w / pw)), y = y0 + Math.min(h - 1, Math.floor((j + 0.5) * h / ph)), c = cam.ids[y * cam.W + x];
    const a = c < 0 ? 0 : Math.PI * 2 * Kao.hash2(cam.keys ? cam.keys[c] : c, 53, seed | 0);
    data[(j * pw + i) * 2] = Math.round(128 + 127 * Math.cos(a)); data[(j * pw + i) * 2 + 1] = Math.round(128 + 127 * Math.sin(a));
  }
  return { data, w: pw, h: ph };
}

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
/** リピートの絵の、ブロブ分けを決めた迷彩。設定が同じあいだ使い回す（画面用と書き出し用で同じものを使う） */
let tileRef: Camo | null = null, tileRefKey = '';
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
 * 返す関数は、升の中の画素 (px, py) の層を返す。px, py は升の外へはみ出してよい（くり返す）。
 * 升の画素 (x, y) は、ふつうの絵の画素 (x, y) と同じ柄になる。だから、リピートを入れても絵の中ほどは同じ柄のまま。変わるのは端のあたりだけ。
 */
function tileableField(p: Params, tw: number, th: number): (px: number, py: number) => number {
  const base = p.layerAt, seed = p.seed | 0, size = p.size, f = 1 / size, wob = p.wobble * size * 0.9, Mt = Math.max(tw, th), TAU = Math.PI * 2;
  const at = (qx: number, qy: number): number => { // 升の中の画素 (qx, qy) の層。うねりも、エンジンと同じ式でここで掛ける
    const nx = qx / Mt, ny = qy / Mt;
    const wx = nx + wob * (Kao.vnoise(nx * f * 2.1, ny * f * 2.1, seed + 50) - 0.5), wy = ny + wob * (Kao.vnoise(nx * f * 2.1 + 40, ny * f * 2.1 + 40, seed + 51) - 0.5);
    if (base) return base(nx, ny, wx, wy);
    let L = 0; for (let k = 1; k < 4; k++) if (Kao.fbm(wx * f / 1.45 + k * 31.7, wy * f + k * 17.3, seed + k) > Kao.THR[k]) L = k; // Anyflage 標準
    return L;
  };
  const mod = (t: number, n: number): number => ((t % n) + n) % n;
  return (px, py) => {
    const u = mod(px, tw), v = mod(py, th), ub = mod(px + tw / 2, tw), vb = mod(py + th / 2, th);
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
  return { data, W, H, blobs: cam.comps.count, phase: job.phase ? phaseMap(cam, 0, 0, W, H, p.seed) : undefined };
}

/**
 * リピートできる絵を1枚（W×H）作る。
 * 2×2 ぶんの大きなキャンバスで迷彩を作り、真ん中の W×H を切り出す。升の端をまたぐブロブも、欠けずに丸ごと描ける。
 * 左端をまたぐブロブと右端をまたぐブロブは、ちょうど W だけずれた同じ形になる。同じ鍵を持たせて、同じ素材・同じ向きで描く。
 */
function renderTile(job: Job, p: Params, src: Picker[]): Result {
  const { W, H } = job, W2 = W * 2, H2 = H * 2, x0 = W >> 1, y0 = H >> 1;
  // ブロブ分けは、決まった大きさの升（tileRef。画面も書き出しも同じ）で決める。絵がそれと違う大きさのときは、そのブロブ分けを広げる。
  // こうしないと、絵の大きさごとにブロブの切れ方が変わり、画面で見た絵と書き出した絵が別物になる
  const [rw, rh] = job.tileRef || [W, H], R2w = rw * 2, R2h = rh * 2, rx0 = rw >> 1, ry0 = rh >> 1;
  const field = tileableField(p, rw, rh), M2 = Math.max(R2w, R2h);
  // 大きすぎるブロブを割る処理は、場所によって割り方が変わるので使わない。えぐれ切りは、正方形のときだけ写しどうしで同じ所が切れる
  const p2: Params = { ...p, layerAt: ((nx, ny) => field(nx * M2 - rx0, ny * M2 - ry0)) as LayerFn, noSplit: true, split: 'none', notch: rw === rh ? p.notch : 0, flatBelow: (p.flatBelow || 0) / 4, cutRef: undefined, clip: [x0 - 1, y0 - 1, x0 + W, y0 + H] };
  const key = ['tile', rw, rh, p.seed, p.size, p.wobble, p.pattern, p.neck, p2.notch].join('|');
  let ref = tileRef && tileRefKey === key ? tileRef : null;
  if (!ref) {
    ref = Kao.buildCamo(R2w, R2h, p2);
    // 左端をまたぐブロブと右端をまたぐブロブは、ちょうど升1つぶんずれた同じ形。同じ鍵を持たせて、同じ素材・同じ向きで描く
    const rc = ref.comps, keys = new Int32Array(rc.count);
    for (let c = 0; c < rc.count; c++) keys[c] = (Math.imul(rc.x0[c] % rw, 73856093) ^ Math.imul(rc.y0[c] % rh, 19349663) ^ Math.imul(rc.area[c], 83492791)) & 0x7fffffff;
    ref.keys = keys;
    tileRef = ref; tileRefKey = key;
  }
  let cam = ref;
  if (W !== rw || H !== rh) { // 絵の画素 (x, y) は、升の画素 (x × rw/W − 升の窓の左上) にあたる
    const sx = R2w / W2, sy = R2h / H2;
    cam = Kao.fromRef(ref, W2, H2, (x, y) => field((x + 0.5) * sx - 0.5 - rx0, (y + 0.5) * sy - 0.5 - ry0));
    cam.keys = ref.keys;
  }
  const cm = cam.comps;
  const big = new Uint8ClampedArray(W2 * H2 * 4);
  Kao.renderCamo(big, cam, src, job.colors as RGB[], p2);
  if (job.soft) softenEdges(big, W2, H2, cam);
  if (job.edges) whiteEdges(big, cam.ids, W2, x0, y0, x0 + W, y0 + H);
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) data.set(big.subarray(((y0 + y) * W2 + x0) * 4, ((y0 + y) * W2 + x0 + W) * 4), y * W * 4);
  let blobs = 0; for (let c = 0; c < cm.count; c++) if (cm.area[c] && !(cm.x1[c] < x0 || cm.y1[c] < y0 || cm.x0[c] >= x0 + W || cm.y0[c] >= y0 + H)) blobs++;
  return { data, W, H, blobs, phase: job.phase ? phaseMap(cam, x0, y0, W, H, p.seed) : undefined };
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

/**
 * ラバランプ用に、柄を時間で変える。θ が1周すると、ちょうど同じ柄に戻る。
 * 標準の柄は、しきい値で切るノイズそのものを「止まったノイズ」と「cos・sin で回るノイズ2枚」のまぜ合わせにする。ブロブが生まれ、くっつき、ちぎれる。
 * ほかの柄は、中のノイズに手が届かない（返ってくるのは「どの層か」だけ）。lavaMap で、層の地図を作って渡す。
 */
function lavaParams(p: Params, lv: Lava, W: number, H: number): Params {
  const m = Math.min(1, Math.max(0, lv.amount)), c = Math.cos(lv.theta), s = Math.sin(lv.theta), seed = p.seed | 0;
  if (!p.layerAt) {
    const f = 1 / p.size, norm = Math.hypot(1 - m, m), T = Kao.THR; // まぜると山が低くなるので、高さを戻す
    return { ...p, layerAt: (_nx, _ny, wx, wy) => {
      let L = 0;
      for (let k = 1; k < 4; k++) {
        const x = wx * f / 1.45 + k * 31.7, y = wy * f + k * 17.3;
        const v = 0.5 + ((1 - m) * (Kao.fbm(x, y, seed + k) - 0.5) + m * ((Kao.fbm(x, y, seed + k + 1000) - 0.5) * c + (Kao.fbm(x, y, seed + k + 2000) - 0.5) * s)) / norm;
        if (v > T[k]) L = k;
      }
      return L;
    } };
  }
  const map = lavaMap(p, W, H, m, c, s), M = Math.max(W, H);
  return { ...p, layerAt: (nx, ny) => map[Math.min(H - 1, Math.round(ny * M)) * W + Math.min(W - 1, Math.round(nx * M))] };
}
/**
 * 標準でない柄の、ラバランプ用の下地。設定が同じあいだ使い回す。
 * A：いつもの柄の、層の地図。B：同じ柄の離れた所の、層の地図。
 * B はブロブに分けておく（ids）。ブロブごとに、縁からの深さ（dt）、いちばん深い所の深さ（dmax）、現れる時刻を決める2つの数（ha、hb）を持つ。
 */
let lavaBase: { key: string; A: Uint8Array; B: Uint8Array; ids: Int32Array; dt: Float32Array; dmax: Float32Array; ha: Float32Array; hb: Float32Array; ok: Uint8Array } | null = null;
/**
 * 標準でない柄の、このコマの層の地図を作る。
 * いつもの柄 A の上に、同じ柄の離れた所 B のブロブを、1つずつ出したり引っこめたりする。
 * B のブロブは、いちばん深い所から現れ、自分の形のまま縁へ向かって太っていく。出きると、同じ色の A のブロブとつながる。引っこむときは、やせて、ちぎれて、消える。
 * 輪郭はいつも「A の縁」か「B のブロブを内側へ削った形」なので、どの柄でもその柄らしい形のまま動く。
 * いつ現れるかは、ブロブの場所で決まる（ゆるやかなノイズ ha・hb を cos・sin で回す）。近くのブロブは近い時刻に現れる。
 * m は溶け具合。大きいほど、同時に出ているブロブが多い。
 */
function lavaMap(p: Params, W: number, H: number, m: number, c: number, s: number): Uint8Array {
  const key = [W, H, p.seed, p.size, p.wobble, p.pattern, p.neck, p.notch, p.split, p.cutRef, p.noSplit].join('|'), n = W * H;
  if (!lavaBase || lavaBase.key !== key) {
    const base = p.layerAt!, M = Math.max(W, H), seed = p.seed | 0, f = 1 / p.size, wob = p.wobble * p.size * 0.9, OX = 3.71, OY = 5.37;
    const A = new Uint8Array(n), B = new Uint8Array(n);
    for (let y = 0, i = 0; y < H; y++) for (let x = 0; x < W; x++, i++) { // 座標とうねりは、エンジン（buildCamo）と同じ決め方
      const nx = x / M, ny = y / M;
      const wx = nx + wob * (Kao.vnoise(nx * f * 2.1, ny * f * 2.1, seed + 50) - 0.5), wy = ny + wob * (Kao.vnoise(nx * f * 2.1 + 40, ny * f * 2.1 + 40, seed + 51) - 0.5);
      A[i] = base(nx, ny, wx, wy); B[i] = base(nx + OX, ny + OY, wx + OX, wy + OY);
    }
    // B をブロブに分ける。大きすぎるブロブ、くびれ、えぐれの切り方は、絵と同じ設定で。切ってあるので、縞のような長い形も、ひとかたまりずつ現れる
    const bc = Kao.buildCamo(W, H, { ...p, layerAt: (nx, ny) => B[Math.min(H - 1, Math.round(ny * M)) * W + Math.min(W - 1, Math.round(nx * M))] }), cm = bc.comps;
    const ha = new Float32Array(cm.count), hb = new Float32Array(cm.count), ok = new Uint8Array(cm.count), g = 1 / (p.size * 2.4);
    for (let k = 0; k < cm.count; k++) {
      const x = cm.cx[k] / M * g, y = cm.cy[k] / M * g;
      ha[k] = Kao.fbm(x, y, seed + 900) - 0.5; hb[k] = Kao.fbm(x + 31.7, y + 17.3, seed + 901) - 0.5;
      ok[k] = cm.area[k] < n * 0.08 ? 1 : 0; // 切れずに残った広すぎるブロブは出さない。絵の大半がいちどに入れ替わってしまう
    }
    lavaBase = { key, A, B, ids: bc.ids, dt: bc.dt, dmax: cm.dmax, ha, hb, ok };
  }
  const { A, B, ids, dt, dmax, ha, hb, ok } = lavaBase, out = new Uint8Array(A), th = (1 - m) * 0.2, w = 0.07, lim = new Float32Array(dmax.length);
  for (let k = 0; k < lim.length; k++) { // lim：これより深い所だけ出す。出きったら 0、出ていなければ無限大
    let r = ok[k] ? (ha[k] * c + hb[k] * s - (th - w)) / (2 * w) : 0;
    r = r <= 0 ? 0 : r >= 1 ? 1 : r * r * (3 - 2 * r);
    lim[k] = r <= 0 ? Infinity : (dmax[k] + 0.5) * (1 - r);
  }
  for (let i = 0; i < n; i++) if (dt[i] > lim[ids[i]]) out[i] = B[i];
  return out;
}
/** 前のコマの状態。次のコマへ、ブロブの鍵（＝同じ素材・同じ向き）と、絵が入っている範囲を引き継ぐ */
/**
 * コマごとの、ブロブの鍵。前向きにたどったもの F と、後ろ向きにたどったもの B。
 * 鍵は前のコマから引き継ぐので、1周たどっても 0 コマ目の鍵には戻らない（顔が入れ替わったままになる）。そのままではループがつながらない。
 * そこで、0 コマ目の鍵から前向きにたどった F と、同じ 0 コマ目の鍵から時間をさかのぼってたどった B を作る。
 * F は1周の始めで、B は1周の終わりで、0 コマ目とつながる。ブロブごとに、途中のどこかで F から B へ乗り換える。
 * 乗り換える時刻は顔（F の鍵）ごとにばらばらにする。乗り換えは、いつもの「消えて、広がり直す」動きになる。
 * 同じコマは、何度作っても同じブロブ分け・同じ番号になる。だから番号で引ける。
 */
let lavaKeys: { F: (Int32Array | undefined)[]; B: (Int32Array | undefined)[] } = { F: [], B: [] };
let lavaPrev: {
  W: number; H: number;
  /** 画素ごとの、そこに絵を出していたブロブの鍵。色だけ塗った所は -1 */
  owner: Int32Array;
  /** 画素ごとの、広がりの出発点（画素の番号）。広がりきったブロブでは、自分自身 */
  org: Int32Array;
  /** 鍵ごとの、広がり始めてからのコマ数。広がりきったら 0 に戻す */
  ageOf: Map<number, number>;
  /** 鍵ごとの層。色の違うブロブへは引き継がない */
  layerOf: Map<number, number>;
  /** 鍵ごとの、素材の版を選んだときの縦横比 */
  aspectOf: Map<number, number>;
  /** 前のコマで、画素ごとに絵を読んだ位置。描いたコマのあとだけある */
  uv: { u: Float32Array<ArrayBuffer>; v: Float32Array<ArrayBuffer>; set: Uint8Array } | null;
} | null = null;
/**
 * ラバランプの1コマ。迷彩を作り直して、押し込み直す。
 *
 * 鍵の引き継ぎ：コマごとにブロブの番号は変わる。番号で素材を決めると、毎コマ別の顔になってちらつく。
 * ブロブの中で、前のコマにいちばん広く絵を出していた鍵を引き継ぐ（同じ色のものだけ）。大きいブロブから先に選ぶ。
 * 引き継げないブロブ（生まれた、ちぎれた小さいほう、くっついて取られた）は、場所から新しい鍵を作る。
 *
 * 侵食：くっついた瞬間、取り込まれた側の絵はすぐ消える（色だけになる）。取り込んだ側の絵は、そこへ少しずつ広がっていく。
 * やり方は、ブロブを「前のコマで同じ鍵の絵が出ていた所」から、1コマに決まった画素数ずつ広げること。
 * まだ届いていない所は、別のブロブとして色だけ塗る。絵を押し込む先は、届いた範囲だけ。範囲が広がるにつれて、絵も伸びていく。
 * 生まれたばかりのブロブ、ちぎれて鍵が変わったブロブは、いちばん深い点から広がる。
 * ふつうに輪郭が動くぶんは、1コマの広がりより小さいので、すぐ届く。
 */
function renderLava(job: Job, p0: Params, src: Picker[]): Result {
  const { W, H } = job, lv = job.lava!, p = lavaParams(p0, lv, W, H), M = Math.max(W, H), n = W * H;
  const base = Kao.buildCamo(W, H, p), bm = base.comps, bids = base.ids;
  const prev = lv.first || !lavaPrev || lavaPrev.W !== W || lavaPrev.H !== H ? null : lavaPrev;
  const dry = lv.pass !== 'draw', seed = p.seed | 0;
  if (lv.first && lv.pass === 'f') lavaKeys = { F: [], B: [] };
  const kf = lavaKeys.F[lv.index], kb = lavaKeys.B[lv.index], given = !dry && !!kf && !!kb && kf.length === bm.count && kb.length === bm.count;
  const keys = new Int32Array(bm.count).fill(-1), used = new Set<number>(), q = Math.max(4, p.size * M * 0.6);
  if (given) for (let c = 0; c < bm.count; c++) { // 覚えた鍵を使う。顔ごとに決めた時刻までは F、そのあとは B
    const t = 1 + Math.floor(Kao.hash2(kf![c], 77, seed) * (lv.count - 1));
    keys[c] = lv.index < t ? kf![c] : kb![c];
  }
  const order = Array.from({ length: bm.count }, (_, c) => c).sort((a, b) => bm.area[b] - bm.area[a]); // 大きいブロブから先に鍵を取る
  if (prev && !given) {
    // ブロブごとに、前のコマの絵がどの鍵でどれだけ重なっているか数える。同じ組が続くあいだは、まとめて足す
    const votes: (Map<number, number> | undefined)[] = new Array(bm.count), po = prev.owner;
    let lc = -1, lk = -1, run = 0;
    const flush = (): void => { if (run && lk >= 0) { const m = votes[lc] || (votes[lc] = new Map()); m.set(lk, (m.get(lk) || 0) + run); } run = 0; };
    for (let i = 0; i < n; i++) { const c = bids[i], k = po[i]; if (c !== lc || k !== lk) { flush(); lc = c; lk = k; } run++; }
    flush();
    for (const c of order) {
      const m = votes[c]; if (!m) continue;
      let best = -1, bn = 0;
      for (const [k, v] of m) if (v > bn && !used.has(k) && prev.layerOf.get(k) === bm.layer[c]) { best = k; bn = v; }
      if (best >= 0) { keys[c] = best; used.add(best); }
    }
  }
  for (const c of order) if (keys[c] < 0) {
    const x = Math.min(W - 1, Math.max(0, Math.round(bm.cx[c]))), y = Math.min(H - 1, Math.max(0, Math.round(bm.cy[c])));
    let k = (Math.imul(Math.floor(x / q), 73856093) ^ Math.imul(Math.floor(y / q), 19349663) ^ Math.imul(bm.layer[c] + 1, 83492791)) & 0x7fffffff;
    while (used.has(k)) k = (k + 1) & 0x7fffffff;
    used.add(k); keys[c] = k;
  }
  let cam = base, camKeys = keys;
  const owner = new Int32Array(n), org = new Int32Array(n), ageOf = new Map<number, number>();
  /** 絵が広がっている最中のブロブ（1）。読む位置のならしを切る */
  const growing = new Uint8Array(bm.count);
  if (!prev) { for (let i = 0; i < n; i++) { owner[i] = keys[bids[i]]; org[i] = i; } } // 最初のコマは、全部に絵を入れる
  else {
    // 絵が届いている所：前のコマで同じ鍵の絵が出ていた所から、同じブロブの中を step 画素ぶん広げる。
    // 広がりは丸くする。画素ごとに「どの出発点から来たか」を持ち回り、出発点からのまっすぐな距離が半径以内の所まで進む。
    // 半径は「広がり始めてからのコマ数 × step」。出発点は、広がり始めたときの縁のまま、コマをまたいで持ち越す。
    // こうすると、1コマの広がりが1〜3画素しかなくても丸く広がる（毎コマ縁から数え直すと、画素の升目の形が積み重なって、ひし形や四角になる）。
    // 広がりきったブロブは、出発点を自分自身に戻す。次に広がるときは、そのときの縁から丸く広がる
    const step = Math.max(0.25, p.size * M * lv.grow), reach = new Int16Array(n).fill(-1), from = new Int32Array(n), queue = new Int32Array(n), po = prev.owner, porg = prev.org;
    const seeded = new Uint8Array(bm.count), rad2 = new Float32Array(bm.count), age = new Int32Array(bm.count);
    for (let c = 0; c < bm.count; c++) { age[c] = prev.ageOf.get(keys[c]) || 0; const r = (age[c] + 1) * step; rad2[c] = r * r; }
    let head = 0, tail = 0;
    for (let i = 0; i < n; i++) { const c = bids[i]; if (po[i] === keys[c]) { reach[i] = 0; from[i] = porg[i]; queue[tail++] = i; seeded[c] = 1; } }
    for (let c = 0; c < bm.count; c++) if (!seeded[c] && bm.area[c]) { // 前の絵がどこにもない。いちばん深い点から広げる
      const i = Math.min(H - 1, Math.max(0, Math.round(bm.cy[c]))) * W + Math.min(W - 1, Math.max(0, Math.round(bm.cx[c])));
      if (bids[i] === c) { reach[i] = 0; from[i] = i; queue[tail++] = i; }
      age[c] = 0; rad2[c] = step * step;
    }
    while (head < tail) {
      const i = queue[head++], c = bids[i], x = i % W, y = (i / W) | 0, s = from[i], sx = s % W, sy = (s / W) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { // まわり8画素
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx; if (reach[j] >= 0 || bids[j] !== c) continue;
        if ((nx - sx) * (nx - sx) + (ny - sy) * (ny - sy) > rad2[c]) continue; // 出発点から遠すぎる。ほかの出発点からなら届くかもしれないので、印は付けない
        reach[j] = 1; from[j] = s; queue[tail++] = j;
      }
    }
    // 届いた所と、まだの所を、別のブロブにする
    const key = new Int32Array(n), layer = new Int32Array(n); let pending = 0;
    for (let i = 0; i < n; i++) { const c = bids[i]; layer[i] = bm.layer[c]; if (reach[i] >= 0) key[i] = c; else { key[i] = bm.count + c; pending++; } }
    if (pending) {
      cam = Kao.fromKeys(W, H, key, layer);
      const cm = cam.comps, flat = new Uint8Array(cm.count); camKeys = new Int32Array(cm.count);
      for (let c = 0; c < cm.count; c++) { // そのブロブの中の1点から、もとのブロブと、届いているかを引く
        const i = Math.round(cm.cy[c]) * W + Math.round(cm.cx[c]), b = bids[i];
        camKeys[c] = keys[b]; if (reach[i] < 0) flat[c] = 1;
      }
      cam.flat = flat;
    }
    const left = new Int32Array(bm.count), fresh = new Int32Array(bm.count); // ブロブごとの、まだ届いていない画素の数と、このコマで届いた画素の数
    for (let i = 0; i < n; i++) { if (reach[i] < 0) left[bids[i]]++; else if (reach[i] > 0) fresh[bids[i]]++; }
    // 広がっている最中：まだ届いていない所がある、前のコマまで広がっていた、このコマでまとまった広さが増えた
    for (let c = 0; c < bm.count; c++) if (left[c] || age[c] > 0 || fresh[c] > bm.area[c] * 0.06) growing[c] = 1;
    for (let i = 0; i < n; i++) { const c = bids[i]; if (reach[i] >= 0) { owner[i] = keys[c]; org[i] = left[c] ? from[i] : i; } else owner[i] = -1; }
    for (let c = 0; c < bm.count; c++) if (bm.area[c] && left[c]) ageOf.set(keys[c], age[c] + 1);
  }
  const layerOf = new Map<number, number>(); for (let c = 0; c < bm.count; c++) layerOf.set(keys[c], bm.layer[c]);
  // 素材の版は、ブロブの縦横比で選ぶ。比が境目のあたりにあると、毎コマ版が入れ替わって絵が飛ぶ。大きく変わるまで、前の比のままにする
  const cmA = cam.comps, aspect = new Float32Array(cmA.count), aspectOf = new Map<number, number>();
  for (let c = 0; c < cmA.count; c++) {
    let a = (cmA.x1[c] - cmA.x0[c] + 1) / (cmA.y1[c] - cmA.y0[c] + 1);
    const a0 = prev ? prev.aspectOf.get(camKeys[c]) : undefined;
    if (a0 && Math.abs(Math.log(a / a0)) < 0.5) a = a0;
    aspect[c] = a; if (!(cam.flat && cam.flat[c])) aspectOf.set(camKeys[c], a);
  }
  if (lv.pass === 'f') lavaKeys.F[lv.index] = keys; else if (lv.pass === 'b') lavaKeys.B[lv.index] = keys;
  if (dry) { lavaPrev = { W, H, owner, org, ageOf, layerOf, aspectOf, uv: null }; return { data: new Uint8ClampedArray(4), W: 1, H: 1, blobs: bm.count }; } // 絵は返さない。1画素だけ
  cam.keys = camKeys; cam.steady = true; cam.aspect = aspect;
  // 絵を読む位置を、前のコマからなめらかにつなぐ。前のコマも同じ鍵の絵だった画素だけ
  const ok = new Uint8Array(n), pu = prev && prev.uv ? prev.uv.u : new Float32Array(0), pv = prev && prev.uv ? prev.uv.v : new Float32Array(0);
  // 広がっている最中のブロブは、ならさない。ならすと、前からある所は古い位置を引きずり、いま届いた所は新しい位置で描かれる。
  // その食い違いが、広がるたびに輪になって残り、縞に見える。ならさなければ、絵は届いた範囲に合わせて、丸ごと大きくなっていく
  if (prev && prev.uv) { const ps = prev.uv.set, po = prev.owner; for (let i = 0; i < n; i++) if (ps[i] && owner[i] >= 0 && po[i] === owner[i] && !growing[bids[i]]) ok[i] = 1; }
  const ease = { pu, pv, ok, nu: new Float32Array(n), nv: new Float32Array(n), set: new Uint8Array(n), a: 1 - Math.exp(-Math.max(0.001, lv.dt) / 0.12) };
  cam.ease = ease;
  const data = new Uint8ClampedArray(n * 4);
  Kao.renderCamo(data, cam, src, job.colors as RGB[], p);
  if (job.soft) softenEdges(data, W, H, cam);
  if (job.edges) whiteEdges(data, cam.ids, W, 0, 0, W - 1, H - 1);
  lavaPrev = { W, H, owner, org, ageOf, layerOf, aspectOf, uv: { u: ease.nu, v: ease.nv, set: ease.set } };
  return { data, W, H, blobs: bm.count };
}

export function run(job: Job): Result {
  const p = withLayer(job.p), src = pickers(job);
  if (job.lava && job.kind === 'one') return renderLava(job, p, src);
  return job.kind === 'tile' ? renderTile(job, p, src) : job.kind === 'orig' ? renderOriginals(job, p, src) : renderOne(job, p, src);
}
