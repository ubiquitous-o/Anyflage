# Anyflage

English | [日本語](README.ja.md)

A graphics tool that warps photos and objects and squeezes one into every blob of a camouflage pattern. From a distance it reads as camouflage; up close you see faces, people and cats.

https://ubiquitous-o.github.io/Anyflage/

## How to use

1. **Choose image sets** — "sample" is built in: 40 portraits that museums publish under CC0. Add your own images with "Add your own images". Background removal can keep the face only, the face and hair, the whole person, or an object
2. **Choose camouflage** — approximations of military and hunting patterns, and patterns traced from real swatches. Set the blob size and colours. You can make your own colour sets
3. **Adjust the squeeze** — ten fitting methods and the strength of seam carving. Methods and patterns can be compared side by side
4. **Export** — pick a ratio or pixel size and save a PNG. There are sizes for Instagram and X, and a tileable image whose edges join on all four sides

The browser remembers the images you add and your settings. Background removal also runs in the browser. Images are never sent anywhere.

The interface is in Japanese and English. ⌘Z undoes. Hold B to see the image from before the last redraw.

## Run it

```bash
npm install
```

```bash
npm run dev
```

- `npm run build` writes to `dist/`. Pushing to `main` deploys to Pages through GitHub Actions
- `npm run typecheck` checks types
- `npm run parity` checks that the prototype engine and the TypeScript engine produce identical pixels. It only runs when the prototype (`prototype/`) and `samples/` exist locally. Neither is in the repository
- `npm run samples` collects test images from public datasets into `samples/`. Their redistribution is restricted, so they are not committed

## What's inside

- `src/engine/` — the engine. Builds the camouflage and squeezes images into the blobs
- `src/main.ts` — the screen. Settings appear in the URL query
- `src/cutout.ts`, `public/models/` — background removal. MediaPipe selfie segmentation and the small U²-Net (both Apache 2.0)
- `src/i18n.ts` — the English text
- `public/swatches/` — patterns traced from real swatch images. Sources and licences are in `public/swatches/index.json`
- `public/sets/sample/` — the sample set. CC0 portraits from the Art Institute of Chicago and The Metropolitan Museum of Art, cut out to the face and hair. Sources are in `public/sets/sample.json`
- `scripts/collect-museum.ts`, `precut.html` — tools for rebuilding the sample set. To cut out, start with `ANYFLAGE_PRECUT=1 npm run dev` and open `/precut.html`
