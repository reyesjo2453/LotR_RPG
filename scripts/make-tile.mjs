// Make a painted texture seamless (cross-fade with a half-shifted copy near the edges) and shrink it.
// Usage: node scripts/make-tile.mjs <in.jpg> <name> [size=1024] [band=0.14]
import sharp from 'sharp';
const [, , input, name, sz = '1024', bd = '0.14'] = process.argv;
if (!input || !name) { console.error('usage: make-tile.mjs <in> <name> [size] [band]'); process.exit(1); }
const N = +sz, band = +bd;
const { data } = await sharp(input).resize(N, N).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const out = Buffer.alloc(N * N * 3);
const w = (t) => { const e = Math.min(t, 1 - t) / band; const k = Math.min(1, Math.max(0, e)); return k * k * (3 - 2 * k); };
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  const m = w(x / N) * w(y / N); // 1 in the middle, 0 on the borders
  const sx = (x + N / 2) % N, sy = (y + N / 2) % N;
  for (let c = 0; c < 3; c++) out[(y * N + x) * 3 + c] = Math.round(data[(y * N + x) * 3 + c] * m + data[(sy * N + sx) * 3 + c] * (1 - m));
}
await sharp(out, { raw: { width: N, height: N, channels: 3 } }).jpeg({ quality: 85, mozjpeg: true }).toFile(`public/assets/tex/${name}.jpg`);
console.log('wrote', name);
