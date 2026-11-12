// テスト画面。samples/ の切り抜きを迷彩に押し込み、方式を切り替えたり並べたりして見る。
// 状態は URL の ? に書ける（例 ?groups=ヒト,ネコ&method=harmonic&compare=6&seed=48213）。
import { Kao } from './engine/kao.ts';
import { PATTERNS, patternById } from './engine/patterns.ts';
import type { Camo, Method, Params, Picker, Raster, RGB } from './engine/types.ts';
import { Material } from './material.ts';
import { addOwnImage, loadCutout, loadManifests } from './samples.ts';
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
};
/** 書き出しの長辺。Instagram 用は仕様の画素数、ほかは EXPORT */
function exportLong(): number { const k = $('ratio').value, r = RATIOS[k] || RATIOS['1:1']; return k.startsWith('ig-') ? Math.max(r[0], r[1]) : EXPORT; }
const LABELS: Record<Method, string> = {
  radial: '放射', harmonic: '調和写像', elastic: '詰め物', area: '面積均等', contour: '輪郭追従',
  areaharm: '輪郭は面積・内側は調和', diffuse: '密度拡散', energy: '歪みエネルギー最小', blend: '単純に混ぜる', carve: '形にカービング',
};
const TILES: Record<string, Method[]> = {
  '10': ['radial', 'harmonic', 'elastic', 'area', 'contour', 'areaharm', 'diffuse', 'energy', 'blend', 'carve'],
};
const HYBRID: Method[] = ['areaharm', 'diffuse', 'energy', 'blend'];
const SLIDERS = ['per', 'softlim', 'neck', 'notch', 'flat', 'mix', 'carve', 'protect', 'imp', 'size', 'wobble', 'squeeze', 'fit', 'dist', 'rot', 'tint'];
const PREVIEW = 720, EXPORT = 2400;

const view = $<HTMLCanvasElement>('view'), ctx = view.getContext('2d')!;
let all: Sample[] = [], groups: string[] = [];
const picked = new Set<string>(), materials = new Map<string, Material>();
let seed = 48213, shuf = 0, showSources = false, camo: Camo | null = null, camoKey = '', token = 0;

function params(patternId = $('pattern').value): Params {
  const pat = patternById(patternId), size = num('size');
  return {
    pattern: pat.id, layerAt: pat.id === 'blob' ? undefined : pat.make(seed, size), flatBelow: pat.flatBelow * num('flat'), flatLayers: pat.flatLayers, noSplit: pat.noSplit, split: $('split').value,
    seed, size, neck: num('neck'), notch: num('notch'), wobble: num('wobble'), fit: num('fit'), dist: num('dist'), rot: num('rot'), zoom: 1, tint: num('tint'),
    smooth: $('smooth').checked, trim: $('trim').checked, assign: $('assign').value, method: $('method').value as Method, imp: num('imp'), mix: num('mix'), squeeze: num('squeeze'),
  };
}
const rgb = (h: string): number[] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
/** 柄の本来の色か、選んだ配色。配色は4色なので、層が多い柄には4色のあいだを補って配る */
function colors(patternId: string): RGB[] {
  const pat = patternById(patternId), name = $('palette').value;
  if (name === 'native') return pat.colors.map(rgb);
  const base = PALETTES[name].map(rgb), K = pat.colors.length;
  return pat.colors.map((_, k) => {
    const t = K > 1 ? k / (K - 1) * 3 : 0, i = Math.min(2, Math.floor(t)), f = t - i;
    return base[i].map((c, ch) => Math.round(c + (base[i + 1][ch] - c) * f));
  });
}
function dims(longEdge: number): [number, number] {
  const r = RATIOS[$('ratio').value] || RATIOS['1:1'], m = Math.max(r[0], r[1]);
  return [Math.round(longEdge * r[0] / m), Math.round(longEdge * r[1] / m)];
}
function setStatus(t: string): void { $('status').textContent = t; }

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
/** 包みから、縮める前の切り抜きを引く。「元の素材と並べる」用 */
const rawOf = new WeakMap<Picker, Raster>();
async function sources(): Promise<Picker[]> {
  const o = { carve: num('carve'), protect: num('protect'), fitBlob: $('fitblob').checked, soften: $('soften').checked, softLimit: +$('softlim').value }, out: Picker[] = [];
  for (const s of chosen()) {
    let m = materials.get(s.id);
    if (!m) { m = new Material(await loadCutout(s)); materials.set(s.id, m); }
    const p = m.picker(o);
    if (p) { out.push(p); rawOf.set(p, m.raw); }
  }
  return out;
}

function getCamo(W: number, H: number, p: Params, reuse: boolean): Camo {
  const key = [W, H, p.seed, p.size, p.wobble, p.pattern, p.neck, p.notch, p.split].join('|');
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
function softenEdges(img: ImageData, cam: Camo): void {
  const W = img.width, H = img.height, ids = cam.ids, d = img.data, src = new Uint8ClampedArray(d);
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
function renderOne(W: number, H: number, src: Picker[], p: Params, reuse: boolean): ImageData {
  const img = new ImageData(W, H);
  const cam = getCamo(W, H, p, reuse);
  Kao.renderCamo(img.data, cam, src, colors(p.pattern || 'blob'), p);
  if ($('soft').checked) softenEdges(img, cam);
  if ($('edges').checked) { // ブロブの境目を白い線で描く。どこで切れているか見る用
    const ids = cam.ids, d = img.data;
    for (let y = 0; y < H - 1; y++) for (let x = 0, i = y * W; x < W - 1; x++, i++) if (ids[i] !== ids[i + 1] || ids[i] !== ids[i + W]) { d[i * 4] = 255; d[i * 4 + 1] = 255; d[i * 4 + 2] = 255; }
  }
  return img;
}
/**
 * 押し込む前の素材を、同じブロブの場所にそのまま置いた絵。歪めない。縮めない。
 * ブロブの外接矩形に収まる大きさで中央に置き、ブロブの形で切り抜く。どの素材がどのブロブに入るか、左右の向きはエンジンと同じ決め方。
 */
function renderOriginals(W: number, H: number, src: Picker[], p: Params, reuse: boolean): ImageData {
  const img = new ImageData(W, H), d = img.data, cam = getCamo(W, H, p, reuse), cm = cam.comps, ids = cam.ids, cols = colors(p.pattern || 'blob');
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
  return img;
}
interface Tile { label: string; p: Params }
/** 同じ素材で、方式だけ、または柄だけ変えて並べる */
function renderSheet(tile: number, cols: number, tiles: Tile[], src: Picker[], reuse: boolean): HTMLCanvasElement {
  const rows = Math.ceil(tiles.length / cols);
  const c = document.createElement('canvas'); c.width = tile * cols; c.height = tile * rows;
  const g = c.getContext('2d')!, fs = Math.max(11, Math.round(tile / 24));
  tiles.forEach((t, k) => {
    const x = (k % cols) * tile, y = Math.floor(k / cols) * tile;
    g.putImageData(renderOne(tile, tile, src, t.p, reuse), x, y);
    g.font = `700 ${fs}px "Hiragino Sans", sans-serif`; g.textBaseline = 'top';
    g.fillStyle = 'rgba(20,23,15,.82)'; g.fillRect(x, y, g.measureText(t.label).width + fs, fs * 1.7);
    g.fillStyle = '#F3F4EA'; g.fillText(t.label, x + fs / 2, y + fs * 0.35);
  });
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
    g.fillText(`${list[k].group} ${list[k].label}`, x + 6, y + 4);
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
async function produce(longEdge: number, reuse: boolean): Promise<HTMLCanvasElement> {
  if (showSources) return renderSources();
  const src = await sources(), cmp = $('compare').value;
  if (cmp === 'orig') { // 左に押し込んだ後、右に元の素材
    const [W, H] = dims(Math.round(longEdge * 2 / 3)), p = params(), c = document.createElement('canvas'); c.width = W * 2 + 8; c.height = H;
    const g = c.getContext('2d')!; g.fillStyle = '#14170F'; g.fillRect(0, 0, c.width, H);
    g.putImageData(renderOne(W, H, src, p, reuse), 0, 0); g.putImageData(renderOriginals(W, H, src, p, reuse), W + 8, 0);
    return c;
  }
  if (cmp === 'patterns') return renderSheet(Math.round(longEdge / 3), bestCols(PATTERNS.length), PATTERNS.map((pt) => ({ label: pt.name, p: params(pt.id) })), src, false);
  if (cmp) { const p = params(); return renderSheet(Math.round(longEdge / 2.5), bestCols(TILES[cmp].length), TILES[cmp].map((m) => ({ label: LABELS[m], p: { ...p, method: m } })), src, reuse); }
  const [W, H] = dims(longEdge), c = document.createElement('canvas'); c.width = W; c.height = H;
  c.getContext('2d')!.putImageData(renderOne(W, H, src, params(), reuse), 0, 0);
  return c;
}

async function draw(): Promise<void> {
  const mine = ++token, t0 = performance.now();
  setStatus('描いている…');
  await new Promise((r) => setTimeout(r, 20)); // 「描いている」を先に画面へ出す
  if (mine !== token) return;
  try {
    const c = await produce($('compare').value ? 1080 : PREVIEW, true);
    if (mine !== token) return;
    const resized = view.width !== c.width || view.height !== c.height;
    view.width = c.width; view.height = c.height; ctx.drawImage(c, 0, 0);
    if (resized) layoutView(); // 絵の大きさが変わったら、置き方を合わせ直す
    const n = chosen().length;
    $('s-info').textContent = showSources ? `素材 ${n}枚` : `シード ${seed}・ブロブ ${camo ? camo.comps.count : 0}・素材 ${n}枚・${Math.round(performance.now() - t0)}ms`;
    setStatus(all.length ? (n ? '' : '種類を1つ選んで。') : '素材がまだない。「自分の画像を足す」から入れて。');
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e));
  }
  writeUrl();
}

function drawChips(): void {
  $('empty').hidden = all.length > 0;
  if (!all.length) $<HTMLDetailsElement>('own-box').open = true; // 画像セットがないときは、足す手順を開いておく
  const box = $<HTMLDivElement>('groups'); box.textContent = '';
  for (const gname of groups) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = gname;
    const n = document.createElement('small'); n.textContent = String(all.filter((s) => s.group === gname).length); b.appendChild(n);
    b.setAttribute('aria-pressed', picked.has(gname) ? 'true' : 'false');
    b.addEventListener('click', () => { if (picked.has(gname)) picked.delete(gname); else picked.add(gname); drawChips(); void draw(); });
    box.appendChild(b);
  }
}
function syncUi(): void {
  for (const id of SLIDERS) $(`o-${id}`).textContent = id === 'per' ? `${$(id).value}枚` : id === 'softlim' ? `${$(id).value}升` : `${$(id).value}%`;
  const m = $('method').value as Method, cv = $('compare').value, cmp = cv === '10';
  $('method').disabled = cmp; $('pattern').disabled = cv === 'patterns';
  $('pattern-note').textContent = patternById($('pattern').value).note;
  $('softlim').disabled = !$('soften').checked;
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
new ResizeObserver(() => layoutView()).observe(viewport);

// ---- URL との行き来 ----
const FIELDS = [...SLIDERS, 'method', 'compare', 'assign', 'ratio', 'palette', 'pattern', 'split'];
function writeUrl(): void {
  const q = new URLSearchParams();
  q.set('groups', [...picked].join(','));
  for (const id of FIELDS) { const el = $(id); if (el.value !== el.dataset.initial) q.set(id, el.value); }
  if (!$('fitblob').checked) q.set('fitblob', '0');
  if (!$('smooth').checked) q.set('smooth', '0');
  if (!$('soft').checked) q.set('soft', '0');
  if (!$('trim').checked) q.set('trim', '0');
  if (!$('soften').checked) q.set('soften', '0');
  if ($('edges').checked) q.set('edges', '1');
  if (showSources) q.set('sources', '1');
  q.set('seed', String(seed));
  if (shuf) q.set('shuf', String(shuf));
  history.replaceState(null, '', `?${q}`);
}
function readUrl(): void {
  const q = new URLSearchParams(location.search);
  for (const id of FIELDS) { const el = $(id); el.dataset.initial = el.value; const v = q.get(id); if (v !== null) el.value = v; }
  if (q.get('fitblob') === '0') $('fitblob').checked = false;
  if (q.get('smooth') === '0') $('smooth').checked = false;
  if (q.get('soft') === '0') $('soft').checked = false;
  if (q.get('trim') === '0') $('trim').checked = false;
  if (q.get('soften') === '0') $('soften').checked = false;
  if (q.get('edges') === '1') $('edges').checked = true;
  if (q.get('seed')) seed = +q.get('seed')! || seed;
  shuf = +(q.get('shuf') || 0) || 0;
  showSources = q.get('sources') === '1';
  if (q.get('compare') === '6') $('compare').value = '10'; // 「6方式を並べる」はなくした。古い URL は「はめ方を比べる」に読み替える
  const want = q.get('groups');
  for (const gname of want !== null ? want.split(',') : groups.slice(0, 2)) if (groups.includes(gname)) picked.add(gname);
}

$('sheet').addEventListener('input', (ev) => { const id = (ev.target as HTMLElement).id; if (id === 'ownname' || id === 'own' || id === 'ownkind') return; syncUi(); void draw(); }); // 名前の入力とファイル選びでは描き直さない
$('reseed').addEventListener('click', () => { seed = Math.floor(Math.random() * 90000) + 10000; void draw(); });
$('shuffle').addEventListener('click', () => { shuf = Math.floor(Math.random() * 90000) + 10000; void draw(); });
// ---- 自分の画像を足す：選ぶ → 背景除去のしかた → 名前 → 追加 ----
/** 選んだだけで、まだ足していない画像 */
let ownFiles: File[] = [], ownBusy = false;
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
    setStatus(kind === 'asis' ? `読んでいる… ${added + 1}/${files.length}` : `背景を除いている… ${added + 1}/${files.length}（最初の1枚はモデルを読むので時間がかかる）`);
    await new Promise((r) => setTimeout(r, 20)); // 文言を先に画面へ出す
    try { all.push(await addOwnImage(f, name, kind)); added++; } catch (e) { failed = `読めなかった: ${f.name}（${e instanceof Error ? e.message : e}）`; console.error(e); }
  }
  ownBusy = false;
  if (failed) setStatus(failed);
  if (!added) { syncOwn(); return; }
  ownFiles = []; $('own').value = ''; nameBox.value = ''; syncOwn(); // 次のセットのために空に戻す。背景除去のしかたは選んだまま残す
  groups.push(name); picked.add(name);
  if (+$('per').value < added) $('per').value = String(Math.min(+$('per').max, added)); // 足した枚数ぶんは使う
  drawChips(); syncUi(); void draw();
});
$('showsrc').addEventListener('click', () => { showSources = !showSources; $('showsrc').setAttribute('aria-pressed', String(showSources)); void draw(); });
$('save').addEventListener('click', async () => {
  setStatus('高解像度で描いている…');
  await new Promise((r) => setTimeout(r, 30));
  const c = await produce(exportLong(), false);
  c.toBlob((blob) => {
    if (!blob) { setStatus('画像を作れなかった。'); return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `anyflage-${$('compare').value ? 'compare-' : ''}${seed}.png`; a.click();
    setStatus(`保存した。${c.width}×${c.height} px`);
  }, 'image/png');
});

await loadSwatches();
for (const kind of ['その他', '実物', '軍用', '狩猟'] as const) {
  const og = document.createElement('optgroup'); og.label = kind === 'その他' ? '標準・その他' : kind === '実物' ? '実物の形（見本画像から）' : `${kind}（手続きで近似）`;
  for (const pt of PATTERNS.filter((x) => x.kind === kind)) { const o = document.createElement('option'); o.value = pt.id; o.textContent = pt.name; og.appendChild(o); }
  $('pattern').appendChild(og);
}
all = await loadManifests();
groups = [...new Set(all.map((s) => s.group))];
readUrl();
$('showsrc').setAttribute('aria-pressed', String(showSources));
drawChips(); syncUi(); void draw();
