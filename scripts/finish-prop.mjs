#!/usr/bin/env node
// Make a raw generated prop (e.g. from fal-trellis) game-ready: weld, decimate to a triangle budget while
// protecting UV seams, recompress the texture to JPEG, and write public/assets/env/<name>.glb.
//
// usage: node scripts/finish-prop.mjs <raw.glb> <name> [targetTriangles=3000] [textureSize=1024] [jpegQuality=85]
import { NodeIO } from '@gltf-transform/core';
import { weld, simplify, prune, dedup } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './lib/pipeline.mjs';

const [src, name, tgt = '3000', texSize = '1024', q = '85'] = process.argv.slice(2);
if (!src || !name) { console.error('usage: node scripts/finish-prop.mjs <raw.glb> <name> [targetTriangles] [textureSize] [jpegQuality]'); process.exit(1); }
await MeshoptSimplifier.ready;
const io = new NodeIO();
const doc = await io.read(resolve(src));
const count = () => doc.getRoot().listMeshes().reduce((n, m) => n + m.listPrimitives().reduce((s, p) => s + (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3, 0), 0);
const before = count();
await doc.transform(weld());
const now = count();
if (now > Number(tgt)) {
  await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: Number(tgt) / now, error: Number(process.env.ERR ?? 0.02), lockBorder: process.env.LOCK !== '0' }));
}
await doc.transform(dedup(), prune());
for (const t of doc.getRoot().listTextures()) {
  const jpg = await sharp(Buffer.from(t.getImage())).resize(Number(texSize), Number(texSize), { fit: 'inside' }).flatten({ background: '#808080' }).jpeg({ quality: Number(q), mozjpeg: true }).toBuffer();
  t.setImage(new Uint8Array(jpg)).setMimeType('image/jpeg');
}
const out = resolve(ROOT, 'public/assets/env', `${name}.glb`);
mkdirSync(resolve(ROOT, 'public/assets/env'), { recursive: true });
const bin = await io.writeBinary(doc);
await (await import('node:fs/promises')).writeFile(out, bin);
console.log(`${name}: ${Math.round(before)} -> ${Math.round(count())} tris, ${(bin.byteLength / 1024).toFixed(0)} KB -> ${out}`);
