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
 */
function precutSaver(): Plugin {
  return {
    name: 'anyflage-precut-saver',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__precut', (req, res) => {
        const name = new URL(req.url || '/', 'http://x').searchParams.get('name') || '';
        // 置けるのは public/sets/ の下の、決まった形の名前だけ
        if (req.method !== 'POST' || !/^[a-z0-9-]+(\/[a-z0-9-]+)?\.(webp|json)$/.test(name)) { res.statusCode = 400; res.end('bad request'); return; }
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
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
