// テスト画面。samples/ の切り抜きを迷彩に押し込み、方式を切り替えたり並べたりして見る。
// 状態は URL の ? に書ける（例 ?groups=ヒト,ネコ&method=harmonic&compare=6&seed=48213）。
import { Kao } from './engine/kao.ts';
import { PATTERNS, patternById } from './engine/patterns.ts';
import type { Method, Params, RGB } from './engine/types.ts';
import * as engine from './client.ts';
import { Motion } from './motion.ts';
import type { MotionKind, MotionOptions } from './motion.ts';
import type { PhaseMap } from './render.ts';
import type { Job } from './render.ts';
import type { MaterialOptions } from './material.ts';
import { addOwnImage, forgetOwnImages, loadCutout, loadManifests, restoreOwnImages } from './samples.ts';
import { loadText, saveText } from './store.ts';
import { initialLang, setLang, tr } from './i18n.ts';
import type { Lang } from './i18n.ts';
import type { CutKind } from './cutout.ts';
import { loadSwatches } from './swatches.ts';
import type { Sample } from './samples.ts';

const $ = <T extends HTMLElement = HTMLInputElement>(id: string): T => document.getElementById(id) as T;
const num = (id: string): number => +$(id).value / 100;

const PALETTES: Record<string, string[]> = {
  // 1色だけの配色。迷彩の色の差がなくなり、押し込んだ画像だけでブロブが見える
  white: ['#FFFFFF', '#FFFFFF', '#FFFFFF', '#FFFFFF'], gray: ['#808080', '#808080', '#808080', '#808080'], black: ['#000000', '#000000', '#000000', '#000000'],
  woodland: ['#C2B280', '#4B5D2A', '#5A4028', '#1C1F18'], desert: ['#D9C7A3', '#B79A6B', '#8A6A45', '#5B4A3A'],
  urban: ['#D5D6D2', '#9A9C98', '#5C5F60', '#232526'], navy: ['#9FB2C4', '#4F6D8C', '#243B5A', '#0F1826'],
  pop: ['#FFD23F', '#EE4266', '#3BCEAC', '#540D6E'],
};
/** 出力の縦横。汎用は比率だけ決め、書き出しは長辺 EXPORT。ig- で始まるものは Instagram の仕様の画素数そのままで書き出す */
const RATIOS: Record<string, [number, number]> = {
  '1:1': [1, 1], '3:4': [3, 4], '4:3': [4, 3], '9:16': [9, 16], '16:9': [16, 9], '4:5': [4, 5],
  'ig-square': [1080, 1080], 'ig-portrait': [1080, 1350], 'ig-tall': [1080, 1440], 'ig-landscape': [1080, 566], 'ig-story': [1080, 1920],
  'x-landscape': [1600, 900], 'x-square': [1080, 1080], 'x-portrait': [1080, 1350], 'x-header': [1500, 500],
};
/** 自分で決める大きさの下限と上限（画素） */
const OWN_MIN = 64, OWN_MAX = 8000;
const clampPx = (v: string): number => Math.min(OWN_MAX, Math.max(OWN_MIN, Math.round(+v) || OWN_MIN));
/** いまの出力の縦横。custom のときは入力欄の画素数 */
function ratioNow(): [number, number] {
  const k = $('ratio').value;
  return k === 'custom' ? [clampPx($('ow').value), clampPx($('oh').value)] : RATIOS[k] || RATIOS['1:1'];
}
/** 画素数そのままで書き出す選択か（Instagram 用、X 用、自分で決める） */
const exactSize = (): boolean => /^(ig-|x-|custom$)/.test($('ratio').value);
/** 書き出しの長辺。Instagram 用は仕様の画素数、ほかは EXPORT */
function exportLong(): number { const r = ratioNow(); return exactSize() ? Math.max(r[0], r[1]) : EXPORT; }
const LABELS: Record<Method, string> = {
  radial: '放射', harmonic: '調和写像', elastic: '詰め物', area: '面積均等', contour: '輪郭追従',
  areaharm: '輪郭は面積・内側は調和', diffuse: '密度拡散', energy: '歪みエネルギー最小', blend: '単純に混ぜる', carve: '形にカービング',
};
const TILES: Record<string, Method[]> = {
  '10': ['radial', 'harmonic', 'elastic', 'area', 'contour', 'areaharm', 'diffuse', 'energy', 'blend', 'carve'],
};
const HYBRID: Method[] = ['areaharm', 'diffuse', 'energy', 'blend'];
const SLIDERS = ['per', 'softlim', 'neck', 'notch', 'flat', 'mix', 'carve', 'protect', 'imp', 'wobble', 'squeeze', 'fit', 'dist', 'rot', 'tint'];
const PREVIEW = 720, EXPORT = 2400;

const view = $<HTMLCanvasElement>('view'), ctx = view.getContext('2d')!;
/** 動かした絵を出すキャンバス。view の真上に、同じ大きさで重ねる */
const mview = $<HTMLCanvasElement>('motion-view');
let all: Sample[] = [], groups: string[] = [];
const picked = new Set<string>(), sent = new Set<string>(); // sent：描く Worker に渡した素材
let ownBusy = false, exporting = false;
/** 何も指定がないときのシードと、画像の並びのかき混ぜ方 */
const SEED0 = 18455, SHUF0 = 75097;
let seed = SEED0, shuf = SHUF0, showSources = false, lastBlobs = 0;
/** くびれなどを切る場所を決めるときの、絵の長辺。画面用と書き出し用で同じ所が切れるように、いつもこの大きさで決める */
const CUT_REF = 720;

function params(patternId = $('pattern').value): Params {
  const pat = patternById(patternId), size = sizeGood / 100;
  return {
    pattern: pat.id, layerAt: pat.id === 'blob' ? undefined : pat.make(seed, size), flatBelow: pat.flatBelow * num('flat'), flatLayers: pat.flatLayers, noSplit: pat.noSplit, split: $('split').value,
    seed, size, cutRef: CUT_REF, neck: num('neck'), notch: num('notch'), wobble: num('wobble'), fit: num('fit'), dist: num('dist'), rot: num('rot'), zoom: 1, tint: num('tint'),
    smooth: $('smooth').checked, trim: $('trim').checked, assign: $('assign').value, method: $('method').value as Method, imp: num('imp'), mix: num('mix'), squeeze: num('squeeze'),
  };
}
const rgb = (h: string): number[] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

// ---- ブロブの大きさ ----
// 数字の入力と − ＋。スライダーのような上限下限は置かない。
// エンジンはどの大きさでも止まらない（計った。いちばん重い書き出しでも10秒ほど）。止めるのは、それより先は絵が変わらない所だけ：
// 0.01% より小さいと、書き出しの大きさでもブロブが1画素より小さい。100000% より大きいと、画面ぜんぶが1つのブロブ。
const SIZE_MIN = 0.01, SIZE_MAX = 100000;
/** いま使っている大きさ（百分率）。入力欄が空や 0 のときも、最後に通った値で描く */
let sizeGood = 8.9;
/** 入力欄の値を確かめて、使える値に直す。直したときは理由を出す */
function fixSize(): void {
  const el = $('size'), v = +el.value, ok = el.value.trim() !== '' && Number.isFinite(v) && v > 0;
  let s = ok ? v : sizeGood, note = ok ? '' : `0 より大きい数値を入力してください（${sizeGood}% のまま）。`;
  if (s < SIZE_MIN) { s = SIZE_MIN; note = `${SIZE_MIN}% 未満は結果が変わりません（${SIZE_MIN}% に制限）。`; }
  if (s > SIZE_MAX) { s = SIZE_MAX; note = `${SIZE_MAX}% を超えても結果が変わりません（${SIZE_MAX}% に制限）。`; }
  sizeGood = s; el.value = String(s);
  $('size-note').textContent = note; $('size-note').hidden = !note; $('size-note').classList.toggle('warn', !!note);
}
/** − ＋ で、いまの値に f を掛ける。細かい端数は丸める */
function stepSize(f: number): void {
  const v = sizeGood * f;
  $('size').value = String(+v.toPrecision(v >= 100 ? 3 : 2));
  fixSize(); syncUi(); void draw();
}

// 引いて変えるスライダー。つまみはいつも真ん中にいる。右へ引くと大きく、左へ引くと小さく、端まで引いて4倍か 1/4。
// 離すと、つまみだけ真ん中へ戻る。値はそのまま。もう一度引けば、そこからさらに変わる。だから上限も下限もない。
// ブロブの大きさは掛け算で効く値なので、「いまの値の何倍にするか」で動かす。
let jogBase: number | null = null;
function jogValue(): number { const v = (jogBase ?? sizeGood) * Math.pow(4, +$('size-jog').value / 100); return +v.toPrecision(v >= 100 ? 3 : 2); }
$('size-jog').addEventListener('input', () => { // 引いているあいだは、数字だけ変える
  if (jogBase === null) jogBase = sizeGood;
  $('size').value = String(jogValue());
});
$('size-jog').addEventListener('change', () => { // 離した。値を決めて描き直し、つまみを真ん中へ戻す
  if (jogBase !== null) $('size').value = String(jogValue());
  jogBase = null; $('size-jog').value = '0';
  fixSize(); syncUi(); void draw();
});

// ---- 自分の配色 ----
// 色を1つずつ選んで作り、名前を付けて「配色」に足す。足した配色はこのブラウザに残す（localStorage）。
// URL には色そのものを書く（palette=custom&colors=c2b280-4b5d2a-…）ので、URL を渡せば同じ色で開ける。
interface OwnPalette { name: string; colors: string[] }
const PAL_KEY = 'anyflage.palettes', PAL_MAX = 12;
const isHex = (h: unknown): h is string => typeof h === 'string' && /^#[0-9a-f]{6}$/i.test(h);
let ownPalettes: OwnPalette[] = [];
/** 作りかけの配色。下の色選びが、いつもこれを映す */
let draft: string[] = PALETTES.woodland.map((h) => h.toLowerCase());
let palMsg = '';
function loadPalettes(): void {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(PAL_KEY) || '[]');
    if (!Array.isArray(raw)) return;
    for (const e of raw as Partial<OwnPalette>[]) {
      const cs = Array.isArray(e?.colors) ? e.colors.filter(isHex).slice(0, PAL_MAX).map((h) => h.toLowerCase()) : [];
      if (typeof e?.name === 'string' && e.name && cs.length && !ownPalettes.some((p) => p.name === e.name)) ownPalettes.push({ name: e.name, colors: cs });
    }
  } catch { /* 読めないときは、足した配色なしで始める */ }
}
function storePalettes(): void {
  try { localStorage.setItem(PAL_KEY, JSON.stringify(ownPalettes)); palMsg = ''; }
  catch { palMsg = 'ブラウザに保存できませんでした。再読み込みで消えます（URL には色が残ります）。'; }
}
const ownPalette = (v: string): OwnPalette | undefined => v.startsWith('my:') ? ownPalettes.find((p) => p.name === v.slice(3)) : undefined;
/** 選んだ配色の色。柄の本来の色のときは null */
function paletteBase(): string[] | null {
  const v = $('palette').value;
  if (v === 'custom') return draft;
  if (v.startsWith('my:')) return ownPalette(v)?.colors || draft;
  return PALETTES[v] || null;
}
/** 「配色」の選択に、足した配色を並べ直す */
function drawPaletteOptions(): void {
  const sel = $<HTMLSelectElement>('palette');
  document.getElementById('pal-mine')?.remove();
  if (!ownPalettes.length) return;
  const og = document.createElement('optgroup'); og.id = 'pal-mine'; og.label = 'カスタム配色';
  for (const p of ownPalettes) { const o = document.createElement('option'); o.value = `my:${p.name}`; o.textContent = p.name; og.appendChild(o); }
  sel.insertBefore(og, sel.querySelector('option[value="custom"]'));
}
/** 作りかけの色を変えた。選択を「作りかけ」に移して描き直す */
function draftChanged(): void { $('palette').value = 'custom'; syncUi(); void draw(); }
function drawPalEditor(): void {
  const box = $<HTMLDivElement>('pal-colors'); box.textContent = '';
  draft.forEach((hex, i) => {
    const w = document.createElement('span'); w.className = 'swatch';
    const c = document.createElement('input'); c.type = 'color'; c.value = hex; c.setAttribute('aria-label', `${i + 1}色目`);
    c.addEventListener('input', () => { draft[i] = c.value; }); // 選んでいるあいだは覚えるだけ。決めたときに描き直す
    c.addEventListener('change', () => { draft[i] = c.value; draftChanged(); });
    const x = document.createElement('button'); x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', `${i + 1}色目を削除`); x.disabled = draft.length <= 1;
    x.addEventListener('click', () => { draft.splice(i, 1); drawPalEditor(); draftChanged(); });
    w.append(c, x); box.appendChild(w);
  });
  const add = document.createElement('button'); add.type = 'button'; add.id = 'pal-add'; add.textContent = '＋ 色を追加'; add.disabled = draft.length >= PAL_MAX;
  add.addEventListener('click', () => { draft.push(draft[draft.length - 1]); drawPalEditor(); draftChanged(); });
  box.appendChild(add);
}
/** 柄の本来の色か、選んだ配色。配色の色の数が柄の層の数と違うときは、色のあいだを補って配る */
function colors(patternId: string): RGB[] {
  const pat = patternById(patternId), src = paletteBase();
  if (!src || !src.length) return pat.colors.map(rgb);
  const base = src.map(rgb), N = base.length, K = pat.colors.length;
  return pat.colors.map((_, k) => {
    if (N === 1) return base[0].slice();
    const t = K > 1 ? k / (K - 1) * (N - 1) : 0, i = Math.min(N - 2, Math.floor(t)), f = t - i;
    return base[i].map((c, ch) => Math.round(c + (base[i + 1][ch] - c) * f));
  });
}
function dims(longEdge: number): [number, number] {
  const r = ratioNow(), m = Math.max(r[0], r[1]);
  return [Math.round(longEdge * r[0] / m), Math.round(longEdge * r[1] / m)];
}
function setStatus(t: string): void { $('status').textContent = t; }
/**
 * 作業中の表示。プレビューの上に、回る輪と文言を重ねる。null で消す。
 * 計算は画面と同じ場所で走るので、あいだは画面が止まる。輪は transform の動きなので、止まっているあいだも回る。
 */
function setBusy(t: string | null): void {
  const el = $('busy');
  if (t === null) { el.hidden = true; $('viewport').classList.remove('working'); return; }
  $('busy-text').textContent = t; el.hidden = false; $('viewport').classList.add('working');
}
/** 画面を一度描かせてから先へ進む。重い計算の前に、作業中の表示を確実に出すため */
const paintNow = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

/** 選んだ種類から、種類ごとに先頭 per 枚 */
function chosen(): Sample[] {
  const want = +$('per').value;
  // セットごとの並び。shuf が 0 なら並び順のまま。それ以外はセットごとに並びをかき混ぜる
  const lists = groups.filter((g) => picked.has(g)).map((g) => {
    const list = all.filter((s) => s.group === g);
    return shuf ? list.map((s, i) => ({ s, k: Kao.hash2(i, 71, shuf) })).sort((a, b) => a.k - b.k).map((e) => e.s) : list;
  });
  // 枚数は、選んだセットぜんぶで合わせて want 枚。セットから1枚ずつ順番に取っていくので、どのセットもなるべく同じ枚数になる。
  // 少ないセットは先に使い切り、残りは多いセットから取る
  const out: Sample[] = [];
  for (let k = 0; out.length < want; k++) {
    let any = false;
    for (const list of lists) if (k < list.length && out.length < want) { out.push(list[k]); any = true; }
    if (!any) break;
  }
  return out;
}
/** いまの設定での、素材の作り方 */
const matOptions = (): MaterialOptions => ({ carve: num('carve'), protect: num('protect'), fitBlob: $('fitblob').checked, soften: $('soften').checked, softLimit: +$('softlim').value });
/** 選んだ素材の切り抜きを読み、描く Worker に渡す。渡した id を返す */
async function sources(): Promise<string[]> {
  const ids: string[] = [];
  for (const s of chosen()) {
    if (!sent.has(s.id)) { engine.addMaterial(s.id, await loadCutout(s)); sent.add(s.id); }
    ids.push(s.id);
  }
  return ids;
}
/** 絵を1枚、Worker に描いてもらう。設定のうち関数（layerAt）は送れないので外す。柄は名前から向こうで作る */
async function paint(kind: Job['kind'], W: number, H: number, mats: string[], p: Params, reuse: boolean): Promise<ImageData> {
  const job: Job = { kind, W, H, p: { ...p, layerAt: undefined }, colors: colors(p.pattern || 'blob') as number[][], mats, mat: matOptions(), soft: $('soft').checked, edges: $('edges').checked, reuse, tileRef: kind === 'tile' ? dims(PREVIEW) : undefined, phase: reuse && kind !== 'orig' && !$('compare').value };
  const r = await engine.render(job);
  lastBlobs = r.blobs;
  if (job.phase) lastPhase = r.phase || null; // 「呼吸」用。粗い地図なので、書き出しでも画面用のものを使う
  return new ImageData(r.data, r.W, r.H);
}
interface Tile { label: string; p: Params }
/** 同じ素材で、方式だけ、または柄だけ変えて並べる */
async function renderSheet(tile: number, cols: number, tiles: Tile[], src: string[], stale: () => boolean): Promise<HTMLCanvasElement> {
  // 1枚ずつを、出力で選んだ比率で描く。tile は1枚の長辺。正方形で並べると、出したい形でどう見えるかが分からない
  const rows = Math.ceil(tiles.length / cols), [tw, th] = dims(tile);
  const c = document.createElement('canvas'); c.width = tw * cols; c.height = th * rows;
  const g = c.getContext('2d')!, fs = Math.max(11, Math.round(Math.min(tw, th) / 20));
  for (let k = 0; k < tiles.length; k++) {
    if (stale()) break; // 新しい描き直しが待っている。残りは描かない
    const t = tiles[k], label = tr(t.label);
    setBusy(`描いている… ${k + 1}/${tiles.length}`);
    const x = (k % cols) * tw, y = Math.floor(k / cols) * th;
    g.putImageData(await paint('one', tw, th, src, t.p, false), x, y);
    g.font = `700 ${fs}px "Hiragino Sans", sans-serif`; g.textBaseline = 'top';
    g.fillStyle = 'rgba(20,23,15,.82)'; g.fillRect(x, y, Math.min(tw, g.measureText(label).width + fs), fs * 1.7);
    g.fillStyle = '#F3F4EA'; g.fillText(label, x + fs / 2, y + fs * 0.35, tw - fs);
  }
  g.fillStyle = 'rgba(20,23,15,.82)';
  for (let k = 1; k < cols; k++) g.fillRect(k * tw - 1, 0, 2, c.height);
  for (let k = 1; k < rows; k++) g.fillRect(0, k * th - 1, c.width, 2);
  return c;
}
/** マスクが合っているか見るための一覧。市松の上に切り抜きを置く */
async function renderSources(): Promise<HTMLCanvasElement> {
  const list = chosen(), cols = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(list.length)))), cell = Math.floor(1080 / cols), rows = Math.max(1, Math.ceil(list.length / cols));
  const c = document.createElement('canvas'); c.width = cell * cols; c.height = cell * rows;
  const g = c.getContext('2d')!;
  for (let y = 0; y < c.height; y += 16) for (let x = 0; x < c.width; x += 16) { g.fillStyle = ((x + y) / 16) % 2 ? '#2a2f22' : '#1d2117'; g.fillRect(x, y, 16, 16); }
  for (let k = 0; k < list.length; k++) {
    const r = await loadCutout(list[k]), t = document.createElement('canvas'); t.width = r.w; t.height = r.h;
    t.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(r.data), r.w, r.h), 0, 0);
    const s = (cell - 24) / Math.max(r.w, r.h), x = (k % cols) * cell, y = Math.floor(k / cols) * cell;
    g.drawImage(t, x + (cell - r.w * s) / 2, y + (cell - r.h * s) / 2, r.w * s, r.h * s);
    g.font = '12px "Hiragino Sans", sans-serif'; g.fillStyle = '#F3F4EA'; g.textBaseline = 'top';
    g.fillText(`${tr(list[k].group)} ${list[k].label}`, x + 6, y + 4);
  }
  return c;
}

/** n 枚を並べるときの列の数。プレビューの枠の形に合わせ、1枚がいちばん大きく見える並べ方を選ぶ */
function bestCols(n: number): number {
  const vp = document.getElementById('viewport'), vw = vp?.clientWidth || 1, vh = vp?.clientHeight || 1, [tw, th] = dims(100);
  let best = 1, bs = 0;
  for (let c = 1; c <= n; c++) { const r = Math.ceil(n / c), sc = Math.min(vw / (c * tw), vh / (r * (th + 6))); if (sc > bs) { bs = sc; best = c; } }
  return best;
}
/** 素材の準備を、複数の Worker に分けて先に済ませる。進み具合を画面に出す */
async function warm(mats: string[], method: string): Promise<void> {
  const p = params();
  await engine.prepare(mats, matOptions(), method, p.mix === undefined ? 0.5 : p.mix, p.imp || 0, !!p.trim, (done, total) => setBusy(`画像を準備中… ${done}/${total}`));
}
/**
 * 画面用の絵の長辺。枠に全体を収めたときの画素数に合わせる。引き伸ばしてぼやけないように。
 * 細かい画面（Retina など）では、その細かさのぶんも足す。重くなりすぎないよう 1440 まで
 */
function previewLong(): number {
  const vw = viewport.clientWidth, vh = viewport.clientHeight, [rw, rh] = ratioNow();
  if (!vw || !vh) return PREVIEW;
  const s = Math.min(vw / rw, vh / rh), dpr = Math.min(2, window.devicePixelRatio || 1);
  return Math.round(Math.min(1440, Math.max(PREVIEW, Math.max(rw, rh) * s * dpr)));
}
async function produce(longEdge: number, reuse: boolean, stale: () => boolean = () => false): Promise<HTMLCanvasElement> {
  if (showSources) return renderSources();
  const src = await sources(), cmp = $('compare').value, p = params();
  const canvasOf = (img: ImageData, n = 1): HTMLCanvasElement => { const c = document.createElement('canvas'); c.width = img.width * n; c.height = img.height * n; for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) c.getContext('2d')!.putImageData(img, i * img.width, j * img.height); return c; };
  if (cmp === 'patterns' || cmp === '10') { // 並べて比べる。方式ごとの準備は、描くときにそれぞれ作る。ここではカービング版だけ先に作る
    await warm(src, 'radial');
    if (cmp === 'patterns') return renderSheet(Math.round(longEdge / 3), bestCols(PATTERNS.length), PATTERNS.map((pt) => ({ label: pt.name, p: params(pt.id) })), src, stale);
    return renderSheet(Math.round(longEdge / 2.5), bestCols(TILES[cmp].length), TILES[cmp].map((m) => ({ label: LABELS[m], p: { ...p, method: m } })), src, stale);
  }
  await warm(src, p.method || 'radial');
  if (reuse) setBusy('描画中…'); else setBusy(`書き出し中…（${dims(longEdge).join('×')} px）`);
  if (cmp === 'orig') { // 左に押し込んだ後、右に元の素材
    const [W, H] = dims(Math.round(longEdge * 2 / 3)), c = document.createElement('canvas'); c.width = W * 2 + 8; c.height = H;
    const g = c.getContext('2d')!; g.fillStyle = '#14170F'; g.fillRect(0, 0, c.width, H);
    g.putImageData(await paint('one', W, H, src, p, reuse), 0, 0); g.putImageData(await paint('orig', W, H, src, p, reuse), W + 8, 0);
    return c;
  }
  const [W, H] = dims(longEdge);
  // リピートできる絵。画面では、頼まれたときだけ 2×2 に並べて、継ぎ目を見られるようにする。書き出しはいつも1枚
  if ($('repeat').checked) return canvasOf(await paint('tile', W, H, src, p, reuse), reuse && $('repeatgrid').checked ? 2 : 1);
  return canvasOf(await paint('one', W, H, src, p, reuse));
}

// 描き直しは、いちどに1つだけ走らせる。走っているあいだに設定が変わったら、終わってから最新の設定でもう1回だけ描く。
// 計算は Worker の中なので、待っているあいだも画面は動く
let drawing = false, wanted = false;
async function draw(): Promise<void> {
  wanted = true;
  if (drawing || exporting) return; // 書き出しのあいだは描き直さない。終わったら書き出しの側が描き直す
  drawing = true;
  try { while (wanted && !exporting) { wanted = false; await drawOnce(); } } finally { drawing = false; }
}
async function drawOnce(): Promise<void> {
  const t0 = performance.now();
  setBusy('描画中…');
  try {
    const cmp = $('compare').value;
    const c = await produce(cmp ? 1080 : $('repeat').checked && $('repeatgrid').checked ? PREVIEW : previewLong(), true, () => wanted);
    if (wanted && cmp) return; // 並べて比べる絵を、途中でやめた。次の描き直しに任せる
    keepBefore(); // 描き替える前の絵を取っておく。「前の絵」ボタンで見比べられる
    const resized = view.width !== c.width || view.height !== c.height;
    view.width = c.width; view.height = c.height; ctx.drawImage(c, 0, 0);
    drawn = true;
    motionPicture(); // 動かしているなら、新しい絵を渡す
    void startLava(); // ラバランプなら、コマを描き直す
    if (resized) layoutView(); // 絵の大きさが変わったら、置き方を合わせ直す
    drawBackdrop(); // 柄や色が変わっていれば、枠の背景も描き直す
    const n = chosen().length;
    $('s-info').textContent = showSources ? `画像 ${n}枚` : `シード ${seed}・ブロブ ${lastBlobs}個・画像 ${n}枚・描画 ${((performance.now() - t0) / 1000).toFixed(1)}秒`;
    setStatus(all.length ? (n ? '' : '画像セットを選択してください。') : '画像がありません。「画像を追加」から追加してください。');
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e));
  } finally { // 途中でやめたときも、作業中の表示を必ず片づける
    if (!wanted && !exporting && !ownBusy) setBusy(null);
  }
  writeUrl();
}

function drawChips(): void {
  $('empty').hidden = all.length > 0;
  if (!all.length) $<HTMLDetailsElement>('own-box').open = true; // 画像セットがないときは、足す手順を開いておく
  // 枚数の上限は、いま選んでいるセットの合計の枚数。右端まで動かせば、選んだセットを全部使う。
  // 上限いっぱいにしていたときは、セットを選び直しても上限に付いていく（「全部使う」のまま）
  const sel = groups.filter((gname) => picked.has(gname)), per = $('per'), wasAll = +per.value >= +per.max && +per.max < 9999;
  const most = Math.max(1, (sel.length ? sel : groups).reduce((n, gname) => n + all.filter((s) => s.group === gname).length, 0)); // 選んだセットの合計
  per.max = String(most);
  if (wasAll || +per.value > most) per.value = String(most);
  syncPer();
  const box = $<HTMLDivElement>('groups'); box.textContent = '';
  for (const gname of groups) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = gname;
    const n = document.createElement('small'); n.textContent = String(all.filter((s) => s.group === gname).length); b.appendChild(n);
    b.setAttribute('aria-pressed', picked.has(gname) ? 'true' : 'false');
    b.addEventListener('click', () => { if (picked.has(gname)) picked.delete(gname); else picked.add(gname); drawChips(); void draw(); });
    box.appendChild(b);
  }
}
/** 枚数の表示。上限いっぱいなら「全部」と出す */
function syncPer(): void { const per = $('per'); $('o-per').textContent = +per.value >= +per.max && +per.max > 1 ? `すべて（${per.value}枚）` : `${per.value}枚`; }
function syncUi(): void {
  for (const id of SLIDERS) if (id === 'per') syncPer(); else $(`o-${id}`).textContent = id === 'softlim' ? `${$(id).value}升` : `${$(id).value}%`;
  const m = $('method').value as Method, cv = $('compare').value, cmp = cv === '10';
  $('method').disabled = cmp; $('pattern').disabled = cv === 'patterns';
  $('pattern-note').textContent = patternById($('pattern').value).note;
  $('softlim').disabled = !$('soften').checked;
  $('repeat-note').hidden = !$('repeat').checked; $('repeatgrid-row').hidden = !$('repeat').checked;
  $('own-size').hidden = $('ratio').value !== 'custom';
  const pv = $('palette').value, pn = $('pal-name').value.trim(), K = patternById($('pattern').value).colors.length;
  $('pal-del').disabled = !ownPalette(pv);
  $('pal-save').textContent = pn && ownPalettes.some((q) => q.name === pn) ? `「${pn}」を上書き` : '配色を保存';
  $('pal-note').textContent = `現在 ${draft.length}色／この柄は${K}色。数が違う場合は、中間色を補って割り当てます。${palMsg}`;
  const [ew, eh] = dims(exportLong()); $('out-size').textContent = `書き出しサイズ：${ew}×${eh} px`;
  $('squeeze').disabled = !cmp && !(m === 'radial' || m === 'elastic');
  $('fit').disabled = !cmp && m !== 'radial';
  $('mix').disabled = !cmp && !HYBRID.includes(m);
  $('imp').disabled = !cmp && !['area', 'areaharm', 'blend'].includes(m);
  $('o-mamt').textContent = `${$('mamt').value}%`; $('o-mfine').textContent = `${$('mfine').value}升`; $('o-msec').textContent = `${$('msec').value}秒`;
  $('motion-box').hidden = !$('motion').checked;
  $('o-mamt2').textContent = `${$('mamt2').value}%`; $('o-mlava').textContent = `${$('mlava').value}%`;
  $('mamt2').disabled = !$('mkind2').value; $('mlava').disabled = $('mgrow').disabled = !$('lava').checked; $('o-mgrow').textContent = `ブロブ ${$('mgrow').value}個分／秒`; $('lava-note').hidden = !$('lava').checked;
  const [vw, vh] = dims(videoLong()); $('video-note').textContent = `動画：${vw & ~1}×${vh & ~1} px、${VIDEO_FPS}fps、${$('msec').value}秒（ループ再生対応）`;
  syncMotion();
}

// ---- プレビューの拡大縮小と移動 ----
// 絵は枠（viewport）の中に置く。fitted のあいだは、枠に全体が収まる大きさに合わせ続ける。
// 拡大縮小や移動をすると fitted を外し、そのままの倍率と位置を保つ。
const viewport = $<HTMLDivElement>('viewport');
let zoom = 1, panX = 0, panY = 0, fitted = true;
function applyView(): void {
  const vw = viewport.clientWidth, vh = viewport.clientHeight, w = view.width * zoom, h = view.height * zoom;
  // 絵が枠より小さい向きは中央に置く。大きい向きは、絵の端が枠の端より内側に入らないようにする
  panX = w <= vw ? (vw - w) / 2 : Math.min(0, Math.max(vw - w, panX));
  panY = h <= vh ? (vh - h) / 2 : Math.min(0, Math.max(vh - h, panY));
  view.style.transform = mview.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  $('zoom-val').textContent = `${Math.round(zoom * 100)}%`;
  viewport.classList.toggle('pannable', w > vw || h > vh);
}
function fitZoom(): number { return Math.min(viewport.clientWidth / view.width, viewport.clientHeight / view.height) || 1; }
function layoutView(): void { if (fitted) zoom = fitZoom(); applyView(); }
/** 枠の中の点 (cx, cy) を動かさずに、倍率を z にする */
function zoomAt(z: number, cx: number, cy: number): void {
  z = Math.min(8, Math.max(Math.min(0.1, fitZoom()), z));
  panX = cx - (cx - panX) * z / zoom; panY = cy - (cy - panY) * z / zoom; zoom = z; fitted = false; applyView();
}
const zoomCentre = (f: number): void => zoomAt(zoom * f, viewport.clientWidth / 2, viewport.clientHeight / 2);
$('zoom-in').addEventListener('click', () => zoomCentre(1.25));
$('zoom-out').addEventListener('click', () => zoomCentre(1 / 1.25));
$('zoom-fit').addEventListener('click', () => { fitted = true; layoutView(); });
$('zoom-100').addEventListener('click', () => zoomAt(1, viewport.clientWidth / 2, viewport.clientHeight / 2));
viewport.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const r = viewport.getBoundingClientRect();
  zoomAt(zoom * Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0015)), ev.clientX - r.left, ev.clientY - r.top);
}, { passive: false });
viewport.addEventListener('dblclick', (ev) => {
  const r = viewport.getBoundingClientRect();
  if (fitted || Math.abs(zoom - fitZoom()) < 0.001) zoomAt(1, ev.clientX - r.left, ev.clientY - r.top); else { fitted = true; layoutView(); }
});
let drag: { x: number; y: number; px: number; py: number } | null = null;
viewport.addEventListener('pointerdown', (ev) => { if (ev.button !== 0) return; drag = { x: ev.clientX, y: ev.clientY, px: panX, py: panY }; viewport.setPointerCapture(ev.pointerId); viewport.classList.add('dragging'); });
viewport.addEventListener('pointermove', (ev) => { if (!drag) return; panX = drag.px + ev.clientX - drag.x; panY = drag.py + ev.clientY - drag.y; fitted = false; applyView(); });
const endDrag = (): void => { drag = null; viewport.classList.remove('dragging'); };
viewport.addEventListener('pointerup', endDrag); viewport.addEventListener('pointercancel', endDrag);
// ---- 前の絵と見比べる ----
// 描き直すたびに、直前の絵を1枚取っておく。「前の絵」を押しているあいだだけ、それを出す。離すと今の絵に戻る。
// 設定を変えてから描き終わるまで時間がかかるので、何が変わったかを見比べるためのもの。
let drawn = false, showingBefore = false;
const beforeCv = document.createElement('canvas'), nowCv = document.createElement('canvas');
let hasBefore = false;
function copyInto(dst: HTMLCanvasElement, src: HTMLCanvasElement): void { dst.width = src.width; dst.height = src.height; dst.getContext('2d')!.drawImage(src, 0, 0); }
function keepBefore(): void {
  if (showingBefore) showBefore(false);
  if (!drawn) return; // まだ1枚も描いていない
  copyInto(beforeCv, view); hasBefore = true; $('before').disabled = false;
}
function showBefore(on: boolean): void {
  if (on === showingBefore || !hasBefore) return;
  if (on) { copyInto(nowCv, view); copyInto(view, beforeCv); } else copyInto(view, nowCv);
  showingBefore = on; layoutView();
  $('before').classList.toggle('on', on); viewport.classList.toggle('before', on);
}
{
  const b = $('before');
  b.addEventListener('pointerdown', (ev) => { b.setPointerCapture(ev.pointerId); showBefore(true); });
  for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(t, () => showBefore(false));
  b.addEventListener('keydown', (ev) => { if ((ev.key === ' ' || ev.key === 'Enter') && !ev.repeat) showBefore(true); });
  b.addEventListener('keyup', (ev) => { if (ev.key === ' ' || ev.key === 'Enter') showBefore(false); });
  b.addEventListener('blur', () => showBefore(false));
  // キーボード：B を押しているあいだ、前の絵を出す。文字や数字を打つ欄、選択欄の中では効かせない
  const typing = (t: EventTarget | null): boolean => t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLInputElement && ['text', 'number', 'search'].includes(t.type));
  window.addEventListener('keydown', (ev) => { if (ev.key.toLowerCase() !== 'b' || ev.metaKey || ev.ctrlKey || ev.altKey || ev.repeat || typing(ev.target)) return; ev.preventDefault(); showBefore(true); });
  window.addEventListener('keyup', (ev) => { if (ev.key.toLowerCase() === 'b') showBefore(false); });
  window.addEventListener('blur', () => showBefore(false)); // 押したまま別の窓へ移っても、前の絵のまま残らないように
}

// ---- 枠の背景：いま選んでいる迷彩を、素材なしの色だけで敷く ----
// 絵に顔を入れると、どんな柄だったか分からなくなる。枠の余白に柄そのものを出しておく。
// 半分の解像度で作って引き伸ばす。ブロブは切らない（色の形は同じなので、切る計算を省ける）。
const backdrop = $<HTMLCanvasElement>('backdrop');
let backdropKey = '';
function drawBackdrop(): void {
  const vw = window.innerWidth, vh = window.innerHeight; if (!vw || !vh) return; // 画面全体に敷く
  const W = Math.max(8, Math.round(vw / 2)), H = Math.max(8, Math.round(vh / 2)), p = params(), cols = colors(p.pattern || 'blob');
  // 全体表示のときの絵と、ブロブの大きさが画面上でそろうようにする
  const shown = Math.max(view.width, view.height) * fitZoom(), size = p.size * shown / Math.max(vw, vh);
  const key = [W, H, p.seed, size.toFixed(4), p.wobble, p.pattern, cols.join(';')].join('|');
  if (key === backdropKey) return;
  backdropKey = key;
  try {
    const bp: Params = { ...p, size, layerAt: p.pattern === 'blob' ? undefined : patternById(p.pattern || 'blob').make(p.seed, size), neck: 0, notch: 0, split: 'none', noSplit: true };
    const img = new ImageData(W, H);
    Kao.renderCamo(img.data, Kao.buildCamo(W, H, bp), [], cols, bp); // 素材なしで描くと、色だけになる
    backdrop.width = W; backdrop.height = H; backdrop.getContext('2d')!.putImageData(img, 0, 0);
  } catch (e) { console.warn('背景の迷彩を描けなかった', e); }
}
new ResizeObserver(() => { layoutView(); drawBackdrop(); }).observe(viewport);
window.addEventListener('resize', () => drawBackdrop());

// ---- 動かす ----
// できあがった絵を、ループする「ずらしの場」で毎フレームゆがめる（motion.ts）。絵は作り直さないので、設定を変えてもすぐ動きが変わる。
// 動かし方の設定を変えても、絵は描き直さない。
const VIDEO_FPS = 30, MOTION_IDS = ['motion', 'mkind', 'mamt', 'mfine', 'msec', 'mkind2', 'mamt2', 'lava', 'mlava', 'mgrow'];
let motion: Motion | null = null, lastPhase: PhaseMap | null = null, motionRaf = 0;
/** ふつうの絵（比較表示でも、切り抜きの一覧でもない）か。リピートと「呼吸」は、ふつうの絵のときだけ効く */
const plain = (): boolean => !$('compare').value && !showSources;
/** 動画の長辺。大きさが決まっている比率はそのまま。汎用の比率は 1920 */
function videoLong(): number { return exactSize() ? exportLong() : 1920; }
function motionOptions(tiles: number): MotionOptions {
  return { kind: $('mkind').value as MotionKind, amount: +$('mamt').value / 100, kind2: $('mkind2').value as MotionKind | '', amount2: +$('mamt2').value / 100, fine: +$('mfine').value, tiles, wrap: plain() && $('repeat').checked, seed };
}
/** いま画面にある絵を、動かす側に渡す */
function motionPicture(): void {
  if (!$('motion').checked) return;
  try { motion ??= new Motion(mview); }
  catch (e) { $('motion').checked = false; $('motion-box').hidden = true; setStatus(e instanceof Error ? e.message : String(e)); return; }
  motion.setPicture(view); motion.setNext(null); motion.setPhase(plain() ? lastPhase : null);
}
// ラバランプ。毎コマ迷彩を作り直すので、その場では動かせない。
// 画面には、1周を毎秒 15 コマで先に描いておき、できたコマから順に出す。コマのあいだは、次のコマへ少しずつまぜて見せる。
// 書き出しでは、毎秒 30 コマぶんを全部描く。
// 画面用のコマは長辺 720 で描く。書き出しと同じブロブ分けになる大きさ（CUT_REF）で、枠の大きさで描くより速い。
const LAVA_FPS = 15, LAVA_MAX = 120;
/** 画面用のコマ数（1周ぶん） */
const lavaCount = (): number => Math.max(12, Math.min(LAVA_MAX, Math.round(+$('msec').value * LAVA_FPS)));
let lavaN = 0;
let lavaFrames: (HTMLCanvasElement | undefined)[] = [], lavaGen = 0, lavaShown = -1;
const lavaOn = (): boolean => $('motion').checked && $('lava').checked && plain() && !$('repeat').checked;
/** 侵食の早さ。絵が1コマに広がる距離（ブロブの大きさを 1 として）。1周 n コマのとき。スライダーは「1秒にブロブ何個分／秒」 */
const lavaGrow = (n: number): number => +$('mgrow').value * +$('msec').value / n;
/** 本番の前に、本当に描いて捨てるコマ数。絵を読む位置のならしを、0 コマ目の前に効かせておくため。0.4 秒ぶん */
const lavaLead = (n: number): number => Math.min(n - 1, Math.ceil(0.4 * n / +$('msec').value) + 1);
/**
 * ラバランプの1周ぶん（n）を、順に描く。描けたコマは emit に渡す（0 から n-1 の順）。
 *
 * どのコマの絵も、その前のコマの続きでできている（どの顔がどこにいるか、絵がどこまで広がったか）。
 * 顔の割り当ては、1周たどっても元に戻らない。そのまま描くと、1周の終わりと 0 コマ目で顔が違い、ループがつながらない。
 * そこで、絵を描く前に「下ごしらえ」を2周回す。1周目は前向きに、2周目は後ろ向きに、顔の割り当てだけをたどる。
 * 本番では、ブロブごとに途中で前向きの割り当てから後ろ向きの割り当てへ乗り換える。こうすると、終わりが必ず 0 コマ目につながる。
 * stale が true を返したら、途中でやめる。note には、下ごしらえの進み具合が来る。
 */
async function lavaRun(W: number, H: number, mats: string[], p: Params, n: number, emit: (i: number, img: ImageData) => void | Promise<void>, note: (text: string, done: number) => void, stale: () => boolean = () => false): Promise<void> {
  const lead = lavaLead(n);
  const step = async (i: number, pass: 'f' | 'b' | 'draw', first: boolean): Promise<ImageData> => {
    const job: Job = { kind: 'one', W, H, p: { ...p, layerAt: undefined }, colors: colors(p.pattern || 'blob') as number[][], mats, mat: matOptions(), soft: $('soft').checked, edges: $('edges').checked, reuse: false,
      lava: { theta: Math.PI * 2 * i / n, amount: +$('mlava').value / 100, first, grow: lavaGrow(n), dt: +$('msec').value / n, pass, index: i, count: n } };
    const r = await engine.render(job);
    return new ImageData(r.data, r.W, r.H);
  };
  for (let i = 0; i < n; i++) { if (stale()) return; await step(i, 'f', i === 0); if (i % 5 === 0) note(`準備 1/2（${i}/${n}）`, i); }
  for (let k = 0; k < n; k++) { if (stale()) return; await step((n - k) % n, 'b', k === 0); if (k % 5 === 0) note(`準備 2/2（${k}/${n}）`, n + k); } // 0、n-1、n-2、…、1 の順
  for (let k = 0; k < lead; k++) { if (stale()) return; await step(n - lead + k, 'draw', k === 0); } // 0 コマ目の手前を描いて捨てる。絵の広がりと、読む位置のならしを効かせておく
  for (let i = 0; i < n; i++) { if (stale()) return; await emit(i, await step(i, 'draw', false)); }
}
/** ラバランプの進み具合を出す。スイッチの下の文と、プレビューの上の札の両方。text が空なら消す。frac は全体のうち済んだ割合（0〜1） */
function lavaNote(text: string, frac = 0): void {
  $('lava-progress').textContent = text;
  $('lava-tag').hidden = !text; $('lava-tag-text').textContent = text; $('lava-tag-bar').style.width = `${Math.round(Math.min(1, Math.max(0, frac)) * 100)}%`;
}
/** 画面用のコマを、最初から描き直す。途中で設定が変わったら、古いほうはやめる */
async function startLava(): Promise<void> {
  const gen = ++lavaGen, had = lavaFrames.length > 0;
  lavaFrames = []; lavaShown = -1; lavaNote('');
  if (had && drawn && !showingBefore) motionPicture(); // コマを捨てた。止まった絵に戻す
  if (!lavaOn() || !drawn || exporting) return;
  try {
    const src = await sources(), p = params(), [W, H] = dims(PREVIEW), N = lavaCount();
    lavaN = N;
    const stale = (): boolean => gen !== lavaGen || exporting;
    const total = 3 * N + lavaLead(N); // 下ごしらえ2周、捨てるコマ、本番
    lavaNote('ラバランプを生成中…');
    await lavaRun(W, H, src, p, N, (i, img) => {
      if (stale()) return;
      const c = document.createElement('canvas'); c.width = W; c.height = H; c.getContext('2d')!.putImageData(img, 0, 0);
      lavaFrames[i] = c;
      if (i + 1 < N) lavaNote(`ラバランプを生成中…（${i + 1}/${N}）`, (total - N + i + 1) / total); else lavaNote('');
    }, (t, done) => { if (!stale()) lavaNote(`ラバランプを生成中…（${t}）`, done / total); }, stale);
  } catch (e) { if (gen === lavaGen) { lavaNote(''); setStatus(e instanceof Error ? e.message : String(e)); } }
}
function motionFrame(now: number): void {
  motionRaf = 0;
  if (!$('motion').checked) { mview.hidden = true; return; }
  // 前の絵を見ているあいだと、書き出しのあいだは止める
  const show = !!motion?.ready && !showingBefore && !exporting && mview.width === view.width && mview.height === view.height;
  mview.hidden = !show;
  const turn = (now / 1000 / +$('msec').value) % 1;
  let blend = 0;
  if (show && lavaFrames.length && lavaN) { // ラバランプ：いまの位置のコマを出し、次のコマへ少しずつまぜる。まだ描けていなければ、手前のコマで止める
    const f = turn * lavaN; let k = Math.floor(f) % lavaN; const k2 = (k + 1) % lavaN, both = !!lavaFrames[k] && !!lavaFrames[k2];
    if (both) blend = f - Math.floor(f); else while (k > 0 && !lavaFrames[k]) k--;
    const id = both ? k : -2 - k;
    if (lavaFrames[k] && id !== lavaShown) { motion!.setPicture(lavaFrames[k]!, view.width, view.height); motion!.setNext(both ? lavaFrames[k2]! : null); lavaShown = id; }
  }
  if (show) motion!.draw(Math.PI * 2 * turn, motionOptions(plain() && $('repeat').checked && $('repeatgrid').checked ? 2 : 1), blend);
  motionRaf = requestAnimationFrame(motionFrame);
}
function syncMotion(): void {
  if (!$('motion').checked) { mview.hidden = true; return; }
  if (!motion?.ready && drawn) motionPicture();
  if (!motionRaf) motionRaf = requestAnimationFrame(motionFrame);
}
// ---- ファイルに保存する ----
/** ファイル名に付ける、いまの日時。年月日-時分秒。同じ設定で何度書き出しても、名前が重ならない */
function stamp(): string {
  const d = new Date(), z = (v: number): string => String(v).padStart(2, '0');
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}
type Saver = (blob: Blob) => Promise<void>;
interface SaveHandle { createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }> }
/**
 * 保存先を選んでもらう。返すのは、中身を渡すとそこへ書く関数。やめたら null。
 * 保存先を選ぶ窓は、ボタンを押してすぐでないと開けない。だから書き出しの計算より前に呼ぶ。
 * この窓を出せないブラウザ（Safari、Firefox）では、いつものダウンロードになる（保存先はブラウザの設定どおり）。
 */
async function pickSave(name: string, desc: string, mime: string, ext: string): Promise<Saver | null> {
  const win = window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<SaveHandle> };
  if (win.showSaveFilePicker) {
    try {
      const h = await win.showSaveFilePicker({ suggestedName: name, types: [{ description: tr(desc), accept: { [mime]: [ext] } }] });
      return async (blob) => { const w = await h.createWritable(); await w.write(blob); await w.close(); };
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return null; // 窓を閉じた
      console.warn('保存先を選ぶ窓を出せなかった。ダウンロードにする', e);
    }
  }
  return async (blob) => { const a = document.createElement('a'), url = URL.createObjectURL(blob); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 60000); };
}
$('save-video').addEventListener('click', async () => {
  if (exporting) return;
  exporting = true; // 保存先を選んでいるあいだも、二度押しと描き直しを止める
  const save = await pickSave(`anyflage-${seed}-${stamp()}.mp4`, 'MP4 動画', 'video/mp4', '.mp4');
  if (!save) { exporting = false; if (wanted) void draw(); return; }
  const btn = $('save-video'), secs = +$('msec').value, N = Math.round(secs * VIDEO_FPS);
  btn.disabled = true; $('save').disabled = true; btn.textContent = '書き出し中…';
  setStatus(''); setBusy('動画用の画像を生成中…');
  await paintNow();
  let m: Motion | null = null;
  const done = (msg: string): void => { m?.dispose(); exporting = false; btn.disabled = false; $('save').disabled = false; btn.textContent = 'MP4 を保存'; setBusy(null); setStatus(msg); if (wanted) void draw(); else void startLava(); };
  try {
    if (typeof VideoEncoder === 'undefined') throw new Error('このブラウザは動画の書き出しに対応していません（WebCodecs 非対応）。');
    const mb = await import('mediabunny');
    const still = await produce(videoLong(), false);
    // H.264 は偶数の画素数しか受けない。奇数なら1画素だけ縮める
    const W = still.width & ~1, H = still.height & ~1, cv = document.createElement('canvas');
    m = new Motion(cv);
    if (Math.max(W, H) > m.maxSize || !(await mb.canEncodeVideo('avc', { width: W, height: H }))) throw new Error(`サイズ（${W}×${H} px）は、このブラウザでは MP4 にできません。小さいサイズを選択してください。`);
    m.setPicture(still, W, H); m.setPhase(plain() ? lastPhase : null);
    const target = new mb.BufferTarget(), out = new mb.Output({ format: new mb.Mp4OutputFormat(), target });
    const src = new mb.CanvasSource(cv, { codec: 'avc', bitrate: mb.QUALITY_HIGH });
    out.addVideoTrack(src, { frameRate: VIDEO_FPS });
    await out.start();
    const o = motionOptions(1), lava = lavaOn(), mats = lava ? await sources() : [], p = params();
    const fc = document.createElement('canvas'); fc.width = still.width; fc.height = still.height;
    const mm = m, add = async (i: number): Promise<void> => { // i = N は i = 0 と同じ絵。入れない。最後のコマの次が最初のコマにつながる
      mm.draw(Math.PI * 2 * i / N, o);
      await src.add(i / VIDEO_FPS, 1 / VIDEO_FPS);
      if (lava || i % 5 === 0) { setBusy(`動画を作成中…（${i}/${N}）`); await new Promise((r) => setTimeout(r, 0)); }
    };
    if (lava) await lavaRun(still.width, still.height, mats, p, N, async (i, img) => { fc.getContext('2d')!.putImageData(img, 0, 0); mm.setPicture(fc, W, H); await add(i); }, (t) => setBusy(`動画を作成中…（${t}）`)); // ラバランプは、コマごとに絵を作り直す
    else for (let i = 0; i < N; i++) await add(i);
    setBusy('ファイルを作成中…');
    await out.finalize();
    if (!target.buffer) throw new Error('動画を作成できませんでした。');
    await save(new Blob([target.buffer], { type: 'video/mp4' }));
    done(`保存しました：${W}×${H} px・${secs}秒`);
  } catch (e) { done(e instanceof Error ? e.message : String(e)); }
});

// ---- URL との行き来 ----
const FIELDS = [...SLIDERS, 'size', 'method', 'compare', 'assign', 'ratio', 'ow', 'oh', 'palette', 'pattern', 'split', 'mkind', 'mamt', 'mfine', 'msec', 'mkind2', 'mamt2', 'mlava', 'mgrow'];
function writeUrl(): void {
  const q = new URLSearchParams();
  q.set('groups', [...picked].join(','));
  for (const id of FIELDS) { const el = $(id); if (el.value !== el.dataset.initial) q.set(id, el.value); }
  const pv = $('palette').value; // 自分の配色は、名前ではなく色そのものを書く。ほかのブラウザでも同じ色で開ける
  if (pv === 'custom' || pv.startsWith('my:')) { q.set('palette', 'custom'); q.set('colors', (paletteBase() || draft).map((h) => h.slice(1)).join('-')); }
  for (const id of CHECKS) if ($(id).checked !== ($(id).dataset.initial === '1')) q.set(id, $(id).checked ? '1' : '0'); // 最初の状態と違うものだけ書く
  if ($('repeat').checked && $('repeatgrid').checked) q.set('grid', '1');
  if (showSources) q.set('sources', '1');
  q.set('seed', String(seed));
  if (shuf !== SHUF0) q.set('shuf', String(shuf));
  const text = q.toString();
  history.replaceState(null, '', `?${text}`);
  saveText('last', text); // ブラウザを閉じても、最後の状態から始められるように
  record(text);
}
/** 最初の値を覚える。applyQuery が「指定のない項目は最初の値に戻す」ために使う。起動時に1回だけ */
/** 入・切のもの。最初の状態（index.html の checked）を覚えておき、URL には違うものだけ書く */
const CHECKS = ['fitblob', 'smooth', 'soft', 'trim', 'soften', 'edges', 'repeat', 'motion', 'lava'];
function rememberDefaults(): void { for (const id of FIELDS) $(id).dataset.initial = $(id).value; for (const id of CHECKS) $(id).dataset.initial = $(id).checked ? '1' : '0'; }
/** 設定をまるごと、この問い合わせ文字列の状態にする。指定のない項目は最初の値に戻す */
function applyQuery(text: string): void {
  const q = new URLSearchParams(text);
  for (const id of FIELDS) { const el = $(id), v = q.get(id); el.value = v !== null ? v : el.dataset.initial || el.value; }
  fixSize(); // URL の size が 0 や数字でないときも落ちないように
  const cs = (q.get('colors') || '').split('-').filter((h) => /^[0-9a-f]{6}$/i.test(h)).slice(0, PAL_MAX).map((h) => `#${h.toLowerCase()}`);
  if (cs.length) draft = cs;
  if ($('palette').value === 'custom') { // 同じ色の配色をすでに足してあれば、それを選ぶ
    const same = ownPalettes.find((p) => p.colors.join() === draft.join());
    if (same) { $('palette').value = `my:${same.name}`; $('pal-name').value = same.name; }
    $<HTMLDetailsElement>('pal-box').open = true;
  }
  if (!$('palette').value) $('palette').value = 'native'; // 知らない配色の名前は、柄の本来の色に読み替える
  for (const id of CHECKS) { const v = q.get(id); $(id).checked = v === null ? $(id).dataset.initial === '1' : v === '1'; }
  $('repeatgrid').checked = q.get('grid') === '1';
  seed = +(q.get('seed') || 0) || SEED0;
  shuf = q.has('shuf') ? +(q.get('shuf') || 0) || 0 : SHUF0;
  picked.clear();
  showSources = q.get('sources') === '1';
  if (q.get('compare') === '6') $('compare').value = '10'; // 「6方式を並べる」はなくした。古い URL は「はめ方を比べる」に読み替える
  const want = q.get('groups');
  for (const gname of want !== null ? want.split(',') : []) if (groups.includes(gname)) picked.add(gname);
  $('showsrc').checked = showSources;
}

// ---- 元に戻す・やり直す ----
// 履歴は、設定の問い合わせ文字列の並び。描き直すたびに、前と違えば1つ足す。ブラウザを閉じても残す。
// 足した画像そのものは履歴に入れない（画像は別に覚えている）。戻した先のセットがもう無ければ、そのセットは選ばれないだけ
const HIST_MAX = 200;
let hist: string[] = [], histAt = -1, replaying = false;
function record(text: string): void {
  if (replaying || hist[histAt] === text) return;
  hist = hist.slice(Math.max(0, histAt + 2 - HIST_MAX), histAt + 1); hist.push(text); histAt = hist.length - 1;
  saveText('history', JSON.stringify({ hist, at: histAt })); syncHistory();
}
function syncHistory(): void { $('undo').disabled = histAt <= 0; $('redo').disabled = histAt >= hist.length - 1; }
function travel(step: number): void {
  const to = histAt + step; if (to < 0 || to >= hist.length) return;
  histAt = to; replaying = true;
  applyQuery(hist[histAt]); drawPalEditor(); drawChips(); syncUi(); syncHistory();
  saveText('history', JSON.stringify({ hist, at: histAt }));
  void draw().finally(() => { replaying = false; });
}
$('undo').addEventListener('click', () => travel(-1));
$('redo').addEventListener('click', () => travel(1));
window.addEventListener('keydown', (ev) => {
  if (!(ev.metaKey || ev.ctrlKey) || ev.altKey) return;
  const k = ev.key.toLowerCase(), t = ev.target;
  if (k !== 'z' && k !== 'y') return;
  // 文字や数字を打つ欄の中では、ブラウザ自身の「元に戻す」に任せる
  if (t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && ['text', 'number', 'search'].includes(t.type))) return;
  ev.preventDefault();
  travel(k === 'y' || ev.shiftKey ? 1 : -1);
});


// スライダーは、動かしているあいだは数字だけ変え、離したときに描き直す。動かすたびに描くと、重い描画が何度も走る。
// 選択欄とチェックは、変えたらすぐ描き直す。名前の入力、ファイル選び、画素数の入力では描き直さない
// 色選びと配色の名前（#pal-box の中）は、表示だけ合わせる。描き直しは自分のリスナーでやる
const QUIET = ['ownname', 'own', 'ownkind', 'ow', 'oh', 'size', 'size-jog', 'showsrc', 'lang'];
const isSlider = (t: EventTarget | null): boolean => t instanceof HTMLInputElement && t.type === 'range';
// 動かし方の設定は、絵を描き直さない。動きだけ変える
$('sheet').addEventListener('input', (ev) => { const id = (ev.target as HTMLElement).id; if (MOTION_IDS.includes(id)) { ev.stopImmediatePropagation(); syncUi(); if (!isSlider(ev.target)) { writeUrl(); if (id === 'lava' || id === 'motion') void startLava(); } } });
$('sheet').addEventListener('change', (ev) => { const id = (ev.target as HTMLElement).id; if (MOTION_IDS.includes(id)) { ev.stopImmediatePropagation(); if (isSlider(ev.target)) { writeUrl(); if (id === 'mlava' || id === 'mgrow' || (id === 'msec' && $('lava').checked)) void startLava(); } } });
$('sheet').addEventListener('input', (ev) => { if (QUIET.includes((ev.target as HTMLElement).id)) return; syncUi(); if ((ev.target as HTMLElement).closest('#pal-box')) return; if (!isSlider(ev.target)) void draw(); });
$('sheet').addEventListener('change', (ev) => { if (isSlider(ev.target) && !QUIET.includes((ev.target as HTMLElement).id)) void draw(); });
for (const id of ['ow', 'oh']) $(id).addEventListener('change', () => { $(id).value = String(clampPx($(id).value)); syncUi(); void draw(); }); // 数字は打ち終わってから描き直す
$('size').addEventListener('change', () => { fixSize(); syncUi(); void draw(); });
$('size-up').addEventListener('click', () => stepSize(1.25));
$('size-down').addEventListener('click', () => stepSize(1 / 1.25));
// 足した配色を選んだら、その色を下の色選びに映す。そこから直して、同じ名前で上書きもできる
$('palette').addEventListener('input', () => {
  const v = $('palette').value, own = ownPalette(v);
  if (own) { draft = [...own.colors]; $('pal-name').value = own.name; drawPalEditor(); }
  if (own || v === 'custom') $<HTMLDetailsElement>('pal-box').open = true;
});
$('pal-save').addEventListener('click', () => {
  let name = $('pal-name').value.trim(), k = 1;
  if (!name) do name = `配色 ${k++}`; while (ownPalettes.some((p) => p.name === name));
  const at = ownPalettes.findIndex((p) => p.name === name), entry = { name, colors: [...draft] };
  if (at >= 0) ownPalettes[at] = entry; else ownPalettes.push(entry);
  storePalettes(); drawPaletteOptions();
  $('palette').value = `my:${name}`; $('pal-name').value = name;
  syncUi(); void draw();
});
// 消しても、色は下の色選びに残る。間違えて消したら、もう一度「配色に足す」で戻せる
$('pal-del').addEventListener('click', () => {
  const own = ownPalette($('palette').value);
  if (!own) return;
  ownPalettes = ownPalettes.filter((p) => p !== own);
  storePalettes(); drawPaletteOptions();
  $('palette').value = 'custom';
  syncUi(); void draw();
});
$('reseed').addEventListener('click', () => { seed = Math.floor(Math.random() * 90000) + 10000; void draw(); });
$('shuffle').addEventListener('click', () => { shuf = Math.floor(Math.random() * 90000) + 10000; void draw(); });
// ---- 画像を追加：選ぶ → 背景除去のしかた → 名前 → 追加 ----
/** 選んだだけで、まだ足していない画像 */
let ownFiles: File[] = [];
function syncOwn(): void {
  const n = ownFiles.length;
  $('own-picked').textContent = n ? `${n}枚を選択：${ownFiles.slice(0, 3).map((f) => f.name).join('、')}${n > 3 ? ' ほか' : ''}` : '未選択。1セットにする画像をまとめて選択してください。';
  $('ownadd').disabled = !n || ownBusy;
  $('ownadd').textContent = ownBusy ? '追加中…' : n ? `${n}枚を追加` : '追加';
}
$('own').addEventListener('change', () => { ownFiles = [...($('own').files || [])]; syncOwn(); });
$('ownadd').addEventListener('click', async () => {
  const files = ownFiles;
  if (!files.length || ownBusy) return;
  ownBusy = true; syncOwn();
  // 1回の追加が1つのセット。名前は入力欄から。空欄の場合：001、002… の連番。同じ名前がすでにあれば番号を足して別のセットにする
  const nameBox = $('ownname'), want = nameBox.value.trim();
  let name = want, k = 1;
  if (!name) { do name = String(k++).padStart(3, '0'); while (groups.includes(name)); }
  else while (groups.includes(name)) name = `${want} ${++k}`;
  let added = 0, failed = '';
  const kind = $('ownkind').value as CutKind;
  for (const f of files) {
    setBusy(kind === 'asis' ? `画像を読み込み中… ${added + 1}/${files.length}` : `背景を除去中… ${added + 1}/${files.length}${added ? '' : '（初回はモデルの読み込みに時間がかかります）'}`);
    await paintNow(); // 文言を先に画面へ出す
    try { all.push(await addOwnImage(f, name, kind)); added++; } catch (e) { failed = `読み込めませんでした: ${f.name}（${e instanceof Error ? e.message : e}）`; console.error(e); }
  }
  ownBusy = false; setBusy(null);
  if (failed) setStatus(failed);
  if (!added) { syncOwn(); return; }
  ownFiles = []; $('own').value = ''; nameBox.value = ''; syncOwn(); // 次のセットのために空に戻す。背景除去のしかたは選んだまま残す
  groups.push(name); picked.add(name);
  drawChips(); // ここで枚数の上限が、足したセットに合わせて広がる
  if (+$('per').value < +$('per').max) $('per').value = String(Math.min(+$('per').max, +$('per').value + added)); // 足した枚数ぶん、使う枚数も増やす
  syncUi(); void draw();
});
let forgetArmed = 0;
$('ownforget').addEventListener('click', async () => { // 押し間違いで消えないよう、2回押して消す
  const btn = $('ownforget');
  if (Date.now() - forgetArmed > 4000) { forgetArmed = Date.now(); btn.textContent = '削除を確定（もう一度押す）'; btn.classList.add('danger'); setTimeout(() => { if (Date.now() - forgetArmed >= 4000) btn.textContent = '追加したセットをすべて削除'; btn.classList.remove('danger'); }, 4100); return; }
  forgetArmed = 0; btn.textContent = '追加したセットをすべて削除'; btn.classList.remove('danger');
  await forgetOwnImages();
  const gone = new Set(all.filter((s) => s.set === 'own').map((s) => s.group));
  all = all.filter((s) => s.set !== 'own'); groups = groups.filter((gname) => !gone.has(gname) || all.some((s) => s.group === gname));
  for (const gname of gone) if (!groups.includes(gname)) { picked.delete(gname); const dead = [...sent].filter((id) => id.startsWith('own-')); for (const id of dead) sent.delete(id); engine.dropMaterials(dead); }
  drawChips(); syncUi(); void draw();
});
$('showsrc').addEventListener('change', () => { showSources = $('showsrc').checked; void draw(); });
$('save').addEventListener('click', async () => {
  if (exporting) return;
  exporting = true; // 保存先を選んでいるあいだも、二度押しと描き直しを止める
  const save = await pickSave(`anyflage-${$('compare').value ? 'compare-' : ''}${seed}-${stamp()}.png`, 'PNG 画像', 'image/png', '.png');
  if (!save) { exporting = false; if (wanted) void draw(); return; }
  const btn = $('save'), [ew, eh] = dims(exportLong());
  btn.disabled = true; btn.textContent = '書き出し中…';
  setStatus(''); setBusy(`書き出し中…（${ew}×${eh} px）`);
  await paintNow();
  const done = (msg: string): void => { exporting = false; btn.disabled = false; btn.textContent = 'PNG を保存'; setBusy(null); setStatus(msg); if (wanted) void draw(); }; // 書き出しのあいだに設定が変わっていたら、ここで描き直す
  try {
    const c = await produce(exportLong(), false);
    setBusy('ファイルを作成中…'); await paintNow();
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
    if (!blob) { done('画像を作成できませんでした。'); return; }
    await save(blob);
    done(`保存しました：${c.width}×${c.height} px`);
  } catch (e) { done(e instanceof Error ? e.message : String(e)); }
});

engine.sendSwatches(await loadSwatches());
for (const kind of ['その他', '実物', '軍用', '狩猟'] as const) {
  const og = document.createElement('optgroup'); og.label = kind === 'その他' ? '標準・その他' : kind === '実物' ? '実物（見本画像から）' : `${kind}（近似）`;
  for (const pt of PATTERNS.filter((x) => x.kind === kind)) { const o = document.createElement('option'); o.value = pt.id; o.textContent = pt.name; og.appendChild(o); }
  $('pattern').appendChild(og);
}
all = [...(await loadManifests()), ...(await restoreOwnImages())]; // 前に足した画像も読み戻す
groups = [...new Set(all.map((s) => s.group))];
loadPalettes(); drawPaletteOptions(); // 配色の一覧を先に作る。設定を当てる前に選択肢が要る
// 言語。最初はブラウザの設定に合わせる。前に選んでいればそれ。比較表示の絵には文字が入るので、切り替えたら描き直す
$('lang').value = initialLang(); setLang($('lang').value as Lang);
$('lang').addEventListener('change', () => { setLang($('lang').value as Lang); void draw(); });
rememberDefaults();
// URL に指定があればそれを使う。なければ、前に閉じたときの状態から始める
const startText = location.search.length > 1 ? location.search.slice(1) : loadText('last') || '';
try { const saved = JSON.parse(loadText('history') || 'null'); if (saved && Array.isArray(saved.hist)) { hist = saved.hist.filter((x: unknown) => typeof x === 'string').slice(-HIST_MAX); histAt = Math.min(hist.length - 1, Math.max(-1, saved.at | 0)); } } catch { /* 壊れた履歴は使わない */ }
if (startText) applyQuery(startText); else applyQuery('');
if (!startText) { picked.clear(); for (const gname of groups.slice(0, 1)) picked.add(gname); } // 何も覚えていなければ、先頭のセット（公開版では sample）
drawPalEditor();
drawChips(); syncUi(); syncHistory(); void draw();
