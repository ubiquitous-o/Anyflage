// 美術館が権利を放棄（CC0）して公開している肖像画を集める。
//   シカゴ美術館        https://api.artic.edu/        鍵なし。is_public_domain が true の作品だけ
//   メトロポリタン美術館  https://metmuseum.github.io/   鍵なし。isPublicDomain が true の作品だけ
// 集めた絵は samples/museum/ に、作品名・作者・年・元ページは samples/museum-credits.json に入れる。
// samples/ は .gitignore 済み。公開版に入れるものは、ここから選んで別に移す。
//
// 使い方： node scripts/collect-museum.ts [美術館ごとの枚数。省くと 20]
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SAMPLES } from './lib.ts';

interface Credit {
  id: string; file: string; museum: string;
  title: string; artist: string; date: string;
  /** 作品のページ */
  page: string;
  /** 画像を落とした URL */
  image: string;
  license: 'CC0';
}

const PER = Math.max(1, +(process.argv[2] || 20));
const DIR = join(SAMPLES, 'museum');
const UA = { 'User-Agent': 'anyflage-collect (open-access portraits)', 'AIC-User-Agent': 'anyflage-collect (open-access portraits)' };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 1人の顔が大きく写っていそうな題だけ通す。群像、家族、2人以上は落とす */
function likelySingle(title: string): boolean {
  if (!/portrait/i.test(title)) return false;
  return !/\b(family|group|children|sisters|brothers|couple|double|two|three|four|and (his|her|their)|with (his|her|their|a child|children|two))\b/i.test(title);
}

async function getJson(url: string): Promise<any> {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${url}`);
  return r.json();
}
async function save(url: string, file: string): Promise<boolean> {
  if (existsSync(file)) return true;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) { console.warn(`  落とせなかった ${r.status}: ${url}`); return false; }
  writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  return true;
}

/** シカゴ美術館。油絵（artwork_type_id=1）で、権利なしで、縦長のもの */
async function chicago(): Promise<Credit[]> {
  const out: Credit[] = [];
  for (let page = 1; out.length < PER && page <= 10; page++) {
    const q = new URLSearchParams({ q: 'portrait', limit: '40', page: String(page), fields: 'id,title,artist_display,date_display,image_id,thumbnail,is_public_domain' });
    q.set('query[bool][must][0][term][is_public_domain]', 'true');
    q.set('query[bool][must][1][term][artwork_type_id]', '1');
    const res = await getJson(`https://api.artic.edu/api/v1/artworks/search?${q}`);
    for (const a of res.data) {
      if (out.length >= PER) break;
      if (!a.is_public_domain || !a.image_id || !likelySingle(a.title || '')) continue;
      if (a.thumbnail && a.thumbnail.width > a.thumbnail.height * 1.1) continue; // 横長は群像や風景が多い
      const id = `aic-${a.id}`, file = `museum/${id}.jpg`, image = `https://www.artic.edu/iiif/2/${a.image_id}/full/843,/0/default.jpg`;
      if (!(await save(image, join(SAMPLES, file)))) continue;
      out.push({ id, file, museum: 'Art Institute of Chicago', title: a.title, artist: String(a.artist_display || '').split('\n')[0], date: a.date_display || '', page: `https://www.artic.edu/artworks/${a.id}`, image, license: 'CC0' });
      await sleep(250);
    }
  }
  return out;
}

/** メトロポリタン美術館。ヨーロッパ絵画部門（departmentId=11）とアメリカ部門（1）から */
async function met(): Promise<Credit[]> {
  const out: Credit[] = [];
  for (const dept of [11, 1]) {
    for (let offset = 0; out.length < PER && offset < 400; offset += 100) {
      const res = await getJson(`https://collectionapi.metmuseum.org/public/collection/v1.1/search?q=portrait&hasImages=true&isPublicDomain=true&departmentId=${dept}&offset=${offset}&limit=100`);
      for (const oid of res.objectIDs || []) {
        if (out.length >= PER) break;
        let o: any;
        try { o = await getJson(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${oid}`); } catch { continue; }
        await sleep(120);
        if (!o.isPublicDomain || !o.primaryImageSmall || o.classification !== 'Paintings' || !likelySingle(o.title || '')) continue;
        const id = `met-${o.objectID}`, file = `museum/${id}.jpg`;
        if (!(await save(o.primaryImageSmall, join(SAMPLES, file)))) continue;
        out.push({ id, file, museum: 'The Metropolitan Museum of Art', title: o.title, artist: o.artistDisplayName || '', date: o.objectDate || '', page: o.objectURL || `https://www.metmuseum.org/art/collection/search/${o.objectID}`, image: o.primaryImageSmall, license: 'CC0' });
      }
      if (!res.objectIDs || res.objectIDs.length < 100) break;
    }
    if (out.length >= PER) break;
  }
  return out;
}

mkdirSync(DIR, { recursive: true });
const all: Credit[] = [];
for (const [name, fn] of [['シカゴ美術館', chicago], ['メトロポリタン美術館', met]] as const) {
  try { const got = await fn(); console.log(`${name}: ${got.length}枚`); all.push(...got); }
  catch (e) { console.error(`${name}: 失敗した。${e instanceof Error ? e.message : e}`); }
}
writeFileSync(join(SAMPLES, 'museum-credits.json'), JSON.stringify(all, null, 1));
console.log(`合計 ${all.length}枚。出どころは samples/museum-credits.json`);
