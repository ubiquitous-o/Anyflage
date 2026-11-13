// 絵を動かす所。できあがった絵を1枚もらい、「ずらしの場」で毎フレームゆがめて描く（WebGL2）。
// 絵そのものは作り直さない。画素を読む位置をずらすだけなので、ブロブの数もつながり方も変わらず、素材も入れ替わらない。
//
// ループのしかた：ずらしの場を「止まったノイズ × cos(hθ) ＋ 別の止まったノイズ × sin(hθ)」の足し算で作る（h = 1, 2, 3）。
// θ が1周すると、ちょうど同じ場に戻る。継ぎ目は出ない。
// ノイズは升目の数を整数にして、絵の端で周期がそろうようにしてある。リピートできる絵は、動かしてもリピートできる。
import type { PhaseMap } from './render.ts';

export type MotionKind = 'sway' | 'flow' | 'breathe' | 'wave' | 'double';
export interface MotionOptions {
  kind: MotionKind;
  /** 動きの大きさ。0〜1。1 で、ノイズの升目の3割ぶん動く */
  amount: number;
  /** 動きの細かさ。絵の長辺に入るノイズの升目の数 */
  fine: number;
  /** キャンバスに絵が何枚並んでいるか（リピートを 2×2 で見るときは 2） */
  tiles: number;
  /** 端をまたいで読む（リピートできる絵）。しないときは、端に近いほど動きを弱める */
  wrap: boolean;
  seed: number;
}

const VERT = `#version 300 es
in vec2 aPos; out vec2 vUv;
void main() { vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5); gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uTex, uPhase;
uniform vec2 uCells, uTiles, uAmp, uPhaseTexel;
uniform float uTheta;
uniform int uKind;
uniform uint uSeed;
uniform bool uWrap, uHasPhase;
in vec2 vUv; out vec4 o;
const float TAU = 6.28318530718;

// 升目の角の乱数。per で折り返すので、ノイズは per 升ごとに繰り返す
float hash(vec2 i, vec2 per, float k) {
  ivec2 q = ivec2(mod(i, per));
  uint h = uint(q.x) * 374761393u + uint(q.y) * 668265263u + uint(k) * 2246822519u + uSeed * 3266489917u;
  h = (h ^ (h >> 13)) * 1274126177u; h ^= h >> 16;
  return float(h & 0xffffu) / 65535.0;
}
float vn(vec2 p, vec2 per, float k) {
  vec2 i = floor(p), f = p - i, u = f * f * (3.0 - 2.0 * f);
  float a = hash(i, per, k), b = hash(i + vec2(1, 0), per, k), c = hash(i + vec2(0, 1), per, k), d = hash(i + vec2(1, 1), per, k);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 2.0 - 1.0;
}
float fb(vec2 p, float k) { return (vn(p, uCells, k) + 0.5 * vn(p * 2.0, uCells * 2.0, k + 7.0)) / 1.5; }

// ゆらぎ：ループするノイズで、点ごとにばらばらに動かす
vec2 sway(vec2 p, float th, float k) {
  vec2 d = vec2(0);
  for (int h = 1; h <= 3; h++) {
    float fh = float(h), kk = k + fh * 10.0;
    d += (vec2(fb(p, kk), fb(p, kk + 1.0)) * cos(fh * th) + vec2(fb(p, kk + 2.0), fb(p, kk + 3.0)) * sin(fh * th)) / fh;
  }
  return d;
}
// 流れ：ループするノイズを「流れの関数」と見て、その等高線に沿って動かす。湧き出しがないので、面積が保たれる
float psi(vec2 p, float th) {
  float s = 0.0;
  for (int h = 1; h <= 3; h++) { float fh = float(h); s += (fb(p, 100.0 + fh * 10.0) * cos(fh * th) + fb(p, 101.0 + fh * 10.0) * sin(fh * th)) / fh; }
  return s;
}
vec2 flow(vec2 p, float th) {
  const float e = 0.06;
  return vec2(psi(p + vec2(0, e), th) - psi(p - vec2(0, e), th), psi(p - vec2(e, 0), th) - psi(p + vec2(e, 0), th)) / (2.0 * e) * 0.45;
}
// 呼吸：ブロブごとに位相をずらした山と谷を作り、その坂に沿って動かす。隣がしぼむぶん、自分がふくらむ
float swell(vec2 t, float th) { vec2 cs = texture(uPhase, t).rg * 2.0 - 1.0; return cs.x * cos(th) - cs.y * sin(th); }
vec2 breathe(vec2 t, float th) {
  vec2 ex = vec2(uPhaseTexel.x * 1.5, 0), ey = vec2(0, uPhaseTexel.y * 1.5);
  return vec2(swell(t + ex, th) - swell(t - ex, th), swell(t + ey, th) - swell(t - ey, th)) * 2.4;
}
// 波：一方向へ渡る。進む向きの押し引きと、横の揺れを重ねる。波の数は整数にして、絵の端でつながるようにする
vec2 wave(vec2 p, vec2 t, float th) {
  vec2 kv = max(vec2(1), floor(uCells * vec2(0.34, 0.2) + 0.5)), n = normalize(kv / uCells);
  float ph = TAU * dot(t, kv) + 2.2 * fb(p, 200.0) - th;
  return n * cos(ph) * 0.6 + vec2(-n.y, n.x) * sin(ph + 1.0) * 0.8;
}

void main() {
  vec2 t = vUv * uTiles, p = t * uCells, d;
  if (uKind == 1) d = flow(p, uTheta);
  else if (uKind == 2 && uHasPhase) d = breathe(t, uTheta);
  else if (uKind == 3) d = wave(p, t, uTheta);
  else if (uKind == 4) { vec2 d1 = sway(p, uTheta, 0.0); d = 0.6 * d1 + 0.8 * sway(p + 1.2 * d1, uTheta + 1.7, 50.0); } // ずらした先で、もう一度ずらす
  else d = sway(p, uTheta, 0.0);
  if (!uWrap) { // 端の外は読めない。端に近いほど動きを弱める
    vec2 e = min(vUv, 1.0 - vUv) / (abs(uAmp) * 2.5 + 1e-6);
    d *= smoothstep(0.0, 1.0, min(e.x, e.y));
  }
  o = vec4(texture(uTex, vUv + d * uAmp).rgb, 1.0);
}`;

const KINDS: MotionKind[] = ['sway', 'flow', 'breathe', 'wave', 'double'];

/** 位相の地図をぼかす。箱ぼかしを3回。wrap のときは端をまたいでぼかす（リピートのため） */
function blurPhase(m: PhaseMap, wrap: boolean): Uint8Array {
  const { w, h } = m, r = Math.max(1, Math.round(Math.max(w, h) * 0.012));
  let a = Float32Array.from(m.data), b = new Float32Array(a.length);
  const at = (i: number, n: number): number => wrap ? ((i % n) + n) % n : Math.min(n - 1, Math.max(0, i));
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 2; c++) { let s = 0; for (let k = -r; k <= r; k++) s += a[(y * w + at(x + k, w)) * 2 + c]; b[(y * w + x) * 2 + c] = s / (2 * r + 1); }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 2; c++) { let s = 0; for (let k = -r; k <= r; k++) s += b[(at(y + k, h) * w + x) * 2 + c]; a[(y * w + x) * 2 + c] = s / (2 * r + 1); }
  }
  return Uint8Array.from(a, (v) => Math.round(v));
}

export class Motion {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private tex: WebGLTexture; private phase: WebGLTexture;
  private loc: Record<string, WebGLUniformLocation | null> = {};
  private hasPhase = false; private phaseSize: [number, number] = [1, 1];
  private wrapNow: boolean | null = null; private phaseSrc: PhaseMap | null = null; private phaseWrap: boolean | null = null;
  /** 絵を入れたか */
  ready = false;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false });
    if (!gl) throw new Error('このブラウザでは動かせない（WebGL2 が使えない）。');
    this.gl = gl;
    const sh = (type: number, src: string): WebGLShader => {
      const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`動かす準備に失敗した：${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const prog = gl.createProgram()!; gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG)); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`動かす準備に失敗した：${gl.getProgramInfoLog(prog)}`);
    this.prog = prog; gl.useProgram(prog);
    for (const n of ['uTex', 'uPhase', 'uCells', 'uTiles', 'uAmp', 'uPhaseTexel', 'uTheta', 'uKind', 'uSeed', 'uWrap', 'uHasPhase']) this.loc[n] = gl.getUniformLocation(prog, n);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const a = gl.getAttribLocation(prog, 'aPos'); gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    this.tex = gl.createTexture()!; this.phase = gl.createTexture()!;
    gl.uniform1i(this.loc.uTex, 0); gl.uniform1i(this.loc.uPhase, 1);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }

  /** いちどに持てる絵の大きさの上限（画素） */
  get maxSize(): number { return this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number; }

  /** 動かす絵を入れる。キャンバスは w×h にする（絵と違う大きさなら、引き伸ばして描く） */
  setPicture(src: HTMLCanvasElement, w = src.width, h = src.height): void {
    const gl = this.gl;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.wrapNow = null; this.ready = true;
  }

  /** ブロブごとの位相の地図（「呼吸」用）。null なら「呼吸」は「ゆらぎ」で代える */
  setPhase(m: PhaseMap | null): void { this.phaseSrc = m; this.phaseWrap = null; this.hasPhase = !!m; }

  /** 使い終わったら呼ぶ。ブラウザが持てる描画の場の数には限りがある */
  dispose(): void { this.gl.getExtension('WEBGL_lose_context')?.loseContext(); this.ready = false; }

  /** θ（0〜2π で1周）のときの絵を描く */
  draw(theta: number, o: MotionOptions): void {
    if (!this.ready) return;
    const gl = this.gl, W = this.canvas.width, H = this.canvas.height;
    if (this.wrapNow !== o.wrap) { // 端をまたいで読むかどうか
      const mode = o.wrap ? gl.REPEAT : gl.CLAMP_TO_EDGE;
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, mode); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, mode);
      this.wrapNow = o.wrap;
    }
    if (this.phaseSrc && this.phaseWrap !== o.wrap) { // ぼかし方が端の扱いで変わるので、ここで作る
      const m = this.phaseSrc, mode = o.wrap ? gl.REPEAT : gl.CLAMP_TO_EDGE;
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.phase);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, m.w, m.h, 0, gl.RG, gl.UNSIGNED_BYTE, blurPhase(m, o.wrap));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, mode); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, mode);
      this.phaseSize = [m.w, m.h]; this.phaseWrap = o.wrap;
    }
    const tiles = Math.max(1, o.tiles), tw = W / tiles, th = H / tiles, long = Math.max(tw, th);
    const cx = Math.max(1, Math.round(o.fine * tw / long)), cy = Math.max(1, Math.round(o.fine * th / long));
    const amp = o.amount * 0.3 * long / o.fine; // 画素。升目ひとつの3割まで。これより大きいと絵が折り重なる
    gl.viewport(0, 0, W, H);
    gl.uniform2f(this.loc.uCells, cx, cy); gl.uniform2f(this.loc.uTiles, tiles, tiles); gl.uniform2f(this.loc.uAmp, amp / W, amp / H);
    gl.uniform2f(this.loc.uPhaseTexel, 1 / this.phaseSize[0], 1 / this.phaseSize[1]);
    gl.uniform1f(this.loc.uTheta, theta); gl.uniform1i(this.loc.uKind, Math.max(0, KINDS.indexOf(o.kind)));
    gl.uniform1ui(this.loc.uSeed, o.seed >>> 0); gl.uniform1i(this.loc.uWrap, o.wrap ? 1 : 0); gl.uniform1i(this.loc.uHasPhase, this.hasPhase ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
