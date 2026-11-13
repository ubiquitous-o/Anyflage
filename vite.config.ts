import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

const root = dirname(fileURLToPath(import.meta.url));

/**
 * 開発用サーバーだけの受け口。precut.html が切り抜いた画像を POST してくるので、public/sets/ に書く。
 * 背景除去のモデルはブラウザでしか動かないため、切り抜きはブラウザでやり、保存だけここでやる。
 * ビルドした公開版には入らない（configureServer は開発用サーバーでしか呼ばれない）。
 *
 * ファイルを書く受け口なので、守りを3つ置く。
 *   1. ふだんは無い。ANYFLAGE_PRECUT=1 を付けて起動したときだけ受け口を作る
 *   2. このサーバー自身のページからの要求だけ受ける。開発中にたまたま開いたよそのページが、勝手に書き込めないように
 *   3. 1回に受ける大きさは 8MB まで
 */
const PRECUT_MAX = 8 * 1024 * 1024;
function precutSaver(): Plugin {
  return {
    name: 'anyflage-precut-saver',
    apply: 'serve',
    configureServer(server) {
      if (process.env.ANYFLAGE_PRECUT !== '1') return;
      server.middlewares.use('/__precut', (req, res) => {
        // よそのページからの要求は断る。ブラウザは、出どころが違う要求に sec-fetch-site: cross-site や別の origin を付ける
        const site = req.headers['sec-fetch-site'], origin = req.headers.origin, host = req.headers.host;
        if (site !== 'same-origin' || (origin && new URL(origin).host !== host)) { res.statusCode = 403; res.end('forbidden'); return; }
        const name = new URL(req.url || '/', 'http://x').searchParams.get('name') || '';
        // 置けるのは public/sets/ の下の、決まった形の名前だけ
        if (req.method !== 'POST' || !/^[a-z0-9-]+(\/[a-z0-9-]+)?\.(webp|json)$/.test(name)) { res.statusCode = 400; res.end('bad request'); return; }
        const chunks: Buffer[] = [];
        let size = 0, tooBig = false;
        req.on('data', (c: Buffer) => { size += c.length; if (size > PRECUT_MAX) { tooBig = true; chunks.length = 0; } else if (!tooBig) chunks.push(c); });
        req.on('end', () => {
          if (tooBig) { res.statusCode = 413; res.end('too large'); return; }
          const file = join(root, 'public', 'sets', name);
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, Buffer.concat(chunks));
          res.end('ok');
        });
      });
    },
  };
}

// GitHub Pages では https://<user>.github.io/Anyflage/ の下に置かれる。
// 相対の base にしておくと、どの置き場所でもそのまま動く。
// samples/ は public/ の外にあるので、ビルドには入らない（再配布に条件のあるデータ）。
// public/sets/ は、権利の切れた絵など、公開してよい素材。こちらはビルドに入る。
export default defineConfig({ base: './', plugins: [precutSaver()] });
