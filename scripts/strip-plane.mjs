#!/usr/bin/env node
// Remove thin, wide "backdrop slab" components that image-to-3D leaves under a prop.
// usage: node scripts/strip-plane.mjs <in.glb> [out.glb=in.glb]
import { NodeIO } from '@gltf-transform/core';
import { prune } from '@gltf-transform/functions';
const strict = process.argv.includes('--strict'); const [src, out = src] = process.argv.slice(2).filter((a) => a !== '--strict');
const doc = await new NodeIO().read(src);
let removed = 0;
for (const mesh of doc.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) {
  const pos = p.getAttribute('POSITION'), idx = p.getIndices(), n = pos.getCount();
  const par = Array.from({ length: n }, (_, i) => i);
  const find = (a) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
  const ia = idx.getArray();
  for (let i = 0; i < ia.length; i += 3) { const r = find(ia[i]); par[find(ia[i + 1])] = r; par[find(ia[i + 2])] = r; }
  const a = [0, 0, 0], bb = new Map(), mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (let i = 0; i < n; i++) {
    pos.getElement(i, a); const r = find(i);
    let b = bb.get(r); if (!b) { b = { mn: [1e9, 1e9, 1e9], mx: [-1e9, -1e9, -1e9] }; bb.set(r, b); }
    for (let k = 0; k < 3; k++) { b.mn[k] = Math.min(b.mn[k], a[k]); b.mx[k] = Math.max(b.mx[k], a[k]); mn[k] = Math.min(mn[k], a[k]); mx[k] = Math.max(mx[k], a[k]); }
  }
  const big = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]);
  const bad = new Set();
  for (const [r, b] of bb) {
    const h = b.mx[1] - b.mn[1], w = Math.max(b.mx[0] - b.mn[0], b.mx[2] - b.mn[2]);
    if (h < 0.06 * big && (strict || w > 0.5 * big)) bad.add(r);
  }
  const keep = [];
  for (let i = 0; i < ia.length; i += 3) if (!bad.has(find(ia[i]))) keep.push(ia[i], ia[i + 1], ia[i + 2]); else removed++;
  idx.setArray(new (ia.constructor)(keep));
}
await doc.transform(prune());
await new NodeIO().write(out, doc);
console.log(`${src}: removed ${removed} slab triangles`);
