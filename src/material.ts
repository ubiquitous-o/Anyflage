// 切り抜き1枚を、エンジンに渡す素材にする。試作の shapeOf / variant の移植。
// ブロブの縦横比ごとにシームカービングした版を作り、放射方式用の極座標表を付ける。
import { Kao } from './engine/kao.ts';
import type { CarveGrid, Inv, Picker, Raster, Source } from './engine/types.ts';

/** ブロブの縦横比の段。いちばん近い段の版を使う */
const BUCKETS = [0.5, 0.8, 1.25, 2];

export interface MaterialOptions {
  /** シームカービング 0〜0.9 */
  carve: number;
  /** 肌色を保護 0〜1 */
  protect: number;
  /** ブロブの縦横に合わせて詰める */
  fitBlob: boolean;
  /** 筋を抜いた跡の階段をならす */
  soften?: boolean;
  /** ならす飛びの上限（升の数） */
  softLimit?: number;
  /**
   * カービングの量を、STEP 刻みの版のあいだでなめらかにつなぐ。動画で量を少しずつ変えるときに使う。
   * シームカービングは粗い升目から筋を1本ずつ抜くので、量を少し変えただけでも、絵は1升ぶん飛ぶ。量が大きく残りの升が少ないほど、飛びが目立つ。
   * そこで、STEP 刻みの量でだけ本当にカービングし、あいだは「元の絵のどこを読むか」の表を2つの版でまぜて作る（画素はまぜない）
   */
  blend?: boolean;
  /**
   * blend のとき、押し込み方の設定。素材を「円に写す表」も、STEP 刻みの版でだけ作って、あいだはまぜる。
   * この表は粗い升目から作るので、コマごとに作り直すと、素材が1画素変わるだけでわずかに飛び、絵がピクピクする
   */
  fit?: { method: string; mix: number; imp: number; trim: boolean };
}
/** 版1つ。key は「どの設定の、どの縦横比の版か」 */
export interface Variant { key: string; source: Source | null; /** 絵は元の切り抜きそのもの。送るときは省き、受けた側で自分の切り抜きを当てる */ raw?: boolean }

export class Material {
  private cache = new Map<string, Source | null>();
  /** 版を覚えている設定。古い順。動画でカービングの量をコマごとに変えると、設定が何十にもなる。全部覚えると記憶があふれるので、新しい KEEP 個だけ残す */
  private recent: string[] = [];
  private touch(key: string): void {
    const g = groupOf(key), at = this.recent.indexOf(g);
    if (at === this.recent.length - 1 && at >= 0) return;
    if (at >= 0) this.recent.splice(at, 1);
    this.recent.push(g);
    while (this.recent.length > KEEP) { const old = this.recent.shift()!; for (const k of [...this.cache.keys()]) if (groupOf(k) === old) this.cache.delete(k); }
  }
  readonly raw: Raster;

  constructor(raw: Raster) { this.raw = raw; }

  /** いまの設定での包み。形を取れない素材は null */
  picker(o: MaterialOptions): Picker | null {
    const base = this.variant(o, 0);
    if (!base) return null;
    return {
      pick: (aspect, carve) => {
        let best = 0, bd = Infinity;
        if (o.fitBlob) for (const b of BUCKETS) { const d = Math.abs(Math.log(aspect / b)); if (d < bd) { bd = d; best = b; } }
        // ブロブごとに量が指定されたら、その量の版をその場で作る（刻みの版をまぜるだけなので速い）。量がばらばらなので、覚えない
        if (carve !== undefined && o.blend) return this.blended({ ...o, carve }, best) || base;
        return best ? this.variant(o, best) || base : base;
      },
    };
  }

  /**
   * この設定で使う版を全部作り、方式ごとの準備（円へ写す表など）も済ませる。
   * 別の場所（別の Worker）で作って、描く場所へ install で渡すためのもの。
   */
  prepare(o: MaterialOptions, method: string, mix: number, imp: number, trim: boolean): Variant[] {
    const out: Variant[] = [];
    for (const aspect of o.fitBlob ? [0, ...BUCKETS] : [0]) {
      const source = this.variant(o, aspect);
      if (source) Kao.prepareSource(source, method, mix, imp, trim);
      // 元の切り抜きをそのまま読む版は、絵を付けずに渡す（受けた側が自分の切り抜きを当てる）。版ごとに絵を写すと重い
      if (source && o.blend && source.data === this.raw.data) out.push({ key: keyOf(o, aspect), source: { ...source, data: new Uint8ClampedArray(0) }, raw: true });
      else out.push({ key: keyOf(o, aspect), source });
      if (!source && aspect === 0) break; // 形を取れない素材
    }
    return out;
  }
  /** よそで作った版を入れる */
  install(list: Variant[]): void { for (const v of list) { if (v.raw && v.source) v.source.data = this.raw.data; this.cache.set(v.key, v.source); this.touch(v.key); } }

  /** STEP 刻みの量での版。作ったものは少しだけ覚える */
  private anchors = new Map<string, Anchor | null>();
  private anchorAt(amount: number, o: MaterialOptions, aspect: number): Anchor | null {
    const key = `${amount}|${o.protect}|${aspect}|${o.soften ? 1 : 0}|${o.softLimit ?? 14}|${fitKey(o)}`;
    let g = this.anchors.get(key);
    if (g === undefined) {
      const r = Kao.carve(this.raw.data, this.raw.w, this.raw.h, { amount, aspect, protect: o.protect, res: 192, soften: o.soften ? 3 : 0, softenLimit: o.softLimit, withGrid: true });
      g = null;
      if (r.grid) {
        let inv: Inv | null = null;
        if (o.fit && DISC(o.fit.method)) {
          const s = withShape({ w: r.w, h: r.h, data: r.data });
          if (s) { Kao.prepareSource(s, o.fit.method, o.fit.mix, o.fit.imp, o.fit.trim); const iv = s.inv && s.inv[o.fit.method]; if (iv && !iv.empty) inv = invToRaw(iv, r.grid); }
        }
        g = { grid: r.grid, inv };
      }
    }
    this.anchors.delete(key); this.anchors.set(key, g); // 使ったものを新しい側へ
    while (this.anchors.size > GRID_KEEP) this.anchors.delete(this.anchors.keys().next().value!);
    return g;
  }
  private rawShape: Source | null | undefined;
  /** 量 o.carve の版を、前後の刻みの版をまぜて作る */
  private blended(o: MaterialOptions, aspect: number): Source | null {
    const c = Math.min(CARVE_MAX, Math.max(0, o.carve)), k = Math.min(Math.round(CARVE_MAX / STEP) - 1, Math.floor(c / STEP + 1e-6));
    const a0 = Math.round(k * STEP * 100) / 100, a1 = Math.round((k + 1) * STEP * 100) / 100, A = this.anchorAt(a0, o, aspect), B = this.anchorAt(a1, o, aspect), t = (c - a0) / STEP;
    if (this.rawShape === undefined) this.rawShape = withShape(this.raw);
    if (!A || !B) return this.rawShape;
    if (o.fit && A.inv && B.inv && this.rawShape) { // 円に写す表をまぜる。絵は元の切り抜きをそのまま読む
      const n = A.inv.N * A.inv.N, tx = new Float32Array(n), ty = new Float32Array(n);
      for (let i = 0; i < n; i++) { tx[i] = A.inv.tx[i] * (1 - t) + B.inv.tx[i] * t; ty[i] = A.inv.ty[i] * (1 - t) + B.inv.ty[i] * t; }
      return { w: this.raw.w, h: this.raw.h, data: this.raw.data, shape: this.rawShape.shape, inv: { [o.fit.method]: { N: A.inv.N, tx, ty, empty: false, mix: A.inv.mix } } };
    }
    return withShape(blendGrids(this.raw, A.grid, B.grid, t)); // 円を使わない方式は、まぜた絵を作る
  }

  private variant(o: MaterialOptions, aspect: number): Source | null {
    const key = keyOf(o, aspect);
    const hit = this.cache.get(key);
    if (hit !== undefined) { this.touch(key); return hit; }
    if (o.blend) { const made0 = this.blended(o, aspect); this.cache.set(key, made0); this.touch(key); return made0; }
    const im = o.carve > 0 ? Kao.carve(this.raw.data, this.raw.w, this.raw.h, { amount: o.carve, aspect, protect: o.protect, res: 192, soften: o.soften ? 3 : 0, softenLimit: o.softLimit }) : this.raw;
    const made = withShape(im);
    this.cache.set(key, made); this.touch(key);
    return made;
  }
}
/** 覚えておく設定の数 */
const KEEP = 3;
/** 版の鍵から、縦横比を除いたもの。同じ設定の版をまとめる */
const groupOf = (key: string): string => { const a = key.split('|'); if (a.length > 2) a.splice(2, 1); return a.join('|'); };
const keyOf = (o: MaterialOptions, aspect: number): string => (o.carve > 0 || o.blend ? `${o.carve}|${o.protect}|${aspect}|${o.soften ? 1 : 0}|${o.softLimit ?? 14}${o.blend ? `|b${fitKey(o)}` : ''}` : '0');
const fitKey = (o: MaterialOptions): string => (o.fit && DISC(o.fit.method) ? `${o.fit.method},${o.fit.mix},${o.fit.imp},${o.fit.trim ? 1 : 0}` : '');
/** 素材を円に写す表を使う方式か（放射、詰め物、形にカービング は使わない） */
const DISC = (method: string): boolean => !['radial', 'elastic', 'carve'].includes(method);
/** 刻みの量での版。升目の表と、（使う方式なら）円から元の切り抜きへ写す表 */
interface Anchor { grid: CarveGrid; inv: Inv | null }
/** 円から「縮めた絵」へ写す表を、升目の表を通して、円から「元の切り抜き」へ写す表に直す */
function invToRaw(iv: Inv, G: CarveGrid): Inv {
  const n = iv.N * iv.N, tx = new Float32Array(n), ty = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const fx = Math.min(G.cw - 1.001, Math.max(0, (iv.tx[k] + 0.5) * G.f - 0.5)), fy = Math.min(G.ch - 1.001, Math.max(0, (iv.ty[k] + 0.5) * G.f - 0.5)), ix = fx | 0, iy = fy | 0, ax = fx - ix, ay = fy - iy;
    const a = ix * G.stride + iy, b = a + G.stride, c = a + 1, e = b + 1;
    let w00 = (1 - ax) * (1 - ay) * G.ok[a], w10 = ax * (1 - ay) * G.ok[b], w01 = (1 - ax) * ay * G.ok[c], w11 = ax * ay * G.ok[e], ws = w00 + w10 + w01 + w11;
    if (ws <= 0) { w00 = (1 - ax) * (1 - ay); w10 = ax * (1 - ay); w01 = (1 - ax) * ay; w11 = ax * ay; ws = 1; } // まわりに絵の升がない。升目の表はどの升にも位置を持っているので、そのまま読む
    tx[k] = (w00 * G.x[a] + w10 * G.x[b] + w01 * G.x[c] + w11 * G.x[e]) / ws;
    ty[k] = (w00 * G.y[a] + w10 * G.y[b] + w01 * G.y[c] + w11 * G.y[e]) / ws;
  }
  return { N: iv.N, tx, ty, empty: false, mix: iv.mix };
}

/** 本当にカービングする量の刻みと、量の上限 */
const STEP = 0.05, CARVE_MAX = 0.9;
/** 覚えておく刻みの版の数。ブロブごとに量が違うとき、1つの素材がいくつもの刻みを使う */
const GRID_KEEP = 24;
/**
 * 升目の表2つ（量のちがう版）を t でまぜて、絵を作る。
 * できあがりの絵の同じ割合の位置どうしで、「元の絵のどこを読むか」をまぜる。絵の大きさと輪郭も、2つのあいだになる
 */
function blendGrids(raw: Raster, A: CarveGrid, B: CarveGrid, t: number): Raster {
  const f = A.f, cw = A.cw + (B.cw - A.cw) * t, ch = A.ch + (B.ch - A.ch) * t, ow = Math.max(4, Math.round(cw / f)), oh = Math.max(4, Math.round(ch / f));
  const out = new Uint8ClampedArray(ow * oh * 4), d = raw.data, w = raw.w, h = raw.h, ra = new Float64Array(4), rb = new Float64Array(4);
  /** 升目 G の、割合 (u, v) の所。r に [絵の中かどうか, 読む位置の重み, 読む位置 x, y] を入れる */
  const at = (G: CarveGrid, u: number, v: number, r: Float64Array): void => {
    const fx = Math.min(G.cw - 1.001, Math.max(0, u * G.cw - 0.5)), fy = Math.min(G.ch - 1.001, Math.max(0, v * G.ch - 0.5)), ix = fx | 0, iy = fy | 0, tx = fx - ix, ty = fy - iy;
    const a = ix * G.stride + iy, b = a + G.stride, c = a + 1, e = b + 1, w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
    r[0] = G.inside[a] * w00 + G.inside[b] * w10 + G.inside[c] * w01 + G.inside[e] * w11;
    const ws = G.ok[a] * w00 + G.ok[b] * w10 + G.ok[c] * w01 + G.ok[e] * w11;
    r[1] = ws;
    if (ws > 0) {
      r[2] = (G.ok[a] * w00 * G.x[a] + G.ok[b] * w10 * G.x[b] + G.ok[c] * w01 * G.x[c] + G.ok[e] * w11 * G.x[e]) / ws;
      r[3] = (G.ok[a] * w00 * G.y[a] + G.ok[b] * w10 * G.y[b] + G.ok[c] * w01 * G.y[c] + G.ok[e] * w11 * G.y[e]) / ws;
    }
  };
  /** 元の絵の (px, py) の画素の場所。透明なら -1 */
  const solid = (px: number, py: number): number => { const s = (Math.min(h - 1, Math.max(0, Math.round(py))) * w + Math.min(w - 1, Math.max(0, Math.round(px)))) * 4; return d[s + 3] > 110 ? s : -1; };
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
    const u = (x + 0.5) / ow, v = (y + 0.5) / oh;
    at(A, u, v, ra); at(B, u, v, rb);
    if (ra[0] * (1 - t) + rb[0] * t < 0.5) continue;
    const hasA = ra[1] > 0, hasB = rb[1] > 0;
    let s = -1;
    if (hasA && hasB) s = solid(ra[2] * (1 - t) + rb[2] * t, ra[3] * (1 - t) + rb[3] * t);
    // まぜた先が透明なら（すき間をまたいだ）、近いほうの版の位置で読む
    if (s < 0 && hasA && (t < 0.5 || !hasB)) s = solid(ra[2], ra[3]);
    if (s < 0 && hasB) s = solid(rb[2], rb[3]);
    if (s < 0 && hasA) s = solid(ra[2], ra[3]);
    if (s < 0) continue;
    const q = (y * ow + x) * 4;
    out[q] = d[s]; out[q + 1] = d[s + 1]; out[q + 2] = d[s + 2]; out[q + 3] = 255;
  }
  return { w: ow, h: oh, data: out };
}

/** 重心まわり360本の線ごとに、外接矩形までの半径、輪郭までの半径、中身のある半径の一覧を記録する */
export function withShape(im: Raster): Source | null {
  const d = im.data, w = im.w, h = im.h;
  let x0 = w, y0 = h, x1 = -1, y1 = -1, sx = 0, sy = 0, cnt = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 110) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; sx += x; sy += y; cnt++;
  }
  if (cnt < 200) return null;
  const cx = sx / cnt, cy = sy / cnt, Rbox = new Float32Array(360), Renv = new Float32Array(360), start = new Int32Array(361), rads: number[] = [];
  for (let k = 0; k < 360; k++) {
    const t = k * Math.PI / 180, dx = Math.cos(t), dy = Math.sin(t);
    const tx = dx > 1e-6 ? (x1 - cx) / dx : dx < -1e-6 ? (x0 - cx) / dx : Infinity, ty = dy > 1e-6 ? (y1 - cy) / dy : dy < -1e-6 ? (y0 - cy) / dy : Infinity;
    Rbox[k] = Math.min(tx, ty);
    let last = 0; const before = rads.length;
    for (let s = 0; s <= Rbox[k]; s++) {
      const x = Math.round(cx + dx * s), y = Math.round(cy + dy * s);
      if (x >= 0 && y >= 0 && x < w && y < h && d[(y * w + x) * 4 + 3] > 110) { rads.push(s); last = s; }
    }
    if (rads.length === before) rads.push(0);
    Renv[k] = Math.max(last, 2); start[k + 1] = rads.length;
  }
  return { w, h, data: d, shape: { cx, cy, Rbox, Renv, start, rads: Int16Array.from(rads) } };
}
