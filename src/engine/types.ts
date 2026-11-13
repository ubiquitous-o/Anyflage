// エンジンが受け渡すデータの形。

export type F32 = Float32Array<ArrayBuffer>;
/** RGBA の画素列。ImageData.data をそのまま渡せる */
export type Pixels = Uint8ClampedArray;
export type RGB = readonly [number, number, number] | number[];

export type Method =
  | 'radial' | 'harmonic' | 'elastic' | 'area' | 'contour'
  | 'areaharm' | 'diffuse' | 'energy' | 'blend' | 'carve';

/** UI から渡すパラメータ。試作の params() と同じ名前 */
export interface Params {
  seed: number;
  /** ブロブの大きさ */
  size: number;
  /** 輪郭のうねり */
  wobble: number;
  /** 形に押し込む（放射だけ） */
  fit: number;
  /** ゆらぎ */
  dist: number;
  /** 回転のばらつき */
  rot: number;
  zoom: number;
  /** 迷彩色の強さ */
  tint: number;
  assign: 'random' | 'apart' | 'layer' | string;
  method?: Method;
  /** 細部を大きく */
  imp?: number;
  /** 面積寄り。0 = 調和写像側、1 = 面積均等側 */
  mix?: number;
  /** 締めつけ（放射と詰め物だけ） */
  squeeze?: number;
  /** 素材を4画素まぜて読む（なめらか）。省くと試作と同じ最近傍 */
  smooth?: boolean;
  /** くびれでブロブを切る。くびれの幅が、つながる先の太さのこの割合より細ければ切る。0 で切らない（試作と同じ） */
  neck?: number;
  /** 素材の細すぎる所（尻尾、耳、指）を落としてから写す。落とさないと、そこがブロブの端で筋状に伸びる。省くと試作と同じ */
  trim?: boolean;
  /** くびれを探すときの地図の長辺（画素）。絵がこれより大きいときは、縮めた地図で探して切り口を引き伸ばす。画面用と書き出し用で同じ所が切れる。省くと絵の大きさのまま探す（試作と同じ） */
  cutRef?: number;
  /** 描く範囲 [x0, y0, x1, y1]。ここにかからないブロブは描かない。省くと全部描く */
  clip?: number[];
  /** えぐれでブロブを切る。0 で切らない。大きいほど、長い切り口でも切る */
  notch?: number;
  /** 素材を入れない層の番号。タイルのすき間など */
  flatLayers?: number[];
  /** 大きすぎるブロブの切り方。省くと試作と同じ直線。'wavy' はうねった線、'none' は切らない */
  split?: string;
  /** 大きすぎるブロブを割らない */
  noSplit?: boolean;
  /** 柄の名前。迷彩の使い回しを見分けるためだけに使う */
  pattern?: string;
  /** 柄の生成器。省くと試作と同じ迷彩 */
  layerAt?: LayerFn;
  /** キャンバス面積に対する割合。これより小さいブロブには素材を入れず、色だけ塗る */
  flatBelow?: number;
}

/**
 * 1画素がどの色の層か返す。nx, ny はキャンバス長辺で割った座標（0〜1）。
 * wx, wy は「輪郭のうねり」で歪めた同じ座標。直線を保ちたい柄は nx, ny を使う。
 */
export type LayerFn = (nx: number, ny: number, wx: number, wy: number) => number;

export interface Comps {
  count: number;
  layer: Uint8Array;
  area: Int32Array;
  x0: Int32Array; y0: Int32Array; x1: Int32Array; y1: Int32Array;
  /** ブロブごとの最大の深さと、その位置 */
  dmax: F32; cx: F32; cy: F32;
}

export interface Trace { idx: Int32Array; t: F32; theta0: number }
export interface UV { u: F32; v: F32 }
export interface BlobMap extends UV { g: Grid }

/** 粗い格子。ブロブにも絵にも使う。後ろの任意項目は計算結果の置き場 */
export interface Grid {
  bx: number; by: number; cs: number; gw: number; gh: number;
  ins: Uint8Array;
  n: number; ci: number; cj: number; center: number;
  tr?: Trace;
  qd?: Int32Array;
  bh?: UV;
  ba?: UV;
  baImp?: number;
  imp?: number;
  wt?: F32 | null;
  sd?: F32;
  deep?: number;
  sdmax?: number;
}

export interface Camo {
  W: number; H: number;
  ids: Int32Array;
  comps: Comps;
  /** ブロブごとの鍵。あれば、素材・向き・回転をブロブの番号ではなくこの鍵で決める。リピート用：ずらした写しどうしが同じ鍵を持つ */
  keys?: Int32Array;
  /** 素材を入れず、色だけ塗るブロブ（1 のもの）。動画用：まだ絵が広がってきていない所 */
  flat?: Uint8Array;
  /**
   * ブロブの中の絵の向きを、形から なめらかに決める。動画用。
   * ふつうは、輪郭をたどり始める升の方角で向きが決まる。形が少し変わると、たどり始めの升が隣へ移り、絵が数度ずつ飛んで回る。
   * これを入れると、ブロブ全体でならした向きに合わせ直す。形が少し変われば、向きも少しだけ変わる。
   */
  steady?: boolean;
  /** ブロブごとの縦横比。あれば、素材の版（縦横比ごとに縮めたもの）を、ブロブの外接矩形ではなくこの値で選ぶ。動画用：版が行ったり来たりしないように */
  aspect?: Float32Array;
  /**
   * 絵を読む位置を、前のコマからなめらかにつなぐ。動画用。
   * ブロブの中の絵は、粗い格子で毎コマ解き直す。形が少し変わるだけで、格子の当たり方が変わり、絵が数画素ぴくぴく動く。
   * 画素ごとに、前のコマで読んだ位置（円の上の座標 pu, pv。ok が 1 の所だけ）へ寄せる。a は新しい位置の割合。
   * このコマで読んだ位置は nu, nv に書き、書いた所は set を 1 にする。
   */
  ease?: { pu: F32; pv: F32; ok: Uint8Array; nu: F32; nv: F32; set: Uint8Array; a: number };
  /** 各画素の、ブロブの縁までの距離 */
  dt: F32;
  /** 使い回し。格子は解像度ごと、写像は方式ごと */
  grids: Record<string, Grid[]>;
  maps: Record<string, { mix: number; list: BlobMap[] }>;
}

/** 放射方式が使う極座標の表。重心まわり360方向 */
export interface Shape {
  cx: number; cy: number;
  Rbox: F32; Renv: F32;
  start: Int32Array;
  rads: Int16Array;
}

export interface Face { cx: number; cy: number; roll: number; R: ArrayLike<number> }

export interface Inv { N: number; tx: F32; ty: F32; empty: boolean; mix: string }

export interface Mesh {
  g: Grid;
  vx: F32; vy: F32; spr: F32;
  quads: Int32Array;
  cx: number; cy: number; rmax: number; area: number;
}

export interface Raster { w: number; h: number; data: Pixels }

/** 素材1つ。アルファが切り抜きのマスク。後ろの任意項目は使い回し */
export interface Source extends Raster {
  shape?: Shape;
  face?: Face;
  grids?: Record<string, Grid>;
  inv?: Record<string, Inv>;
  mesh?: Mesh;
  en?: F32;
}

/** ブロブの縦横比を受けて、それ用に縮めた版を返す包み */
export interface Picker { pick(aspect: number): Source }
export type SourceLike = Source | Picker;

export interface CarveOptions {
  /** 0〜0.9。シルエットの幅と高さから抜く割合 */
  amount: number;
  /** 合わせたい縦横比（幅÷高さ）。0 か省略で指定なし */
  aspect?: number;
  /** 0〜1。肌色の抜かれにくさ */
  protect: number;
  /** 筋を決めるときの長辺の画素数。省くと試作と同じ 144。上げると輪郭の段々が細かくなり、遅くなる */
  res?: number;
  /** 筋を抜いた跡の階段をならす半径（升の数）。0 か省略で試作と同じ */
  soften?: number;
  /** ならす飛びの上限（升の数）。隣の升との読む位置の差がこれを超える所は、ならさない。省くと 14 */
  softenLimit?: number;
}

export interface FitOptions {
  method: Method;
  ang: number; flip: number; spin: number;
  dist: number; tint: number; squeeze: number; mix: number; imp: number;
  smooth: boolean;
  trim?: boolean;
}
