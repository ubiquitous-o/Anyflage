// 柄ごとの色の面積比を測る。公式の比率が分かっている柄の、しきい値や偏りを合わせるために使う。
// 使い方：node scripts/pattern-shares.ts [柄のid ...]
import { PATTERNS } from '../src/engine/patterns.ts';

const N = 360, ids = process.argv.slice(2);
for (const pt of PATTERNS) {
  if (pt.id === 'blob' || (ids.length && !ids.includes(pt.id))) continue;
  const count = new Array(pt.colors.length).fill(0);
  for (const seed of [48213, 11111, 77777]) {
    const f = pt.make(seed, 0.17);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) count[f(x / N, y / N, x / N, y / N)]++;
  }
  console.log(pt.id.padEnd(11) + count.map((c) => (c / (N * N * 3) * 100).toFixed(1).padStart(6)).join(''));
}
