// 実在の迷彩の「作り方」をまねた柄の生成器。実物の版を写したものではなく、構造を手続きで再現した近似。
// 色も実物の近似値。経緯と出典は docs/RESEARCH.md の「迷彩の柄」。
//
// どの生成器も「1画素がどの色の層か」を返す。座標は u = x ÷ ブロブの大きさ。u が 1 進むと、だいたい大きな斑1つぶん。
import { Kao } from './kao.ts';
import type { LayerFn } from './types.ts';

const { hash2, vnoise } = Kao;

export interface Pattern {
  id: string;
  name: string;
  kind: '実物' | '軍用' | '狩猟' | 'その他';
  /** どこの何をまねたか、どう作っているか */
  note: string;
  /** 層の番号順の色 */
  colors: string[];
  /** この割合（キャンバス面積比）より小さいブロブには素材を入れない。点や画素の粒を色のまま残す */
  flatBelow: number;
  /** 素材を入れない層。タイルのすき間など */
  flatLayers?: number[];
  /** 大きいブロブを割らない。形をそのまま使いたい柄 */
  noSplit?: boolean;
  make(seed: number, size: number): LayerFn;
}

/** 値ノイズを oct 段重ねる。0〜1、平均 0.5 */
function fbm(x: number, y: number, s: number, oct: number): number {
  let a = 0, amp = 1, tot = 0;
  for (let o = 0; o < oct; o++) { a += amp * vnoise(x, y, s + o * 13); tot += amp; x = x * 2 + 17.1; y = y * 2 + 9.3; amp *= 0.5; }
  return a / tot;
}

/** ばらまいた円のどれかに入っているか。cell = 升の大きさ、density = 升に円がある確率、半径は升に対する割合 */
function inDots(u: number, v: number, cell: number, s: number, density: number, rmin: number, rmax: number): boolean {
  const gx = u / cell, gy = v / cell, cx = Math.floor(gx), cy = Math.floor(gy);
  for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
    const ix = cx + ox, iy = cy + oy;
    if (hash2(ix, iy, s) > density) continue;
    const px = ix + hash2(ix, iy, s + 1), py = iy + hash2(ix, iy, s + 2), r = rmin + (rmax - rmin) * hash2(ix, iy, s + 3);
    if ((px - gx) * (px - gx) + (py - gy) * (py - gy) < r * r) return true;
  }
  return false;
}

/** いちばん近い点の升を返す（ボロノイ）。辺がまっすぐな多角形になる。戻り値は升の番号2つを1つにまとめた数 */
function voronoi(u: number, v: number, s: number): number {
  const cx = Math.floor(u), cy = Math.floor(v);
  let best = 1e9, id = 0;
  for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
    const ix = cx + ox, iy = cy + oy, px = ix + hash2(ix, iy, s), py = iy + hash2(ix, iy, s + 1);
    const d = (px - u) * (px - u) + (py - v) * (py - v);
    if (d < best) { best = d; id = ix * 7919 + iy * 104729; }
  }
  return id;
}

/** 重みつきの抽選。r は 0〜1 */
function weighted(r: number, w: number[]): number {
  let t = 0; for (const x of w) t += x;
  let a = r * t;
  for (let k = 0; k < w.length; k++) { a -= w[k]; if (a < 0) return k; }
  return w.length - 1;
}

// ---- 生成器 ----

/** 有機的な大きい斑を重ねる。M81 ウッドランド系。黒は枝のように細く伸びる */
function woodland(seed: number, size: number): LayerFn {
  return (_nx, _ny, wx, wy) => {
    const u = wx / size / 1.6, v = wy / size; // 横に1.6倍のばす。ERDL を6割大きくした M81 の、横に流れる斑
    let L = 0;
    if (fbm(u + 31.7, v + 17.3, seed + 1, 3) > 0.47) L = 1; // 濃緑。広い
    if (fbm(u * 1.1 + 63.4, v * 1.1 + 34.6, seed + 2, 3) > 0.53) L = 2; // 茶。広い。明るい緑の地は少しだけ残る
    const ridge = Math.abs(fbm(u * 1.1 + 5.5, v * 1.1 + 8.1, seed + 4, 3) - 0.5); // 0 に近い所が等高線＝枝
    if (fbm(u * 1.5 + 95.1, v * 1.5 + 51.9, seed + 3, 3) > 0.585 || (ridge < 0.012 && vnoise(u * 0.8, v * 0.8, seed + 5) > 0.45)) L = 3;
    return L;
  };
}

/** 刷毛で払ったような、流れて渦を巻く斑。英国 DPM 系 */
function brush(seed: number, size: number): LayerFn {
  return (_nx, _ny, wx, wy) => {
    const u0 = wx / size, v0 = wy / size;
    // 流れの向きをゆっくり変える。刷毛の筋は流れに沿って長く、直角方向に細い
    const a = (vnoise(u0 * 0.3, v0 * 0.3, seed + 9) - 0.5) * 1.6, ca = Math.cos(a), sa = Math.sin(a);
    const u = (u0 * ca + v0 * sa) * 0.7, v = (-u0 * sa + v0 * ca) * 1.25;
    let L = 0;
    if (fbm(u + 31.7, v + 17.3, seed + 1, 3) > 0.5) L = 1;
    if (fbm(u + 63.4, v + 34.6, seed + 2, 3) > 0.55) L = 2;
    if (fbm(u * 0.9 + 95.1, v * 1.9 + 51.9, seed + 3, 3) > 0.6) L = 3;
    return L;
  };
}

/**
 * 点の群れ。フレックターン系。
 * まず色ごとのなだらかな場で「この辺は何色」を決める。その上に大小の点をまき、
 * 点は自分の中心から少しずれた場所の色を持ってくる。境目で点が互いの領域に食い込み、遠目に色が混ざって見える。
 */
function fleck(bias: number[], dot: number): (seed: number, size: number) => LayerFn {
  return (seed, size) => {
    const region = (u: number, v: number): number => {
      let best = -1e9, k = 0;
      for (let c = 0; c < bias.length; c++) { const f = fbm(u * 0.9 + c * 31.7, v * 0.9 + c * 17.3, seed + c, 2) + bias[c]; if (f > best) { best = f; k = c; } }
      return k;
    };
    const dotAt = (u: number, v: number, cell: number, s: number, reach: number): number => {
      const gx = u / cell, gy = v / cell, cx = Math.floor(gx), cy = Math.floor(gy);
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const ix = cx + ox, iy = cy + oy;
        if (hash2(ix, iy, s) > 0.92) continue;
        const px = ix + hash2(ix, iy, s + 1), py = iy + hash2(ix, iy, s + 2), r = 0.22 + 0.3 * hash2(ix, iy, s + 3);
        // 点を少しいびつにする
        const dx = px - gx, dy = py - gy, wob = 1 + 0.35 * (vnoise(gx * 3, gy * 3, s + 4) - 0.5);
        if (dx * dx + dy * dy < r * r * wob) {
          const t = hash2(ix, iy, s + 5) * 6.283, d = reach * hash2(ix, iy, s + 6);
          return region(px * cell + Math.cos(t) * d, py * cell + Math.sin(t) * d);
        }
      }
      return -1;
    };
    return (nx, ny) => {
      const u = nx / size, v = ny / size; // うねりをかけない。点は丸いまま
      let L = dotAt(u, v, dot, seed + 40, 0.7);
      if (L < 0) L = dotAt(u, v, dot * 2.3, seed + 50, 0.9);
      return L < 0 ? region(u, v) : L;
    };
  };
}

// 重ねる順は特許のとおり：カーキの地 → 緑 → コヨーテ茶 → 黒。しきい値は面積比が 5／30／47／18％ になるよう測って決めた
const DIGITAL_THR = [0, 0.335, 0.445, 0.678];

/** 画素の升目。大きい斑（マクロ）に、升1つぶんの細かい乱れ（ミクロ）を足す。CADPAT／MARPAT 系 */
function digital(seed: number, size: number): LayerFn {
  const px = size / 11;
  return (nx, ny) => {
    const qx = Math.floor(nx / px), qy = Math.floor(ny / px), u = (qx + 0.5) * px / size / 1.3, v = (qy + 0.5) * px / size;
    let L = 0;
    for (let k = 1; k < 4; k++) {
      const macro = fbm(u * (0.8 + k * 0.15) + k * 31.7, v * (0.8 + k * 0.15) + k * 17.3, seed + k, 2);
      const micro = fbm(qx * 0.6 + k * 7.7, qy * 0.6 + k * 3.1, seed + 20 + k, 2) - 0.5 + (hash2(qx, qy, seed + 30 + k) - 0.5) * 0.25;
      if (macro + micro * 0.42 > DIGITAL_THR[k]) L = k;
    }
    return L;
  };
}

/** 画素の升目で、大きい形の縁だけを点描でぼかす。大小2段の柄。Optifade 系 */
function macroMicro(seed: number, size: number): LayerFn {
  const px = size / 14;
  return (nx, ny) => {
    const qx = Math.floor(nx / px), qy = Math.floor(ny / px), u = (qx + 0.5) * px / size, v = (qy + 0.5) * px / size;
    const f = fbm(u * 0.55, v * 0.55, seed + 1, 2) + (hash2(qx, qy, seed + 7) - 0.5) * 0.09 + (fbm(qx * 0.3, qy * 0.3, seed + 8, 2) - 0.5) * 0.16;
    return f < 0.44 ? 0 : f < 0.52 ? 1 : f < 0.6 ? 2 : 3;
  };
}

/** 粗い升目の、階段状の葉の群れ。ソ連 KLMK「ベリョースカ」系。2色 */
function stepped(seed: number, size: number): LayerFn {
  const px = size / 7;
  return (nx, ny) => {
    const qx = Math.floor(nx / px), qy = Math.floor(ny / px), u = (qx + 0.5) * px / size, v = (qy + 0.5) * px / size;
    return fbm(u * 1.1, v * 1.1, seed + 1, 2) + (hash2(qx, qy, seed + 3) - 0.5) * 0.14 > 0.54 ? 1 : 0;
  };
}

/** 横に走って噛み合う縞。タイガーストライプ系。縞は先が細くなって途切れる */
function tiger(seed: number, size: number): LayerFn {
  return (_nx, _ny, wx, wy) => {
    const u = wx / size, v = wy / size;
    let L = 0;
    if (fbm(u * 0.35 + 31.7, v * 1.2 + 17.3, seed + 1, 2) > 0.5) L = 1;
    const p2 = v * 1.3 + (fbm(u * 0.4 + 9, v * 0.5 + 4, seed + 6, 2) - 0.5) * 4;
    if (Math.sin(p2 * 6.283) > 0.72 + (vnoise(u * 0.7, v * 0.7, seed + 7) - 0.5) * 0.9) L = 2;
    const p = v * 1.6 + (fbm(u * 0.45, v * 0.6, seed + 2, 2) - 0.5) * 4.5;
    if (Math.sin(p * 6.283) > 0.1 + (vnoise(u * 0.6 + 50, v * 0.9 + 50, seed + 3) - 0.5) * 1.5) L = 3;
    return L;
  };
}

/** 辺がまっすぐな多角形。スプリッター系（独 Splittertarn、瑞 M90）。同じ色の隣どうしはつながって大きな角ばった面になる */
function splinter(weights: number[]): (seed: number, size: number) => LayerFn {
  return (seed, size) => (nx, ny) => {
    const id = voronoi(nx / size / 0.75, ny / size / 0.45, seed + 1); // 横長の多角形
    return weighted(hash2(id, 3, seed + 2), weights);
  };
}

/** 地を広く残した多角形に、短い縦線の「雨」を所々に重ねる。独 Splittermuster 31 系 */
function splitter31(seed: number, size: number): LayerFn {
  return (nx, ny) => {
    const u = nx / size, v = ny / size;
    // 雨：幅 0.07、高さ 0.42 の升に、少し傾いた細い線を1本。ゆるいノイズで雨の降る場所を選ぶ
    if (vnoise(u * 0.7 + 3, v * 0.7 + 3, seed + 20) > 0.52) {
      const cx = Math.floor(u / 0.07), row = v / 0.42 + hash2(cx, 0, seed + 21), cy = Math.floor(row), t = row - cy;
      const len = 0.45 + 0.45 * hash2(cx, cy, seed + 22), x = (cx + 0.3 + 0.4 * hash2(cx, cy, seed + 23)) * 0.07 + (t - 0.5) * 0.02;
      if (t < len && Math.abs(u - x) < 0.008) return 3;
    }
    const id = voronoi(u / 0.8, v / 0.5, seed + 1);
    return weighted(hash2(id, 3, seed + 2), [46, 27, 27]);
  };
}

/** 丸い斑を大小重ねる。フロッグスキン／ダックハンター系 */
function spots(seed: number, size: number): LayerFn {
  return (_nx, _ny, wx, wy) => {
    const u = wx / size + (vnoise(wx / size * 2.5, wy / size * 2.5, seed + 30) - 0.5) * 0.12, v = wy / size + (vnoise(wx / size * 2.5 + 9, wy / size * 2.5 + 9, seed + 31) - 0.5) * 0.12;
    let L = 0;
    if (inDots(u, v, 0.95, seed + 1, 0.75, 0.3, 0.62)) L = 1;
    if (inDots(u, v, 0.7, seed + 5, 0.6, 0.25, 0.5)) L = 2;
    if (inDots(u, v, 0.5, seed + 9, 0.5, 0.2, 0.42)) L = 3;
    if (inDots(u, v, 0.3, seed + 13, 0.4, 0.18, 0.36)) L = 4;
    return L;
  };
}

/** 広い波の帯に、黒い小石と白い影。6色デザート（チョコチップ）系 */
function chocolateChip(seed: number, size: number): LayerFn {
  return (_nx, _ny, wx, wy) => {
    const u = wx / size, v = wy / size, f = fbm(u * 0.4, v * 1.0, seed + 1, 2);
    if (inDots(u, v, 0.34, seed + 5, 0.4, 0.1, 0.24)) return 4;
    if (inDots(u + 0.035, v + 0.035, 0.34, seed + 5, 0.4, 0.1, 0.24)) return 5; // 同じ小石を少しずらすと、片側に白い三日月が残る
    return f < 0.43 ? 0 : f < 0.5 ? 1 : f < 0.575 ? 2 : 3;
  };
}

/**
 * 色を段階的に変える地に、小さい形を散らす。MultiCam 系。
 * 実物は網点のグラデーション。ここは層が飛び飛びなので、明るさの近い色を3段並べて代わりにする。
 */
function gradient(seed: number, size: number): LayerFn {
  return (_nx, _ny, wx, wy) => {
    const u = wx / size / 1.3, v = wy / size;
    if (fbm(u * 2.2 + 70, v * 3.2 + 70, seed + 5, 2) > 0.66) return 6; // 茶の小片
    if (fbm(u * 1.8 + 40, v * 2.8 + 40, seed + 4, 2) > 0.655) return 5; // 焦げ茶の小片
    const g = fbm(u * 0.7 + 31.7, v * 0.7 + 17.3, seed + 2, 3);
    if (g > 0.5) return g > 0.6 ? 4 : g > 0.545 ? 3 : 2; // 緑のグラデーション：ライム→オリーブ→深緑
    return fbm(u * 0.5, v * 0.6, seed + 1, 2) > 0.5 ? 1 : 0; // 地のグラデーション：クリーム→タン
  };
}

/** まっすぐな縞で形を断ち切る。第一次大戦の艦船のダズル迷彩。区画ごとに縞の向きと幅と色が変わる */
function dazzle(seed: number, size: number): LayerFn {
  return (nx, ny) => {
    const id = voronoi(nx / size / 1.5, ny / size / 1.5, seed + 1);
    const a = hash2(id, 1, seed + 2) * 3.1416, period = 0.28 + 0.5 * hash2(id, 2, seed + 3);
    const t = (nx * Math.cos(a) + ny * Math.sin(a)) / size / period + hash2(id, 5, seed + 6);
    const c1 = Math.floor(hash2(id, 3, seed + 4) * 4), c2 = (c1 + 1 + Math.floor(hash2(id, 4, seed + 5) * 3)) % 4;
    return (Math.floor(t) & 1) ? c1 : c2;
  };
}

/** 明るい地に、縦に流れる曲がった筋。ASAT 系。「物と物のあいだの何もない所」に見せる、輪郭を割るための柄 */
function branches(seed: number, size: number): LayerFn {
  return (_nx, _ny, wx, wy) => {
    const u = wx / size, v = wy / size;
    // ノイズの等高線は必ず閉じた輪になる。線が地を囲んで、ブロブを作る
    // 横に細かく縦にゆるいノイズ。等高線が縦に長く流れる
    const w = 0.012 + 0.03 * vnoise(u * 1.3, v * 0.6, seed + 3);
    if (Math.abs(fbm(u * 1.5, v * 0.5, seed + 1, 3) - 0.5) < w) return 2;
    return Math.abs(fbm(u * 1.3 + 40, v * 0.45 + 40, seed + 2, 3) - 0.47) < w * 1.3 ? 1 : 0;
  };
}

/** 角の丸い正方形を升目に並べる。迷彩ではない。押し込み方を素直な形で見るための見本。層0がすき間、1〜3がタイルの色 */
function tiles(seed: number, size: number): LayerFn {
  const gap = 0.06, round = 0.2; // タイル1枚に対する割合
  return (nx, ny) => {
    const u = nx / size, v = ny / size, cx = Math.floor(u), cy = Math.floor(v);
    const half = 0.5 - gap / 2, r = round * (1 - gap), dx = Math.abs(u - cx - 0.5), dy = Math.abs(v - cy - 0.5);
    if (dx > half || dy > half) return 0;
    const qx = dx - (half - r), qy = dy - (half - r);
    if (qx > 0 && qy > 0 && qx * qx + qy * qy > r * r) return 0; // 角を丸く落とす
    return 1 + Math.floor(hash2(cx, cy, seed) * 3);
  };
}

export const PATTERNS: Pattern[] = [
  { id: 'blob', name: 'Anyflage 標準', kind: 'その他', flatBelow: 0, colors: ['#C2B280', '#4B5D2A', '#5A4028', '#1C1F18'],
    note: '試作からの柄。値ノイズを3層、しきい値で重ねる。どの実物もまねていない。',
    make: () => { throw new Error('標準の柄は kao.ts の中で作る'); } },
  { id: 'tiles', name: '角丸の正方形タイル', kind: 'その他', flatBelow: 0, flatLayers: [0], noSplit: true, colors: ['#14170F', '#C2B280', '#4B5D2A', '#5A4028'],
    note: '迷彩ではない。角の丸い正方形を升目に並べる。押し込み方を素直な形で比べるための見本。すき間には素材を入れない。「ブロブの大きさ」がタイル1枚の大きさ。',
    make: tiles },
  { id: 'woodland', name: 'ウッドランド（米 M81 系）', kind: '軍用', flatBelow: 0.0012, colors: ['#A9A67C', '#4A5A3A', '#5F4B37', '#1F1F1B'],
    note: '1981年。茶が多いほうの ERDL を6割拡大した4色。明るい緑に染めた地へ、濃緑・茶・黒を重ねて刷る。縁はくっきり、ぼかしなし。黒は枝のように細く伸びる。', make: woodland },
  { id: 'dpm', name: 'ブラッシュストローク（英 DPM 系）', kind: '軍用', flatBelow: 0.0012, colors: ['#B7A06B', '#56653B', '#6A4930', '#1E1E1A'],
    note: '1960年代。刷毛で払ったような、流れて渦を巻く4色の斑。流れの向きに沿って細長くのばしたノイズで作る。', make: brush },
  { id: 'flecktarn', name: 'フレックターン（独）', kind: '軍用', flatBelow: 0.0025, colors: ['#8E9566', '#6F7550', '#35472F', '#6B4636', '#1B1D19'],
    note: '1976年の試験を経て1990年に採用。5色の点の群れ。公式の配分は明緑15・明オリーブ20・暗緑35・茶20・黒10。点が隣の色の領域に食い込み、遠目に色が混ざる。',
    make: fleck([-0.004, 0.02, 0.105, -0.012, -0.036], 0.16) },
  { id: 'jgsdf', name: '陸自迷彩2型系', kind: '軍用', flatBelow: 0.0025, colors: ['#B5A887', '#7A8650', '#5E4631', '#1D1E1A'],
    note: 'カーキの地に草緑・茶・黒の点。4色。日本の山野の風景を計算機で処理して点にした、とされる。3型も生地の柄は同じ。ここでは点を細かめにした。',
    make: fleck([0.03, 0.04, 0.0, -0.04], 0.12) },
  { id: 'digital', name: 'デジタル（CADPAT／MARPAT 系）', kind: '軍用', flatBelow: 0.0025, colors: ['#8C8266', '#3F4A38', '#5E4F40', '#262527'],
    note: '1997〜2002年。画素の升目で、大きい斑（マクロ）と細かい乱れ（ミクロ）の2段を作る。MARPAT の特許に合わせ、カーキの地に緑・コヨーテ茶・黒の順で重ね、面積比を 5／30／47／18％ にした。升目そのものに隠す効果はなく、設計と印刷が楽になるだけとされる。', make: digital },
  { id: 'berezka', name: 'ベリョースカ（ソ連 KLMK 系）', kind: '軍用', flatBelow: 0.0012, colors: ['#566B38', '#B9C08A'],
    note: '1968年ごろ。オリーブの地に、縁が階段状の明るい葉形の斑。2色。デジタル迷彩の遠い先祖。粗い升目でノイズを切る。', make: stepped },
  { id: 'tiger', name: 'タイガーストライプ（南ベトナム系）', kind: '軍用', flatBelow: 0.0012, colors: ['#8B8B5E', '#55623B', '#5A4631', '#17181A'],
    note: '1960年代。仏のリザード迷彩が元。横に走って噛み合う黒い縞。うねらせた位相に sin をかけ、太さを場所で変えて縞を途切れさせる。', make: tiger },
  { id: 'splitter31', name: 'スプリッター（独 1931 系）', kind: '軍用', flatBelow: 0.0008, colors: ['#A39A7C', '#6B4B34', '#4F6240', '#2C3A2A'],
    note: '1931年。灰ベージュの地に茶と緑の角ばった多角形、最後に暗緑の「雨」の線を部分的に重ねる。多角形はボロノイ分割、雨は場所を選んで並べた短い縦線。',
    make: splitter31 },
  { id: 'm90', name: 'スプリッター（瑞 M90 系）', kind: '軍用', flatBelow: 0.0008, colors: ['#73804E', '#3E5236', '#B3A77C', '#26303A'],
    note: '1990年。4色の多角形がすき間なく接する。雨の線はない。ボロノイ分割の升に色を割り当て、同じ色の隣どうしをつなぐ。',
    make: splinter([30, 34, 18, 18]) },
  { id: 'frog', name: 'フロッグスキン（米 1942 系）', kind: '軍用', flatBelow: 0.0012, colors: ['#C3B089', '#8E9562', '#566238', '#7A5A3C', '#3D3226'],
    note: '1942年。米軍初の量産迷彩で、のちにダックハンターとして狩猟にも広まった。丸い斑を大小5色重ねる。', make: spots },
  { id: 'chocchip', name: 'チョコチップ（米 6色デザート系）', kind: '軍用', flatBelow: 0.0006, colors: ['#D9CBA6', '#C2A878', '#9D7C56', '#6C4B35', '#1E1A17', '#EFE8D6'],
    note: '1980年代。広い波の帯4色に、黒い小石と白い影。岩の多い砂漠を想定した。', make: chocolateChip },
  { id: 'multi', name: 'グラデーション（MultiCam 系）', kind: '軍用', flatBelow: 0.0012, colors: ['#CFC3A1', '#A8956E', '#A3A878', '#6D7650', '#4B573C', '#45382C', '#7A6548'],
    note: '2002年。7色。タンから茶へのグラデーションに緑のグラデーションを重ね、焦げ茶とクリームの小片を散らす。対比より「なじませる」考え方。ここでは色を3段に刻んで近似。', make: gradient },
  { id: 'dazzle', name: 'ダズル（第一次大戦の艦船）', kind: 'その他', flatBelow: 0.0006, colors: ['#E8E8E2', '#1A1D22', '#7C8C99', '#2F4A66'],
    note: '1917年。隠すのではなく、まっすぐな縞で形・向き・速さを読ませない。区画ごとに縞の向きと幅を変える。', make: dazzle },
  { id: 'asat', name: '縦の筋（狩猟 ASAT 系）', kind: '狩猟', flatBelow: 0.0012, colors: ['#C9B48A', '#7A5A3C', '#1E1A17'],
    note: '1986年。3色。明るい砂色の地に、中間の茶と黒の、縦に流れる曲がった筋。緑なし。木や葉をまねず、明暗の差で輪郭を割る。ノイズの等高線を筋にする。', make: branches },
  { id: 'optifade', name: '大小2段のデジタル（狩猟 Optifade 系）', kind: '狩猟', flatBelow: 0.0025, colors: ['#CBC3AE', '#989380', '#646052', '#3B3930'],
    note: '2000年代。鹿の目（細部が見えにくく、動きに敏感）に合わせた設計とされる。大きい形で輪郭を割り、縁を画素の点描でぼかす。森の緑や茶を使わない。', make: macroMicro },
  { id: 'blaze', name: 'ブレイズオレンジ（狩猟の安全色）', kind: '狩猟', flatBelow: 0.0012, colors: ['#FF7900', '#C4500F', '#FFA640', '#1B1B1B'],
    note: '人にははっきり見え、赤と緑を見分けにくい鹿には目立ちにくい、という考えの安全色迷彩。柄はウッドランドと同じ作り。', make: woodland },
];

/** 実物の見本から起こした層のタイル。scripts/build-swatches.ts が作る */
export interface Swatch {
  id: string; name: string; note: string;
  w: number; h: number;
  /** 見本の横幅が、ブロブの大きさ何個ぶんか */
  span: number;
  colors: string[];
  source: { title: string; page: string; license: string; author: string };
  /** 画素ごとの層の番号。w × h */
  labels: Uint8Array;
}

/**
 * 見本のタイルをそのまま柄にする。形は実物と同じ。
 * 見本より広い範囲は、半タイルずらした2枚を継いで埋める。シードで読む位置をずらす。
 * 拡大しても縁が階段にならないよう、層ごとに「その層である度合い」をぼかした面を作り、
 * 面をなめらかに読んで、いちばん度合いの高い層を返す。ブロブを大きくしても輪郭が曲線になる。
 */
function softFields(sw: Swatch): Float32Array[] {
  const { w, h, labels } = sw, K = sw.colors.length, R = 3, ker: number[] = [];
  let sum = 0; for (let i = -R; i <= R; i++) { const v = Math.exp(-i * i / (2 * 1.1 * 1.1)); ker.push(v); sum += v; }
  const out: Float32Array[] = [], tmp = new Float32Array(w * h);
  for (let k = 0; k < K; k++) {
    const f = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let a = 0; for (let i = -R; i <= R; i++) { const xx = Math.min(w - 1, Math.max(0, x + i)); if (labels[y * w + xx] === k) a += ker[i + R]; }
      tmp[y * w + x] = a / sum;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let a = 0; for (let i = -R; i <= R; i++) { const yy = Math.min(h - 1, Math.max(0, y + i)); a += tmp[yy * w + x] * ker[i + R]; }
      f[y * w + x] = a / sum;
    }
    out.push(f);
  }
  return out;
}
const fieldCache = new WeakMap<Swatch, Float32Array[]>();
export function swatchPattern(sw: Swatch): Pattern {
  const K = sw.colors.length, grainy = K >= 4 && /emr|flecktarn|jgsdf/.test(sw.id);
  return {
    id: `sw-${sw.id}`, name: sw.name, kind: '実物', colors: sw.colors, flatBelow: grainy ? 0.0025 : 0.0012,
    note: `${sw.note} 形は見本画像を色で分けたもの。出典：${sw.source.title}（${sw.source.author}、${sw.source.license}）。「輪郭のうねり」は効かない。`,
    make: (seed, size) => {
      const { w, h } = sw, scale = w / sw.span / size, ox = hash2(seed, 1, 7) * w, oy = hash2(seed, 2, 7) * h;
      let fields = fieldCache.get(sw); if (!fields) { fields = softFields(sw); fieldCache.set(sw, fields); }
      const F = fields;
      const mod = (t: number, n: number): number => ((t % n) + n) % n;
      return (nx, ny) => {
        // 見本は柄の一部分の切り抜きで、そのまま並べると端に段差が出る。
        // 半タイルずらした2枚を用意し、各画素で「自分のタイルの端から遠いほう」を使う。境目はノイズで揺らして直線にしない
        const tx = nx * scale + ox, ty = ny * scale + oy;
        let x = mod(tx, w), y = mod(ty, h);
        const xb = mod(tx + w / 2, w), yb = mod(ty + h / 2, h);
        const wa = Math.min(Math.min(x, w - x) / w, Math.min(y, h - y) / h), wb = Math.min(Math.min(xb, w - xb) / w, Math.min(yb, h - yb) / h);
        if (wa + (vnoise(tx / w * 7, ty / h * 7, seed + 9) - 0.5) * 0.16 < wb) { x = xb; y = yb; }
        x -= 0.5; y -= 0.5;
        const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y)), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1), fx = Math.min(1, Math.max(0, x - x0)), fy = Math.min(1, Math.max(0, y - y0));
        // 3次の重み（smoothstep）で読む。升目の境で輪郭が折れない
        const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), i00 = y0 * w + x0, i01 = y0 * w + x1, i10 = y1 * w + x0, i11 = y1 * w + x1;
        const w00 = (1 - sx) * (1 - sy), w01 = sx * (1 - sy), w10 = (1 - sx) * sy, w11 = sx * sy;
        let best = 0, bv = -1;
        for (let k = 0; k < K; k++) { const f = F[k], v = f[i00] * w00 + f[i01] * w01 + f[i10] * w10 + f[i11] * w11; if (v > bv) { bv = v; best = k; } }
        return best;
      };
    },
  };
}

export function patternById(id: string): Pattern { return PATTERNS.find((p) => p.id === id) || PATTERNS[0]; }
