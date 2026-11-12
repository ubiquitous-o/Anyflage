// 背景除去（人）を動かす MediaPipe の部品（wasm）を、node_modules から public/vendor/ に写す。
// 物用の onnxruntime-web は、ビルドのときに Vite が自分で束ねるので、ここでは写さない。
// 実行時に外の配布元から読まないようにするため。npm install のあとに自動で走る（package.json の postinstall）。
// public/vendor/ は .gitignore に入れてある。npm の版は package-lock.json で固定される。
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const jobs: [string, string][] = [
  ['node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.js', 'public/vendor/mediapipe/vision_wasm_internal.js'],
  ['node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm', 'public/vendor/mediapipe/vision_wasm_internal.wasm'],
];
for (const [from, to] of jobs) {
  const src = join(root, from);
  if (!existsSync(src)) { console.error(`見つからない: ${from}`); process.exit(1); }
  mkdirSync(dirname(join(root, to)), { recursive: true });
  copyFileSync(src, join(root, to));
}
console.log(`背景除去の部品を public/vendor/ に写した（${jobs.length} ファイル）`);
