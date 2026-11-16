// ファビコンを、アプリと同じ柄の生成器で作る。ERDL（米軍のリーフ迷彩）風。
// 柄は「ウッドランド（米 M81 系）」の生成器。M81 は ERDL を拡大した柄なので、形の作りは同じ。色を ERDL の緑が多いほうに寄せる。
// 角を丸めた正方形の PNG にして、public/favicon.png に書く。
//
// 使い方： node scripts/build-favicon.ts            決めたシードと大きさで public/favicon.png を作る
//          node scripts/build-favicon.ts 出力フォルダ   シードと大きさを変えた候補を、1枚に並べて書く（選ぶ用）
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pngjs from 'pngjs';
import { Kao } from '../src/engine/kao.ts';
import { patternById } from '../src/engine/patterns.ts';
import { ROOT, ensureDir } from './lib.ts';

/** 地（明るい緑）、濃緑、茶、黒。ERDL の緑が多いほうの色を、小さい絵でもつぶれないよう少し明るく濃くした */
const COLORS = [[143, 163, 94], [63, 90, 58], [107, 74, 46], [30, 33, 28]];
/** 決めた絵 */
const SEED = 33, SIZE = 0.42;
const OUT = 256, SS = 3; // 仕上がりの画素数と、なめらかにするための倍率（大きく描いて縮める）

/** 柄を1枚描く。戻り値は OUT×OUT の RGBA。角は丸めて、外は透明 */
function draw(seed: number, size: number): Uint8Array {
  const W = OUT * SS, pat = patternById('woodland');
  const cam = Kao.buildCamo(W, W, { seed, size, wobble: 0.3, neck: 0, notch: 0, split: 'none', noSplit: true, layerAt: pat.make(seed, size) });
  const out = new Uint8Array(OUT * OUT * 4), rad = OUT * 7 / 32;
  for (let y = 0; y < OUT; y++) for (let x = 0; x < OUT; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) {
      const px = x + (i + 0.5) / SS, py = y + (j + 0.5) / SS;
      // 角の丸みの内側か
      const dx = Math.max(rad - px, px - (OUT - rad), 0), dy = Math.max(rad - py, py - (OUT - rad), 0);
      if (dx * dx + dy * dy > rad * rad) continue;
      const c = COLORS[cam.comps.layer[cam.ids[(y * SS + j) * W + x * SS + i]] % COLORS.length];
      r += c[0]; g += c[1]; b += c[2]; a++;
    }
    const o = (y * OUT + x) * 4;
    if (a) { out[o] = r / a; out[o + 1] = g / a; out[o + 2] = b / a; }
    out[o + 3] = Math.round(255 * a / (SS * SS));
  }
  return out;
}

const dir = process.argv[2];
if (dir) { // 候補を並べる。横にシード、縦に大きさ
  const seeds = [1, 3, 7, 12, 21, 33, 48, 77], sizes = [0.3, 0.42, 0.56], pad = 12, cell = OUT + pad;
  const png = new pngjs.PNG({ width: cell * seeds.length + pad, height: cell * sizes.length + pad });
  png.data.fill(40); for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255;
  sizes.forEach((size, row) => seeds.forEach((seed, col) => {
    const d = draw(seed, size);
    for (let y = 0; y < OUT; y++) for (let x = 0; x < OUT; x++) {
      const s = (y * OUT + x) * 4, t = ((pad + row * cell + y) * png.width + pad + col * cell + x) * 4, a = d[s + 3] / 255;
      for (let k = 0; k < 3; k++) png.data[t + k] = d[s + k] * a + 40 * (1 - a);
    }
  }));
  const file = join(dir, 'favicon-candidates.png'); ensureDir(file); writeFileSync(file, pngjs.PNG.sync.write(png));
  console.log(`候補を書いた：${file}（横にシード ${seeds.join(', ')}、縦に大きさ ${sizes.join(', ')}）`);
} else {
  const png = new pngjs.PNG({ width: OUT, height: OUT }); png.data.set(draw(SEED, SIZE));
  const file = join(ROOT, 'public', 'favicon.png'); writeFileSync(file, pngjs.PNG.sync.write(png));
  console.log(`書いた：${file}（シード ${SEED}、大きさ ${SIZE}）`);
}
