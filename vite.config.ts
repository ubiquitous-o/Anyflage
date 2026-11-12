import { defineConfig } from 'vite';

// GitHub Pages では https://<user>.github.io/Anyflage/ の下に置かれる。
// 相対の base にしておくと、どの置き場所でもそのまま動く。
// samples/ は public/ の外にあるので、ビルドには入らない（再配布に条件のあるデータ）。
export default defineConfig({ base: './' });
