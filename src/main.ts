// テスト画面。samples/ の切り抜きを迷彩に押し込み、方式を切り替えたり並べたりして見る。
// 状態は URL の ? に書ける（例 ?groups=ヒト,ネコ&method=harmonic&compare=6&seed=48213）。
import { Kao } from './engine/kao.ts';
import { PATTERNS, patternById } from './engine/patterns.ts';
import type { Method, Params, RGB } from './engine/types.ts';
import * as engine from './client.ts';
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
let all: Sample[] = [], groups: string[] = [];
const picked = new Set<string>(), sent = new Set<string>(); // sent：描く Worker に渡した素材
let ownBusy = false, exporting = false;
let seed = 48213, shuf = 0, showSources = false, lastBlobs = 0;
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
let sizeGood = 17;
/** 入力欄の値を確かめて、使える値に直す。直したときは理由を出す */
function fixSize(): void {
  const el = $('size'), v = +el.value, ok = el.value.trim() !== '' && Number.isFinite(v) && v > 0;
  let s = ok ? v : sizeGood, note = ok ? '' : `0 より大きい数字を入れて。${sizeGood}% のままにした。`;
  if (s < SIZE_MIN) { s = SIZE_MIN; note = `${SIZE_MIN}% より小さくしても、ブロブが1画素より小さいまま変わらない。${SIZE_MIN}% で止めた。`; }
  if (s > SIZE_MAX) { s = SIZE_MAX; note = `${SIZE_MAX}% より大きくしても、画面ぜんぶが1つのブロブのまま変わらない。${SIZE_MAX}% で止めた。`; }
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
  catch { palMsg = 'このブラウザには保存できなかった。開き直すと消える。URL には色が残る。'; }
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
  const og = document.createElement('optgroup'); og.id = 'pal-mine'; og.label = '自分の配色';
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
    const x = document.createElement('button'); x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', `${i + 1}色目を消す`); x.disabled = draft.length <= 1;
    x.addEventListener('click', () => { draft.splice(i, 1); drawPalEditor(); draftChanged(); });
    w.append(c, x); box.appendChild(w);
  });
  const add = document.createElement('button'); add.type = 'button'; add.id = 'pal-add'; add.textContent = '＋ 色を足す'; add.disabled = draft.length >= PAL_MAX;
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
  const per = +$('per').value;
  // shuf が 0 なら並び順の先頭から。それ以外は種類ごとに並びをかき混ぜてから取る
  return groups.filter((g) => picked.has(g)).flatMap((g) => {
    const list = all.filter((s) => s.group === g);
    if (!shuf) return list.slice(0, per);
    return list.map((s, i) => ({ s, k: Kao.hash2(i, 71, shuf) })).sort((a, b) => a.k - b.k).slice(0, per).map((e) => e.s);
  });
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
  const job: Job = { kind, W, H, p: { ...p, layerAt: undefined }, colors: colors(p.pattern || 'blob') as number[][], mats, mat: matOptions(), soft: $('soft').checked, edges: $('edges').checked, reuse };
  const r = await engine.render(job);
  lastBlobs = r.blobs;
  return new ImageData(r.data, r.W, r.H);
}
interface Tile { label: string; p: Params }
/** 同じ素材で、方式だけ、または柄だけ変えて並べる */
async function renderSheet(tile: number, cols: number, tiles: Tile[], src: string[], stale: () => boolean): Promise<HTMLCanvasElement> {
  const rows = Math.ceil(tiles.length / cols);
  const c = document.createElement('canvas'); c.width = tile * cols; c.height = tile * rows;
  const g = c.getContext('2d')!, fs = Math.max(11, Math.round(tile / 24));
  for (let k = 0; k < tiles.length; k++) {
    if (stale()) break; // 新しい描き直しが待っている。残りは描かない
    const t = tiles[k];
    setBusy(`描いている… ${k + 1}/${tiles.length}`);
    const x = (k % cols) * tile, y = Math.floor(k / cols) * tile;
    g.putImageData(await paint('one', tile, tile, src, t.p, false), x, y);
    g.font = `700 ${fs}px "Hiragino Sans", sans-serif`; g.textBaseline = 'top';
    g.fillStyle = 'rgba(20,23,15,.82)'; g.fillRect(x, y, g.measureText(t.label).width + fs, fs * 1.7);
    g.fillStyle = '#F3F4EA'; g.fillText(tr(t.label), x + fs / 2, y + fs * 0.35);
  }
  g.fillStyle = 'rgba(20,23,15,.82)';
  for (let k = 1; k < cols; k++) g.fillRect(k * tile - 1, 0, 2, c.height);
  for (let k = 1; k < rows; k++) g.fillRect(0, k * tile - 1, c.width, 2);
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
  await engine.prepare(mats, matOptions(), method, p.mix === undefined ? 0.5 : p.mix, p.imp || 0, !!p.trim, (done, total) => setBusy(`素材を準備している… ${done}/${total}`));
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
  if (reuse) setBusy('描いている…'); else setBusy(`書き出している…（${dims(longEdge).join('×')} px。数秒かかる）`);
  if (cmp === 'orig') { // 左に押し込んだ後、右に元の素材
    const [W, H] = dims(Math.round(longEdge * 2 / 3)), c = document.createElement('canvas'); c.width = W * 2 + 8; c.height = H;
    const g = c.getContext('2d')!; g.fillStyle = '#14170F'; g.fillRect(0, 0, c.width, H);
    g.putImageData(await paint('one', W, H, src, p, reuse), 0, 0); g.putImageData(await paint('orig', W, H, src, p, reuse), W + 8, 0);
    return c;
  }
  const [W, H] = dims(longEdge);
  // リピートできる絵。画面では 2×2 に並べて、継ぎ目を見られるようにする。書き出しは1枚
  if ($('repeat').checked) return canvasOf(await paint('tile', W, H, src, p, reuse), reuse ? 2 : 1);
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
  setBusy('描いている…');
  try {
    const cmp = $('compare').value;
    const c = await produce(cmp ? 1080 : $('repeat').checked ? PREVIEW : previewLong(), true, () => wanted);
    if (wanted && cmp) return; // 並べて比べる絵を、途中でやめた。次の描き直しに任せる
    keepBefore(); // 描き替える前の絵を取っておく。「前の絵」ボタンで見比べられる
    const resized = view.width !== c.width || view.height !== c.height;
    view.width = c.width; view.height = c.height; ctx.drawImage(c, 0, 0);
    drawn = true;
    if (resized) layoutView(); // 絵の大きさが変わったら、置き方を合わせ直す
    drawBackdrop(); // 柄や色が変わっていれば、枠の背景も描き直す
    const n = chosen().length;
    $('s-info').textContent = showSources ? `素材 ${n}枚` : `シード ${seed}・ブロブ ${lastBlobs}・素材 ${n}枚・${Math.round(performance.now() - t0)}ms`;
    setStatus(all.length ? (n ? '' : '種類を1つ選んで。') : '素材がまだない。「自分の画像を足す」から入れて。');
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
  // 枚数の上限は、いま選んでいるセットのうち、いちばん多いセットの枚数。右端まで動かせば、選んだセットを全部使う。
  // 上限いっぱいにしていたときは、セットを選び直しても上限に付いていく（「全部使う」のまま）
  const sel = groups.filter((gname) => picked.has(gname)), per = $('per'), wasAll = +per.value >= +per.max && +per.max < 9999;
  const most = Math.max(1, ...(sel.length ? sel : groups).map((gname) => all.filter((s) => s.group === gname).length));
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
function syncPer(): void { const per = $('per'); $('o-per').textContent = +per.value >= +per.max && +per.max > 1 ? `全部（${per.value}枚）` : `${per.value}枚`; }
function syncUi(): void {
  for (const id of SLIDERS) if (id === 'per') syncPer(); else $(`o-${id}`).textContent = id === 'softlim' ? `${$(id).value}升` : `${$(id).value}%`;
  const m = $('method').value as Method, cv = $('compare').value, cmp = cv === '10';
  $('method').disabled = cmp; $('pattern').disabled = cv === 'patterns';
  $('pattern-note').textContent = patternById($('pattern').value).note;
  $('softlim').disabled = !$('soften').checked;
  $('repeat-note').hidden = !$('repeat').checked;
  $('own-size').hidden = $('ratio').value !== 'custom';
  const pv = $('palette').value, pn = $('pal-name').value.trim(), K = patternById($('pattern').value).colors.length;
  $('pal-del').disabled = !ownPalette(pv);
  $('pal-save').textContent = pn && ownPalettes.some((q) => q.name === pn) ? `「${pn}」を上書きする` : '配色に足す';
  $('pal-note').textContent = `いま${draft.length}色。この柄は${K}色を使う。数が違うときは、色のあいだを補って配る。${palMsg}`;
  const [ew, eh] = dims(exportLong()); $('out-size').textContent = `書き出しの大きさ：${ew}×${eh} px`;
  $('squeeze').disabled = !cmp && !(m === 'radial' || m === 'elastic');
  $('fit').disabled = !cmp && m !== 'radial';
  $('mix').disabled = !cmp && !HYBRID.includes(m);
  $('imp').disabled = !cmp && !['area', 'areaharm', 'blend'].includes(m);
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
  view.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
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

// ---- URL との行き来 ----
const FIELDS = [...SLIDERS, 'size', 'method', 'compare', 'assign', 'ratio', 'ow', 'oh', 'palette', 'pattern', 'split'];
function writeUrl(): void {
  const q = new URLSearchParams();
  q.set('groups', [...picked].join(','));
  for (const id of FIELDS) { const el = $(id); if (el.value !== el.dataset.initial) q.set(id, el.value); }
  const pv = $('palette').value; // 自分の配色は、名前ではなく色そのものを書く。ほかのブラウザでも同じ色で開ける
  if (pv === 'custom' || pv.startsWith('my:')) { q.set('palette', 'custom'); q.set('colors', (paletteBase() || draft).map((h) => h.slice(1)).join('-')); }
  if (!$('fitblob').checked) q.set('fitblob', '0');
  if (!$('smooth').checked) q.set('smooth', '0');
  if (!$('soft').checked) q.set('soft', '0');
  if (!$('trim').checked) q.set('trim', '0');
  if (!$('soften').checked) q.set('soften', '0');
  if ($('edges').checked) q.set('edges', '1');
  if ($('repeat').checked) q.set('repeat', '1');
  if (showSources) q.set('sources', '1');
  q.set('seed', String(seed));
  if (shuf) q.set('shuf', String(shuf));
  const text = q.toString();
  history.replaceState(null, '', `?${text}`);
  saveText('last', text); // ブラウザを閉じても、最後の状態から始められるように
  record(text);
}
/** 最初の値を覚える。applyQuery が「指定のない項目は最初の値に戻す」ために使う。起動時に1回だけ */
const SEED0 = seed;
function rememberDefaults(): void { for (const id of FIELDS) $(id).dataset.initial = $(id).value; }
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
  for (const id of ['fitblob', 'smooth', 'soft', 'trim', 'soften']) $(id).checked = q.get(id) !== '0';
  $('edges').checked = q.get('edges') === '1';
  $('repeat').checked = q.get('repeat') === '1';
  seed = +(q.get('seed') || 0) || SEED0;
  shuf = +(q.get('shuf') || 0) || 0;
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
// ---- 自分の画像を足す：選ぶ → 背景除去のしかた → 名前 → 追加 ----
/** 選んだだけで、まだ足していない画像 */
let ownFiles: File[] = [];
function syncOwn(): void {
  const n = ownFiles.length;
  $('own-picked').textContent = n ? `${n}枚選んだ：${ownFiles.slice(0, 3).map((f) => f.name).join('、')}${n > 3 ? ' ほか' : ''}` : 'まだ選んでいない。まとめて入れたい画像は、一度に複数選ぶ。';
  $('ownadd').disabled = !n || ownBusy;
  $('ownadd').textContent = ownBusy ? '追加している…' : n ? `${n}枚を追加する` : '追加する';
}
$('own').addEventListener('change', () => { ownFiles = [...($('own').files || [])]; syncOwn(); });
$('ownadd').addEventListener('click', async () => {
  const files = ownFiles;
  if (!files.length || ownBusy) return;
  ownBusy = true; syncOwn();
  // 1回の追加が1つのセット。名前は入力欄から。空なら 001、002… の連番。同じ名前がすでにあれば番号を足して別のセットにする
  const nameBox = $('ownname'), want = nameBox.value.trim();
  let name = want, k = 1;
  if (!name) { do name = String(k++).padStart(3, '0'); while (groups.includes(name)); }
  else while (groups.includes(name)) name = `${want} ${++k}`;
  let added = 0, failed = '';
  const kind = $('ownkind').value as CutKind;
  for (const f of files) {
    setBusy(kind === 'asis' ? `画像を読んでいる… ${added + 1}/${files.length}` : `背景を除いている… ${added + 1}/${files.length}${added ? '' : '（最初の1枚はモデルを読むので時間がかかる）'}`);
    await paintNow(); // 文言を先に画面へ出す
    try { all.push(await addOwnImage(f, name, kind)); added++; } catch (e) { failed = `読めなかった: ${f.name}（${e instanceof Error ? e.message : e}）`; console.error(e); }
  }
  ownBusy = false; setBusy(null);
  if (failed) setStatus(failed);
  if (!added) { syncOwn(); return; }
  ownFiles = []; $('own').value = ''; nameBox.value = ''; syncOwn(); // 次のセットのために空に戻す。背景除去のしかたは選んだまま残す
  groups.push(name); picked.add(name);
  drawChips(); // ここで枚数の上限が、足したセットに合わせて広がる
  if (+$('per').value < added) $('per').value = String(added); // 足した枚数ぶんは使う
  syncUi(); void draw();
});
let forgetArmed = 0;
$('ownforget').addEventListener('click', async () => { // 押し間違いで消えないよう、2回押して消す
  const btn = $('ownforget');
  if (Date.now() - forgetArmed > 4000) { forgetArmed = Date.now(); btn.textContent = '本当に消す（もう一度押す）'; btn.classList.add('danger'); setTimeout(() => { if (Date.now() - forgetArmed >= 4000) btn.textContent = '足したセットを全部消す'; btn.classList.remove('danger'); }, 4100); return; }
  forgetArmed = 0; btn.textContent = '足したセットを全部消す'; btn.classList.remove('danger');
  await forgetOwnImages();
  const gone = new Set(all.filter((s) => s.set === 'own').map((s) => s.group));
  all = all.filter((s) => s.set !== 'own'); groups = groups.filter((gname) => !gone.has(gname) || all.some((s) => s.group === gname));
  for (const gname of gone) if (!groups.includes(gname)) { picked.delete(gname); const dead = [...sent].filter((id) => id.startsWith('own-')); for (const id of dead) sent.delete(id); engine.dropMaterials(dead); }
  drawChips(); syncUi(); void draw();
});
$('showsrc').addEventListener('change', () => { showSources = $('showsrc').checked; void draw(); });
$('save').addEventListener('click', async () => {
  if (exporting) return;
  const btn = $('save'), [ew, eh] = dims(exportLong());
  exporting = true; btn.disabled = true; btn.textContent = '書き出している…';
  setStatus(''); setBusy(`書き出している…（${ew}×${eh} px。数秒かかる）`);
  await paintNow();
  const done = (msg: string): void => { exporting = false; btn.disabled = false; btn.textContent = 'PNGを保存'; setBusy(null); setStatus(msg); if (wanted) void draw(); }; // 書き出しのあいだに設定が変わっていたら、ここで描き直す
  try {
    const c = await produce(exportLong(), false);
    setBusy('ファイルにしている…'); await paintNow();
    c.toBlob((blob) => {
      if (!blob) { done('画像を作れなかった。'); return; }
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = `anyflage-${$('compare').value ? 'compare-' : ''}${seed}.png`; a.click();
      done(`保存した。${c.width}×${c.height} px`);
    }, 'image/png');
  } catch (e) { done(e instanceof Error ? e.message : String(e)); }
});

engine.sendSwatches(await loadSwatches());
for (const kind of ['その他', '実物', '軍用', '狩猟'] as const) {
  const og = document.createElement('optgroup'); og.label = kind === 'その他' ? '標準・その他' : kind === '実物' ? '実物の形（見本画像から）' : `${kind}（手続きで近似）`;
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
