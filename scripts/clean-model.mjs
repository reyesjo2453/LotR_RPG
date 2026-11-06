// Remove the flat "base disc" image-to-3D generators leave under a character's feet.
// usage: node scripts/clean-model.mjs public/assets/models/vaelen.glb [heightFrac=0.1] [maxRadius=0.22]
import { NodeIO } from '@gltf-transform/core';
import { prune } from '@gltf-transform/functions';
const [file, hf = '0.1', mr = '0.22'] = process.argv.slice(2);
const io = new NodeIO();
const doc = await io.read(file);
let removed = 0;
for (const mesh of doc.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) {
  const pos = p.getAttribute('POSITION'), idx = p.getIndices();
  const mn = pos.getMin([0, 0, 0]), mx = pos.getMax([0, 0, 0]);
  const ylim = mn[1] + (mx[1] - mn[1]) * Number(hf);
  const cx = (mn[0] + mx[0]) / 2, cz = (mn[2] + mx[2]) / 2, rLim = (mx[1] - mn[1]) * Number(mr);
  const src = idx.getArray(), keep = [], v = [0, 0, 0];
  for (let i = 0; i < src.length; i += 3) {
    let allLow = true, far = false;
    for (let k = 0; k < 3; k++) { pos.getElement(src[i + k], v); if (v[1] > ylim) allLow = false; if (Math.hypot(v[0] - cx, v[2] - cz) > rLim) far = true; }
    if (allLow && far) removed += 1; else keep.push(src[i], src[i + 1], src[i + 2]);
  }
  idx.setArray(new (src.constructor)(keep));
}
await doc.transform(prune());
await io.write(file, doc);
console.log(`removed ${removed} triangles from ${file}`);
