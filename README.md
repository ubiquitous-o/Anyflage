# Anyflage

迷彩柄のブロブひとつずつに、写真や物の形を歪めて押し込むグラフィック生成ツール。遠目は迷彩、近づくと顔や人や猫が見える。

公開版：https://ubiquitous-o.github.io/Anyflage/

公開版にテスト素材は入っていない。画面の「自分の画像を足す」から画像を入れる。背景が透明な PNG を入れると、透明でない所が切り抜きになる。画像はブラウザの中だけで使い、どこにも送らない。

## 動かす

```bash
npm install
```

```bash
npm run dev
```

- `npm run build` で `dist/` に出す。`main` に push すると GitHub Actions が Pages に出す
- `npm run typecheck` で型検査
- `npm run parity` で、試作エンジンと TS 版の出力が画素単位で同じか比べる。試作（`prototype/`）と `samples/` が手元にあるときだけ動く。どちらもリポジトリには入れていない
- `npm run samples` で、公開データセットからテスト素材を `samples/` に集める。再配布に条件があるのでコミットしない

## 中身

- `src/engine/` — エンジン。迷彩を作り、素材をブロブに押し込む
- `src/main.ts` — テスト画面。設定は URL の `?` に出る
- `public/swatches/` — 実物の見本画像から起こした柄。出典とライセンスは `public/swatches/index.json`
