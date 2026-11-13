// 試作 prototype/anyflage.engine.js の移植。ロジックは同じ。型を足し、使い回しの置き場に名前を付けた。
import type { BlobMap, Camo, CarveOptions, Comps, F32, FitOptions, Grid, Inv, Mesh, Params, Pixels, Raster, RGB, Source, SourceLike, Trace, UV } from './types.ts';

export const Kao = (function () {
  function hash2(ix: number, iy: number, s: number) {
    var h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(s, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function vnoise(x: number, y: number, s: number) {
    var ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    var a = hash2(ix, iy, s), b = hash2(ix + 1, iy, s), c = hash2(ix, iy + 1, s), d = hash2(ix + 1, iy + 1, s);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }
  function fbm(x: number, y: number, s: number) { return (vnoise(x, y, s) + 0.5 * vnoise(x * 2 + 17.1, y * 2 + 9.3, s + 7)) / 1.5; }

  // Connected components over an Int32 key map (4-neighbour). Returns ids + count.
  function label(key: Int32Array, W: number, H: number) {
    var n = W * H, ids = new Int32Array(n).fill(-1), stack = new Int32Array(n), count = 0;
    for (var i = 0; i < n; i++) {
      if (ids[i] !== -1) continue;
      var k = key[i], sp = 0; stack[sp++] = i; ids[i] = count;
      while (sp > 0) {
        var p = stack[--sp], x = p % W;
        if (x > 0 && ids[p - 1] === -1 && key[p - 1] === k) { ids[p - 1] = count; stack[sp++] = p - 1; }
        if (x < W - 1 && ids[p + 1] === -1 && key[p + 1] === k) { ids[p + 1] = count; stack[sp++] = p + 1; }
        if (p >= W && ids[p - W] === -1 && key[p - W] === k) { ids[p - W] = count; stack[sp++] = p - W; }
        if (p < n - W && ids[p + W] === -1 && key[p + W] === k) { ids[p + W] = count; stack[sp++] = p + W; }
      }
      count++;
    }
    return { ids: ids, count: count };
  }

  var THR = [0, 0.52, 0.56, 0.6], DX = [-1, -1, 0, 1, 1, 1, 0, -1], DY = [0, -1, -1, -1, 0, 1, 1, 1];

  // 各画素の、自分のブロブの縁までの距離（面取り距離）
  function depthOf(ids: Int32Array, W: number, H: number): F32 {
    var n = W * H, dt = new Float32Array(n).fill(1e9), x, y, i, c, d;
    for (y = 0, i = 0; y < H; y++) for (x = 0; x < W; x++, i++) {
      c = ids[i];
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1 || ids[i - 1] !== c || ids[i + 1] !== c || ids[i - W] !== c || ids[i + W] !== c) dt[i] = 0.5;
    }
    for (y = 0, i = 0; y < H; y++) for (x = 0; x < W; x++, i++) {
      d = dt[i];
      if (x > 0 && dt[i - 1] + 1 < d) d = dt[i - 1] + 1;
      if (y > 0) { if (dt[i - W] + 1 < d) d = dt[i - W] + 1; if (x > 0 && dt[i - W - 1] + 1.414 < d) d = dt[i - W - 1] + 1.414; if (x < W - 1 && dt[i - W + 1] + 1.414 < d) d = dt[i - W + 1] + 1.414; }
      dt[i] = d;
    }
    for (y = H - 1, i = n - 1; y >= 0; y--) for (x = W - 1; x >= 0; x--, i--) {
      d = dt[i];
      if (x < W - 1 && dt[i + 1] + 1 < d) d = dt[i + 1] + 1;
      if (y < H - 1) { if (dt[i + W] + 1 < d) d = dt[i + W] + 1; if (x < W - 1 && dt[i + W + 1] + 1.414 < d) d = dt[i + W + 1] + 1.414; if (x > 0 && dt[i + W - 1] + 1.414 < d) d = dt[i + W - 1] + 1.414; }
      dt[i] = d;
    }
    return dt;
  }
  // くびれでつながったブロブを切り分ける。
  // 縁からの深さを山の高さと見る。ブロブの太い所が山、くびれが峠になる。
  // 深い画素から順に見ていき、2つの山が初めて出会う所（峠）で、峠の深さが低いほうの山の alpha 倍より浅ければ切る。
  // つまり「くびれの幅が、つながる先の太さの alpha 倍より細い」とき切る。大きさによらない。
  // 山が1つのブロブ（もとから小さい島、全体が同じ太さの帯）は切れない。minPeak より低い山は出っぱりと見て数えない。
  // 切り口は、峠の点からいちばん近い縁と、その反対側のいちばん近い縁を結ぶ直線。くびれを最短で横切る。
  // （山の境目をそのまま切り口にすると、境目が縁に沿って這い、細長い切れ端ができる）
  function splitNecks(ids: Int32Array<ArrayBuffer>, W: number, H: number, alpha: number, minPeak: number): { ids: Int32Array<ArrayBuffer>; count: number } {
    var segs = neckSegments(ids, W, H, alpha, minPeak), wall = new Uint8Array(W * H), walls = 0;
    for (var k = 0; k < segs.length; k++) walls += drawWall(wall, ids, W, H, segs[k][4], segs[k][0], segs[k][1], segs[k][2], segs[k][3]);
    return cutByWalls(ids, wall, walls, W, H);
  }
  /** くびれの切り口の一覧 [始点x, 始点y, 終点x, 終点y, ブロブの番号] */
  function neckSegments(ids: Int32Array, W: number, H: number, alpha: number, minPeak: number): number[][] {
    var n = W * H, dt = depthOf(ids, W, H), i, k, maxd = 0, segs: number[][] = [];
    for (i = 0; i < n; i++) if (dt[i] > maxd) maxd = dt[i];
    // 深さの順に並べる（0.5刻みの桶）
    var levels = Math.floor(maxd * 2) + 2, cnt = new Int32Array(levels + 1), order = new Int32Array(n);
    for (i = 0; i < n; i++) cnt[Math.floor(dt[i] * 2) + 1]++;
    for (k = 0; k < levels; k++) cnt[k + 1] += cnt[k];
    for (i = 0; i < n; i++) order[cnt[Math.floor(dt[i] * 2)]++] = i;
    var parent = new Int32Array(n).fill(-1), peak = new Float32Array(n), cut = false;
    var border = new Uint8Array(n), saddles: number[] = [];
    var find = function (a: number): number { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    for (var t = n - 1; t >= 0; t--) {
      var p = order[t], x = p % W, bid = ids[p], d = dt[p], best = -1;
      for (k = 0; k < 4; k++) {
        var m = k === 0 ? (x > 0 ? p - 1 : -1) : k === 1 ? (x < W - 1 ? p + 1 : -1) : k === 2 ? p - W : p + W;
        if (m < 0 || m >= n || parent[m] < 0 || ids[m] !== bid) continue;
        var r = find(m);
        if (best < 0) { best = r; continue; }
        if (r === best) continue;
        var lo = peak[r] < peak[best] ? r : best, hi = lo === r ? best : r;
        if (peak[lo] < minPeak || d >= alpha * peak[lo]) { parent[lo] = hi; best = hi; } // 峠が十分に深い、または山が小さすぎる：同じブロブ
        else { // 切る。山の境目の最初の画素が峠
          best = hi; cut = true;
          var fresh = !border[p]; for (var q = 0; q < 8 && fresh; q++) { var bx = x + DX[q], bp = p + DX[q] + DY[q] * W; if (bx >= 0 && bx < W && bp >= 0 && bp < n && border[bp]) fresh = false; }
          if (fresh) saddles.push(p);
          border[p] = 1;
        }
      }
      if (best < 0) { parent[p] = p; peak[p] = d; } else parent[p] = best;
    }
    if (!cut) return segs;
    var kept: number[] = [];
    for (var si = 0; si < saddles.length; si++) {
      var sp = saddles[si], sx = sp % W, sy = (sp / W) | 0, sid = ids[sp], R = Math.ceil(dt[sp]) + 4, xx, yy, dx, dy, dd;
      // すでに切った所から、くびれの幅より近い峠は飛ばす。同じ太さの帯を輪切りにしない
      var dup = false;
      for (var ki = 0; ki < kept.length && !dup; ki++) { var kp = kept[ki]; if (ids[kp] === sid) { dx = kp % W - sx; dy = ((kp / W) | 0) - sy; if (dx * dx + dy * dy < 9 * dt[sp] * dt[sp]) dup = true; } }
      if (dup) continue;
      // いちばん近い縁
      var b1 = 1e9, ex1 = 0, ey1 = 0;
      for (dy = -R; dy <= R; dy++) for (dx = -R; dx <= R; dx++) {
        xx = sx + dx; yy = sy + dy; dd = dx * dx + dy * dy;
        if (dd >= b1 || dd > R * R) continue;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H || ids[yy * W + xx] !== sid) { b1 = dd; ex1 = dx; ey1 = dy; }
      }
      if (b1 > 1e8) continue;
      // その反対側（110度より向こう）でいちばん近い縁
      var b2 = 1e9, ex2 = 0, ey2 = 0, R2 = R * 2, l1 = Math.sqrt(b1);
      for (dy = -R2; dy <= R2; dy++) for (dx = -R2; dx <= R2; dx++) {
        xx = sx + dx; yy = sy + dy; dd = dx * dx + dy * dy;
        if (dd >= b2 || dd > R2 * R2 || dx * ex1 + dy * ey1 > -0.34 * Math.sqrt(dd) * l1) continue;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H || ids[yy * W + xx] !== sid) { b2 = dd; ex2 = dx; ey2 = dy; }
      }
      if (b2 > 1e8) continue;
      // 2つの縁を結ぶ線が切り口
      segs.push([sx + ex1, sy + ey1, sx + ex2, sy + ey2, sid]);
      kept.push(sp);
    }
    return segs;
  }
  /** (ax,ay)→(zx,zy) の線を壁にする。sid のブロブの上だけ。増えた壁の画素数を返す */
  function drawWall(wall: Uint8Array, ids: Int32Array, W: number, H: number, sid: number, ax: number, ay: number, zx: number, zy: number): number {
    var adx = Math.abs(zx - ax), ady = Math.abs(zy - ay), stx = ax < zx ? 1 : -1, sty = ay < zy ? 1 : -1, err = adx - ady, made = 0;
    for (;;) {
      if (ax >= 0 && ay >= 0 && ax < W && ay < H && ids[ay * W + ax] === sid && !wall[ay * W + ax]) { wall[ay * W + ax] = 1; made++; }
      if (ax === zx && ay === zy) break;
      var e2 = 2 * err; if (e2 > -ady) { err -= ady; ax += stx; } if (e2 < adx) { err += adx; ay += sty; }
    }
    return made;
  }
  /** 壁をはさんで塗り分け、壁の画素は隣のブロブに入れる */
  function cutByWalls(ids: Int32Array<ArrayBuffer>, wall: Uint8Array, walls: number, W: number, H: number): { ids: Int32Array<ArrayBuffer>; count: number } {
    var n = W * H, i, x;
    if (!walls) { var nb = 0; for (i = 0; i < n; i++) if (ids[i] >= nb) nb = ids[i] + 1; return { ids: ids, count: nb }; }
    var key = new Int32Array(n); for (i = 0; i < n; i++) key[i] = wall[i] ? -1 : ids[i];
    var parts = label(key, W, H).ids;
    for (var pass = 0; pass < 8 && walls > 0; pass++) for (i = 0; i < n; i++) {
      if (!wall[i]) continue;
      x = i % W;
      var to = x > 0 && !wall[i - 1] && ids[i - 1] === ids[i] ? i - 1 : x < W - 1 && !wall[i + 1] && ids[i + 1] === ids[i] ? i + 1 : i >= W && !wall[i - W] && ids[i - W] === ids[i] ? i - W : i < n - W && !wall[i + W] && ids[i + W] === ids[i] ? i + W : -1;
      if (to >= 0) { parts[i] = parts[to]; wall[i] = 0; walls--; }
    }
    return label(parts, W, H);
  }

  // えぐれでブロブを切る。
  // 縁が内側へ鋭く食い込んでいる点（まわりの円の中で、自分のブロブが6割5分を超える縁の点）を探し、
  // 食い込みの向きへまっすぐ進んで、反対側の縁まで切る。
  // 切り口の長さが、切り分けた小さいほうの大きさ（面積の平方根）× 1.6 × amount より短いときだけ切る。
  // 粗い地図（長辺 360）で決めるので、画面用と書き出し用で同じ所が切れる。
  function splitNotches(ids: Int32Array<ArrayBuffer>, W: number, H: number, amount: number): { ids: Int32Array<ArrayBuffer>; count: number } {
    var n = W * H, f = Math.min(1, 360 / Math.max(W, H)), cw = Math.max(1, Math.round(W * f)), ch = Math.max(1, Math.round(H * f)), cn = cw * ch;
    var cid = new Int32Array(cn), x, y, i, k, nb = 0;
    for (y = 0; y < ch; y++) for (x = 0; x < cw; x++) { var v = ids[Math.min(H - 1, Math.floor((y + 0.5) / f)) * W + Math.min(W - 1, Math.floor((x + 0.5) / f))]; cid[y * cw + x] = v; if (v >= nb) nb = v + 1; }
    var dt = depthOf(cid, cw, ch), dmax = new Float32Array(nb);
    for (i = 0; i < cn; i++) if (dt[i] > dmax[cid[i]]) dmax[cid[i]] = dt[i];
    // 候補：縁の画素ごとに、半径 r の円の中で自分のブロブが占める割合
    var cand: number[][] = []; // [割合, x, y, 内向きx, 内向きy, r]
    for (y = 0; y < ch; y++) for (x = 0; x < cw; x++) {
      i = y * cw + x; var c = cid[i];
      if (dmax[c] < 3) continue;
      if (!((x > 0 && cid[i - 1] !== c) || (x < cw - 1 && cid[i + 1] !== c) || (y > 0 && cid[i - cw] !== c) || (y < ch - 1 && cid[i + cw] !== c))) continue;
      var r = Math.max(3, Math.min(12, Math.round(dmax[c] * 0.6))), ins = 0, all = 0, ox = 0, oy = 0;
      for (var dy = -r; dy <= r; dy++) for (var dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        var xx = x + dx, yy = y + dy; all++;
        if (xx >= 0 && yy >= 0 && xx < cw && yy < ch && cid[yy * cw + xx] === c) ins++; else { ox += dx; oy += dy; }
      }
      var ol = Math.sqrt(ox * ox + oy * oy);
      if (ins / all >= 0.65 && ol > 0) cand.push([ins / all, x, y, -ox / ol, -oy / ol, r]);
    }
    cand.sort(function (a, b) { return b[0] - a[0]; });
    var cwall = new Uint8Array(cn), mark = new Int32Array(cn), stamp = 0, stack = new Int32Array(cn), used: number[][] = [], segs: number[][] = [];
    var flood = function (start: number, c: number, stop: number): number { // 壁を越えずに塗れる面積。stop に届いたら -1
      stamp++; var sp = 0, area = 0; stack[sp++] = start; mark[start] = stamp;
      while (sp > 0) {
        var p = stack[--sp], px = p % cw; area++;
        if (p === stop) return -1;
        var q;
        if (px > 0) { q = p - 1; if (mark[q] !== stamp && cid[q] === c && !cwall[q]) { mark[q] = stamp; stack[sp++] = q; } }
        if (px < cw - 1) { q = p + 1; if (mark[q] !== stamp && cid[q] === c && !cwall[q]) { mark[q] = stamp; stack[sp++] = q; } }
        if (p >= cw) { q = p - cw; if (mark[q] !== stamp && cid[q] === c && !cwall[q]) { mark[q] = stamp; stack[sp++] = q; } }
        if (p < cn - cw) { q = p + cw; if (mark[q] !== stamp && cid[q] === c && !cwall[q]) { mark[q] = stamp; stack[sp++] = q; } }
      }
      return area;
    };
    for (k = 0; k < cand.length; k++) {
      var cd = cand[k], tx = cd[1], ty = cd[2], c0 = cid[ty * cw + tx], near = false;
      for (var u = 0; u < used.length && !near; u++) if (used[u][2] === c0 && (used[u][0] - tx) * (used[u][0] - tx) + (used[u][1] - ty) * (used[u][1] - ty) < cd[5] * cd[5] * 2.25) near = true;
      if (near) continue; // 同じえぐれの、となりの点
      used.push([tx, ty, c0]);
      // 食い込みの向き ±100度の線を全部ためす。切り分けた小さいほうが、切り口の長さのわりにいちばん大きくなる線を選ぶ
      var ang0 = Math.atan2(cd[4], cd[3]), maxL = Math.max(cw, ch), sx0 = Math.round(tx - cd[3] * 2), sy0 = Math.round(ty - cd[4] * 2);
      var bestScore = 0, bex = 0, bey = 0, before = cwall.slice();
      for (var da = -100; da <= 100; da += 10) {
        var ca = Math.cos(ang0 + da * Math.PI / 180), sa = Math.sin(ang0 + da * Math.PI / 180), L = 0, ex0 = 0, ey0 = 0;
        for (var t = 1.5; t < maxL; t += 0.5) {
          var rx = Math.round(tx + ca * t), ry = Math.round(ty + sa * t);
          if (rx < 0 || ry < 0 || rx >= cw || ry >= ch || cid[ry * cw + rx] !== c0) { if (t > 2.5) { L = t; ex0 = rx; ey0 = ry; } break; }
          if (cwall[ry * cw + rx]) break; // すでにある切り口をまたがない
        }
        if (!L) continue;
        drawWall(cwall, cid, cw, ch, c0, sx0, sy0, ex0, ey0);
        var mx = tx + ca * L / 2, my = ty + sa * L / 2, sA = -1, sB = -1;
        for (var off = 1.5; off <= 3 && (sA < 0 || sB < 0); off += 0.75) {
          var ax1 = Math.round(mx - sa * off), ay1 = Math.round(my + ca * off), bx1 = Math.round(mx + sa * off), by1 = Math.round(my - ca * off);
          var pa = ax1 >= 0 && ay1 >= 0 && ax1 < cw && ay1 < ch ? ay1 * cw + ax1 : -1, pb = bx1 >= 0 && by1 >= 0 && bx1 < cw && by1 < ch ? by1 * cw + bx1 : -1;
          if (sA < 0 && pa >= 0 && cid[pa] === c0 && !cwall[pa]) sA = pa;
          if (sB < 0 && pb >= 0 && cid[pb] === c0 && !cwall[pb]) sB = pb;
        }
        if (sA >= 0 && sB >= 0) {
          var aA = flood(sA, c0, sB);
          if (aA > 0) { var score = Math.sqrt(Math.min(aA, flood(sB, c0, -1))) / L; if (score > bestScore) { bestScore = score; bex = ex0; bey = ey0; } }
        }
        cwall.set(before);
      }
      if (bestScore * 1.6 * amount >= 1) { drawWall(cwall, cid, cw, ch, c0, sx0, sy0, bex, bey); segs.push([sx0, sy0, bex, bey, c0]); }
    }
    if (!segs.length) return { ids: ids, count: nb };
    var wall = new Uint8Array(n), walls = 0;
    for (k = 0; k < segs.length; k++) {
      var sg = segs[k], ex = sg[2] - sg[0], ey = sg[3] - sg[1], el = Math.sqrt(ex * ex + ey * ey) || 1; // 両端を少し伸ばして、縁まで確実に届かせる
      walls += drawWall(wall, ids, W, H, sg[4], Math.round((sg[0] + 0.5 - ex / el * 1.5) / f), Math.round((sg[1] + 0.5 - ey / el * 1.5) / f), Math.round((sg[2] + 0.5 + ex / el * 1.5) / f), Math.round((sg[3] + 0.5 + ey / el * 1.5) / f));
    }
    return cutByWalls(ids, wall, walls, W, H);
  }

  function buildCamo(W: number, H: number, p: Pick<Params, 'seed' | 'size' | 'wobble' | 'layerAt' | 'neck' | 'notch' | 'noSplit' | 'split' | 'cutRef'>): Camo {
    if (p.cutRef && Math.max(W, H) > p.cutRef) return buildFromRef(W, H, p);
    var layerAt = p.layerAt, wavy = p.split === 'wavy';
    var n = W * H, M = Math.max(W, H), seed = p.seed | 0;
    var size = p.size, f = 1 / size, wob = p.wobble * size * 0.9;
    var layer = new Int32Array(n), cell = new Int32Array(n), cs = size * 2.6;
    for (var y = 0, i = 0; y < H; y++) {
      for (var x = 0; x < W; x++, i++) {
        var nx = x / M, ny = y / M;
        var wx = nx + wob * (vnoise(nx * f * 2.1, ny * f * 2.1, seed + 50) - 0.5);
        var wy = ny + wob * (vnoise(nx * f * 2.1 + 40, ny * f * 2.1 + 40, seed + 51) - 0.5);
        var L = 0;
        if (layerAt) L = layerAt(nx, ny, wx, wy); // 柄の生成器（patterns.ts）。なければ試作と同じ値ノイズ3層
        else for (var k = 1; k < 4; k++) {
          if (fbm(wx * f / 1.45 + k * 31.7, wy * f + k * 17.3, seed + k) > THR[k]) L = k;
        }
        layer[i] = L;
        // jittered Voronoi cell in the same warped space, used to break up oversized regions
        var gx = wx / cs + 4, gy = wy / cs + 4;
        if (wavy) { // 切り口をうねらせる。直線の切れ目はブロブの縁に見えない
          var q = 3.1 / cs;
          gx += (vnoise(nx * q, ny * q, seed + 92) - 0.5) * 0.7 + (vnoise(nx * q * 2.7, ny * q * 2.7, seed + 94) - 0.5) * 0.3;
          gy += (vnoise(nx * q + 20, ny * q + 20, seed + 93) - 0.5) * 0.7 + (vnoise(nx * q * 2.7 + 20, ny * q * 2.7 + 20, seed + 95) - 0.5) * 0.3;
        }
        var cx = Math.floor(gx), cy = Math.floor(gy), best = 1e9, bid = 0;
        for (var oy = -1; oy <= 1; oy++) for (var ox = -1; ox <= 1; ox++) {
          var px = cx + ox + hash2(cx + ox, cy + oy, seed + 90), py = cy + oy + hash2(cx + ox, cy + oy, seed + 91);
          var d = (px - gx) * (px - gx) + (py - gy) * (py - gy);
          if (d < best) { best = d; bid = (cx + ox) * 512 + (cy + oy); }
        }
        cell[i] = bid;
      }
    }
    var first = label(layer, W, H), area = new Int32Array(first.count);
    for (i = 0; i < n; i++) area[first.ids[i]]++;
    var big = p.noSplit || p.split === 'none' ? Infinity : n * 0.035, key = new Int32Array(n);
    for (i = 0; i < n; i++) { var c = first.ids[i]; key[i] = area[c] > big ? -1 - cell[i] * 16 - layer[i] : c; }
    var res = label(key, W, H), C = res.count, ids = res.ids;
    if (p.neck) { // くびれでつながったブロブを切り分ける
      res = splitNecks(ids, W, H, p.neck, M * 0.004); C = res.count; ids = res.ids;
    }
    if (p.notch) { // えぐれで切る
      res = splitNotches(ids, W, H, p.notch); C = res.count; ids = res.ids;
    }
    return finishCamo(W, H, ids, C, layer);
  }
  /** ブロブ分けが済んだあとの仕上げ。ブロブごとの面積・外接矩形・層と、各画素の縁からの深さ */
  function finishCamo(W: number, H: number, ids: Int32Array<ArrayBuffer>, C: number, layer: Int32Array): Camo {
    var n = W * H, x, y, i, c, d;
    var comps: Comps = { dmax: new Float32Array(C), cx: new Float32Array(C), cy: new Float32Array(C), count: C, layer: new Uint8Array(C), area: new Int32Array(C),
      x0: new Int32Array(C).fill(W), y0: new Int32Array(C).fill(H), x1: new Int32Array(C).fill(-1), y1: new Int32Array(C).fill(-1) };
    for (y = 0, i = 0; y < H; y++) for (x = 0; x < W; x++, i++) {
      c = ids[i]; comps.area[c]++; comps.layer[c] = layer[i];
      if (x < comps.x0[c]) comps.x0[c] = x; if (x > comps.x1[c]) comps.x1[c] = x;
      if (y < comps.y0[c]) comps.y0[c] = y; if (y > comps.y1[c]) comps.y1[c] = y;
    }
    // Depth of every pixel inside its blob (chamfer distance to the blob's edge), plus each blob's deepest point.
    var dt = new Float32Array(n).fill(1e9);
    for (y = 0, i = 0; y < H; y++) for (x = 0; x < W; x++, i++) {
      c = ids[i];
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1 || ids[i - 1] !== c || ids[i + 1] !== c || ids[i - W] !== c || ids[i + W] !== c) dt[i] = 0.5;
    }
    for (y = 0, i = 0; y < H; y++) for (x = 0; x < W; x++, i++) {
      d = dt[i];
      if (x > 0 && dt[i - 1] + 1 < d) d = dt[i - 1] + 1;
      if (y > 0) { if (dt[i - W] + 1 < d) d = dt[i - W] + 1; if (x > 0 && dt[i - W - 1] + 1.414 < d) d = dt[i - W - 1] + 1.414; if (x < W - 1 && dt[i - W + 1] + 1.414 < d) d = dt[i - W + 1] + 1.414; }
      dt[i] = d;
    }
    for (y = H - 1, i = n - 1; y >= 0; y--) for (x = W - 1; x >= 0; x--, i--) {
      d = dt[i];
      if (x < W - 1 && dt[i + 1] + 1 < d) d = dt[i + 1] + 1;
      if (y < H - 1) { if (dt[i + W] + 1 < d) d = dt[i + W] + 1; if (x < W - 1 && dt[i + W + 1] + 1.414 < d) d = dt[i + W + 1] + 1.414; if (x > 0 && dt[i + W - 1] + 1.414 < d) d = dt[i + W - 1] + 1.414; }
      dt[i] = d;
    }
    for (y = 0, i = 0; y < H; y++) for (x = 0; x < W; x++, i++) { c = ids[i]; if (dt[i] > comps.dmax[c]) { comps.dmax[c] = dt[i]; comps.cx[c] = x; comps.cy[c] = y; } }
    return { W: W, H: H, ids: ids, comps: comps, dt: dt, grids: {}, maps: {} };
  }

  /**
   * 大きい絵の迷彩を、小さい絵（長辺 cutRef）のブロブ分けに合わせて作る。
   * ブロブをどこで切るか（大きすぎるブロブ、くびれ、えぐれ）は、絵の大きさで少しずつ変わる。
   * そのまま大きい絵で作ると、画面で見た絵と書き出した絵でブロブの数や形が違ってしまう。
   * そこで、切る場所は小さい絵で決める。大きい絵では、色の境目だけを細かく作り直し、
   * 各画素を「同じ色の、いちばん近い小さい絵のブロブ」に入れる。大きい絵でブロブを切る計算も省ける。
   */
  function buildFromRef(W: number, H: number, p: Pick<Params, 'seed' | 'size' | 'wobble' | 'layerAt' | 'neck' | 'notch' | 'noSplit' | 'split' | 'cutRef'>): Camo {
    var M = Math.max(W, H), f = (p.cutRef as number) / M, cw = Math.max(1, Math.round(W * f)), ch = Math.max(1, Math.round(H * f));
    var q: typeof p = { seed: p.seed, size: p.size, wobble: p.wobble, layerAt: p.layerAt, neck: p.neck, notch: p.notch, noSplit: p.noSplit, split: p.split };
    var layerAt = p.layerAt, seed = p.seed | 0, size = p.size, fq = 1 / size, wob = p.wobble * size * 0.9;
    return fromRef(buildCamo(cw, ch, q), W, H, function (x: number, y: number) {
      var nx = x / M, ny = y / M;
      var wx = nx + wob * (vnoise(nx * fq * 2.1, ny * fq * 2.1, seed + 50) - 0.5), wy = ny + wob * (vnoise(nx * fq * 2.1 + 40, ny * fq * 2.1 + 40, seed + 51) - 0.5);
      if (layerAt) return layerAt(nx, ny, wx, wy);
      var L = 0; for (var k = 1; k < 4; k++) if (fbm(wx * fq / 1.45 + k * 31.7, wy * fq + k * 17.3, seed + k) > THR[k]) L = k;
      return L;
    });
  }
  /**
   * 小さい絵（ref）のブロブ分けを、W×H の絵へ広げる。layerOf は、W×H の絵の画素 (x, y) の色の層を返す。
   * ブロブの番号は ref と同じまま。だから、番号や ref の形から決めたもの（どの画像を入れるか、など）が、どの大きさでも同じになる。
   */
  function fromRef(ref: Camo, W: number, H: number, layerOf: (x: number, y: number) => number): Camo {
    var cw = ref.W, ch = ref.H, rid = ref.ids, rl = ref.comps.layer, C = ref.comps.count;
    var n = W * H, layer = new Int32Array(n), ids = new Int32Array(n), fx = cw / W, fy = ch / H;
    var cand = [0, 0, 0, 0], wgt = [0, 0, 0, 0];
    for (var y = 0, i = 0; y < H; y++) for (var x = 0; x < W; x++, i++) {
      var L = layerOf(x, y);
      // 小さい絵の、まわり4画素。同じ色のブロブだけを候補にして、近さの重みがいちばん大きいものを選ぶ。境目がなめらかな斜めになる
      var rx = Math.min(cw - 1, Math.max(0, (x + 0.5) * fx - 0.5)), ry = Math.min(ch - 1, Math.max(0, (y + 0.5) * fy - 0.5));
      var x0 = Math.floor(rx), y0 = Math.floor(ry), x1 = Math.min(cw - 1, x0 + 1), y1 = Math.min(ch - 1, y0 + 1), tx = rx - x0, ty = ry - y0, nc = 0, best = -1, bw = 0;
      for (var j = 0; j < 4; j++) {
        var b = rid[(j < 2 ? y0 : y1) * cw + (j % 2 ? x1 : x0)], w = (j % 2 ? tx : 1 - tx) * (j < 2 ? 1 - ty : ty) + 1e-6;
        if (rl[b] !== L) continue;
        for (var m = 0; m < nc && cand[m] !== b; m++);
        if (m === nc) { cand[nc] = b; wgt[nc] = 0; nc++; }
        wgt[m] += w;
      }
      for (j = 0; j < nc; j++) if (wgt[j] > bw) { bw = wgt[j]; best = cand[j]; }
      if (best < 0) { // まわりに同じ色のブロブがない。少し広げて探す
        var cxr = Math.round(rx), cyr = Math.round(ry), bd = 1e9;
        for (var r = 1; r <= 3 && best < 0; r++) for (var dy = -r; dy <= r; dy++) for (var dx = -r; dx <= r; dx++) {
          var xx = cxr + dx, yy = cyr + dy; if (xx < 0 || yy < 0 || xx >= cw || yy >= ch) continue;
          var bb = rid[yy * cw + xx], dd = dx * dx + dy * dy;
          if (rl[bb] === L && dd < bd) { bd = dd; best = bb; }
        }
      }
      if (best < 0) { best = rid[Math.round(ry) * cw + Math.round(rx)]; L = rl[best]; } // 小さい絵には無い、点のようなかけら。まわりのブロブに合わせる
      ids[i] = best; layer[i] = L;
    }
    return finishCamo(W, H, ids, C, layer);
  }

  function smooth(a: F32, r: number): F32 {
    if (r < 1) return a;
    var n = a.length, out = new Float32Array(n), sum = 0, cnt = 0, j;
    for (j = 0; j < Math.min(n, r + 1); j++) { sum += a[j]; cnt++; }
    for (var i = 0; i < n; i++) {
      out[i] = sum / cnt;
      var add = i + r + 1, rem = i - r;
      if (add < n) { sum += a[add]; cnt++; }
      if (rem >= 0) { sum -= a[rem]; cnt--; }
    }
    return out;
  }

  /**
   * ブロブごとに、何番の素材を入れるか決める。素材を入れないブロブは -1。
   * assign が 'apart' のときは、隣どうしのブロブに同じ素材が来ないように選ぶ。
   * 隣とは、斜めも含めて境目を接しているか、細いすき間（ブロブの大きさの22%。角丸タイルの斜め向かいに届く幅）をはさんで向かい合っているブロブ。
   */
  function assignSources(camo: Camo, np: number, p: Pick<Params, 'seed' | 'size' | 'assign' | 'flatBelow' | 'flatLayers'>): Int32Array {
    var W = camo.W, H = camo.H, ids = camo.ids, cm = camo.comps, C = cm.count, seed = p.seed | 0, c, i, x, y;
    var pick = new Int32Array(C).fill(-1), flatArea = (p.flatBelow || 0) * W * H;
    for (c = 0; c < C; c++) {
      var L = cm.layer[c];
      if (!np || cm.area[c] < flatArea || (p.flatLayers && p.flatLayers.indexOf(L) >= 0)) continue;
      pick[c] = p.assign === 'layer' ? L % np : Math.floor(hash2(camo.keys ? camo.keys[c] : c, 11, seed) * np) % np;
    }
    if (p.assign !== 'apart' || np < 2 || camo.keys) return pick; // 鍵つき（リピート用）のときは、ずらした写しどうしで同じ素材にしたいので、隣よけはしない
    var nb: Record<number, 1>[] = []; for (c = 0; c < C; c++) nb.push({});
    var gap = Math.max(2, Math.round(Math.max(W, H) * p.size * 0.22)), steps = [1, gap];
    for (var s = 0; s < 2; s++) {
      var d = steps[s];
      for (y = 0; y < H; y++) for (x = 0, i = y * W; x < W; x++, i++) {
        var a = ids[i]; if (pick[a] < 0) continue;
        if (x + d < W) { var b = ids[i + d]; if (b !== a && pick[b] >= 0) { nb[a][b] = 1; nb[b][a] = 1; } }
        if (y + d < H) { b = ids[i + d * W]; if (b !== a && pick[b] >= 0) { nb[a][b] = 1; nb[b][a] = 1; } }
        if (y + d < H && x + d < W) { b = ids[i + d * W + d]; if (b !== a && pick[b] >= 0) { nb[a][b] = 1; nb[b][a] = 1; } } // 斜めの隣
        if (y + d < H && x - d >= 0) { b = ids[i + d * W - d]; if (b !== a && pick[b] >= 0) { nb[a][b] = 1; nb[b][a] = 1; } }
      }
    }
    // 大きいブロブから順に決める。希望の素材が隣とかぶっていたら、次の番号へずらす
    var order: number[] = []; for (c = 0; c < C; c++) if (pick[c] >= 0) order.push(c);
    order.sort(function (u, v) { return cm.area[v] - cm.area[u]; });
    var done = new Uint8Array(C), used = new Uint8Array(np);
    for (var o = 0; o < order.length; o++) {
      c = order[o]; used.fill(0);
      for (var k in nb[c]) if (done[+k] && used[pick[+k]] < 255) used[pick[+k]]++;
      var bj = pick[c]; // 隣でいちばん使われていない素材。同点なら希望に近い番号
      for (var t = 1; t < np; t++) { var j = (pick[c] + t) % np; if (used[j] < used[bj]) bj = j; }
      pick[c] = bj;
      done[c] = 1;
    }
    return pick;
  }

  // photos: [{w, h, data: Uint8ClampedArray RGBA, face?: {cx, cy, roll, R: 360 radii}}]. colors: 4 x [r,g,b]. out: RGBA buffer W*H*4.
  function renderCamo(out: Pixels, camo: Camo, photos: SourceLike[], colors: RGB[], p: Params) {
    var W = camo.W, H = camo.H, ids = camo.ids, cm = camo.comps, seed = p.seed | 0;
    var fit = p.fit, dist = p.dist, tint = p.tint, zoom = p.zoom, np = photos.length, sq = p.squeeze || 0, e1 = sq < 0.7 ? sq / 0.7 : 1, g1 = sq < 0.7 ? 0 : (sq - 0.7) / 0.3;
    var flatArea = (p.flatBelow || 0) * W * H, apart = p.assign === 'apart' ? assignSources(camo, np, p) : null;
    var clip = p.clip, keys = camo.keys;
    for (var c = 0; c < cm.count; c++) {
      var L = cm.layer[c], col = colors[L % colors.length], bx = cm.x0[c], by = cm.y0[c];
      var bw = cm.x1[c] - bx + 1, bh = cm.y1[c] - by + 1, x, y, i, lx, ly;
      if (!cm.area[c]) continue; // 画素を1つも持たないブロブ
      if (clip && (cm.x1[c] < clip[0] || cm.y1[c] < clip[1] || bx > clip[2] || by > clip[3])) continue; // 描く範囲にかからないブロブは飛ばす
      if (!np || cm.area[c] < flatArea || (p.flatLayers && p.flatLayers.indexOf(L) >= 0)) { // 素材なし、または小さすぎるブロブは色だけ塗る
        for (y = by; y < by + bh; y++) for (x = bx, i = y * W + bx; x < bx + bw; x++, i++) if (ids[i] === c) {
          out[i * 4] = col[0]; out[i * 4 + 1] = col[1]; out[i * 4 + 2] = col[2]; out[i * 4 + 3] = 255;
        }
        continue;
      }
      var kc = keys ? keys[c] : c; // 素材・向き・回転を決める鍵。ふつうはブロブの番号
      var r1 = hash2(kc, 11, seed), r2 = hash2(kc, 23, seed), r3 = hash2(kc, 37, seed), r4 = hash2(kc, 41, seed);
      var ph0 = photos[apart ? apart[c] : p.assign === 'layer' ? L % np : Math.floor(r1 * np) % np];
      var ph: Source = 'pick' in ph0 ? ph0.pick(bw / bh) : ph0; // content-aware sources hand back a version carved for this blob's proportions
      if (ph.shape && p.method && p.method !== 'radial') {
        var opt: FitOptions = { method: p.method, ang: (r2 - 0.5) * 2 * Math.PI * p.rot, flip: r3 < 0.5 ? -1 : 1, spin: (r3 - 0.5) * 2, dist: dist, tint: tint, squeeze: sq, mix: p.mix === undefined ? 0.5 : p.mix, imp: p.imp || 0, smooth: !!p.smooth, trim: !!p.trim };
        if (p.method === 'elastic') renderElastic(out, camo, c, ph, col, opt); else if (p.method === 'carve') renderCarve(out, camo, c, ph, col, opt); else renderDisc(out, camo, c, ph, col, opt);
        continue;
      }
      var rmin = new Float32Array(bh).fill(bw), rmax = new Float32Array(bh).fill(-1);
      var cmin = new Float32Array(bw).fill(bh), cmax = new Float32Array(bw).fill(-1);
      for (ly = 0; ly < bh; ly++) for (lx = 0, i = (by + ly) * W + bx; lx < bw; lx++, i++) if (ids[i] === c) {
        if (lx < rmin[ly]) rmin[ly] = lx; if (lx > rmax[ly]) rmax[ly] = lx;
        if (ly < cmin[lx]) cmin[lx] = ly; if (ly > cmax[lx]) cmax[lx] = ly;
      }
      var rr = Math.round(bh * 0.07), cr = Math.round(bw * 0.07);
      rmin = smooth(rmin, rr); rmax = smooth(rmax, rr); cmin = smooth(cmin, cr); cmax = smooth(cmax, cr);
      var s = Math.max(bw, bh), ang = (r2 - 0.5) * 2 * Math.PI * p.rot, flip = r3 < 0.5 ? -1 : 1;
      var ph1 = r4 * 6.283, ph2 = r1 * 6.283, pw = ph.w, phh = ph.h, pd = ph.data, F = ph.face || null, SH = ph.shape || null;
      var ccx = cm.cx ? cm.cx[c] : 0, ccy = cm.cy ? cm.cy[c] : 0, dmax = cm.dmax ? Math.max(cm.dmax[c], 0.5) : 1;
      for (ly = 0; ly < bh; ly++) for (lx = 0, i = (by + ly) * W + bx; lx < bw; lx++, i++) {
        if (ids[i] !== c) continue;
        var u0 = (lx - bw / 2) / s, v0 = (ly - bh / 2) / s;
        var u1 = (lx - rmin[ly]) / (rmax[ly] - rmin[ly] + 1) - 0.5, v1 = (ly - cmin[lx]) / (cmax[lx] - cmin[lx] + 1) - 0.5;
        var du = (u0 + (u1 - u0) * fit) * flip, dv = v0 + (v1 - v0) * fit, fxp, fyp, rad, sw, a, ca, sa, tu, tv;
        if (SH) {
          // Blob side: depth from the blob's edge and angle around its deepest point, so the blob's edge always lands on the silhouette's edge.
          var sx2 = du * 2, sy2 = dv * 2;
          if (sx2 > 1) sx2 = 1; else if (sx2 < -1) sx2 = -1; if (sy2 > 1) sy2 = 1; else if (sy2 < -1) sy2 = -1;
          var qx = sx2 * Math.sqrt(1 - sy2 * sy2 / 2), qy = sy2 * Math.sqrt(1 - sx2 * sx2 / 2);
          var dep = 1 - camo.dt[i] / dmax, ba = Math.atan2(by + ly - ccy, (bx + lx - ccx) * flip);
          if (dep < 0) dep = 0;
          qx += (dep * Math.cos(ba) - qx) * fit; qy += (dep * Math.sin(ba) - qy) * fit;
          rad = Math.sqrt(qx * qx + qy * qy); sw = Math.max(0, 1 - rad);
          var th2 = Math.atan2(qy, qx) + ang + dist * 2.4 * sw * sw * (r3 - 0.5) * 2 + dist * 0.5 * Math.sin(rad * 7 + ph1);
          if (rad > 1) rad = 1;
          // Silhouette side: radius along each ray, from bounding box (loose) to outline (tight) to gap-free (crushed).
          var dg = (th2 * 57.29577951) % 360; if (dg < 0) dg += 360;
          var k0 = dg | 0; if (k0 > 359) k0 = 359; var k1 = (k0 + 1) % 360, fq = dg - k0;
          var Rb = SH.Rbox[k0] + (SH.Rbox[k1] - SH.Rbox[k0]) * fq, Re = SH.Renv[k0] + (SH.Renv[k1] - SH.Renv[k0]) * fq;
          var rr = rad * (Rb + (Re - Rb) * e1);
          if (g1 > 0) {
            var s0 = SH.start[k0], s1 = SH.start[k1], rc0 = SH.rads[s0 + ((rad * (SH.start[k0 + 1] - s0 - 1)) | 0)], rc1 = SH.rads[s1 + ((rad * (SH.start[k1 + 1] - s1 - 1)) | 0)];
            rr += (rc0 + (rc1 - rc0) * fq - rr) * g1;
          }
          if (p.smooth) { if (!paintSmooth(out, i * 4, pd, pw, phh, SH.cx + rr * Math.cos(th2), SH.cy + rr * Math.sin(th2), col, tint)) { out[i * 4] = col[0]; out[i * 4 + 1] = col[1]; out[i * 4 + 2] = col[2]; out[i * 4 + 3] = 255; } continue; }
          var sxp = Math.round(SH.cx + rr * Math.cos(th2)), syp = Math.round(SH.cy + rr * Math.sin(th2)), oo = i * 4, si = (syp * pw + sxp) * 4;
          if (sxp < 0 || syp < 0 || sxp >= pw || syp >= phh || pd[si + 3] <= 110) {
            out[oo] = col[0]; out[oo + 1] = col[1]; out[oo + 2] = col[2]; out[oo + 3] = 255; continue;
          }
          var mm = 0.45 + (0.299 * pd[si] + 0.587 * pd[si + 1] + 0.114 * pd[si + 2]) / 255 * 1.1;
          out[oo] = pd[si] + (col[0] * mm - pd[si]) * tint; out[oo + 1] = pd[si + 1] + (col[1] * mm - pd[si + 1]) * tint;
          out[oo + 2] = pd[si + 2] + (col[2] * mm - pd[si + 2]) * tint; out[oo + 3] = 255;
          continue;
        }
        if (F) {
          // Face mode: blob square -> unit disc -> inside of the face contour. Nothing outside the contour is sampled.
          var sx = du * 2, sy = dv * 2;
          if (sx > 1) sx = 1; else if (sx < -1) sx = -1; if (sy > 1) sy = 1; else if (sy < -1) sy = -1;
          var ex = sx * Math.sqrt(1 - sy * sy / 2), ey = sy * Math.sqrt(1 - sx * sx / 2);
          rad = Math.sqrt(ex * ex + ey * ey); sw = Math.max(0, 1 - rad); a = ang + dist * 2.4 * sw * sw * (r3 - 0.5) * 2;
          ca = Math.cos(a); sa = Math.sin(a); tu = ex * ca - ey * sa; tv = ex * sa + ey * ca;
          tu += dist * 0.18 * Math.sin(tv * 4.5 + ph1); tv += dist * 0.18 * Math.sin(tu * 4.5 + ph2);
          rad = Math.sqrt(tu * tu + tv * tv); if (rad > 1) rad = 1;
          var th = Math.atan2(tv, tu), deg = th * 57.29577951; if (deg < 0) deg += 360;
          var d0 = deg | 0, fr = deg - d0; if (d0 > 359) d0 = 359;
          var Rf = (F.R[d0] * (1 - fr) + F.R[(d0 + 1) % 360] * fr) * 0.97 * rad / (zoom < 1 ? 1 : zoom);
          fxp = F.cx + Rf * Math.cos(th + F.roll); fyp = F.cy + Rf * Math.sin(th + F.roll);
          if (fxp < 0) fxp = 0; else if (fxp > pw - 1) fxp = pw - 1; if (fyp < 0) fyp = 0; else if (fyp > phh - 1) fyp = phh - 1;
        } else {
          du /= zoom; dv /= zoom;
          rad = Math.sqrt(du * du + dv * dv); sw = Math.max(0, 1 - rad * 2); a = ang + dist * 2.4 * sw * sw * (r3 - 0.5) * 2;
          ca = Math.cos(a); sa = Math.sin(a); tu = du * ca - dv * sa; tv = du * sa + dv * ca;
          tu += dist * 0.1 * Math.sin(tv * 9 + ph1); tv += dist * 0.1 * Math.sin(tu * 9 + ph2);
          var u = tu + 0.5, v = tv + 0.5;
          u -= 2 * Math.floor(u / 2); if (u > 1) u = 2 - u;
          v -= 2 * Math.floor(v / 2); if (v > 1) v = 2 - v;
          fxp = u * (pw - 1); fyp = v * (phh - 1);
        }
        var x0 = fxp | 0, y0 = fyp | 0;
        var x1 = x0 < pw - 1 ? x0 + 1 : x0, y1 = y0 < phh - 1 ? y0 + 1 : y0, tx = fxp - x0, ty = fyp - y0;
        var i00 = (y0 * pw + x0) * 4, i10 = (y0 * pw + x1) * 4, i01 = (y1 * pw + x0) * 4, i11 = (y1 * pw + x1) * 4;
        var w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
        var R = pd[i00] * w00 + pd[i10] * w10 + pd[i01] * w01 + pd[i11] * w11;
        var G = pd[i00 + 1] * w00 + pd[i10 + 1] * w10 + pd[i01 + 1] * w01 + pd[i11 + 1] * w11;
        var B = pd[i00 + 2] * w00 + pd[i10 + 2] * w10 + pd[i01 + 2] * w01 + pd[i11 + 2] * w11;
        var m = 0.45 + (0.299 * R + 0.587 * G + 0.114 * B) / 255 * 1.1, o = i * 4;
        out[o] = R + (col[0] * m - R) * tint; out[o + 1] = G + (col[1] * m - G) * tint;
        out[o + 2] = B + (col[2] * m - B) * tint; out[o + 3] = 255;
      }
    }
  }
  // Seam carving, the algorithm behind content-aware scale: repeatedly delete the top-to-bottom path of pixels that crosses the least detail.
  // P is a protection cost per pixel (skin tones), added to the energy so seams go around those areas for as long as they can.
  function seamPass(L: F32, A: F32, P: F32, MX: F32, MY: F32, W: number, H: number, count: number) {
    var cw = W, E = new Float32Array(W * H), M = new Float32Array(W * H), sxs = new Int32Array(H), x, y, i;
    var en = function (x: number, y: number) {
      var i = y * W + x, xl = x > 0 ? i - 1 : i, xr = x < cw - 1 ? i + 1 : i, yu = y > 0 ? i - W : i, yd = y < H - 1 ? i + W : i;
      return Math.abs(L[xr] - L[xl]) + Math.abs(L[yd] - L[yu]) + (Math.abs(A[xr] - A[xl]) + Math.abs(A[yd] - A[yu])) * 0.5 + (A[i] > 110 ? 1.5 : 0) + P[i];
    };
    for (y = 0; y < H; y++) for (x = 0; x < cw; x++) E[y * W + x] = en(x, y);
    for (var s = 0; s < count && cw > 6; s++) {
      for (x = 0; x < cw; x++) M[x] = E[x];
      for (y = 1; y < H; y++) for (x = 0, i = y * W; x < cw; x++, i++) {
        var m = M[i - W]; if (x > 0 && M[i - W - 1] < m) m = M[i - W - 1]; if (x < cw - 1 && M[i - W + 1] < m) m = M[i - W + 1];
        M[i] = E[i] + m;
      }
      var bx = 0, bm = Infinity; for (x = 0, i = (H - 1) * W; x < cw; x++, i++) if (M[i] < bm) { bm = M[i]; bx = x; }
      for (y = H - 1; y >= 0; y--) { sxs[y] = bx;
        if (y > 0) { var up = (y - 1) * W + bx, nb = bx, mm = M[up]; if (bx > 0 && M[up - 1] < mm) { mm = M[up - 1]; nb = bx - 1; } if (bx < cw - 1 && M[up + 1] < mm) nb = bx + 1; bx = nb; } }
      for (y = 0; y < H; y++) { var row = y * W; for (x = row + sxs[y]; x < row + cw - 1; x++) { L[x] = L[x + 1]; A[x] = A[x + 1]; P[x] = P[x + 1]; MX[x] = MX[x + 1]; MY[x] = MY[x + 1]; E[x] = E[x + 1]; } }
      cw--;
      for (y = 0; y < H; y++) for (x = Math.max(0, sxs[y] - 2); x <= Math.min(cw - 1, sxs[y] + 1); x++) E[y * W + x] = en(x, y);
    }
    return cw;
  }
  function transpose(a: F32, W: number, H: number, cw: number, ch: number) { var o = new Float32Array(H * W); for (var y = 0; y < ch; y++) for (var x = 0; x < cw; x++) o[x * H + y] = a[y * W + x]; return o; }
  // Returns a smaller RGBA image. o.amount 0..0.9 = share of the silhouette's width and height to remove;
  // o.aspect (w/h, optional) = proportions to squeeze the silhouette into; o.protect 0..1 = how hard skin tones resist.
  function carve(data: Pixels, w: number, h: number, o: CarveOptions): Raster {
    var f = (o.res || 144) / Math.max(w, h), W = Math.round(w * f), H = Math.round(h * f), n = W * H, x, y, i;
    var L = new Float32Array(n), A = new Float32Array(n), P = new Float32Array(n), MX = new Float32Array(n), MY = new Float32Array(n), x0 = W, x1 = -1, y0 = H, y1 = -1;
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) { i = y * W + x; var sx = Math.min(w - 1, Math.floor((x + 0.5) / f)), sy = Math.min(h - 1, Math.floor((y + 0.5) / f)), s = (sy * w + sx) * 4;
      var r = data[s], g = data[s + 1], b = data[s + 2];
      A[i] = data[s + 3]; L[i] = A[i] > 110 ? 0.299 * r + 0.587 * g + 0.114 * b : 0; MX[i] = sx; MY[i] = sy;
      if (A[i] > 110) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (o.protect > 0 && r > g && g > b) { // warm hues from yellow to brown, the way Photoshop's skin-tone protection picks them
          var mx = r / 255, mn = b / 255, sat = mx > 0 ? (mx - mn) / mx : 0, hue = 60 * (g - b) / (r - b || 1);
          if (hue >= 10 && hue <= 56 && sat >= 0.2 && mx >= 0.35) P[i] = o.protect * 60; } } }
    if (x1 < 0) return { w: w, h: h, data: data };
    var fw = x1 - x0 + 1, fh = y1 - y0 + 1, kw = fw * (1 - o.amount), kh = fh * (1 - o.amount);
    if (o.aspect) { if (kw / kh > o.aspect) kw = kh * o.aspect; else kh = kw / o.aspect; }
    kw = Math.max(kw, fw * 0.1, 6); kh = Math.max(kh, fh * 0.1, 6);
    var cw = seamPass(L, A, P, MX, MY, W, H, Math.round(fw - kw));
    var Lt = transpose(L, W, H, cw, H), At = transpose(A, W, H, cw, H), Pt = transpose(P, W, H, cw, H), Xt = transpose(MX, W, H, cw, H), Yt = transpose(MY, W, H, cw, H);
    var ch = seamPass(Lt, At, Pt, Xt, Yt, H, W, Math.round(fh - kh));
    var MXt0 = Xt, MYt0 = Yt, okc: Uint8Array | undefined, Mb: Float32Array | undefined;
    if (o.soften) { // 筋を1本ずつ抜いた跡は、行ごとに1画素ずつずれた階段になる。「どこを読むか」の表をならして、なめらかな伸び縮みに変える
      // 隣の升とのあいだに透明な所をはさむとき（尻尾と体のすき間をまるごと抜いた所）は、ならさずに残す。そこをならすと透明な所を読んでしまう。
      // 色の中で大きく飛んでいるだけの所は、ならす
      var R = Math.round(o.soften), unit = 1 / f, lim = (o.softenLimit === undefined ? 14 : o.softenLimit) * unit;
      var solid = function (px: number, py: number): boolean { var ix = Math.round(px), iy = Math.round(py); return ix >= 0 && iy >= 0 && ix < w && iy < h && data[(iy * w + ix) * 4 + 3] > 110; };
      for (var pass = 0; pass < 2; pass++) {
        var nX = new Float32Array(Xt), nY = new Float32Array(Yt);
        for (var cy = 0; cy < ch; cy++) for (var cx = 0; cx < cw; cx++) {
          var ci = cx * H + cy; if (At[ci] <= 110) continue;
          var sxm = 0, sym = 0, sw = 0;
          for (var dy = -R; dy <= R; dy++) for (var dx = -R; dx <= R; dx++) {
            var qx = cx + dx, qy = cy + dy; if (qx < 0 || qy < 0 || qx >= cw || qy >= ch) continue;
            var qi = qx * H + qy; if (At[qi] <= 110) continue;
            var steps = Math.abs(dx) + Math.abs(dy), px0 = Xt[qi] - dx * unit, py0 = Yt[qi] - dy * unit;
            var jx = Xt[qi] - Xt[ci], jy = Yt[qi] - Yt[ci], jump = Math.abs(px0 - Xt[ci]) + Math.abs(py0 - Yt[ci]);
            if (jump > lim * steps) continue;
            if (jump > 2.5 * unit * steps && !(solid(Xt[ci] + jx * 0.25, Yt[ci] + jy * 0.25) && solid(Xt[ci] + jx * 0.5, Yt[ci] + jy * 0.5) && solid(Xt[ci] + jx * 0.75, Yt[ci] + jy * 0.75))) continue;
            var wgt = 1 / (1 + steps); sxm += px0 * wgt; sym += py0 * wgt; sw += wgt;
          }
          if (sw > 0 && solid(sxm / sw, sym / sw)) { nX[ci] = sxm / sw; nY[ci] = sym / sw; }
        }
        Xt = nX; Yt = nY;
      }
      // 輪郭もならす。筋を抜いた跡は、輪郭でも行ごとに1升ずつずれた段になる。
      // 「絵の中かどうか」を 3×3 でぼかした面 Mb を作り、0.5 の線を新しい輪郭にする。
      // 輪郭のすぐ外の升にも「読む位置」を延ばしておく（2升ぶん）。輪郭の升でも補間して読めるようにするため
      okc = new Uint8Array(W * H); Mb = new Float32Array(W * H); var ring, add: number[];
      for (cy = 0; cy < ch; cy++) for (cx = 0; cx < cw; cx++) if (At[cx * H + cy] > 110) okc[cx * H + cy] = 1;
      for (cy = 0; cy < ch; cy++) for (cx = 0; cx < cw; cx++) {
        var ms = 0;
        for (dy = -1; dy <= 1; dy++) for (dx = -1; dx <= 1; dx++) { qx = cx + dx; qy = cy + dy; if (qx >= 0 && qy >= 0 && qx < cw && qy < ch && At[qx * H + qy] > 110) ms += dx && dy ? 1 : dx || dy ? 2 : 4; }
        Mb[cx * H + cy] = ms / 16;
      }
      for (ring = 0; ring < 2; ring++) {
        add = [];
        for (cy = 0; cy < ch; cy++) for (cx = 0; cx < cw; cx++) {
          ci = cx * H + cy; if (okc[ci]) continue;
          sxm = 0; sym = 0; sw = 0;
          for (dy = -1; dy <= 1; dy++) for (dx = -1; dx <= 1; dx++) { qx = cx + dx; qy = cy + dy; if (qx < 0 || qy < 0 || qx >= cw || qy >= ch) continue; qi = qx * H + qy; if (!okc[qi]) continue; sxm += Xt[qi] - dx * unit; sym += Yt[qi] - dy * unit; sw++; }
          if (sw) add.push(ci, sxm / sw, sym / sw);
        }
        for (var ai = 0; ai < add.length; ai += 3) { okc[add[ai]] = 1; Xt[add[ai]] = add[ai + 1]; Yt[add[ai]] = add[ai + 2]; }
      }
    }
    var ow = Math.max(4, Math.round(cw / f)), oh = Math.max(4, Math.round(ch / f)), out = new Uint8ClampedArray(ow * oh * 4);
    // carved cell (cx, cy) lives at transposed index cx * H + cy
    for (y = 0; y < oh; y++) for (x = 0; x < ow; x++) {
      var fx = Math.min(cw - 1.001, Math.max(0, (x + 0.5) * f - 0.5)), fy = Math.min(ch - 1.001, Math.max(0, (y + 0.5) * f - 0.5)), ix = fx | 0, iy = fy | 0, tx = fx - ix, ty = fy - iy;
      var a = ix * H + iy, b2 = (ix + 1) * H + iy, c = a + 1, d = b2 + 1, px, py;
      if (o.soften && okc! && Mb!) { // ならした輪郭で読む
        var q = (y * ow + x) * 4, w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
        if (Mb[a] * w00 + Mb[b2] * w10 + Mb[c] * w01 + Mb[d] * w11 < 0.5) continue;
        var ws = okc[a] * w00 + okc[b2] * w10 + okc[c] * w01 + okc[d] * w11; if (ws <= 0) continue;
        px = (okc[a] * w00 * Xt[a] + okc[b2] * w10 * Xt[b2] + okc[c] * w01 * Xt[c] + okc[d] * w11 * Xt[d]) / ws;
        py = (okc[a] * w00 * Yt[a] + okc[b2] * w10 * Yt[b2] + okc[c] * w01 * Yt[c] + okc[d] * w11 * Yt[d]) / ws;
        var sp2 = (Math.min(h - 1, Math.max(0, Math.round(py))) * w + Math.min(w - 1, Math.max(0, Math.round(px)))) * 4;
        if (data[sp2 + 3] <= 110) { // 読んだ先が透明なら、絵の中のいちばん近い升を読む
          var bw2 = -1, bn = -1;
          if (At[a] > 110 && w00 > bw2) { bw2 = w00; bn = a; } if (At[b2] > 110 && w10 > bw2) { bw2 = w10; bn = b2; } if (At[c] > 110 && w01 > bw2) { bw2 = w01; bn = c; } if (At[d] > 110 && w11 > bw2) { bw2 = w11; bn = d; }
          if (bn < 0) continue;
          sp2 = (Math.min(h - 1, Math.round(MYt0[bn])) * w + Math.min(w - 1, Math.round(MXt0[bn]))) * 4;
        }
        out[q] = data[sp2]; out[q + 1] = data[sp2 + 1]; out[q + 2] = data[sp2 + 2]; out[q + 3] = 255;
        continue;
      }
      var oa = At[a] > 110, same = (At[b2] > 110) === oa && (At[c] > 110) === oa && (At[d] > 110) === oa;
      if (same) { px = (Xt[a] * (1 - tx) + Xt[b2] * tx) * (1 - ty) + (Xt[c] * (1 - tx) + Xt[d] * tx) * ty; py = (Yt[a] * (1 - tx) + Yt[b2] * tx) * (1 - ty) + (Yt[c] * (1 - tx) + Yt[d] * tx) * ty; }
      else { var nn = tx < 0.5 ? (ty < 0.5 ? a : c) : (ty < 0.5 ? b2 : d); px = Xt[nn]; py = Yt[nn]; }
      var sp = (Math.min(h - 1, Math.round(py)) * w + Math.min(w - 1, Math.round(px))) * 4, q = (y * ow + x) * 4;
      out[q] = data[sp]; out[q + 1] = data[sp + 1]; out[q + 2] = data[sp + 2]; out[q + 3] = data[sp + 3];
    }
    return { w: ow, h: oh, data: out };
  }
  // ================= Alternative warps =================
  // Every shape (blob or silhouette) is reduced to a coarse grid. Three methods map a shape onto the unit disc
  // (harmonic, area, contour); a blob pixel goes blob -> disc -> silhouette. The elastic method simulates a
  // spring mesh of the silhouette inflating inside the blob.
  function makeGrid(bx: number, by: number, bw: number, bh: number, G: number, test: (x: number, y: number) => boolean, trim?: boolean): Grid {
    var cs = Math.max(bw, bh) / G; if (cs < 1) cs = 1;
    var gw = Math.ceil(bw / cs) + 2, gh = Math.ceil(bh / cs) + 2, ins = new Uint8Array(gw * gh), i, j;
    for (j = 1; j < gh - 1; j++) for (i = 1; i < gw - 1; i++) {
      if (test(Math.min(bx + bw - 1, Math.floor(bx + (i - 0.5) * cs)), Math.min(by + bh - 1, Math.floor(by + (j - 0.5) * cs)))) ins[j * gw + i] = 1;
    }
    if (trim) { // 細すぎる所を落とす。2×2 の升がそろわない所は絵として描けず、まわりの引き伸ばしで埋まってしまう
      var keep = new Uint8Array(gw * gh);
      for (j = 1; j < gh - 2; j++) for (i = 1; i < gw - 2; i++) { var q0 = j * gw + i; if (ins[q0] && ins[q0 + 1] && ins[q0 + gw] && ins[q0 + gw + 1]) keep[q0] = keep[q0 + 1] = keep[q0 + gw] = keep[q0 + gw + 1] = 1; }
      var left = 0; for (i = 0; i < gw * gh; i++) left += keep[i];
      if (left >= 16) ins = keep; // ほとんど残らない素材は、そのまま使う
    }
    // keep the largest 4-connected piece
    var lab = new Int32Array(gw * gh), stack = new Int32Array(gw * gh), best = 0, bestN = 0, cur = 0;
    for (i = 0; i < gw * gh; i++) {
      if (!ins[i] || lab[i]) continue;
      cur++; var sp = 0, cnt = 0; stack[sp++] = i; lab[i] = cur;
      while (sp) { var q = stack[--sp]; cnt++;
        if (ins[q - 1] && !lab[q - 1]) { lab[q - 1] = cur; stack[sp++] = q - 1; }
        if (ins[q + 1] && !lab[q + 1]) { lab[q + 1] = cur; stack[sp++] = q + 1; }
        if (ins[q - gw] && !lab[q - gw]) { lab[q - gw] = cur; stack[sp++] = q - gw; }
        if (ins[q + gw] && !lab[q + gw]) { lab[q + gw] = cur; stack[sp++] = q + gw; } }
      if (cnt > bestN) { bestN = cnt; best = cur; }
    }
    var sx = 0, sy = 0;
    for (j = 0; j < gh; j++) for (i = 0; i < gw; i++) { var k = j * gw + i; ins[k] = lab[k] === best && best ? 1 : 0; if (ins[k]) { sx += i; sy += j; } }
    var g: Grid = { bx: bx, by: by, cs: cs, gw: gw, gh: gh, ins: ins, n: bestN, ci: bestN ? sx / bestN : gw / 2, cj: bestN ? sy / bestN : gh / 2, center: -1 };
    var bd = 1e9;
    for (j = 0; j < gh; j++) for (i = 0; i < gw; i++) if (ins[j * gw + i]) { var d = (i - g.ci) * (i - g.ci) + (j - g.cj) * (j - g.cj); if (d < bd) { bd = d; g.center = j * gw + i; } }
    return g;
  }
  // Moore-neighbour trace of the outer boundary, clockwise on screen. Returns cell indices and arc-length fractions.
  function trace(g: Grid): Trace {
    if (g.tr) return g.tr;
    var gw = g.gw, ins = g.ins, start = -1, i;
    for (i = 0; i < ins.length; i++) if (ins[i]) { start = i; break; }
    var idx = [start], len = [0], cur = start, b = 0, first = -1, total = 0, guard = ins.length * 8;
    while (guard-- > 0) {
      var found = -1;
      for (var k = 0; k < 8; k++) { var d = (b + k) % 8, nx = cur + DX[d] + DY[d] * gw; if (ins[nx]) { found = d; break; } }
      if (found < 0) break;
      if (cur === start) { if (first < 0) first = found; else if (found === first) break; }
      cur = cur + DX[found] + DY[found] * gw; total += found % 2 ? 1.41421 : 1;
      idx.push(cur); len.push(total); b = found % 2 ? (found + 5) % 8 : (found + 6) % 8;
    }
    if (idx.length > 1) { idx.pop(); len.pop(); }
    if (total <= 0) total = 1;
    var t = new Float32Array(idx.length); for (i = 0; i < idx.length; i++) t[i] = len[i] / total;
    var si = start % gw, sj = (start / gw) | 0;
    g.tr = { idx: Int32Array.from(idx), t: t, theta0: Math.atan2(sj - g.cj, si - g.ci) };
    return g.tr;
  }
  function fillAll(g: Grid, u: F32, v: F32) { // spread values from inside cells to every cell so bilinear lookups work at the rim
    var gw = g.gw, n = gw * g.gh, done = new Uint8Array(n), q = new Int32Array(n), h = 0, t = 0, i;
    for (i = 0; i < n; i++) if (g.ins[i]) { done[i] = 1; q[t++] = i; }
    while (h < t) { var c = q[h++], x = c % gw;
      var nb = [x > 0 ? c - 1 : -1, x < gw - 1 ? c + 1 : -1, c - gw, c + gw];
      for (var k = 0; k < 4; k++) { var m = nb[k]; if (m >= 0 && m < n && !done[m]) { done[m] = 1; u[m] = u[c]; v[m] = v[c]; q[t++] = m; } } }
  }
  function mobius(g: Grid, u: F32, v: F32) { // slide the disc so the shape's centroid sits at the disc's centre
    if (g.center < 0) return;
    var ar = u[g.center], ai = v[g.center], m = Math.sqrt(ar * ar + ai * ai); if (m > 0.95) { ar *= 0.95 / m; ai *= 0.95 / m; }
    for (var i = 0; i < u.length; i++) { if (!g.ins[i]) continue;
      var nr = u[i] - ar, ni = v[i] - ai, dr = 1 - (ar * u[i] + ai * v[i]), di = -(ar * v[i] - ai * u[i]), dd = dr * dr + di * di || 1e-9;
      u[i] = (nr * dr + ni * di) / dd; v[i] = (ni * dr - nr * di) / dd; }
  }
  function baseMap(g: Grid, method: string): UV {
    var gw = g.gw, gh = g.gh, n = gw * gh, ins = g.ins, u = new Float32Array(n), v = new Float32Array(n), i, j, k;
    if (g.n < 1) return { u: u, v: v };
    if (method === 'harmonic') {
      var tr = trace(g), fixed = new Uint8Array(n), cnt = new Uint8Array(n);
      for (k = 0; k < tr.idx.length; k++) { var a = tr.theta0 + tr.t[k] * 6.2831853, c = tr.idx[k]; u[c] += Math.cos(a); v[c] += Math.sin(a); if (cnt[c] < 255) cnt[c]++; fixed[c] = 1; }
      for (i = 0; i < n; i++) if (fixed[i]) { var m = Math.sqrt(u[i] * u[i] + v[i] * v[i]) || 1; u[i] /= m; v[i] /= m; }
      var gm = Math.max(gw, gh), w = 2 / (1 + Math.sin(3.14159 / gm)), iters = Math.min(600, 5 * gm);
      for (var it = 0; it < iters; it++) for (i = gw; i < n - gw; i++) {
        if (!ins[i] || fixed[i]) continue;
        var su = 0, sv = 0, c4 = 0;
        if (ins[i - 1]) { su += u[i - 1]; sv += v[i - 1]; c4++; } if (ins[i + 1]) { su += u[i + 1]; sv += v[i + 1]; c4++; }
        if (ins[i - gw]) { su += u[i - gw]; sv += v[i - gw]; c4++; } if (ins[i + gw]) { su += u[i + gw]; sv += v[i + gw]; c4++; }
        if (c4) { u[i] += w * (su / c4 - u[i]); v[i] += w * (sv / c4 - v[i]); }
      }
      mobius(g, u, v);
    } else if (method === 'contour') {
      var tc = trace(g), nb = tc.idx.length, step = Math.max(1, Math.floor(nb / 400)), dist = new Float32Array(n), ss = new Float32Array(n), dmax = 0;
      for (j = 0; j < gh; j++) for (i = 0; i < gw; i++) { var ci = j * gw + i; if (!ins[ci]) continue;
        var bd = 1e9, bk = 0;
        for (k = 0; k < nb; k += step) { var q = tc.idx[k], qx = q % gw - i, qy = ((q / gw) | 0) - j, d2 = qx * qx + qy * qy; if (d2 < bd) { bd = d2; bk = k; } }
        dist[ci] = Math.sqrt(bd) + 0.5; ss[ci] = tc.t[bk]; if (dist[ci] > dmax) dmax = dist[ci]; }
      for (i = 0; i < n; i++) if (ins[i]) { var r = 1 - dist[i] / (dmax + 0.5), an = tc.theta0 + ss[i] * 6.2831853; u[i] = r * Math.cos(an); v[i] = r * Math.sin(an); }
    } else { // 'area': polar equal-area. Angle is re-spaced by wedge weight, radius by the share of the wedge's weight inside it.
      // Weight is 1 per cell, or the cell's detail energy when content-aware weighting is on.
      var NB = 48, ccx = g.center % gw, ccy = (g.center / gw) | 0, bins: number[][][] = [], pre: F32[] = [], binW = new Float32Array(NB), cum = new Float32Array(NB + 1), wt = g.wt;
      for (k = 0; k < NB; k++) bins.push([]);
      for (j = 0; j < gh; j++) for (i = 0; i < gw; i++) if (ins[j * gw + i]) {
        var th = Math.atan2(j - ccy, i - ccx); if (th < 0) th += 6.2831853;
        bins[Math.min(NB - 1, (th / 6.2831853 * NB) | 0)].push([Math.sqrt((i - ccx) * (i - ccx) + (j - ccy) * (j - ccy)), wt ? wt[j * gw + i] : 1]);
      }
      for (k = 0; k < NB; k++) { var arr0 = bins[k]; arr0.sort(function (p: number[], q2: number[]) { return p[0] - q2[0]; });
        var pf = new Float32Array(arr0.length + 1); for (var m0 = 0; m0 < arr0.length; m0++) pf[m0 + 1] = pf[m0] + arr0[m0][1];
        pre.push(pf); binW[k] = pf[arr0.length]; cum[k + 1] = cum[k] + binW[k]; }
      var tot = cum[NB] || 1;
      var rank = function (bn: number, r: number) { bn = (bn + NB) % NB; var arr = bins[bn], L = arr.length; if (!L) return -1; var lo = 0, hi = L; while (lo < hi) { var md = (lo + hi) >> 1; if (arr[md][0] < r) lo = md + 1; else hi = md; }
        return (pre[bn][lo] + 0.5 * (lo < L ? arr[lo][1] : 0)) / (binW[bn] + 1e-6); };
      for (j = 0; j < gh; j++) for (i = 0; i < gw; i++) { var ca = j * gw + i; if (!ins[ca]) continue;
        var t2 = Math.atan2(j - ccy, i - ccx); if (t2 < 0) t2 += 6.2831853;
        var fb = t2 / 6.2831853 * NB, b0 = Math.min(NB - 1, fb | 0), fr = fb - b0, rr = Math.sqrt((i - ccx) * (i - ccx) + (j - ccy) * (j - ccy));
        var phi = (cum[b0] + fr * binW[b0]) / tot * 6.2831853;
        var c0 = fr < 0.5 ? b0 - 1 : b0, wtb = fr < 0.5 ? fr + 0.5 : fr - 0.5, ra = rank(c0, rr), rb = rank(c0 + 1, rr);
        var rho2 = ra < 0 ? rb : rb < 0 ? ra : ra + (rb - ra) * wtb; if (rho2 < 0) rho2 = 0; if (rho2 > 1) rho2 = 1;
        var rho = Math.sqrt(rho2); u[ca] = rho * Math.cos(phi); v[ca] = rho * Math.sin(phi); }
    }
    fillAll(g, u, v);
    return { u: u, v: v };
  }
  function quadsOf(g: Grid) { // top-left cell of every 2x2 block that is fully inside
    if (g.qd) return g.qd;
    var q = [], gw = g.gw, ins = g.ins;
    for (var i = 0; i < ins.length - gw - 1; i++) if (ins[i] && ins[i + 1] && ins[i + gw] && ins[i + gw + 1]) q.push(i);
    return (g.qd = Int32Array.from(q));
  }
  // Hybrids between the harmonic map (smooth) and the area map (even filling). mix: 0 = harmonic end, 1 = area end.
  function discMap(g: Grid, method: string, mix: number): UV {
    if (method === 'harmonic' || method === 'contour' || method === 'area') return baseMap(g, method);
    var gw = g.gw, n = gw * g.gh, ins = g.ins, i, k, it;
    if (g.n < 1) return baseMap(g, 'area');
    var H = g.bh || (g.bh = baseMap(g, 'harmonic')), A = g.ba && g.baImp === (g.imp || 0) ? g.ba : (g.baImp = g.imp || 0, g.ba = baseMap(g, 'area'));
    var u = new Float32Array(n), v = new Float32Array(n), tr = trace(g), edge = new Uint8Array(n), gm = Math.max(gw, g.gh);
    for (k = 0; k < tr.idx.length; k++) edge[tr.idx[k]] = 1;
    var relax = function (lam: number, keepEdge: boolean) { // one smoothing sweep toward the average of inside neighbours
      for (var c = gw; c < n - gw; c++) { if (!ins[c] || (keepEdge && edge[c])) continue;
        var su = 0, sv = 0, c4 = 0;
        if (ins[c - 1]) { su += u[c - 1]; sv += v[c - 1]; c4++; } if (ins[c + 1]) { su += u[c + 1]; sv += v[c + 1]; c4++; }
        if (ins[c - gw]) { su += u[c - gw]; sv += v[c - gw]; c4++; } if (ins[c + gw]) { su += u[c + gw]; sv += v[c + gw]; c4++; }
        if (c4) { u[c] += lam * (su / c4 - u[c]); v[c] += lam * (sv / c4 - v[c]); } }
    };
    var toRim = function () { for (var e = 0; e < tr.idx.length; e++) { var c = tr.idx[e], m = Math.sqrt(u[c] * u[c] + v[c] * v[c]) || 1; u[c] /= m; v[c] /= m; } };
    if (method === 'areaharm') {
      // outline keeps the area map's allocation; the inside is relaxed toward a harmonic fill
      u.set(A.u); v.set(A.v);
      var its = Math.round((1 - mix) * (1 - mix) * 6 * gm);
      for (it = 0; it < its; it++) relax(1.5, true);
    } else if (method === 'blend') {
      // rotate the harmonic map into the area map's orientation, then interpolate coordinates
      var sn = 0, cs2 = 0;
      for (i = 0; i < n; i++) if (ins[i]) { sn += H.u[i] * A.v[i] - H.v[i] * A.u[i]; cs2 += H.u[i] * A.u[i] + H.v[i] * A.v[i]; }
      var ro = Math.atan2(sn, cs2), cr = Math.cos(ro), sr = Math.sin(ro);
      for (i = 0; i < n; i++) if (ins[i]) { var hu = H.u[i] * cr - H.v[i] * sr, hv = H.u[i] * sr + H.v[i] * cr; u[i] = hu + (A.u[i] - hu) * mix; v[i] = hv + (A.v[i] - hv) * mix; }
    } else {
      u.set(H.u); v.set(H.v);
      var qd = quadsOf(g), nq = qd.length, du = new Float32Array(n), dv = new Float32Array(n), ar = new Float32Array(nq);
      var areas = function () { var sum = 0; for (var q = 0; q < nq; q++) { var a = qd[q], b = a + 1, c = a + gw, d = c + 1;
        ar[q] = 0.5 * ((u[a] * v[b] - u[b] * v[a]) + (u[b] * v[d] - u[d] * v[b]) + (u[d] * v[c] - u[c] * v[d]) + (u[c] * v[a] - u[a] * v[c])); sum += ar[q]; } return sum; };
      if (nq > 0 && method === 'diffuse') {
        // pressure relaxation: cells squeezed below the average area push their corners out, bloated ones pull in
        var itd = Math.round(mix * 140);
        for (it = 0; it < itd; it++) {
          var sum = areas(), sg = sum < 0 ? -1 : 1, At = Math.abs(sum) / nq || 1e-9; du.fill(0); dv.fill(0);
          for (k = 0; k < nq; k++) { var a = qd[k], b = a + 1, c = a + gw, d = c + 1, pr = (At - sg * ar[k]) / At; if (pr > 1) pr = 1; else if (pr < -1.5) pr = -1.5; pr *= 0.08;
            var mx = (u[a] + u[b] + u[c] + u[d]) / 4, my = (v[a] + v[b] + v[c] + v[d]) / 4;
            du[a] += (u[a] - mx) * pr; dv[a] += (v[a] - my) * pr; du[b] += (u[b] - mx) * pr; dv[b] += (v[b] - my) * pr;
            du[c] += (u[c] - mx) * pr; dv[c] += (v[c] - my) * pr; du[d] += (u[d] - mx) * pr; dv[d] += (v[d] - my) * pr; }
          for (i = 0; i < n; i++) if (ins[i]) { u[i] += du[i]; v[i] += dv[i]; }
          relax(0.15, false); toRim();
        }
      } else if (nq > 0) { // 'energy': gradient descent on (1-w) * angle distortion + w * area distortion
        var w = mix;
        for (it = 0; it < 160; it++) {
          var sm = areas(), s2 = sm < 0 ? -1 : 1, At2 = Math.abs(sm) / nq || 1e-9, lim = 0.5 * Math.sqrt(At2); du.fill(0); dv.fill(0);
          for (k = 0; k < nq; k++) { var a2 = qd[k], b2 = a2 + 1, c2 = a2 + gw, d2 = c2 + 1;
            var e1x = (u[b2] - u[a2] + u[d2] - u[c2]) / 2, e1y = (v[b2] - v[a2] + v[d2] - v[c2]) / 2, e2x = (u[c2] - u[a2] + u[d2] - u[b2]) / 2, e2y = (v[c2] - v[a2] + v[d2] - v[b2]) / 2;
            var rx = e2x + s2 * e1y, ry = e2y - s2 * e1x, D = s2 * (e1x * e2y - e1y * e2x), ka = w * 2 * (D - At2) / At2 * s2, kc = (1 - w) * 2;
            var g1x = kc * ry * -s2 + ka * e2y, g1y = kc * rx * s2 - ka * e2x, g2x = kc * rx - ka * e1y, g2y = kc * ry + ka * e1x;
            du[a2] += (-g1x - g2x) / 2; dv[a2] += (-g1y - g2y) / 2; du[b2] += (g1x - g2x) / 2; dv[b2] += (g1y - g2y) / 2;
            du[c2] += (-g1x + g2x) / 2; dv[c2] += (-g1y + g2y) / 2; du[d2] += (g1x + g2x) / 2; dv[d2] += (g1y + g2y) / 2; }
          for (i = 0; i < n; i++) if (ins[i]) { var sx = -0.12 * du[i], sy = -0.12 * dv[i], sl = Math.sqrt(sx * sx + sy * sy); if (sl > lim) { sx *= lim / sl; sy *= lim / sl; } u[i] += sx; v[i] += sy; }
          relax(0.03, false); toRim();
        }
      }
    }
    for (i = 0; i < n; i++) if (ins[i] && !(u[i] === u[i] && v[i] === v[i])) { u[i] = H.u[i]; v[i] = H.v[i]; }
    fillAll(g, u, v);
    return { u: u, v: v };
  }
  function blobGrid(camo: Camo, c: number, G: number): Grid {
    var key = 'g' + G, list = camo.grids[key] || (camo.grids[key] = []);
    if (list[c]) return list[c];
    var cm = camo.comps, ids = camo.ids, W = camo.W;
    return (list[c] = makeGrid(cm.x0[c], cm.y0[c], cm.x1[c] - cm.x0[c] + 1, cm.y1[c] - cm.y0[c] + 1, G, function (x: number, y: number) { return ids[y * W + x] === c; }));
  }
  function blobMap(camo: Camo, c: number, method: string, mix: number): BlobMap { // one cached set per method; a new mix value replaces it
    var e = camo.maps[method]; if (!e || e.mix !== mix) e = camo.maps[method] = { mix: mix, list: [] };
    var L = e.list;
    if (!L[c]) { var g = blobGrid(camo, c, 44), m = discMap(g, method, mix); L[c] = { u: m.u, v: m.v, g: g }; }
    return L[c];
  }
  function sourceGrid(ph: Source, G: number, trim?: boolean): Grid {
    var key = 'g' + G + (trim ? 't' : ''), gs = ph.grids || (ph.grids = {}); if (gs[key]) return gs[key];
    var d = ph.data, w = ph.w, h = ph.h, x0 = w, y0 = h, x1 = -1, y1 = -1, x, y;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 110) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) { x0 = y0 = 0; x1 = w - 1; y1 = h - 1; }
    return (gs[key] = makeGrid(x0, y0, x1 - x0 + 1, y1 - y0 + 1, G, function (px: number, py: number) { return d[(py * w + px) * 4 + 3] > 110; }, trim));
  }
  // Inverse of the silhouette's disc map: a table over the disc holding silhouette pixel positions.
  // Detail energy of the silhouette: where colour changes, there is something worth keeping (eyes, hands, stripes).
  function setWeights(ph: Source, g: Grid, imp: number) {
    g.imp = imp; if (!imp) { g.wt = null; return; }
    var w = ph.w, h = ph.h, d = ph.data, x, y, i;
    if (!ph.en) { var L = new Float32Array(w * h); ph.en = new Float32Array(w * h);
      for (i = 0; i < w * h; i++) L[i] = d[i * 4 + 3] > 110 ? 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2] : -1;
      for (y = 1; y < h - 1; y++) for (x = 1; x < w - 1; x++) { i = y * w + x; if (L[i] < 0) continue;
        var a = L[i - 1], b = L[i + 1], c = L[i - w], e = L[i + w]; ph.en[i] = (a < 0 || b < 0 ? 0 : Math.abs(b - a)) + (c < 0 || e < 0 ? 0 : Math.abs(e - c)); } }
    var gw = g.gw, n = gw * g.gh, raw = new Float32Array(n), sum = 0, st = Math.max(1, Math.floor(g.cs / 3));
    for (var j = 0; j < g.gh; j++) for (i = 0; i < gw; i++) { var k = j * gw + i; if (!g.ins[k]) continue;
      var px = Math.floor(g.bx + (i - 1) * g.cs), py = Math.floor(g.by + (j - 1) * g.cs), s = 0, c2 = 0;
      for (y = py; y < py + g.cs; y += st) for (x = px; x < px + g.cs; x += st) if (x >= 0 && y >= 0 && x < w && y < h) { s += ph.en[y * w + x]; c2++; }
      raw[k] = c2 ? s / c2 : 0; sum += raw[k]; }
    var mean = sum / Math.max(1, g.n) || 1; g.wt = new Float32Array(n);
    for (i = 0; i < n; i++) if (g.ins[i]) g.wt[i] = 1 + imp * 6 * Math.min(raw[i] / mean, 4);
  }
  function sourceInv(ph: Source, method: string, mix: number, imp: number, trim?: boolean): Inv {
    var key = method, tag = mix + '|' + imp + (trim ? '|t' : ''), invs = ph.inv || (ph.inv = {}); if (invs[key] && invs[key].mix === tag) return invs[key];
    var g = sourceGrid(ph, 72, trim); setWeights(ph, g, method === 'harmonic' || method === 'contour' ? 0 : imp);
    var map = discMap(g, method, mix), gw = g.gw, gh = g.gh, N = 192, tx = new Float32Array(N * N), ty = new Float32Array(N * N), ok = new Uint8Array(N * N);
    // 素材の隣どうしの升が、円の上で遠く離れることがある（手足や尻尾で凹んだ形）。そのあいだを1升ぶんの絵で埋めると、
    // 輪郭線の黒が帯になって伸びる。trim のときは、升1つが円の上で占める大きさの1.8倍を超える三角は描かず、穴にする。
    // 穴は下で、まわりからなめらかにつないで埋める
    var triMax = trim ? Math.max(4, 1.8 * Math.sqrt(3.14159 * (N / 2) * (N / 2) / Math.max(1, g.n))) : N * 0.4;
    var tri = function (ax: number, ay: number, bx: number, by: number, cx: number, cy: number, asx: number, asy: number, bsx: number, bsy: number, csx: number, csy: number) {
      var minx = Math.max(0, Math.floor(Math.min(ax, bx, cx))), maxx = Math.min(N - 1, Math.ceil(Math.max(ax, bx, cx)));
      var miny = Math.max(0, Math.floor(Math.min(ay, by, cy))), maxy = Math.min(N - 1, Math.ceil(Math.max(ay, by, cy)));
      if (maxx - minx > triMax || maxy - miny > triMax) return;
      var den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy); if (Math.abs(den) < 1e-9) return;
      for (var y = miny; y <= maxy; y++) for (var x = minx; x <= maxx; x++) {
        var w0 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / den, w1 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / den, w2 = 1 - w0 - w1;
        if (w0 < -0.02 || w1 < -0.02 || w2 < -0.02) continue;
        var k = y * N + x; tx[k] = w0 * asx + w1 * bsx + w2 * csx; ty[k] = w0 * asy + w1 * bsy + w2 * csy; ok[k] = 1;
      }
    };
    var S = (N - 1) / 2;
    for (var j = 0; j < gh - 1; j++) for (var i = 0; i < gw - 1; i++) {
      var a = j * gw + i, b = a + 1, c = a + gw, d = c + 1;
      if (!(g.ins[a] && g.ins[b] && g.ins[c] && g.ins[d])) continue;
      var px = g.bx + (i - 0.5) * g.cs, py = g.by + (j - 0.5) * g.cs, q = g.cs;
      tri((map.u[a] + 1) * S, (map.v[a] + 1) * S, (map.u[b] + 1) * S, (map.v[b] + 1) * S, (map.u[c] + 1) * S, (map.v[c] + 1) * S, px, py, px + q, py, px, py + q);
      tri((map.u[b] + 1) * S, (map.v[b] + 1) * S, (map.u[d] + 1) * S, (map.v[d] + 1) * S, (map.u[c] + 1) * S, (map.v[c] + 1) * S, px + q, py, px + q, py + q, px, py + q);
    }
    var qu = new Int32Array(N * N), hh = 0, tt = 0, k2, hole = trim ? new Uint8Array(N * N) : null;
    for (k2 = 0; k2 < N * N; k2++) if (ok[k2]) qu[tt++] = k2; else if (hole) hole[k2] = 1;
    while (hh < tt) { var cc = qu[hh++], cx2 = cc % N, nbs = [cx2 > 0 ? cc - 1 : -1, cx2 < N - 1 ? cc + 1 : -1, cc - N, cc + N];
      for (var e = 0; e < 4; e++) { var m = nbs[e]; if (m >= 0 && m < N * N && !ok[m]) { ok[m] = 1; tx[m] = tx[cc]; ty[m] = ty[cc]; qu[tt++] = m; } } }
    if (hole && tt > 0) {
      // 写せなかった所（穴）は、上で「いちばん近い値の写し」で埋めてある。写しは同じ値が並ぶので、絵が筋になって伸びる。
      // 穴の中を、まわりの値からなめらかにつなぎ直す。つないだ先が透明な所を指すなら、写しの値に戻す
      var bx0 = new Float32Array(tx), by0 = new Float32Array(ty), pd = ph.data, pw = ph.w, phh = ph.h;
      for (var itr = 0; itr < 160; itr++) for (k2 = N; k2 < N * N - N; k2++) {
        if (!hole[k2]) continue; var hx = k2 % N; if (hx === 0 || hx === N - 1) continue;
        tx[k2] += 1.6 * ((tx[k2 - 1] + tx[k2 + 1] + tx[k2 - N] + tx[k2 + N]) / 4 - tx[k2]);
        ty[k2] += 1.6 * ((ty[k2 - 1] + ty[k2 + 1] + ty[k2 - N] + ty[k2 + N]) / 4 - ty[k2]);
      }
      for (k2 = 0; k2 < N * N; k2++) if (hole[k2]) {
        var rx2 = Math.round(tx[k2]), ry2 = Math.round(ty[k2]);
        if (!(rx2 >= 0 && ry2 >= 0 && rx2 < pw && ry2 < phh && pd[(ry2 * pw + rx2) * 4 + 3] > 110)) { tx[k2] = bx0[k2]; ty[k2] = by0[k2]; }
      }
    }
    return (invs[key] = { N: N, tx: tx, ty: ty, empty: tt === 0, mix: tag });
  }
  /**
   * 素材1枚ぶんの、方式ごとの準備（円へ写す表、弾性体の網）を先に済ませる。結果は素材の中に入る。
   * 描くときにも同じものを作るが、先に別の場所で作っておけば、描くときは使うだけで済む。
   */
  function prepareSource(ph: Source, method: string, mix: number, imp: number, trim: boolean): void {
    if (!ph.shape) return;
    if (method === 'elastic') sourceMesh(ph);
    else if (method !== 'radial' && method !== 'carve') sourceInv(ph, method, mix, imp, trim);
  }
  function paint(out: Pixels, o: number, pd: Pixels, si: number, col: RGB, tint: number) {
    var m = 0.45 + (0.299 * pd[si] + 0.587 * pd[si + 1] + 0.114 * pd[si + 2]) / 255 * 1.1;
    out[o] = pd[si] + (col[0] * m - pd[si]) * tint; out[o + 1] = pd[si + 1] + (col[1] * m - pd[si + 1]) * tint;
    out[o + 2] = pd[si + 2] + (col[2] * m - pd[si + 2]) * tint; out[o + 3] = 255;
  }
  // 4画素を混ぜて読む。引きのばしたときに画素の角が見えない。透明な画素は混ぜず、中身のある画素だけで割る。
  // 重みの4分の1以上が中身なら塗る。塗れたら true
  function paintSmooth(out: Pixels, o: number, pd: Pixels, pw: number, ph: number, sx: number, sy: number, col: RGB, tint: number): boolean {
    var x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0, r = 0, g = 0, b = 0, wt = 0;
    for (var k = 0; k < 4; k++) {
      var x = x0 + (k & 1), y = y0 + (k >> 1); if (x < 0 || y < 0 || x >= pw || y >= ph) continue;
      var si = (y * pw + x) * 4; if (pd[si + 3] <= 110) continue;
      var w = ((k & 1) ? fx : 1 - fx) * ((k >> 1) ? fy : 1 - fy);
      r += pd[si] * w; g += pd[si + 1] * w; b += pd[si + 2] * w; wt += w;
    }
    if (wt < 0.25) return false;
    r /= wt; g /= wt; b /= wt;
    var m = 0.45 + (0.299 * r + 0.587 * g + 0.114 * b) / 255 * 1.1;
    out[o] = r + (col[0] * m - r) * tint; out[o + 1] = g + (col[1] * m - g) * tint; out[o + 2] = b + (col[2] * m - b) * tint; out[o + 3] = 255;
    return true;
  }
  function flat(out: Pixels, camo: Camo, c: number, col: RGB) {
    var cm = camo.comps, W = camo.W, ids = camo.ids;
    for (var y = cm.y0[c]; y <= cm.y1[c]; y++) for (var x = cm.x0[c], i = y * W + x; x <= cm.x1[c]; x++, i++) if (ids[i] === c) { out[i * 4] = col[0]; out[i * 4 + 1] = col[1]; out[i * 4 + 2] = col[2]; out[i * 4 + 3] = 255; }
  }
  function renderDisc(out: Pixels, camo: Camo, c: number, ph: Source, col: RGB, o: FitOptions) {
    var M = blobMap(camo, c, o.method, o.mix), g = M.g, inv = sourceInv(ph, o.method, o.mix, o.imp, o.trim), cm = camo.comps, W = camo.W, ids = camo.ids;
    flat(out, camo, c, col); if (g.n < 1 || inv.empty) return;
    var gw = g.gw, gh = g.gh, N = inv.N, S = (N - 1) / 2, pw = ph.w, phh = ph.h, pd = ph.data, ca = Math.cos(o.ang), sa = Math.sin(o.ang);
    for (var y = cm.y0[c]; y <= cm.y1[c]; y++) for (var x = cm.x0[c], i = y * W + x; x <= cm.x1[c]; x++, i++) {
      if (ids[i] !== c) continue;
      var gi = (x - g.bx) / g.cs + 0.5, gj = (y - g.by) / g.cs + 0.5, i0 = gi | 0, j0 = gj | 0;
      if (i0 > gw - 2) i0 = gw - 2; if (j0 > gh - 2) j0 = gh - 2;
      var fx = gi - i0, fy = gj - j0, k = j0 * gw + i0;
      var qx = (M.u[k] * (1 - fx) + M.u[k + 1] * fx) * (1 - fy) + (M.u[k + gw] * (1 - fx) + M.u[k + gw + 1] * fx) * fy;
      var qy = (M.v[k] * (1 - fx) + M.v[k + 1] * fx) * (1 - fy) + (M.v[k + gw] * (1 - fx) + M.v[k + gw + 1] * fx) * fy;
      qx *= o.flip;
      var rad = Math.sqrt(qx * qx + qy * qy), sw = rad < 1 ? 1 - rad : 0, tw = o.dist * 2.4 * sw * sw * o.spin, ct = Math.cos(tw), st = Math.sin(tw);
      var rx = qx * (ca * ct - sa * st) - qy * (sa * ct + ca * st), ry = qx * (sa * ct + ca * st) + qy * (ca * ct - sa * st);
      if (rad > 1) { rx /= rad; ry /= rad; }
      var tx = (rx + 1) * S, ty = (ry + 1) * S, a0 = tx | 0, b0 = ty | 0; if (a0 > N - 2) a0 = N - 2; if (b0 > N - 2) b0 = N - 2;
      var ax = tx - a0, ay = ty - b0, t = b0 * N + a0;
      var sx = (inv.tx[t] * (1 - ax) + inv.tx[t + 1] * ax) * (1 - ay) + (inv.tx[t + N] * (1 - ax) + inv.tx[t + N + 1] * ax) * ay;
      var sy = (inv.ty[t] * (1 - ax) + inv.ty[t + 1] * ax) * (1 - ay) + (inv.ty[t + N] * (1 - ax) + inv.ty[t + N + 1] * ax) * ay;
      if (o.smooth) { paintSmooth(out, i * 4, pd, pw, phh, sx, sy, col, o.tint); continue; }
      var px = Math.round(sx), py = Math.round(sy); if (px < 0 || py < 0 || px >= pw || py >= phh) continue;
      var si = (py * pw + px) * 4; if (pd[si + 3] > 110) paint(out, i * 4, pd, si, col, o.tint);
    }
  }
  // ---- elastic: a spring mesh of the silhouette is inflated inside the blob and pushed back by the blob's walls ----
  function sourceMesh(ph: Source): Mesh {
    if (ph.mesh) return ph.mesh;
    var g = sourceGrid(ph, 30), gw = g.gw, gh = g.gh, vid = new Int32Array((gw + 1) * (gh + 1)).fill(-1), vx: number[] = [], vy: number[] = [], spr: number[] = [], quads: number[] = [], seen: Record<number, number> = {};
    var vert = function (i: number, j: number) { var k = j * (gw + 1) + i; if (vid[k] < 0) { vid[k] = vx.length; vx.push(i); vy.push(j); } return vid[k]; };
    var edge = function (a: number, b: number, r: number) { var k = a < b ? a * 100000 + b : b * 100000 + a; if (!seen[k]) { seen[k] = 1; spr.push(a, b, r); } };
    for (var j = 0; j < gh; j++) for (var i = 0; i < gw; i++) if (g.ins[j * gw + i]) {
      var a = vert(i, j), b = vert(i + 1, j), c = vert(i, j + 1), d = vert(i + 1, j + 1);
      edge(a, b, 1); edge(c, d, 1); edge(a, c, 1); edge(b, d, 1); edge(a, d, 1.41421); edge(b, c, 1.41421); quads.push(a, b, c, d);
    }
    var cx = g.ci + 0.5, cy = g.cj + 0.5, rmax = 1;
    for (var k = 0; k < vx.length; k++) rmax = Math.max(rmax, Math.sqrt((vx[k] - cx) * (vx[k] - cx) + (vy[k] - cy) * (vy[k] - cy)));
    return (ph.mesh = { g: g, vx: Float32Array.from(vx), vy: Float32Array.from(vy), spr: Float32Array.from(spr), quads: Int32Array.from(quads), cx: cx, cy: cy, rmax: rmax, area: Math.max(1, g.n) });
  }
  function chamfer(d: F32, gw: number, gh: number) {
    var i, x, y, v, n = gw * gh;
    for (y = 0, i = 0; y < gh; y++) for (x = 0; x < gw; x++, i++) { v = d[i];
      if (x > 0 && d[i - 1] + 1 < v) v = d[i - 1] + 1;
      if (y > 0) { if (d[i - gw] + 1 < v) v = d[i - gw] + 1; if (x > 0 && d[i - gw - 1] + 1.414 < v) v = d[i - gw - 1] + 1.414; if (x < gw - 1 && d[i - gw + 1] + 1.414 < v) v = d[i - gw + 1] + 1.414; }
      d[i] = v; }
    for (y = gh - 1, i = n - 1; y >= 0; y--) for (x = gw - 1; x >= 0; x--, i--) { v = d[i];
      if (x < gw - 1 && d[i + 1] + 1 < v) v = d[i + 1] + 1;
      if (y < gh - 1) { if (d[i + gw] + 1 < v) v = d[i + gw] + 1; if (x < gw - 1 && d[i + gw + 1] + 1.414 < v) v = d[i + gw + 1] + 1.414; if (x > 0 && d[i + gw - 1] + 1.414 < v) v = d[i + gw - 1] + 1.414; }
      d[i] = v; }
  }
  function blobField(camo: Camo, c: number): Grid {
    var g = blobGrid(camo, c, 44); if (g.sd) return g;
    var n = g.gw * g.gh, a = new Float32Array(n), b = new Float32Array(n), i, best = -1e9;
    for (i = 0; i < n; i++) { a[i] = g.ins[i] ? 1e6 : 0; b[i] = g.ins[i] ? 0 : 1e6; }
    chamfer(a, g.gw, g.gh); chamfer(b, g.gw, g.gh);
    g.sd = new Float32Array(n);
    for (i = 0; i < n; i++) { g.sd[i] = g.ins[i] ? a[i] - 0.5 : 0.5 - b[i]; if (g.sd[i] > best) { best = g.sd[i]; g.deep = i; } }
    g.sdmax = best;
    return g;
  }
  function renderElastic(out: Pixels, camo: Camo, c: number, ph: Source, col: RGB, o: FitOptions) {
    var g = blobField(camo, c), me = sourceMesh(ph), cm = camo.comps, W = camo.W, ids = camo.ids;
    flat(out, camo, c, col); if (g.n < 1 || me.vx.length < 4) return;
    var gw = g.gw, gh = g.gh, sd = g.sd!, nv = me.vx.length, X = new Float32Array(nv), Y = new Float32Array(nv), k, it;
    var deep = g.deep!, ox = deep % gw, oy = (deep / gw) | 0, ca = Math.cos(o.ang), sa = Math.sin(o.ang);
    var s0 = 0.8 * Math.max(0.5, g.sdmax!) / me.rmax, sT = Math.sqrt((0.5 + 2 * o.squeeze) * g.n / me.area); if (sT < s0) sT = s0;
    for (k = 0; k < nv; k++) { var mx = (me.vx[k] - me.cx) * o.flip, my = me.vy[k] - me.cy; X[k] = ox + (mx * ca - my * sa) * s0; Y[k] = oy + (mx * sa + my * ca) * s0; }
    var field = function (x: number, y: number) {
      if (x < 0) x = 0; else if (x > gw - 1.001) x = gw - 1.001; if (y < 0) y = 0; else if (y > gh - 1.001) y = gh - 1.001;
      var i0 = x | 0, j0 = y | 0, fx = x - i0, fy = y - j0, q = j0 * gw + i0;
      return (sd[q] * (1 - fx) + sd[q + 1] * fx) * (1 - fy) + (sd[q + gw] * (1 - fx) + sd[q + gw + 1] * fx) * fy;
    };
    var collide = function () {
      for (var v = 0; v < nv; v++) { var f = field(X[v], Y[v]); if (f >= 0.45) continue;
        var gx = field(X[v] + 0.5, Y[v]) - field(X[v] - 0.5, Y[v]), gy = field(X[v], Y[v] + 0.5) - field(X[v], Y[v] - 0.5), gl = Math.sqrt(gx * gx + gy * gy);
        if (gl > 1e-4) { X[v] += gx / gl * (0.45 - f); Y[v] += gy / gl * (0.45 - f); } else { X[v] += (ox - X[v]) * 0.2; Y[v] += (oy - Y[v]) * 0.2; } }
    };
    var NIT = 90, spr = me.spr, ns = spr.length;
    var sPrev = s0;
    for (it = 0; it < NIT; it++) {
      var s = s0 + (sT - s0) * Math.min(1, it / (NIT * 0.6)), grow = s / sPrev; sPrev = s;
      if (grow !== 1) for (k = 0; k < nv; k++) { X[k] = ox + (X[k] - ox) * grow; Y[k] = oy + (Y[k] - oy) * grow; }
      for (var pass = 0; pass < 2; pass++) for (k = 0; k < ns; k += 3) {
        var a = spr[k], b = spr[k + 1], dx = X[b] - X[a], dy = Y[b] - Y[a], len = Math.sqrt(dx * dx + dy * dy) || 1e-6, corr = (len - spr[k + 2] * s) / len * 0.3;
        X[a] += dx * corr; Y[a] += dy * corr; X[b] -= dx * corr; Y[b] -= dy * corr;
      }
      collide();
    }
    for (it = 0; it < 4; it++) collide();
    // rasterise the deformed mesh into the blob; later quads paint over earlier ones, which is what shows the folds
    var sg = me.g, pw = ph.w, phh = ph.h, pd = ph.data, x0 = cm.x0[c], x1 = cm.x1[c], y0 = cm.y0[c], y1 = cm.y1[c], qd = me.quads;
    var tri = function (ax: number, ay: number, bx: number, by: number, cx: number, cy: number, asx: number, asy: number, bsx: number, bsy: number, csx: number, csy: number) {
      var minx = Math.max(x0, Math.floor(Math.min(ax, bx, cx))), maxx = Math.min(x1, Math.ceil(Math.max(ax, bx, cx)));
      var miny = Math.max(y0, Math.floor(Math.min(ay, by, cy))), maxy = Math.min(y1, Math.ceil(Math.max(ay, by, cy)));
      var den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy); if (Math.abs(den) < 1e-9) return;
      for (var y = miny; y <= maxy; y++) for (var x = minx, i = y * W + minx; x <= maxx; x++, i++) {
        if (ids[i] !== c) continue;
        var w0 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / den, w1 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / den, w2 = 1 - w0 - w1;
        if (w0 < -0.01 || w1 < -0.01 || w2 < -0.01) continue;
        if (o.smooth) { paintSmooth(out, i * 4, pd, pw, phh, w0 * asx + w1 * bsx + w2 * csx, w0 * asy + w1 * bsy + w2 * csy, col, o.tint); continue; }
        var px = Math.round(w0 * asx + w1 * bsx + w2 * csx), py = Math.round(w0 * asy + w1 * bsy + w2 * csy);
        if (px < 0 || py < 0 || px >= pw || py >= phh) continue;
        var si = (py * pw + px) * 4; if (pd[si + 3] > 110) paint(out, i * 4, pd, si, col, o.tint);
      }
    };
    var toX = function (v: number) { return g.bx + (X[v] - 0.5) * g.cs; }, toY = function (v: number) { return g.by + (Y[v] - 0.5) * g.cs; };
    var sX = function (v: number) { return sg.bx + (me.vx[v] - 1) * sg.cs; }, sY = function (v: number) { return sg.by + (me.vy[v] - 1) * sg.cs; };
    for (k = 0; k < qd.length; k += 4) { var A = qd[k], B = qd[k + 1], C = qd[k + 2], D = qd[k + 3];
      tri(toX(A), toY(A), toX(B), toY(B), toX(C), toY(C), sX(A), sY(A), sX(B), sY(B), sX(C), sY(C));
      tri(toX(B), toY(B), toX(D), toY(D), toX(C), toY(C), sX(B), sY(B), sX(D), sY(D), sX(C), sY(C)); }
  }

  // ---- carve: ブロブの形そのものへシームカービングする ----
  // 絵をブロブと同じ行数にそろえ、行ごとに「ブロブのその行の幅」になるまで画素を抜く。抜く本数が行ごとに違う。
  // 筋は上から下までつながった道で、もう抜き終えた行は素通りする。透明な画素は最初に抜く。
  // 残った中身のある画素を、ブロブの行の内側に左から順に並べる。だからブロブの中に背景は出ない。
  function renderCarve(out: Pixels, camo: Camo, c: number, ph: Source, col: RGB, o: FitOptions) {
    var cm = camo.comps, W = camo.W, ids = camo.ids, bx = cm.x0[c], by = cm.y0[c], bw = cm.x1[c] - bx + 1, bh = cm.y1[c] - by + 1;
    flat(out, camo, c, col);
    var cs = Math.max(1, Math.max(bw, bh) / 80), gw = Math.ceil(bw / cs), gh = Math.ceil(bh / cs), i, j, x, y, k, maxm = 0;
    var ins = new Uint8Array(gw * gh), need = new Int32Array(gh);
    for (j = 0; j < gh; j++) for (i = 0; i < gw; i++) {
      x = Math.min(bx + bw - 1, Math.floor(bx + (i + 0.5) * cs)); y = Math.min(by + bh - 1, Math.floor(by + (j + 0.5) * cs));
      if (ids[y * W + x] === c) { ins[j * gw + i] = 1; need[j]++; }
    }
    for (j = 0; j < gh; j++) if (need[j] > maxm) maxm = need[j];
    if (!maxm) return;
    var d = ph.data, pw = ph.w, phh = ph.h, x0 = pw, y0 = phh, x1 = -1, y1 = -1;
    for (y = 0; y < phh; y++) for (x = 0; x < pw; x++) if (d[(y * pw + x) * 4 + 3] > 110) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) return;
    // 絵のシルエットを、行数 gh、幅 sw の升目に読む。幅はブロブのいちばん広い行より狭くしない
    var fw = x1 - x0 + 1, fh = y1 - y0 + 1, sw = Math.min(maxm * 3, Math.max(maxm, Math.round(fw * gh / fh))), n = sw * gh;
    var E = new Float32Array(n), live = new Uint8Array(n), op = new Uint8Array(n), SX = new Float32Array(n), SY = new Float32Array(n), Lm = new Float32Array(n), P = new Float32Array(n);
    for (j = 0; j < gh; j++) for (i = 0; i < sw; i++) {
      k = j * sw + i; var px = x0 + (o.flip < 0 ? sw - 1 - i + 0.5 : i + 0.5) * fw / sw, py = y0 + (j + 0.5) * fh / gh;
      var qx = Math.min(pw - 1, px | 0), qy = Math.min(phh - 1, py | 0), si = (qy * pw + qx) * 4, r = d[si], g = d[si + 1], b = d[si + 2];
      SX[k] = px - 0.5; SY[k] = py - 0.5; live[k] = 1;
      if (d[si + 3] > 110) { op[k] = 1; Lm[k] = 0.299 * r + 0.587 * g + 0.114 * b;
        if (r > g && g > b) { var mx = r / 255, sat = (mx - b / 255) / mx, hue = 60 * (g - b) / (r - b || 1); if (hue >= 10 && hue <= 56 && sat >= 0.2 && mx >= 0.35) P[k] = 40; } } // 肌色は抜かれにくく
    }
    for (j = 0; j < gh; j++) for (i = 0; i < sw; i++) {
      k = j * sw + i; if (!op[k]) { E[k] = -1000; continue; }
      var xl = i > 0 ? k - 1 : k, xr = i < sw - 1 ? k + 1 : k, yu = j > 0 ? k - sw : k, yd = j < gh - 1 ? k + sw : k;
      E[k] = Math.abs(Lm[xr] - Lm[xl]) + Math.abs(Lm[yd] - Lm[yu]) + (Math.abs(op[xr] - op[xl]) + Math.abs(op[yd] - op[yu])) * 127 + 1.5 + P[k];
    }
    var quota = new Int32Array(gh), left = 0, M = new Float32Array(n), path = new Int32Array(gh);
    for (j = 0; j < gh; j++) { quota[j] = sw - Math.max(1, need[j]); left += quota[j]; }
    for (var it = 0; left > 0 && it < sw * 2; it++) {
      for (j = 0; j < gh; j++) for (i = 0, k = j * sw; i < sw; i++, k++) {
        var cost = quota[j] > 0 ? (live[k] ? E[k] : 1e4) : 0; // 抜き終えた行は素通り。もう抜いた升を通ると何も抜けないので高くつく
        if (j > 0) { var mn = M[k - sw]; if (i > 0 && M[k - sw - 1] < mn) mn = M[k - sw - 1]; if (i < sw - 1 && M[k - sw + 1] < mn) mn = M[k - sw + 1]; cost += mn; }
        M[k] = cost;
      }
      var bi = 0, bm = Infinity; for (i = 0, k = (gh - 1) * sw; i < sw; i++, k++) if (M[k] < bm) { bm = M[k]; bi = i; }
      for (j = gh - 1; j >= 0; j--) { path[j] = bi;
        if (j > 0) { var up = (j - 1) * sw + bi, nb = bi, mm = M[up]; if (bi > 0 && M[up - 1] < mm) { mm = M[up - 1]; nb = bi - 1; } if (bi < sw - 1 && M[up + 1] < mm) nb = bi + 1; bi = nb; } }
      var took = 0;
      for (j = 0; j < gh; j++) { k = j * sw + path[j]; if (quota[j] > 0 && live[k]) { live[k] = 0; quota[j]--; left--; took++; } }
      if (!took) break;
    }
    // 筋で抜ききれなかった行は、その行でいちばん安い升から抜く
    for (j = 0; j < gh; j++) while (quota[j] > 0) { var be = Infinity, bk = -1; for (i = 0, k = j * sw; i < sw; i++, k++) if (live[k] && E[k] < be) { be = E[k]; bk = k; } if (bk < 0) break; live[bk] = 0; quota[j]--; }
    // ブロブの行の内側の升に、残った中身のある升を左から順に割り当てる。足りない行は引きのばす
    var GX = new Float32Array(gw * gh), GY = new Float32Array(gw * gh), has = new Uint8Array(gw * gh), keep = new Int32Array(sw), prev = -1;
    for (j = 0; j < gh; j++) {
      var nk = 0; for (i = 0, k = j * sw; i < sw; i++, k++) if (live[k] && op[k]) keep[nk++] = k;
      if (!nk) for (i = 0, k = j * sw; i < sw; i++, k++) if (op[k]) keep[nk++] = k;
      var row = nk ? j : prev; if (nk) prev = j;
      if (row < 0 || !need[j]) continue;
      if (!nk) { for (i = 0, k = row * sw; i < sw; i++, k++) if (op[k]) keep[nk++] = k; }
      var t = 0; for (i = 0; i < gw; i++) if (ins[j * gw + i]) { var kk = keep[Math.min(nk - 1, ((t + 0.5) * nk / need[j]) | 0)]; GX[j * gw + i] = SX[kk]; GY[j * gw + i] = SY[kk]; has[j * gw + i] = 1; t++; }
    }
    // 外側の升にも隣の値を広げておく。縁の画素を補間で読めるように
    var qu = new Int32Array(gw * gh), hd = 0, tl = 0;
    for (k = 0; k < gw * gh; k++) if (has[k]) qu[tl++] = k;
    if (!tl) return;
    while (hd < tl) { var cc = qu[hd++], cxx = cc % gw, nbs = [cxx > 0 ? cc - 1 : -1, cxx < gw - 1 ? cc + 1 : -1, cc - gw, cc + gw];
      for (var e = 0; e < 4; e++) { var m2 = nbs[e]; if (m2 >= 0 && m2 < gw * gh && !has[m2]) { has[m2] = 1; GX[m2] = GX[cc]; GY[m2] = GY[cc]; qu[tl++] = m2; } } }
    for (y = by; y < by + bh; y++) for (x = bx, i = y * W + bx; x < bx + bw; x++, i++) {
      if (ids[i] !== c) continue;
      var gi = (x - bx) / cs - 0.5, gj = (y - by) / cs - 0.5; if (gi < 0) gi = 0; if (gj < 0) gj = 0;
      var i0 = gi | 0, j0 = gj | 0; if (i0 > gw - 2) i0 = Math.max(0, gw - 2); if (j0 > gh - 2) j0 = Math.max(0, gh - 2);
      var fx = Math.min(1, gi - i0), fy = Math.min(1, gj - j0), a0 = j0 * gw + i0, a1 = gw > 1 ? a0 + 1 : a0, a2 = gh > 1 ? a0 + gw : a0, a3 = gh > 1 ? a1 + gw : a1;
      var sx = (GX[a0] * (1 - fx) + GX[a1] * fx) * (1 - fy) + (GX[a2] * (1 - fx) + GX[a3] * fx) * fy;
      var sy = (GY[a0] * (1 - fx) + GY[a1] * fx) * (1 - fy) + (GY[a2] * (1 - fx) + GY[a3] * fx) * fy;
      if (o.smooth && paintSmooth(out, i * 4, d, pw, phh, sx, sy, col, o.tint)) continue;
      var rx = Math.round(sx), ry = Math.round(sy), s2 = (ry * pw + rx) * 4;
      if (rx < 0 || ry < 0 || rx >= pw || ry >= phh || d[s2 + 3] <= 110) { // 補間した先が透明なら、いちばん近い升の位置を使う。そこは必ず中身がある
        var near = (fy < 0.5 ? (fx < 0.5 ? a0 : a1) : (fx < 0.5 ? a2 : a3)); rx = Math.round(GX[near]); ry = Math.round(GY[near]); s2 = (ry * pw + rx) * 4; }
      paint(out, i * 4, d, s2, col, o.tint);
    }
  }
  return { buildCamo: buildCamo, renderCamo: renderCamo, carve: carve, assignSources: assignSources, prepareSource: prepareSource, hash2: hash2, vnoise: vnoise, fbm: fbm, THR: THR, fromRef: fromRef };
})();
