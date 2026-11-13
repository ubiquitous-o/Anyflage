// 開発用。samples/museum/ の肖像画を背景除去して、公開版に最初から入れるセット「sample」を作る。
// 背景除去のモデルはブラウザでしか動かないので、ここ（precut.html）で切り抜き、開発用サーバーの /__precut に送って保存してもらう。
// 使い方：ANYFLAGE_PRECUT=1 npm run dev で起動し、ブラウザで /precut.html を開く。?kind=skin で髪なし。
// ANYFLAGE_PRECUT=1 を付けないと、保存の受け口が無いので書けない（ふだんの開発中に、ファイルを書く口を開けておかないため）。
import { cutOut } from './cutout.ts';
import type { CutKind } from './cutout.ts';
import type { Sample } from './samples.ts';

interface Credit { id: string; file: string; museum: string; title: string; artist: string; date: string; page: string }

const SET = 'sample', LONG = 1024;
const kind = (new URLSearchParams(location.search).get('kind') || 'face') as CutKind;
const log = document.getElementById('log')!, out = document.getElementById('out')!;
const say = (t: string): void => { log.textContent = t; };

function load(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => { const im = new Image(); im.onload = () => resolve(im); im.onerror = () => reject(new Error(`読めなかった: ${src}`)); im.src = src; });
}
async function send(name: string, body: Blob | string): Promise<void> {
  const r = await fetch(`/__precut?name=${encodeURIComponent(name)}`, { method: 'POST', body });
  if (!r.ok) throw new Error(`保存できなかった: ${name}（${r.status}）`);
}

const credits: Credit[] = await (await fetch('/samples/museum-credits.json')).json();
const manifest: Sample[] = [], failed: string[] = [];
for (let n = 0; n < credits.length; n++) {
  const c = credits[n];
  say(`切り抜いている… ${n + 1}/${credits.length}　${c.title}`);
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  const fig = document.createElement('figure'), cap = document.createElement('figcaption'); cap.textContent = c.id; fig.appendChild(cap); out.appendChild(fig);
  try {
    const img = await load(`/samples/${c.file}`), k = Math.min(1, LONG / Math.max(img.naturalWidth, img.naturalHeight));
    const src = document.createElement('canvas'); src.width = Math.round(img.naturalWidth * k); src.height = Math.round(img.naturalHeight * k);
    src.getContext('2d', { willReadFrequently: true })!.drawImage(img, 0, 0, src.width, src.height);
    const r = await cutOut(src, kind);
    // 何も切れずに元の絵がそのまま返ってきたら、失敗として入れない
    let clear = 0; for (let i = 3; i < r.data.length; i += 4) if (r.data[i] < 110) clear++;
    if (r.w === src.width && r.h === src.height && clear < r.w * r.h * 0.02) throw new Error('顔を切り抜けなかった');
    const cv = document.createElement('canvas'); cv.width = r.w; cv.height = r.h;
    cv.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(r.data), r.w, r.h), 0, 0);
    const blob = await new Promise<Blob | null>((res) => cv.toBlob(res, 'image/webp', 0.92));
    if (!blob) throw new Error('画像にできなかった');
    await send(`${SET}/${c.id}.webp`, blob);
    const view = new Image(); view.src = URL.createObjectURL(blob); fig.appendChild(view);
    manifest.push({ id: `${SET}-${c.id}`, set: SET, group: SET, label: c.title, image: `${SET}/${c.id}.webp`, mask: null, bbox: [0, 0, r.w, r.h],
      source: `${c.museum}「${c.title}」${c.artist}${c.date ? `、${c.date}` : ''}。CC0。${c.page}` });
  } catch (e) { fig.className = 'bad'; failed.push(`${c.id}: ${e instanceof Error ? e.message : e}`); }
}
await send(`${SET}.json`, JSON.stringify(manifest, null, 1));
say(`できた。${manifest.length}枚を public/sets/${SET}/ に書いた。種類は ${kind}。${failed.length ? `\n入れなかったもの ${failed.length}枚：\n${failed.join('\n')}` : ''}`);
