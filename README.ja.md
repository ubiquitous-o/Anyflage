# Anyflage

[English](README.md) | 日本語

迷彩柄のブロブひとつずつに、写真や物の形を歪めて押し込むグラフィック生成ツール。遠目は迷彩、近づくと顔や人や猫が見える。

https://ubiquitous-o.github.io/Anyflage/

## 使い方

1. **画像セットを選ぶ** — 最初から「sample」（美術館が CC0 で公開している肖像画40枚）が入っている。「自分の画像を足す」で手元の画像も足せる。背景除去は、顔だけ・顔と髪・全身・もの から選ぶ
2. **迷彩を選ぶ** — 軍用・狩猟用の柄の近似と、実物の見本から起こした柄。ブロブの大きさと配色を決める。配色は自分でも作れる
3. **押し込み方を調整する** — はめ方10方式、シームカービングの強さ。方式や柄を並べて比べられる
4. **出力する** — 比率や画素数を選んで PNG を保存。Instagram・X 用の大きさ、上下左右がつながるリピート用の絵も出せる

足した画像と設定は、ブラウザが覚える。背景除去もブラウザの中で計算する。画像はどこにも送らない。

表示は日本語と英語。⌘Z で元に戻す。B を押しているあいだ、描き直す前の絵を出す。

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
- `src/main.ts` — 画面。設定は URL の `?` に出る
- `src/cutout.ts`、`public/models/` — 背景除去。MediaPipe の自撮り用分割と U²-Net の小型版（どちらも Apache 2.0）
- `src/i18n.ts` — 英語の文言
- `public/swatches/` — 実物の見本画像から起こした柄。出典とライセンスは `public/swatches/index.json`
- `public/sets/sample/` — sample セット。シカゴ美術館とメトロポリタン美術館の CC0 の肖像画を、顔と髪で切り抜いたもの。出どころは `public/sets/sample.json`
- `scripts/collect-museum.ts`、`precut.html` — sample セットを作り直す道具。切り抜きは `ANYFLAGE_PRECUT=1 npm run dev` で起動して `/precut.html` を開く
