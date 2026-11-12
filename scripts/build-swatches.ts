// 実物の見本画像（samples/_raw/swatches）を色で分け、層の番号のタイルに起こす。
// 出力：public/swatches/<id>.png（画素値 = 層の番号 × 40 のグレースケール）と public/swatches/index.json。
// 手順：縮小 → （写真は）明るさのむらを取る → k-means で K 色に分ける → 多数決フィルタで粒を消す → 明るい順に層の番号を振る。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pngjs from 'pngjs';
import jpeg from 'jpeg-js';
import { RAW, ROOT } from './lib.ts';

const { PNG } = pngjs;
const SRC = join(RAW, 'swatches'), OUT = join(ROOT, 'public', 'swatches');
const PREVIEW = process.argv[2]; // 指定すると、元と結果を並べた確認用の画像をそこへ書く

interface Job {
  id: string; file: string; name: string;
  /** 色の数 */
  k: number;
  /** 切り出す範囲 [x0, y0, x1, y1]、0〜1 */
  crop?: [number, number, number, number];
  /** 布の写真。明るさのむら（しわ、照明）を取ってから色を分ける */
  photo?: boolean;
  /** 多数決フィルタの回数。粒や織り目を消す */
  clean: number;
  /** 見本の横幅が、ブロブの大きさ何個ぶんか。小さいほど柄が大きく出る */
  span: number;
  note: string;
}
const JOBS: Job[] = [
  { id: 'm81', file: 'm81.png', name: 'M81 ウッドランド（実物の形）', k: 4, clean: 1, span: 3.5, note: '米陸軍の見本。1981年。茶が多いほうの ERDL を6割拡大した4色。' },
  { id: 'erdl-green', file: 'erdl-green.png', name: 'ERDL 緑優勢（実物の形）', k: 4, clean: 1, span: 3, note: '米陸軍 ERDL の「低地」版。1948年設計、1967年からベトナムで支給。M81 の元。' },
  { id: 'erdl-brown', file: 'erdl-brown.png', name: 'ERDL 茶優勢（実物の形）', k: 4, clean: 1, span: 3, note: '米陸軍 ERDL の「高地」版。これを6割拡大したのが M81。' },
  { id: 'lizard', file: 'lizard.png', name: 'リザード（仏、実物の形）', k: 3, clean: 1, span: 3.5, note: '仏 1950年代。緑と茶の刷毛の縞を、地を広く残して重ねる。タイガーストライプの元。' },
  { id: 'emr', file: 'emr.png', name: 'EMR デジタルフローラ（露、実物の形）', k: 4, clean: 0, span: 2.5, note: 'ロシア 2008年。淡い緑の地に黒・茶・濃緑の升目。' },
  { id: 'dpm', file: 'dpm.jpg', name: 'DPM（英、実物の形）', k: 4, photo: true, clean: 2, span: 4, note: '英 Combat 95。砂色の地に緑・茶・黒の刷毛の跡。布の写真から起こした。' },
  { id: 'flecktarn', file: 'flecktarn.jpg', name: 'フレックターン（独、実物の形）', k: 5, photo: true, crop: [0.1, 0.1, 0.9, 0.9], clean: 1, span: 3, note: '独 1990年採用。5色の点の群れ。布の写真から起こした。' },
  { id: 'splitter31', file: 'splitter31.jpg', name: 'スプリッター31（独、実物の形）', k: 4, photo: true, clean: 1, span: 4, note: '独 1931年。角ばった多角形と「雨」の線。布のスキャンから起こした。' },
  { id: 'klmk', file: 'klmk.jpg', name: 'ベリョースカ KLMK（ソ連、実物の形）', k: 2, photo: true, clean: 2, span: 3.5, note: 'ソ連 1968年ごろ。縁が階段状の葉形の斑。布の写真から起こした。' },
  { id: 'frogskin', file: 'frogskin.jpg', name: 'フロッグスキン（米、実物の形）', k: 5, photo: true, clean: 2, span: 3, note: '米 1942年。丸い斑5色。布の写真から起こした。' },
  { id: 'jgsdf2', file: 'jgsdf2.jpg', name: '陸自迷彩2型（実物の形）', k: 4, photo: true, crop: [0.12, 0.1, 1, 1], clean: 1, span: 3, note: '陸上自衛隊。カーキの地に草緑・茶・黒の点。布の写真から起こした。' },
];

interface Img { w: number; h: number; d: Float32Array } // RGB、0〜255

function load(file: string): Img {
  const buf = readFileSync(join(SRC, file));
  const im = file.endsWith('.png') ? PNG.sync.read(buf) : jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 1024 });
  const d = new Float32Array(im.width * im.height * 3);
  for (let i = 0; i < im.width * im.height; i++) { // 透明は白の上に置く
    const a = im.data[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) d[i * 3 + c] = im.data[i * 4 + c] * a + 255 * (1 - a);
  }
  return { w: im.width, h: im.height, d };
}
/** 範囲を切り出し、幅 tw に面積平均で縮める */
function shrink(im: Img, crop: [number, number, number, number], tw: number): Img {
  const x0 = Math.round(crop[0] * im.w), y0 = Math.round(crop[1] * im.h), cw = Math.round((crop[2] - crop[0]) * im.w), ch = Math.round((crop[3] - crop[1]) * im.h);
  const w = Math.min(tw, cw), h = Math.round(ch * w / cw), d = new Float32Array(w * h * 3), n = new Float32Array(w * h);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const o = Math.min(h - 1, Math.floor(y * h / ch)) * w + Math.min(w - 1, Math.floor(x * w / cw)), s = ((y0 + y) * im.w + x0 + x) * 3;
    d[o * 3] += im.d[s]; d[o * 3 + 1] += im.d[s + 1]; d[o * 3 + 2] += im.d[s + 2]; n[o]++;
  }
  for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) d[i * 3 + c] /= n[i] || 1;
  return { w, h, d };
}
/** 箱ぼかし（横→縦）。1チャンネル */
function boxBlur(a: Float32Array, w: number, h: number, r: number): Float32Array {
  const t = new Float32Array(w * h), o = new Float32Array(w * h);
  for (let y = 0; y < h; y++) { let s = 0, c = 0; for (let x = -r; x < w; x++) { if (x + r < w) { s += a[y * w + x + r]; c++; } if (x - r - 1 >= 0) { s -= a[y * w + x - r - 1]; c--; } if (x >= 0) t[y * w + x] = s / c; } }
  for (let x = 0; x < w; x++) { let s = 0, c = 0; for (let y = -r; y < h; y++) { if (y + r < h) { s += t[(y + r) * w + x]; c++; } if (y - r - 1 >= 0) { s -= t[(y - r - 1) * w + x]; c--; } if (y >= 0) o[y * w + x] = s / c; } }
  return o;
}
/** 明るさのむらを取る。広くぼかした明るさで割り、全体の平均に戻す */
function flatten(im: Img): void {
  const n = im.w * im.h, lum = new Float32Array(n); let mean = 0;
  for (let i = 0; i < n; i++) { lum[i] = 0.299 * im.d[i * 3] + 0.587 * im.d[i * 3 + 1] + 0.114 * im.d[i * 3 + 2]; mean += lum[i]; }
  mean /= n;
  const wide = boxBlur(boxBlur(lum, im.w, im.h, Math.round(im.w / 5)), im.w, im.h, Math.round(im.w / 5));
  for (let i = 0; i < n; i++) { const g = Math.min(2, Math.max(0.5, (mean / (wide[i] || 1)) ** 0.7)); for (let c = 0; c < 3; c++) im.d[i * 3 + c] = Math.min(255, im.d[i * 3 + c] * g); }
}
/** k-means。最初の中心は「いちばん遠い点」を順に取る。毎回同じ結果になる */
function kmeans(im: Img, k: number): { label: Uint8Array; centers: number[][] } {
  const n = im.w * im.h, d = im.d, step = Math.max(1, Math.floor(n / 40000));
  const dist = (i: number, c: number[]): number => (d[i * 3] - c[0]) ** 2 + (d[i * 3 + 1] - c[1]) ** 2 + (d[i * 3 + 2] - c[2]) ** 2;
  let mr = 0, mg = 0, mb = 0, cnt = 0;
  for (let i = 0; i < n; i += step) { mr += d[i * 3]; mg += d[i * 3 + 1]; mb += d[i * 3 + 2]; cnt++; }
  const centers: number[][] = [];
  let far = 0, fd = -1; for (let i = 0; i < n; i += step) { const x = dist(i, [mr / cnt, mg / cnt, mb / cnt]); if (x > fd) { fd = x; far = i; } }
  centers.push([d[far * 3], d[far * 3 + 1], d[far * 3 + 2]]);
  while (centers.length < k) {
    far = 0; fd = -1;
    for (let i = 0; i < n; i += step) { let m = Infinity; for (const c of centers) m = Math.min(m, dist(i, c)); if (m > fd) { fd = m; far = i; } }
    centers.push([d[far * 3], d[far * 3 + 1], d[far * 3 + 2]]);
  }
  const label = new Uint8Array(n);
  const assign = (st: number): void => { for (let i = 0; i < n; i += st) { let b = 0, bd = Infinity; for (let c = 0; c < k; c++) { const x = dist(i, centers[c]); if (x < bd) { bd = x; b = c; } } label[i] = b; } };
  for (let it = 0; it < 20; it++) {
    assign(step);
    const sum = centers.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < n; i += step) { const s = sum[label[i]]; s[0] += d[i * 3]; s[1] += d[i * 3 + 1]; s[2] += d[i * 3 + 2]; s[3]++; }
    for (let c = 0; c < k; c++) if (sum[c][3]) centers[c] = [sum[c][0] / sum[c][3], sum[c][1] / sum[c][3], sum[c][2] / sum[c][3]];
  }
  assign(1);
  return { label, centers };
}
/** 群を K 個まで減らす。全体の1.5％未満の群は先に近い群へ入れ、あとは中心がいちばん近い2つを順にまとめる */
function merge(km: { label: Uint8Array; centers: number[][] }, k: number, n: number): { label: Uint8Array; centers: number[][] } {
  const cnt = km.centers.map(() => 0); for (let i = 0; i < n; i++) cnt[km.label[i]]++;
  const cen = km.centers.map((c) => c.slice()), to = cen.map((_, c) => c), alive = cen.map(() => true);
  const d2 = (a: number[], b: number[]): number => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  const join2 = (a: number, b: number): void => { // a を b へ
    const t = cnt[a] + cnt[b] || 1; for (let c = 0; c < 3; c++) cen[b][c] = (cen[a][c] * cnt[a] + cen[b][c] * cnt[b]) / t;
    cnt[b] += cnt[a]; cnt[a] = 0; alive[a] = false; for (let c = 0; c < to.length; c++) if (to[c] === a) to[c] = b;
  };
  const left = (): number => alive.filter(Boolean).length;
  for (let a = 0; a < cen.length; a++) if (alive[a] && cnt[a] < n * 0.015 && left() > 1) {
    let b = -1, bd = Infinity; for (let c = 0; c < cen.length; c++) if (c !== a && alive[c]) { const x = d2(cen[a], cen[c]); if (x < bd) { bd = x; b = c; } }
    join2(a, b);
  }
  while (left() > k) {
    let pa = -1, pb = -1, bd = Infinity;
    for (let a = 0; a < cen.length; a++) for (let b = a + 1; b < cen.length; b++) if (alive[a] && alive[b]) { const x = d2(cen[a], cen[b]); if (x < bd) { bd = x; pa = a; pb = b; } }
    if (cnt[pa] < cnt[pb]) join2(pa, pb); else join2(pb, pa);
  }
  const ids = cen.map((_, c) => c).filter((c) => alive[c]), label = new Uint8Array(n);
  for (let i = 0; i < n; i++) label[i] = ids.indexOf(to[km.label[i]]);
  return { label, centers: ids.map((c) => cen[c]) };
}

/** 5×5 の多数決 */
function mode(label: Uint8Array, w: number, h: number, k: number): Uint8Array {
  const out = new Uint8Array(w * h), cnt = new Int32Array(k);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    cnt.fill(0);
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h) cnt[label[yy * w + xx]]++; }
    let b = label[y * w + x], bc = cnt[b]; for (let c = 0; c < k; c++) if (cnt[c] > bc) { bc = cnt[c]; b = c; }
    out[y * w + x] = b;
  }
  return out;
}

mkdirSync(OUT, { recursive: true });
const meta: { id: string; title: string; page: string; license: string; author: string }[] = JSON.parse(readFileSync(join(SRC, 'meta.json'), 'utf8'));
const index: object[] = [], rows: { orig: Img; label: Uint8Array; colors: number[][] }[] = [];
for (const job of JOBS) {
  const im = shrink(load(job.file), job.crop || [0, 0, 1, 1], 640);
  const work: Img = { w: im.w, h: im.h, d: im.d.slice() };
  if (job.photo) { // 織り目と粒を先にならす
    flatten(work);
    for (let c = 0; c < 3; c++) { const ch = new Float32Array(im.w * im.h); for (let i = 0; i < ch.length; i++) ch[i] = work.d[i * 3 + c]; const b = boxBlur(ch, im.w, im.h, 1); for (let i = 0; i < ch.length; i++) work.d[i * 3 + c] = b[i]; }
  }
  // 色みの差（緑と茶）を明るさの差より重く見る。迷彩の緑と茶は明るさが近いので、RGB のままだと混ざる
  const feat: Img = { w: im.w, h: im.h, d: new Float32Array(work.d.length) };
  for (let i = 0; i < im.w * im.h; i++) {
    const r = work.d[i * 3], g = work.d[i * 3 + 1], b = work.d[i * 3 + 2];
    feat.d[i * 3] = (0.299 * r + 0.587 * g + 0.114 * b) * 0.6; feat.d[i * 3 + 1] = (r - g) * 1.8; feat.d[i * 3 + 2] = (b - (r + g) / 2) * 1.8;
  }
  // 多めに分けてから、ごく小さい群（文字や枠などの外れ値）と、いちばん近い群どうしをまとめて K 色にする
  const km = merge(kmeans(feat, job.k + 3), job.k, im.w * im.h);
  let label = km.label; for (let t = 0; t < job.clean; t++) label = mode(label, im.w, im.h, job.k);
  // 層の色は元の画像の平均。明るい順に番号を振り直す
  const sum = km.centers.map(() => [0, 0, 0, 0]);
  for (let i = 0; i < label.length; i++) { const s = sum[label[i]]; s[0] += im.d[i * 3]; s[1] += im.d[i * 3 + 1]; s[2] += im.d[i * 3 + 2]; s[3]++; }
  const col = sum.map((s) => [s[0] / (s[3] || 1), s[1] / (s[3] || 1), s[2] / (s[3] || 1)]);
  const order = col.map((_, c) => c).sort((a, b) => (0.299 * col[b][0] + 0.587 * col[b][1] + 0.114 * col[b][2]) - (0.299 * col[a][0] + 0.587 * col[a][1] + 0.114 * col[a][2]));
  const rank = new Uint8Array(job.k); order.forEach((c, r) => { rank[c] = r; });
  const png = new PNG({ width: im.w, height: im.h });
  for (let i = 0; i < label.length; i++) { label[i] = rank[label[i]]; const v = label[i] * 40; png.data[i * 4] = png.data[i * 4 + 1] = png.data[i * 4 + 2] = v; png.data[i * 4 + 3] = 255; }
  writeFileSync(join(OUT, `${job.id}.png`), PNG.sync.write(png, { colorType: 0 }));
  const colors = order.map((c) => col[c]), share = order.map((c) => +(sum[c][3] / label.length * 100).toFixed(1));
  const hex = colors.map((c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join(''));
  const m = meta.find((x) => x.id === job.id)!;
  index.push({ id: job.id, name: job.name, note: job.note, w: im.w, h: im.h, span: job.span, colors: hex, share, source: { title: m.title, page: m.page, license: m.license, author: m.author } });
  rows.push({ orig: im, label, colors });
  console.log(job.id.padEnd(11), `${im.w}x${im.h}`, hex.join(' '), share.join('/'));
}
writeFileSync(join(OUT, 'index.json'), JSON.stringify(index, null, 1));

if (PREVIEW) { // 左に元、右に起こした層。目で比べる用
  const cw = 420, gap = 8, hs = rows.map((r) => Math.round(r.orig.h * cw / r.orig.w)), H = hs.reduce((a, b) => a + b + gap, 0);
  const png = new PNG({ width: cw * 2 + gap, height: H }); png.data.fill(255);
  let y0 = 0;
  rows.forEach((r, k) => {
    for (let y = 0; y < hs[k]; y++) for (let x = 0; x < cw; x++) {
      const s = Math.min(r.orig.h - 1, Math.floor(y * r.orig.h / hs[k])) * r.orig.w + Math.min(r.orig.w - 1, Math.floor(x * r.orig.w / cw));
      const a = ((y0 + y) * png.width + x) * 4, b = ((y0 + y) * png.width + x + cw + gap) * 4, c = r.colors[r.label[s]];
      for (let ch = 0; ch < 3; ch++) { png.data[a + ch] = r.orig.d[s * 3 + ch]; png.data[b + ch] = c[ch]; }
    }
    y0 += hs[k] + gap;
  });
  writeFileSync(PREVIEW, PNG.sync.write(png));
}
