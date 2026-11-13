// 切り抜き1枚を、エンジンに渡す素材にする。試作の shapeOf / variant の移植。
// ブロブの縦横比ごとにシームカービングした版を作り、放射方式用の極座標表を付ける。
import { Kao } from './engine/kao.ts';
import type { Picker, Raster, Source } from './engine/types.ts';

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
}
/** 版1つ。key は「どの設定の、どの縦横比の版か」 */
export interface Variant { key: string; source: Source | null }

export class Material {
  private cache = new Map<string, Source | null>();
  readonly raw: Raster;

  constructor(raw: Raster) { this.raw = raw; }

  /** いまの設定での包み。形を取れない素材は null */
  picker(o: MaterialOptions): Picker | null {
    const base = this.variant(o, 0);
    if (!base) return null;
    return {
      pick: (aspect) => {
        if (!o.fitBlob) return base;
        let best = 0, bd = Infinity;
        for (const b of BUCKETS) { const d = Math.abs(Math.log(aspect / b)); if (d < bd) { bd = d; best = b; } }
        return this.variant(o, best) || base;
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
      out.push({ key: keyOf(o, aspect), source });
      if (!source && aspect === 0) break; // 形を取れない素材
    }
    return out;
  }
  /** よそで作った版を入れる */
  install(list: Variant[]): void { for (const v of list) this.cache.set(v.key, v.source); }

  private variant(o: MaterialOptions, aspect: number): Source | null {
    const key = keyOf(o, aspect);
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const im = o.carve > 0 ? Kao.carve(this.raw.data, this.raw.w, this.raw.h, { amount: o.carve, aspect, protect: o.protect, res: 192, soften: o.soften ? 3 : 0, softenLimit: o.softLimit }) : this.raw;
    const made = withShape(im);
    this.cache.set(key, made);
    return made;
  }
}
const keyOf = (o: MaterialOptions, aspect: number): string => (o.carve > 0 ? `${o.carve}|${o.protect}|${aspect}|${o.soften ? 1 : 0}|${o.softLimit ?? 14}` : '0');

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
