// GLB -> OBJ + MTL + PNG zip for Mixamo upload (no Blender needed).
// usage: node scripts/glb-to-obj.mjs <in.glb> <name> [outDir=mixamo/<name>] [targetHeight=1.8]
import { NodeIO } from '@gltf-transform/core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
const [src, name, out = `mixamo/${name}`, h = '1.8'] = process.argv.slice(2);
const doc = await new NodeIO().read(src);
mkdirSync(out, { recursive: true });
let v = [], vt = [], vn = [], f = [], base = 0, tex = null;
for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh(); if (!mesh) continue;
  const m = node.getWorldMatrix();
  for (const p of mesh.listPrimitives()) {
    const pos = p.getAttribute('POSITION'), uv = p.getAttribute('TEXCOORD_0'), nor = p.getAttribute('NORMAL'), idx = p.getIndices();
    const bt = p.getMaterial()?.getBaseColorTexture(); if (bt && !tex) tex = bt.getImage();
    const n = pos.getCount(), a = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      pos.getElement(i, a); v.push([m[0]*a[0]+m[4]*a[1]+m[8]*a[2]+m[12], m[1]*a[0]+m[5]*a[1]+m[9]*a[2]+m[13], m[2]*a[0]+m[6]*a[1]+m[10]*a[2]+m[14]]);
      if (uv) { uv.getElement(i, a); vt.push([a[0], 1 - a[1]]); } else vt.push([0, 0]);
      if (nor) { nor.getElement(i, a); vn.push([m[0]*a[0]+m[4]*a[1]+m[8]*a[2], m[1]*a[0]+m[5]*a[1]+m[9]*a[2], m[2]*a[0]+m[6]*a[1]+m[10]*a[2]]); } else vn.push([0, 1, 0]);
    }
    const ia = idx.getArray();
    for (let i = 0; i < ia.length; i += 3) f.push([ia[i] + base + 1, ia[i + 1] + base + 1, ia[i + 2] + base + 1]);
    base += n;
  }
}
// scale to target height, feet on y=0, centred on x/z
let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
for (const p of v) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[k]); mx[k] = Math.max(mx[k], p[k]); }
const s = Number(h) / (mx[1] - mn[1]), cx = (mn[0] + mx[0]) / 2, cz = (mn[2] + mx[2]) / 2;
const L = [`mtllib material.mtl`, `o ${name}`];
for (const p of v) L.push(`v ${((p[0] - cx) * s).toFixed(5)} ${((p[1] - mn[1]) * s).toFixed(5)} ${((p[2] - cz) * s).toFixed(5)}`);
for (const t of vt) L.push(`vt ${t[0].toFixed(5)} ${t[1].toFixed(5)}`);
for (const n of vn) L.push(`vn ${n[0].toFixed(4)} ${n[1].toFixed(4)} ${n[2].toFixed(4)}`);
L.push('usemtl material_0');
for (const t of f) L.push(`f ${t.map((i) => `${i}/${i}/${i}`).join(' ')}`);
writeFileSync(`${out}/${name}.obj`, L.join('\n'));
writeFileSync(`${out}/material.mtl`, `newmtl material_0\nKa 1 1 1\nKd 1 1 1\nmap_Kd material_0.png\n`);
await sharp(Buffer.from(tex)).png().toFile(`${out}/material_0.png`);
spawnSync('zip', ['-j', `mixamo/${name}_for_mixamo.zip`, `${out}/${name}.obj`, `${out}/material.mtl`, `${out}/material_0.png`], { stdio: 'inherit' });
console.log(`${name}: ${v.length} verts, ${f.length} tris, height ${h}`);
