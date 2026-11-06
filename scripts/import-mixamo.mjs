// Turn Mixamo FBX downloads into game assets.
// usage: node scripts/import-mixamo.mjs <name> <texture.png> [slashStart slashEnd]
//   expects public/assets/models/<Name>_{Idle,Run,Slash,Impact}.fbx  (any one of them contains the skinned mesh)
// writes:  <name>.glb (mesh+skeleton+texture, no animation) and <name>.{idle,run,slash,hit}.glb (animation only)
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { NodeIO } from '@gltf-transform/core';
import { prune, dedup } from '@gltf-transform/functions';
import { ROOT } from './lib/pipeline.mjs';

const [name, texPath, s0 = '0.95', s1 = '1.95'] = process.argv.slice(2);
if (!name || !texPath) { console.error('usage: node scripts/import-mixamo.mjs <name> <texture.png> [slashStart slashEnd]'); process.exit(1); }
const dir = resolve(ROOT, 'public/assets/models');
const Name = name[0].toUpperCase() + name.slice(1);
const bin = resolve(ROOT, 'node_modules/fbx2gltf/bin', { linux: 'Linux', darwin: 'Darwin', win32: 'Windows_NT' }[process.platform], process.platform === 'win32' ? 'FBX2glTF.exe' : 'FBX2glTF');
const tmp = join(tmpdir(), `import-${name}`); rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true });
const CLIPS = { idle: 'Idle', run: 'Run', slash: 'Slash', hit: 'Impact' };
const io = new NodeIO();

const glbs = {};
for (const [suffix, label] of Object.entries(CLIPS)) {
  const fbx = join(dir, `${Name}_${label}.fbx`);
  if (!existsSync(fbx)) { console.log(`skip ${suffix}: ${fbx} not found`); continue; }
  const out = join(tmp, suffix);
  const r = spawnSync(bin, ['--binary', '--input', fbx, '--output', out], { encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(1); }
  glbs[suffix] = out + '.glb';
}

// ---- base model: first file that actually carries a skinned mesh ----
let baseDone = !!process.env.CLIPS_ONLY; // CLIPS_ONLY=1: leave <name>.glb untouched, regenerate clips only
for (const [suffix, file] of Object.entries(glbs)) {
  if (process.env.CLIPS_ONLY) break;
  const doc = await io.read(file);
  if (!doc.getRoot().listMeshes().length) continue;
  for (const a of doc.getRoot().listAnimations()) a.dispose();
  const tex = doc.createTexture('baseColor').setImage(readFileSync(resolve(texPath))).setMimeType('image/png');
  for (const m of doc.getRoot().listMaterials()) m.setBaseColorTexture(tex).setBaseColorFactor([1, 1, 1, 1]).setMetallicFactor(0).setRoughnessFactor(1);
  await doc.transform(prune(), dedup());
  await io.write(join(dir, `${name}.glb`), doc);
  console.log(`${name}.glb  (from ${suffix}): ${doc.getRoot().listSkins()[0]?.listJoints().length} joints`);
  baseDone = true; break;
}
if (!baseDone) { console.error('no FBX contained a mesh'); process.exit(1); }

// ---- animation-only clips ----
for (const [suffix, file] of Object.entries(glbs)) {
  const doc = await io.read(file);
  const root = doc.getRoot();
  const anim = root.listAnimations()[0];
  anim.setName(suffix);
  if (suffix === 'slash') trim(anim, Number(s0), Number(s1));
  for (const m of root.listMeshes()) m.dispose();
  for (const s of root.listSkins()) s.dispose();
  for (const m of root.listMaterials()) m.dispose();
  for (const t of root.listTextures()) t.dispose();
  await doc.transform(prune({ keepLeaves: true }));
  await io.write(join(dir, `${name}.${suffix}.glb`), doc);
  let dur = 0; for (const s of anim.listSamplers()) dur = Math.max(dur, s.getInput().getMax([0])[0]);
  console.log(`${name}.${suffix}.glb  ${dur.toFixed(2)}s`);
}

/** Keep keyframes in [t0,t1] (linearly clamped at the edges) and shift to start at 0. Every sampler gets its own new accessors
 *  (the originals are shared between samplers, so rewriting them in place corrupts the other channels). */
function trim(anim, t0, t1) {
  const jobs = anim.listSamplers().map((s) => ({ s, T: Float32Array.from(s.getInput().getArray()), V: s.getOutput(), arr: Float32Array.from(s.getOutput().getArray()), stride: s.getOutput().getElementSize() }));
  for (const { s, T, V, arr, stride } of jobs) {
    const times = [], vals = [];
    const sample = (t, k) => {
      let i = 0; while (i < T.length - 2 && T[i + 1] < t) i++;
      const u = Math.min(1, Math.max(0, (t - T[i]) / Math.max(1e-6, T[i + 1] - T[i])));
      return arr[i * stride + k] * (1 - u) + arr[(i + 1) * stride + k] * u;
    };
    const push = (t) => { times.push(t - t0); const row = []; for (let k = 0; k < stride; k++) row.push(sample(t, k)); if (stride === 4) { const n = Math.hypot(...row) || 1; row.forEach((x, k) => (row[k] = x / n)); } vals.push(...row); };
    push(t0); for (const t of T) if (t > t0 && t < t1) push(t); push(t1);
    const inAcc = s.getInput().clone().setArray(new Float32Array(times));
    const outAcc = V.clone().setArray(new Float32Array(vals));
    s.setInput(inAcc).setOutput(outAcc);
  }
}
