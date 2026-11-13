// 画面の言葉の切り替え（日本語／英語）。
// 画面の文言は日本語で書いてある。英語のときは、画面に出る直前に英語へ置き換える。
// 置き換えは DOM を見張ってやるので、文言を出す側のコードは日本語のまま書けばよい。
// キャンバスに直接描く文字だけは、描く側で tr() を通す。
// 辞書にない文言は日本語のまま出る（足したセットの名前など、使う人が付けた名前はそれでよい）。

export type Lang = 'ja' | 'en';

const EN: Record<string, string> = {
  // 枠まわり
  '変更前': 'Before', '全体表示': 'Fit to view', '↶ 元に戻す': '↶ Undo', '↷ やり直す': '↷ Redo', '変更前を表示（B）': 'See before (hold B)',
  '全体を枠内に表示': 'Scale the image to fit the frame', '等倍で表示': 'Show at actual pixels',
  'ホイール：拡大縮小／ドラッグ：移動／ダブルクリック：全体表示と 100% の切り替え': 'Scroll: zoom / Drag: pan / Double-click: switch between fit and 100%',
  'プレビューの拡大縮小': 'Preview zoom', '縮小': 'Zoom out', '拡大': 'Zoom in', '編集の履歴': 'Edit history',
  '元に戻す（⌘Z／Ctrl+Z）': 'Undo (⌘Z / Ctrl+Z)', 'やり直す（⇧⌘Z／Ctrl+Y）': 'Redo (⇧⌘Z / Ctrl+Y)', '押している間、変更前を表示（B キー）': 'Hold to see the previous image (keyboard: B)',
  'GitHub でソースを表示': 'View the source on GitHub',
  // 1 画像セット
  '画像セット': 'Image sets',
  '画像セットがありません。「画像を追加」から追加してください。画像はブラウザ内でのみ使用され、送信されません。': 'No image sets. Add some from "Add images". Images are used only in this browser and are never sent anywhere.',
  '使用枚数': 'Images to use', 'シャッフル': 'Shuffle', '切り抜き一覧を表示': 'Show cutouts', '画像を追加': 'Add images',
  '画像を選択': 'Choose images', '未選択。1セットにする画像をまとめて選択してください。': 'None selected. Select all the images for one set at once.',
  '背景の除去方法': 'Background removal', '除去しない（切り抜き済み）': 'None (images are already cut out)',
  '顔のみ（髪を除く）': 'Face only (no hair)', '顔と髪': 'Face and hair', '人物全体': 'Whole person', '物・キャラクター': 'Object or character',
  'セット名': 'Set name', '空欄の場合：001、002…': 'Blank becomes 001, 002…', '追加': 'Add', '追加中…': 'Adding…',
  '追加ごとに新しいセットになります。背景の除去はブラウザ内で行われ、画像は送信されません。追加したセットはブラウザに保存されます。': 'Each addition becomes a new set. Background removal runs in this browser and images are never sent. Added sets are saved in this browser.',
  '追加したセットをすべて削除': 'Delete all added sets', '削除を確定（もう一度押す）': 'Confirm delete (press again)',
  // 2 迷彩
  '迷彩柄': 'Camouflage pattern', '柄': 'Pattern', 'ブロブの大きさ': 'Blob size', 'ブロブの大きさを調整': 'Drag to change the blob size', '右：拡大／左：縮小。離すと中央に戻ります': 'Right: larger / Left: smaller. Returns to the centre when released',
  'ブロブを小さく': 'Smaller blobs', '小さく（÷1.25）': 'Smaller (÷1.25)', 'ブロブを大きく': 'Larger blobs', '大きく（×1.25）': 'Larger (×1.25)',
  '配色': 'Colours', '柄の本来の色': "The pattern's own colours", 'ウッドランド': 'Woodland', 'デザート': 'Desert', 'アーバン': 'Urban', 'ネイビー': 'Navy', 'ポップ': 'Pop', '白だけ': 'All white', 'グレーだけ': 'All grey', '黒だけ': 'All black',
  '編集中の配色': 'Colours being edited', 'カスタム配色': 'Custom colours', '配色を作成': 'Create colours', '配色名': 'Colour set name', '空欄の場合：配色 1、配色 2…': 'Blank becomes 配色 1, 配色 2…',
  '配色を保存': 'Save colours', '選択中の配色を削除': 'Delete the selected colours', '＋ 色を追加': '+ Add a colour',
  'ブラウザに保存できませんでした。再読み込みで消えます（URL には色が残ります）。': 'Could not save in this browser. It will be gone when you reopen the page. The colours remain in the URL.',
  '迷彩色の強さ': 'Camouflage tint', 'ブロブを再生成': 'Regenerate blobs', 'ブロブの詳細設定': 'Blob details', '輪郭のうねり': 'Outline wobble',
  '大きいブロブの分割': 'Splitting large blobs', '曲線で分割': 'Split with curves', '直線で分割': 'Split with straight lines', '分割しない': 'Don\'t split',
  'くびれで分割': 'Split at necks', 'えぐれで分割': 'Split at notches', '小さいブロブは色のみ': 'Colour only for small blobs',
  '縁をなめらかにする': 'Smooth blob edges', '境界線を表示': 'Show blob borders',
  '標準・その他': 'Standard and others', '実物（見本画像から）': 'Real shapes (from swatch images)', '軍用（近似）': 'Military (procedural approximations)', '狩猟（近似）': 'Hunting (procedural approximations)',
  // 3 調整
  '押し込みの調整': 'Squeeze settings', 'はめ方': 'Fitting method',
  '放射（重心から線を伸ばす）': 'Radial (rays from the centre)', '調和写像（ゴム膜）': 'Harmonic map (rubber sheet)', '詰め物（弾性体）': 'Stuffing (elastic body)', '面積均等（風船）': 'Equal area (balloon)',
  '輪郭追従（皮を貼る）': 'Contour following (skin)', '輪郭は面積・内側は調和': 'Area outline, harmonic inside', '密度拡散（圧力でならす）': 'Density diffusion (pressure)', '歪みエネルギー最小': 'Minimum distortion energy',
  '単純に混ぜる': 'Simple blend', '形にカービング（背景を出さない）': 'Carve to shape (no background)',
  '放射': 'Radial', '調和写像': 'Harmonic', '詰め物': 'Stuffing', '面積均等': 'Equal area', '輪郭追従': 'Contour', '密度拡散': 'Diffusion', '形にカービング': 'Carve to shape',
  'シームカービング': 'Seam carving', '画像の割り当て': 'Image assignment', 'ランダム': 'Random', '隣接で重複を避ける': 'Avoid repeats between neighbours', '色ごとに1画像': 'One image per colour',
  '比較表示': 'Comparison', 'なし': 'None', '元画像と比較（左：適用後／右：元）': 'Compare with originals (left: squeezed / right: original)',
  'はめ方を比較（10方式）': 'Compare fitting methods (all 10)', '迷彩柄を比較（全種）': 'Compare camouflage (all patterns)',
  'はめ方の詳細設定': 'Fitting details', '面積均等の割合': 'Lean toward equal area', '締めつけ': 'Tightness', '形への追従': 'Push into shape', 'ゆがみ': 'Distortion', '回転のばらつき': 'Rotation spread', '細部の強調': 'Detail emphasis',
  '縮小の詳細設定': 'Shrinking details', '肌色の保護': 'Protect skin tones', 'ブロブの縦横比に合わせる': 'Match the blob\'s proportions', 'なめらかに補間': 'Smooth interpolation',
  'カービングの段差をならす': 'Smooth carving steps', 'ならす範囲の上限': 'Largest jump to smooth', '細い部分を省く': 'Drop thin parts',
  // 4 出力
  '出力': 'Output', 'サイズと比率': 'Size and ratio', '汎用（長辺 2400px）': 'General (long edge 2400px)', 'Instagram': 'Instagram',
  'X（Twitter）': 'X (Twitter)', 'カスタム': 'Custom',
  '1:1 スクエア': '1:1 square', '3:4 縦': '3:4 portrait', '4:3 横': '4:3 landscape', '9:16 縦': '9:16 portrait', '16:9 横': '16:9 landscape', '4:5 縦': '4:5 portrait',
  'フィード 正方形 1080×1080': 'Feed square 1080×1080', 'フィード 縦 4:5 1080×1350': 'Feed portrait 4:5 1080×1350', 'フィード 縦 3:4 1080×1440': 'Feed portrait 3:4 1080×1440', 'フィード 横 1.91:1 1080×566': 'Feed landscape 1.91:1 1080×566',
  'ストーリーズ／リール 9:16 1080×1920': 'Stories / Reels 9:16 1080×1920', 'ポスト 横 16:9 1600×900': 'Post landscape 16:9 1600×900', 'ポスト 正方形 1080×1080': 'Post square 1080×1080', 'ポスト 縦 4:5 1080×1350': 'Post portrait 4:5 1080×1350', 'ヘッダー 3:1 1500×500': 'Header 3:1 1500×500',
  'サイズを指定（px）': 'Custom size (px)', '幅': 'Width', '高さ': 'Height',
  'リピート可能にする（上下左右がつながる）': 'Make it tileable (edges join on all four sides)',
  '2×2 で継ぎ目を確認': 'Repeat 2×2 to check the seams',
  '端付近の柄が、つながるように変わります。ブロブの分割と画像の割り当ても変わります（大きいブロブの分割と「隣接で重複を避ける」は無効）。書き出しは1枚分です。': 'The pattern near the edges changes so that they join. Blob splitting and image assignment also change (splitting large blobs and "Avoid repeats between neighbours" are disabled). One tile is exported.',
  'PNG を保存': 'Save PNG', '書き出し中…': 'Exporting…', 'ファイルを作成中…': 'Encoding the file…', '画像を作成できませんでした。': 'Could not create the image.',
  // 動かす
  'アニメーション（ループ動画）': 'Animation (looping video)', '動きの種類': 'Motion type',
  'ゆらぎ（不規則な揺れ）': 'Sway (every part drifts on its own)', '流れ（液体状の渦）': 'Flow (swirls like liquid)', '呼吸（膨張と収縮）': 'Breathe (each blob swells and shrinks)',
  '波（一方向）': 'Wave (travels in one direction)', '二重ゆがみ（強いうねり）': 'Double warp (strong swirls)',
  '重ねる動き': 'Second motion', '重ねない': 'None', '重ねる動きの強さ': 'Second motion amount',
  'ラバランプ（ブロブの生成・結合・分離）': 'Lava lamp (blobs appear, merge and split)', 'MP4 動画': 'MP4 video', 'PNG 画像': 'PNG image', '変化の強さ': 'Change amount', '侵食の速さ': 'Invasion speed', 'ラバランプを生成中…': 'Drawing the lava lamp…',
  'ブロブが生成・結合・分離します。計算に時間がかかります。プレビューは準備後に再生され、書き出しには数分かかります。リピートと比較表示では使用できません。': 'Blobs appear, merge and split. It takes time to compute. The preview plays once it is ready, and export takes minutes. Unavailable with tileable images and comparisons.',
  '動きの強さ': 'Motion amount', '動きの細かさ': 'Motion detail', 'ループの長さ': 'Loop length', 'MP4 を保存': 'Save MP4',
  '動画用の画像を生成中…': 'Drawing the image for the video…', '動画を作成できませんでした。': 'Could not create the video.',
  'このブラウザは動画の書き出しに対応していません（WebCodecs 非対応）。': 'This browser cannot export video (WebCodecs is unavailable).',
  'このブラウザはアニメーションに対応していません（WebGL2 非対応）。': 'This browser cannot animate (WebGL2 is unavailable).',
  // 状態
  '描画中…': 'Drawing…', '描画中…（枚数が多いと時間がかかります）': 'Drawing… (many images take longer)', '画像セットを選択してください。': 'Choose at least one set.', '画像がありません。「画像を追加」から追加してください。': 'No images yet. Add some under "Add your own images".',
  '人物の切り抜きに失敗しました': 'Could not cut out the person', '追加した画像': 'Added by you',
  // 手元のテスト素材のセット名
  'カオ': 'Faces', 'アタマ': 'Heads', 'イヌ': 'Dogs', 'クルマ': 'Cars', 'ドウブツ': 'Animals', 'ネコ': 'Cats', 'ノリモノ': 'Vehicles', 'ヒト': 'People', 'ビル': 'Buildings', 'ポケモン': 'Pokémon',
  // 柄の名前
  'Anyflage 標準': 'Anyflage standard', '角丸の正方形タイル': 'Rounded square tiles', 'ウッドランド（米 M81 系）': 'Woodland (US M81 type)', 'ブラッシュストローク（英 DPM 系）': 'Brushstroke (UK DPM type)', 'フレックターン（独）': 'Flecktarn (Germany)',
  '陸自迷彩2型系': 'JGSDF Type 2 type', 'デジタル（CADPAT／MARPAT 系）': 'Digital (CADPAT / MARPAT type)', 'ベリョースカ（ソ連 KLMK 系）': 'Berezka (Soviet KLMK type)', 'タイガーストライプ（南ベトナム系）': 'Tigerstripe (South Vietnam type)',
  'スプリッター（独 1931 系）': 'Splinter (German 1931 type)', 'スプリッター（瑞 M90 系）': 'Splinter (Swedish M90 type)', 'フロッグスキン（米 1942 系）': 'Frog Skin (US 1942 type)', 'チョコチップ（米 6色デザート系）': 'Chocolate Chip (US six-colour desert type)',
  'グラデーション（MultiCam 系）': 'Gradient (MultiCam type)', 'ダズル（第一次大戦の艦船）': 'Dazzle (WWI ships)', '縦の筋（狩猟 ASAT 系）': 'Vertical streaks (hunting, ASAT type)', '大小2段のデジタル（狩猟 Optifade 系）': 'Two-scale digital (hunting, Optifade type)', 'ブレイズオレンジ（狩猟の安全色）': 'Blaze orange (hunting safety colour)',
  'M81 ウッドランド（実物の形）': 'M81 Woodland (real shapes)', 'ERDL 緑優勢（実物の形）': 'ERDL green-dominant (real shapes)', 'ERDL 茶優勢（実物の形）': 'ERDL brown-dominant (real shapes)', 'リザード（仏、実物の形）': 'Lizard (France, real shapes)',
  'EMR デジタルフローラ（露、実物の形）': 'EMR Digital Flora (Russia, real shapes)', 'DPM（英、実物の形）': 'DPM (UK, real shapes)', 'フレックターン（独、実物の形）': 'Flecktarn (Germany, real shapes)', 'スプリッター31（独、実物の形）': 'Splinter 31 (Germany, real shapes)',
  'ベリョースカ KLMK（ソ連、実物の形）': 'Berezka KLMK (Soviet, real shapes)', 'フロッグスキン（米、実物の形）': 'Frog Skin (US, real shapes)', '陸自迷彩2型（実物の形）': 'JGSDF Type 2 (real shapes)',
  // 柄の説明
  'Anyflage の標準の柄。値ノイズを3層、しきい値で重ねる。どの実物もまねていない。': 'The standard Anyflage pattern: three layers of value noise stacked by thresholds. It imitates no real camouflage.',
  '迷彩ではない。角の丸い正方形を升目に並べる。押し込み方を素直な形で比べるための見本。すき間には素材を入れない。「ブロブの大きさ」がタイル1枚の大きさ。': 'Not camouflage. Rounded squares on a grid, a plain shape for comparing how images get squeezed. Nothing is put in the gaps. "Blob size" is the size of one tile.',
  '1981年。茶が多いほうの ERDL を6割拡大した4色。明るい緑に染めた地へ、濃緑・茶・黒を重ねて刷る。縁はくっきり、ぼかしなし。黒は枝のように細く伸びる。': '1981. Four colours: the brown-dominant ERDL enlarged by 60%. Dark green, brown and black are printed over a light green ground. Edges are crisp with no blur. The black runs thin like twigs.',
  '1960年代。刷毛で払ったような、流れて渦を巻く4色の斑。流れの向きに沿って細長くのばしたノイズで作る。': '1960s. Four-colour blotches that flow and swirl like brush strokes, made from noise stretched along the direction of flow.',
  '1976年の試験を経て1990年に採用。5色の点の群れ。公式の配分は明緑15・明オリーブ20・暗緑35・茶20・黒10。点が隣の色の領域に食い込み、遠目に色が混ざる。': 'Trialled in 1976, adopted in 1990. Swarms of dots in five colours. The official shares are light green 15, light olive 20, dark green 35, brown 20, black 10. Dots bite into neighbouring colours so they blend at a distance.',
  'カーキの地に草緑・茶・黒の点。4色。日本の山野の風景を計算機で処理して点にした、とされる。3型も生地の柄は同じ。ここでは点を細かめにした。': 'Grass green, brown and black dots on khaki. Four colours. Said to be Japanese landscapes processed by computer into dots. Type 3 uses the same print. The dots here are on the fine side.',
  '1997〜2002年。画素の升目で、大きい斑（マクロ）と細かい乱れ（ミクロ）の2段を作る。MARPAT の特許に合わせ、カーキの地に緑・コヨーテ茶・黒の順で重ね、面積比を 5／30／47／18％ にした。升目そのものに隠す効果はなく、設計と印刷が楽になるだけとされる。': '1997–2002. A pixel grid builds two scales: large blotches (macro) and fine disruption (micro). Following the MARPAT patent, green, coyote brown and black are layered in that order over khaki at 5 / 30 / 47 / 18% of the area. The grid itself is said not to hide anything; it only makes design and printing easier.',
  '1968年ごろ。オリーブの地に、縁が階段状の明るい葉形の斑。2色。デジタル迷彩の遠い先祖。粗い升目でノイズを切る。': 'Around 1968. Light leaf-shaped blotches with stepped edges on olive. Two colours. A distant ancestor of digital camouflage. Noise is cut on a coarse grid.',
  '1960年代。仏のリザード迷彩が元。横に走って噛み合う黒い縞。うねらせた位相に sin をかけ、太さを場所で変えて縞を途切れさせる。': '1960s. Derived from the French Lizard pattern. Black stripes run sideways and interlock. A sine over a warped phase, with thickness varying by place so the stripes break up.',
  '1931年。灰ベージュの地に茶と緑の角ばった多角形、最後に暗緑の「雨」の線を部分的に重ねる。多角形はボロノイ分割、雨は場所を選んで並べた短い縦線。': '1931. Angular brown and green polygons on grey-beige, with dark green "rain" strokes overprinted in places. The polygons are Voronoi cells; the rain is short vertical lines placed in chosen areas.',
  '1990年。4色の多角形がすき間なく接する。雨の線はない。ボロノイ分割の升に色を割り当て、同じ色の隣どうしをつなぐ。': '1990. Four-colour polygons meet with no gaps. No rain strokes. Voronoi cells are assigned colours, and neighbouring cells of the same colour merge.',
  '1942年。米軍初の量産迷彩で、のちにダックハンターとして狩猟にも広まった。丸い斑を大小5色重ねる。': '1942. The first mass-produced US military camouflage, later popular with hunters as Duck Hunter. Round blotches of five colours, large and small, overlap.',
  '1980年代。広い波の帯4色に、黒い小石と白い影。岩の多い砂漠を想定した。': '1980s. Four broad wavy bands with black pebbles and white shadows, designed for rocky desert.',
  '2002年。7色。タンから茶へのグラデーションに緑のグラデーションを重ね、焦げ茶とクリームの小片を散らす。対比より「なじませる」考え方。ここでは色を3段に刻んで近似。': '2002. Seven colours. A green gradient over a tan-to-brown gradient, scattered with small dark brown and cream pieces. The idea is to blend rather than contrast. Approximated here with three steps per gradient.',
  '1917年。隠すのではなく、まっすぐな縞で形・向き・速さを読ませない。区画ごとに縞の向きと幅を変える。': '1917. Not for hiding: straight stripes make shape, heading and speed hard to read. Each zone has its own stripe direction and width.',
  '1986年。3色。明るい砂色の地に、中間の茶と黒の、縦に流れる曲がった筋。緑なし。木や葉をまねず、明暗の差で輪郭を割る。ノイズの等高線を筋にする。': '1986. Three colours. Curved streaks of mid brown and black flow vertically over light sand. No green. It imitates no trees or leaves and breaks the outline by contrast alone. The streaks are contour lines of noise.',
  '2000年代。鹿の目（細部が見えにくく、動きに敏感）に合わせた設計とされる。大きい形で輪郭を割り、縁を画素の点描でぼかす。森の緑や茶を使わない。': '2000s. Said to be designed for deer vision (poor at detail, sensitive to motion). Large shapes break the outline and pixel stippling blurs their edges. No forest greens or browns.',
  '人にははっきり見え、赤と緑を見分けにくい鹿には目立ちにくい、という考えの安全色迷彩。柄はウッドランドと同じ作り。': 'Safety camouflage: obvious to people, but meant to stand out less to deer, which tell red from green poorly. The shapes are built like Woodland.',
  '米陸軍の見本。1981年。茶が多いほうの ERDL を6割拡大した4色。': 'US Army swatch, 1981. Four colours: the brown-dominant ERDL enlarged by 60%.',
  '米陸軍 ERDL の「低地」版。1948年設計、1967年からベトナムで支給。M81 の元。': 'The "lowland" version of US Army ERDL. Designed in 1948, issued in Vietnam from 1967. The basis of M81.',
  '米陸軍 ERDL の「高地」版。これを6割拡大したのが M81。': 'The "highland" version of US Army ERDL. M81 is this enlarged by 60%.',
  '仏 1950年代。緑と茶の刷毛の縞を、地を広く残して重ねる。タイガーストライプの元。': 'France, 1950s. Green and brown brush stripes layered with plenty of ground showing. The basis of Tigerstripe.',
  'ロシア 2008年。淡い緑の地に黒・茶・濃緑の升目。': 'Russia, 2008. Black, brown and dark green pixels on pale green.',
  '英 Combat 95。砂色の地に緑・茶・黒の刷毛の跡。布の写真から起こした。': 'UK Combat 95. Green, brown and black brush marks on sand. Traced from a photo of the fabric.',
  '独 1990年採用。5色の点の群れ。布の写真から起こした。': 'Germany, adopted 1990. Swarms of dots in five colours. Traced from a photo of the fabric.',
  '独 1931年。角ばった多角形と「雨」の線。布のスキャンから起こした。': 'Germany, 1931. Angular polygons and "rain" strokes. Traced from a scan of the fabric.',
  'ソ連 1968年ごろ。縁が階段状の葉形の斑。布の写真から起こした。': 'Soviet Union, around 1968. Leaf-shaped blotches with stepped edges. Traced from a photo of the fabric.',
  '米 1942年。丸い斑5色。布の写真から起こした。': 'US, 1942. Round blotches in five colours. Traced from a photo of the fabric.',
  '陸上自衛隊。カーキの地に草緑・茶・黒の点。布の写真から起こした。': 'Japan Ground Self-Defense Force. Grass green, brown and black dots on khaki. Traced from a photo of the fabric.',
};

/** 数字や名前が入る文言。上から順に試す */
const RULES: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^ラバランプを生成中…（(\d+)\/(\d+)）$/, (m) => `Drawing the lava lamp… (frame ${m[1]} of ${m[2]})`],
  [/^(動画を作成中|ラバランプを生成中)…（準備 (\d)\/2（(\d+)\/(\d+)））$/, (m) => `${m[1] === '動画を作成中' ? 'Encoding the video' : 'Drawing the lava lamp'}… (preparing ${m[2]}/2, frame ${m[3]} of ${m[4]})`],
  [/^ブロブ (\d+)個分／秒$/, (m) => `${m[1]} blob widths per second`],
  [/^画像を準備中… (\d+)\/(\d+)$/, (m) => `Preparing images… ${m[1]}/${m[2]}`],
  [/^(\d+)升$/, (m) => `${m[1]} cells`],
  [/^(\d+)秒$/, (m) => `${m[1]} s`],
  [/^動画：(\d+)×(\d+) px、(\d+)fps、(\d+)秒（ループ再生対応）$/, (m) => `Video: ${m[1]}×${m[2]} px, ${m[3]} fps, ${m[4]} s. It loops smoothly when played on repeat.`],
  [/^動画を作成中…（(\d+)\/(\d+)）$/, (m) => `Encoding the video… (frame ${m[1]} of ${m[2]})`],
  [/^保存しました：(\d+)×(\d+) px・(\d+)秒$/, (m) => `Saved. ${m[1]}×${m[2]} px, ${m[3]} s`],
  [/^サイズ（(\d+)×(\d+) px）は、このブラウザでは MP4 にできません。小さいサイズを選択してください。$/, (m) => `This browser cannot make an MP4 at ${m[1]}×${m[2]} px. Choose a smaller size.`],
  [/^シード (\d+)・ブロブ (\d+)個・画像 (\d+)枚・描画 ([\d.]+)秒$/, (m) => `Seed ${m[1]} · ${m[2]} blobs · ${m[3]} images · drawn in ${m[4]} s`],
  [/^画像 (\d+)枚$/, (m) => `${m[1]} images`],
  [/^すべて（(\d+)枚）$/, (m) => `All (${m[1]})`],
  [/^(\d+)枚$/, (m) => m[1]],
  [/^(\d+)升$/, (m) => `${m[1]} cells`],
  [/^(\d+)色目$/, (m) => `Colour ${m[1]}`],
  [/^(\d+)色目を削除$/, (m) => `Remove colour ${m[1]}`],
  [/^「(.*)」を上書き$/, (m) => `Overwrite "${m[1]}"`],
  [/^現在 (\d+)色／この柄は(\d+)色。数が違う場合は、中間色を補って割り当てます。(.*)$/, (m) => `${m[1]} colours now. This pattern uses ${m[2]}. When the counts differ, colours in between are interpolated. ${tr(m[3])}`.trim()],
  [/^書き出しサイズ：(\d+)×(\d+) px$/, (m) => `Export size: ${m[1]}×${m[2]} px`],
  [/^(\d+)枚を選択：(.*?)( ほか)?$/, (m) => `${m[1]} chosen: ${m[2].split('、').join(', ')}${m[3] ? ' and more' : ''}`],
  [/^(\d+)枚を追加$/, (m) => `Add ${m[1]} image${m[1] === '1' ? '' : 's'}`],
  [/^画像を読み込み中… (\d+)\/(\d+)$/, (m) => `Reading images… ${m[1]}/${m[2]}`],
  [/^背景を除去中… (\d+)\/(\d+)(（初回はモデルの読み込みに時間がかかります）)?$/, (m) => `Removing backgrounds… ${m[1]}/${m[2]}${m[3] ? ' (the first one takes longer while the model loads)' : ''}`],
  [/^読み込めませんでした: (.*?)(?:（(.*)）)?$/, (m) => `Could not read: ${m[1]}${m[2] ? ` (${tr(m[2])})` : ''}`],
  [/^書き出し中…（(\d+)×(\d+) px）$/, (m) => `Exporting… (${m[1]}×${m[2]} px, takes a few seconds)`],
  [/^保存しました：(\d+)×(\d+) px$/, (m) => `Saved. ${m[1]}×${m[2]} px`],
  [/^0 より大きい数値を入力してください（([\d.]+)% のまま）。$/, (m) => `Enter a number above 0. Kept at ${m[1]}%.`],
  [/^([\d.]+)% 未満は結果が変わりません（[\d.]+% に制限）。$/, (m) => `Below ${m[1]}% the blobs stay smaller than a pixel and nothing changes. Stopped at ${m[1]}%.`],
  [/^([\d.]+)% を超えても結果が変わりません（[\d.]+% に制限）。$/, (m) => `Above ${m[1]}% the whole image stays one blob and nothing changes. Stopped at ${m[1]}%.`],
  [/^(.*?) 形は見本画像を色で分けたもの。出典：(.*)（(.*)、(.*)）。「輪郭のうねり」は効かない。$/, (m) => `${tr(m[1])} Shapes are traced from a swatch image by colour. Source: ${m[2]} (${m[3]}, ${m[4]}). "Outline wobble" has no effect.`],
];

const KEY = 'anyflage:lang', JA = /[ぁ-んァ-ヶ一-龠]/;
let lang: Lang = 'ja';
export function currentLang(): Lang { return lang; }

/** いまの言語での文言。日本語のときはそのまま返す。キャンバスに描く文字はこれを通す */
export function tr(ja: string): string {
  if (lang === 'ja' || !ja || !JA.test(ja)) return ja;
  const hit = EN[ja]; if (hit !== undefined) return hit;
  for (const [re, fn] of RULES) { const m = ja.match(re); if (m) return fn(m); }
  return ja;
}

/** ブラウザの設定から、最初の言語を決める。前に選んだものがあればそれ */
export function initialLang(): Lang {
  try { const s = localStorage.getItem(KEY); if (s === 'ja' || s === 'en') return s; } catch { /* 覚えていなければ下で決める */ }
  const prefs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'en'];
  return /^ja\b/i.test(prefs[0] || '') ? 'ja' : 'en';
}

// ---- DOM の置き換え ----
// 文字のノードと、決まった属性について、「もとの日本語」と「いま画面に出している文言」を覚えておく。
// コードが新しい日本語を書き込んだら、それをもとの日本語として覚え直し、いまの言語で出し直す。
const ATTRS = ['title', 'placeholder', 'aria-label', 'label'];
const srcText = new WeakMap<Node, string>(), shown = new WeakMap<Node, string>();
const srcAttr = new WeakMap<Element, Record<string, string>>(), shownAttr = new WeakMap<Element, Record<string, string>>();
const skip = (n: Node | null): boolean => { for (let e = n instanceof Element ? n : n?.parentElement; e; e = e.parentElement) if (e.tagName === 'SCRIPT' || e.tagName === 'STYLE' || e.hasAttribute('data-noi18n')) return true; return false; };

function doText(n: Node): void {
  const cur = n.nodeValue || '';
  if (shown.get(n) !== cur) srcText.set(n, cur); // コードが書き換えた。これが新しい「もとの日本語」
  const ja = srcText.get(n) ?? cur, core = ja.trim();
  const out = core && JA.test(core) ? ja.replace(core, () => tr(core)) : ja;
  shown.set(n, out);
  if (out !== cur) n.nodeValue = out;
}
function doAttrs(el: Element): void {
  const src = srcAttr.get(el) || {}, sh = shownAttr.get(el) || {};
  for (const a of ATTRS) {
    const cur = el.getAttribute(a); if (cur === null) continue;
    if (sh[a] !== cur) src[a] = cur;
    const out = tr(src[a]); sh[a] = out;
    if (out !== cur) el.setAttribute(a, out);
  }
  srcAttr.set(el, src); shownAttr.set(el, sh);
}
function walk(root: Node): void {
  if (skip(root)) return;
  if (root.nodeType === Node.TEXT_NODE) { doText(root); return; }
  if (!(root instanceof Element)) return;
  doAttrs(root);
  for (const c of [...root.childNodes]) walk(c);
}

let watching = false;
/** 言語を切り替える。画面の文言を全部出し直し、選んだ言語をブラウザに覚える */
export function setLang(next: Lang): void {
  lang = next;
  try { localStorage.setItem(KEY, next); } catch { /* 覚えられなくても切り替えはする */ }
  document.documentElement.lang = next;
  walk(document.body);
  if (watching) return;
  watching = true;
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'characterData') { if (!skip(m.target)) doText(m.target); }
      else if (m.type === 'attributes') { if (m.target instanceof Element && !skip(m.target)) doAttrs(m.target); }
      else for (const n of m.addedNodes) walk(n);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}
