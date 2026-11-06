// Re-bake a texture onto a differently-unwrapped version of the same model.
// Mixamo (and many editors) re-unwrap the mesh, so the original texture no longer fits the new UVs.
// For every texel of the target's UV layout we find the closest point on the source surface and copy its colour.
// usage: node scripts/bake-texture.mjs <source-textured.glb> <target.glb> <out.png> [size=1024]
import { NodeIO } from '@gltf-transform/core';
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';

const [srcFile, dstFile, outFile, sizeArg = '1024'] = process.argv.slice(2);
if (!srcFile || !dstFile || !outFile) { console.error('usage: node scripts/bake-texture.mjs <source.glb> <target.glb> <out.png> [size]'); process.exit(1); }
const SIZE = Number(sizeArg);
const io = new NodeIO();

const prim = async (f) => (await io.read(f)).getRoot();
const sRoot = await prim(srcFile), dRoot = await prim(dstFile);
const sp = sRoot.listMeshes()[0].listPrimitives()[0], dp = dRoot.listMeshes()[0].listPrimitives()[0];
const SP = sp.getAttribute('POSITION').getArray(), SU = sp.getAttribute('TEXCOORD_0').getArray(), SI = sp.getIndices().getArray();
const DP = dp.getAttribute('POSITION').getArray(), DU = dp.getAttribute('TEXCOORD_0').getArray(), DI = dp.getIndices().getArray();
const sv = SP.length / 3, dv = DP.length / 3;

// ---- source texture ----
const tex = sRoot.listTextures()[0];
const { data: TEXD, info: TI } = await sharp(Buffer.from(tex.getImage())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const TW = TI.width, TH = TI.height;
function sample(u, v, out) { // bilinear, glTF convention (v down from top)
  const x = Math.min(TW - 1.001, Math.max(0, u * TW - 0.5)), y = Math.min(TH - 1.001, Math.max(0, v * TH - 0.5));
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  for (let c = 0; c < 3; c++) {
    const a = TEXD[(y0 * TW + x0) * 4 + c], b = TEXD[(y0 * TW + x0 + 1) * 4 + c], d = TEXD[((y0 + 1) * TW + x0) * 4 + c], e = TEXD[((y0 + 1) * TW + x0 + 1) * 4 + c];
    out[c] = (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
  }
}

// ---- spatial hash of source triangles ----
const CELL = 0.03, H = new Map();
const ck = (a, b, c) => `${a},${b},${c}`;
for (let t = 0; t < SI.length / 3; t++) {
  const i0 = SI[t * 3], i1 = SI[t * 3 + 1], i2 = SI[t * 3 + 2];
  const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (const i of [i0, i1, i2]) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], SP[i * 3 + k]); mx[k] = Math.max(mx[k], SP[i * 3 + k]); }
  for (let a = Math.floor(mn[0] / CELL); a <= Math.floor(mx[0] / CELL); a++) for (let b = Math.floor(mn[1] / CELL); b <= Math.floor(mx[1] / CELL); b++) for (let c = Math.floor(mn[2] / CELL); c <= Math.floor(mx[2] / CELL); c++) {
    const k = ck(a, b, c); (H.get(k) || H.set(k, []).get(k)).push(t);
  }
}

// closest point on triangle (Ericson), returns barycentric weights via out and squared distance
function closest(px, py, pz, t, out) {
  const i0 = SI[t * 3], i1 = SI[t * 3 + 1], i2 = SI[t * 3 + 2];
  const ax = SP[i0 * 3], ay = SP[i0 * 3 + 1], az = SP[i0 * 3 + 2], bx = SP[i1 * 3], by = SP[i1 * 3 + 1], bz = SP[i1 * 3 + 2], cx = SP[i2 * 3], cy = SP[i2 * 3 + 1], cz = SP[i2 * 3 + 2];
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az, apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let u, v, w;
  const set = (a, b, c) => { u = a; v = b; w = c; };
  const bpx = px - bx, bpy = py - by, bpz = pz - bz, d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz, d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
  if (d1 <= 0 && d2 <= 0) set(1, 0, 0);
  else if (d3 >= 0 && d4 <= d3) set(0, 1, 0);
  else if (vc <= 0 && d1 >= 0 && d3 <= 0) { const s = d1 / (d1 - d3); set(1 - s, s, 0); }
  else if (d6 >= 0 && d5 <= d6) set(0, 0, 1);
  else if (vb <= 0 && d2 >= 0 && d6 <= 0) { const s = d2 / (d2 - d6); set(1 - s, 0, s); }
  else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const s = (d4 - d3) / ((d4 - d3) + (d5 - d6)); set(0, 1 - s, s); }
  else { const den = 1 / (va + vb + vc); const s = vb * den, r = vc * den; set(1 - s - r, s, r); }
  const qx = u * ax + v * bx + w * cx, qy = u * ay + v * by + w * cy, qz = u * az + v * bz + w * cz;
  out[0] = u; out[1] = v; out[2] = w;
  return (px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2;
}
const bary = [0, 0, 0], bb = [0, 0, 0];
function query(x, y, z, res) { // -> squared distance; res = [u,v] of source
  let best = 1e9, bt = -1;
  const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL), cz = Math.floor(z / CELL);
  for (let r = 0; r <= 5; r++) {
    for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) for (let c = -r; c <= r; c++) {
      if (Math.max(Math.abs(a), Math.abs(b), Math.abs(c)) !== r) continue;
      const l = H.get(ck(cx + a, cy + b, cz + c)); if (!l) continue;
      for (const t of l) { const d = closest(x, y, z, t, bary); if (d < best) { best = d; bt = t; bb[0] = bary[0]; bb[1] = bary[1]; bb[2] = bary[2]; } }
    }
    if (bt >= 0 && Math.sqrt(best) <= r * CELL) break;
  }
  if (bt < 0) return 1e9;
  const i0 = SI[bt * 3], i1 = SI[bt * 3 + 1], i2 = SI[bt * 3 + 2];
  res[0] = bb[0] * SU[i0 * 2] + bb[1] * SU[i1 * 2] + bb[2] * SU[i2 * 2];
  res[1] = bb[0] * SU[i0 * 2 + 1] + bb[1] * SU[i1 * 2 + 1] + bb[2] * SU[i2 * 2 + 1];
  return best;
}

// ---- align target onto source (uniform scale + translation), coordinate descent on vertex->surface distance ----
const bbox = (a) => { const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9]; for (let i = 0; i < a.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], a[i + k]); mx[k] = Math.max(mx[k], a[i + k]); } return [mn, mx]; };
const [smn, smx] = bbox(SP), [dmn, dmx] = bbox(DP);
const tmp = [0, 0];
const cost = (p) => { let s = 0, c = 0; for (let i = 0; i < dv; i += 5) { s += Math.min(Math.sqrt(query(DP[i * 3] * p[0] + p[1], DP[i * 3 + 1] * p[0] + p[2], DP[i * 3 + 2] * p[0] + p[3], tmp)), 0.15); c++; } return s / c; };
const ratio = (smx[1] - smn[1]) / (dmx[1] - dmn[1]);
let bestFit = null;
for (const f of [1, 0.85, 0.75, 0.65, 0.55]) {
  const s = ratio * f; let p = [s, (smn[0] + smx[0]) / 2 - (dmn[0] + dmx[0]) / 2 * s, smn[1] - dmn[1] * s, (smn[2] + smx[2]) / 2 - (dmn[2] + dmx[2]) / 2 * s];
  let c = cost(p); if (!bestFit || c < bestFit.c) bestFit = { p, c };
}
let { p, c: best } = bestFit; let step = [p[0] * 0.08, 0.05, 0.05, 0.05];
for (let it = 0; it < 120 && step[1] > 2e-4; it++) {
  let imp = false;
  for (let k = 0; k < 4; k++) for (const sg of [1, -1]) { const q = [...p]; q[k] += sg * step[k]; const c = cost(q); if (c < best) { best = c; p = q; imp = true; } }
  if (!imp) step = step.map((x) => x / 2);
}
console.log(`alignment: scale ${p[0].toFixed(3)}  mean surface distance ${best.toFixed(4)} (model height ${(smx[1] - smn[1]).toFixed(2)})`);

writeFileSync(outFile + '.align.json', JSON.stringify({ scale: p[0], tx: p[1], ty: p[2], tz: p[3], note: 'source = target * scale + t' }));

// ---- bake: rasterise target triangles in UV space ----
const out = new Uint8ClampedArray(SIZE * SIZE * 4), filled = new Uint8Array(SIZE * SIZE), col = [0, 0, 0], uv = [0, 0];
let maxD = 0, sumD = 0, cnt = 0;
function texel(px, py, w0, w1, w2, i0, i1, i2) {
  const x = (w0 * DP[i0 * 3] + w1 * DP[i1 * 3] + w2 * DP[i2 * 3]) * p[0] + p[1];
  const y = (w0 * DP[i0 * 3 + 1] + w1 * DP[i1 * 3 + 1] + w2 * DP[i2 * 3 + 1]) * p[0] + p[2];
  const z = (w0 * DP[i0 * 3 + 2] + w1 * DP[i1 * 3 + 2] + w2 * DP[i2 * 3 + 2]) * p[0] + p[3];
  const d = Math.sqrt(query(x, y, z, uv)); sumD += d; cnt++; if (d > maxD) maxD = d;
  sample(uv[0], uv[1], col);
  const o = (py * SIZE + px) * 4; out[o] = col[0]; out[o + 1] = col[1]; out[o + 2] = col[2]; out[o + 3] = 255; filled[py * SIZE + px] = 1;
}
for (let t = 0; t < DI.length / 3; t++) {
  const i0 = DI[t * 3], i1 = DI[t * 3 + 1], i2 = DI[t * 3 + 2];
  const x0 = DU[i0 * 2] * SIZE, y0 = DU[i0 * 2 + 1] * SIZE, x1 = DU[i1 * 2] * SIZE, y1 = DU[i1 * 2 + 1] * SIZE, x2 = DU[i2 * 2] * SIZE, y2 = DU[i2 * 2 + 1] * SIZE;
  const den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2); if (Math.abs(den) < 1e-9) continue;
  const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)) - 1), maxX = Math.min(SIZE - 1, Math.ceil(Math.max(x0, x1, x2)) + 1);
  const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)) - 1), maxY = Math.min(SIZE - 1, Math.ceil(Math.max(y0, y1, y2)) + 1);
  for (let py = minY; py <= maxY; py++) for (let px = minX; px <= maxX; px++) {
    const sx = px + 0.5, sy = py + 0.5;
    let w0 = ((y1 - y2) * (sx - x2) + (x2 - x1) * (sy - y2)) / den, w1 = ((y2 - y0) * (sx - x2) + (x0 - x2) * (sy - y2)) / den, w2 = 1 - w0 - w1;
    const eps = -0.02; if (w0 < eps || w1 < eps || w2 < eps) continue;
    w0 = Math.min(1, Math.max(0, w0)); w1 = Math.min(1, Math.max(0, w1)); w2 = Math.min(1, Math.max(0, w2));
    const s = w0 + w1 + w2; texel(px, py, w0 / s, w1 / s, w2 / s, i0, i1, i2);
  }
}
// dilate into gutters so bilinear filtering and mip-maps never pull in black
for (let pass = 0; pass < 6; pass++) {
  const add = [];
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    if (filled[y * SIZE + x]) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE || !filled[ny * SIZE + nx]) continue;
      add.push([x, y, (ny * SIZE + nx) * 4]); break;
    }
  }
  for (const [x, y, s] of add) { const o = (y * SIZE + x) * 4; out[o] = out[s]; out[o + 1] = out[s + 1]; out[o + 2] = out[s + 2]; out[o + 3] = 255; filled[y * SIZE + x] = 1; }
}
writeFileSync(outFile, await sharp(Buffer.from(out.buffer), { raw: { width: SIZE, height: SIZE, channels: 4 } }).png().toBuffer());
console.log(`baked ${cnt} texels, mean surface distance ${(sumD / cnt).toFixed(4)}, max ${maxD.toFixed(3)} -> ${outFile}`);
