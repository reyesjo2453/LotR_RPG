// Cut weapons out of the original (armed) model and attach them to a rigged, weaponless version.
// The weapons are the original triangles that lie far outside the weaponless body. Each blade becomes a
// separate mesh (vertex-coloured from the original texture) parented to the nearest hand bone.
// usage: node scripts/attach-weapons.mjs <armed-textured.glb> <rigged.glb> <align.json> [farDistance=0.07]
import { NodeIO } from '@gltf-transform/core';
import sharp from 'sharp';
import { readFileSync } from 'node:fs';

const [armedFile, riggedFile, alignFile, farArg = '0.07'] = process.argv.slice(2);
if (!armedFile || !riggedFile || !alignFile) { console.error('usage: node scripts/attach-weapons.mjs <armed.glb> <rigged.glb> <align.json> [far]'); process.exit(1); }
const FAR = Number(farArg);
const A = JSON.parse(readFileSync(alignFile, 'utf8')); // armed = rigged * scale + t
const io = new NodeIO();
const armedRoot = (await io.read(armedFile)).getRoot();
const doc = await io.read(riggedFile), root = doc.getRoot();

const ap = armedRoot.listMeshes()[0].listPrimitives()[0];
const AP = ap.getAttribute('POSITION').getArray(), AU = ap.getAttribute('TEXCOORD_0').getArray(), AI = ap.getIndices().getArray();
const rp = root.listMeshes()[0].listPrimitives()[0];
const RP = rp.getAttribute('POSITION').getArray();

// ---- which armed vertices are far from the weaponless body? ----
const CELL = 0.05, H = new Map(), key = (a, b, c) => `${a},${b},${c}`;
for (let i = 0; i < RP.length / 3; i++) {
  const x = RP[i * 3] * A.scale + A.tx, y = RP[i * 3 + 1] * A.scale + A.ty, z = RP[i * 3 + 2] * A.scale + A.tz;
  const k = key(Math.floor(x / CELL), Math.floor(y / CELL), Math.floor(z / CELL)); (H.get(k) || H.set(k, []).get(k)).push(x, y, z);
}
const nv = AP.length / 3, far = new Uint8Array(nv);
for (let i = 0; i < nv; i++) {
  const x = AP[i * 3], y = AP[i * 3 + 1], z = AP[i * 3 + 2]; let best = 1e9;
  const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL), cz = Math.floor(z / CELL);
  for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) for (let c = -2; c <= 2; c++) {
    const l = H.get(key(cx + a, cy + b, cz + c)); if (!l) continue;
    for (let j = 0; j < l.length; j += 3) best = Math.min(best, Math.hypot(l[j] - x, l[j + 1] - y, l[j + 2] - z));
  }
  far[i] = best > FAR ? 1 : 0;
}
// triangles whose vertices are all far, grouped into connected components
const parent = new Int32Array(nv).map((_, i) => i);
const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
const tris = [];
for (let t = 0; t < AI.length; t += 3) {
  if (far[AI[t]] && far[AI[t + 1]] && far[AI[t + 2]]) { tris.push(t); parent[find(AI[t])] = find(AI[t + 1]); parent[find(AI[t + 1])] = find(AI[t + 2]); }
}
const comps = new Map();
for (const t of tris) { const r = find(AI[t]); (comps.get(r) || comps.set(r, []).get(r)).push(t); }
const sorted = [...comps.values()].sort((a, b) => b.length - a.length);
console.log('far triangles', tris.length, 'components', sorted.length, 'sizes', sorted.slice(0, 6).map((c) => c.length).join(','));
// swords are fragmented into many components (unwelded mesh): group by side of the body instead
const midX = (RP.reduce((a, _, i) => (i % 3 === 0 ? a + RP[i] : a), 0) / (RP.length / 3)) * A.scale + A.tx;
const sides = [[], []];
for (const t of tris) { const cx = (AP[AI[t] * 3] + AP[AI[t + 1] * 3] + AP[AI[t + 2] * 3]) / 3; sides[cx > midX ? 1 : 0].push(t); }
for (const [i, s] of sides.entries()) { const b = [[1e9, 1e9, 1e9], [-1e9, -1e9, -1e9]]; for (const t of s) for (let k = 0; k < 3; k++) for (let a = 0; a < 3; a++) { b[0][a] = Math.min(b[0][a], AP[AI[t + k] * 3 + a]); b[1][a] = Math.max(b[1][a], AP[AI[t + k] * 3 + a]); } console.log('side', i, s.length, 'tris bbox', b[0].map((x) => +x.toFixed(2)), b[1].map((x) => +x.toFixed(2))); }
const keep = sides.filter((s) => s.length > 200);

// ---- texture colours (sRGB -> linear) ----
const tex = armedRoot.listTextures()[0];
const { data: TD, info: TI } = await sharp(Buffer.from(tex.getImage())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const lin = (v) => Math.pow(v / 255, 2.2);
const colorAt = (u, v) => { const x = Math.min(TI.width - 1, Math.max(0, Math.floor(u * TI.width))), y = Math.min(TI.height - 1, Math.max(0, Math.floor(v * TI.height))); const o = (y * TI.width + x) * 4; return [lin(TD[o]), lin(TD[o + 1]), lin(TD[o + 2])]; };

// ---- hands ----
const hands = ['mixamorig:LeftHand', 'mixamorig:RightHand'].map((n) => root.listNodes().find((x) => x.getName() === n));
if (hands.some((h) => !h)) { console.error('hand bones not found'); process.exit(1); }
function inv(m) { // general 4x4 inverse (column-major)
  const o = new Array(16), a = m;
  const b00 = a[0] * a[5] - a[1] * a[4], b01 = a[0] * a[6] - a[2] * a[4], b02 = a[0] * a[7] - a[3] * a[4], b03 = a[1] * a[6] - a[2] * a[5], b04 = a[1] * a[7] - a[3] * a[5], b05 = a[2] * a[7] - a[3] * a[6];
  const b06 = a[8] * a[13] - a[9] * a[12], b07 = a[8] * a[14] - a[10] * a[12], b08 = a[8] * a[15] - a[11] * a[12], b09 = a[9] * a[14] - a[10] * a[13], b10 = a[9] * a[15] - a[11] * a[13], b11 = a[10] * a[15] - a[11] * a[14];
  let d = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06; d = 1 / d;
  o[0] = (a[5] * b11 - a[6] * b10 + a[7] * b09) * d; o[1] = (a[2] * b10 - a[1] * b11 - a[3] * b09) * d; o[2] = (a[13] * b05 - a[14] * b04 + a[15] * b03) * d; o[3] = (a[10] * b04 - a[9] * b05 - a[11] * b03) * d;
  o[4] = (a[6] * b08 - a[4] * b11 - a[7] * b07) * d; o[5] = (a[0] * b11 - a[2] * b08 + a[3] * b07) * d; o[6] = (a[14] * b02 - a[12] * b05 - a[15] * b01) * d; o[7] = (a[8] * b05 - a[10] * b02 + a[11] * b01) * d;
  o[8] = (a[4] * b10 - a[5] * b08 + a[7] * b06) * d; o[9] = (a[1] * b08 - a[0] * b10 - a[3] * b06) * d; o[10] = (a[12] * b04 - a[13] * b02 + a[15] * b00) * d; o[11] = (a[9] * b02 - a[8] * b04 - a[11] * b00) * d;
  o[12] = (a[5] * b07 - a[4] * b09 - a[6] * b06) * d; o[13] = (a[0] * b09 - a[1] * b07 + a[2] * b06) * d; o[14] = (a[13] * b01 - a[12] * b03 - a[14] * b00) * d; o[15] = (a[8] * b03 - a[9] * b01 + a[10] * b00) * d;
  return o;
}
const xf = (m, x, y, z) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
const handW = hands.map((h) => h.getWorldMatrix()), handInv = handW.map(inv), handPos = handW.map((m) => [m[12], m[13], m[14]]);

const mat = doc.createMaterial('weapon').setBaseColorFactor([1, 1, 1, 1]).setMetallicFactor(0).setRoughnessFactor(1);
const buf = root.listBuffers()[0] ?? doc.createBuffer();
let n = 0;
for (const comp of keep) {
  const remap = new Map(), P = [], C = [], I = [];
  for (const t of comp) for (let k = 0; k < 3; k++) {
    const i = AI[t + k]; let r = remap.get(i);
    if (r === undefined) { r = P.length / 3; remap.set(i, r); P.push((AP[i * 3] - A.tx) / A.scale, (AP[i * 3 + 1] - A.ty) / A.scale, (AP[i * 3 + 2] - A.tz) / A.scale); C.push(...colorAt(AU[i * 2], AU[i * 2 + 1])); }
    I.push(r);
  }
  // nearest hand to the centroid, in rigged-mesh space
  let cx = 0, cy = 0, cz = 0; for (let i = 0; i < P.length; i += 3) { cx += P[i]; cy += P[i + 1]; cz += P[i + 2]; } cx /= P.length / 3; cy /= P.length / 3; cz /= P.length / 3;
  const hi = handPos.map((h) => Math.hypot(h[0] - cx, h[1] - cy, h[2] - cz)).reduce((b, d, i, a) => (d < a[b] ? i : b), 0);
  // vertices into the hand's local space, then smooth normals
  const L = new Float32Array(P.length);
  for (let i = 0; i < P.length; i += 3) { const q = xf(handInv[hi], P[i], P[i + 1], P[i + 2]); L[i] = q[0]; L[i + 1] = q[1]; L[i + 2] = q[2]; }
  const N = new Float32Array(P.length);
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ux = L[b] - L[a], uy = L[b + 1] - L[a + 1], uz = L[b + 2] - L[a + 2], vx = L[c] - L[a], vy = L[c + 1] - L[a + 1], vz = L[c + 2] - L[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const q of [a, b, c]) { N[q] += nx; N[q + 1] += ny; N[q + 2] += nz; }
  }
  for (let i = 0; i < N.length; i += 3) { const l = Math.hypot(N[i], N[i + 1], N[i + 2]) || 1; N[i] /= l; N[i + 1] /= l; N[i + 2] /= l; }
  const prim = doc.createPrimitive().setMaterial(mat)
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(L).setBuffer(buf))
    .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(N).setBuffer(buf))
    .setAttribute('COLOR_0', doc.createAccessor().setType('VEC3').setArray(new Float32Array(C)).setBuffer(buf))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(I)).setBuffer(buf));
  const name = `weapon_${hi === 0 ? 'L' : 'R'}${n++}`;
  const node = doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim));
  hands[hi].addChild(node);
  console.log(`${name}: ${I.length / 3} tris -> ${hands[hi].getName()}`);
}
await io.write(riggedFile, doc);
