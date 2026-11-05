#!/usr/bin/env node
// Usage: node scripts/generate-characters.mjs [name ...]
// text-to-model -> decimate -> (biped) rig-check/rig/retarget -> weld/simplify/meshopt -> public/assets/models
import { resolve } from 'node:path';
import { ROOT, makeClient, runTask, modelUrls, download, compressGlb, log } from './lib/pipeline.mjs';

const CHARACTERS = {
  vaelen: { biped: true, prompt: 'Stylized dark fantasy elven blade-warden, twin crescent swords, silver and obsidian armor, cel-shaded game character, symmetrical T-pose, full body' },
  seraphina: { biped: true, prompt: 'Stylized dark fantasy elven lore-mistress, glowing spectral runes, hooded cloak, astral staff, cel-shaded game character, symmetrical T-pose, full body' },
  kaelen: { biped: true, prompt: 'Stylized dark fantasy dwarven runesmith warrior, heavy mithril geometric armor, warhammer and tower shield, symmetrical T-pose, full body' },
  castellan_knight: { biped: true, prompt: 'Stylized dark fantasy wraith knight in spiked morgul iron plate armor, cursed greatsword, symmetrical T-pose, full body' },
  barrow_hound: { biped: false, prompt: 'Stylized dark fantasy spectral shadow hound beast, jagged spine, glowing eyes, standing pose' },
};

// Retarget presets -> suffix of the clip file the runtime looks for (<name>.<suffix>.glb).
const ANIMATIONS = {
  'preset:biped:idle': 'idle',
  'preset:biped:run': 'run',
  'preset:biped:slash': 'slash',
  'preset:biped:hit_react': 'hit',
};

const client = makeClient();
const only = process.argv.slice(2);
const outDir = resolve(ROOT, 'public/assets/models');
let failures = 0;

for (const [name, def] of Object.entries(CHARACTERS)) {
  if (only.length && !only.includes(name)) continue;
  try {
    const base = await runTask(client, name, 'text-to-model', () =>
      client.textToModel({ prompt: def.prompt, model: 'v3.1-20260211', texture: true, texture_quality: 'standard' }));

    const dec = await runTask(client, name, 'decimate', () =>
      client.decimateMesh({ input: base.task_id, model: 'v3.0', face_limit: 7500, smart_uv: true }));

    let finalUrl = modelUrls(dec)[0];
    const clips = {};

    if (def.biped) {
      const check = await runTask(client, name, 'rig-check', () => client.rigCheck({ input: dec.task_id }));
      if (check.output?.riggable === false) {
        log(name, 'rig-check says not riggable; shipping static mesh (procedural animation will drive it)');
      } else {
        const rig = await runTask(client, name, 'rig', () =>
          client.rigModel({ input: dec.task_id, model: 'v3.0-20260909', rig_type: 'biped', spec: 'mixamo', out_format: 'glb' }));
        finalUrl = modelUrls(rig)[0] ?? finalUrl;
        for (const [preset, suffix] of Object.entries(ANIMATIONS)) {
          const anim = await runTask(client, name, `retarget ${suffix}`, () =>
            client.retargetAnimation({ input: rig.task_id, animation: preset, out_format: 'glb', export_with_geometry: suffix === 'idle' }));
          clips[suffix] = modelUrls(anim)[0];
        }
      }
    }

    if (!finalUrl) throw new Error('no model URL in task output');
    // Model URLs expire in ~5 minutes, so download immediately.
    const main = clips.idle ?? finalUrl;
    const size = await compressGlb(await download(main), resolve(outDir, `${name}.glb`));
    log(name, `wrote models/${name}.glb (${(size / 1024).toFixed(0)} KB)`);
    for (const [suffix, url] of Object.entries(clips)) {
      if (suffix === 'idle' || !url) continue;
      const s = await compressGlb(await download(url), resolve(outDir, `${name}.${suffix}.glb`), { animationOnly: true });
      log(name, `wrote models/${name}.${suffix}.glb (${(s / 1024).toFixed(0)} KB)`);
    }
  } catch (err) {
    failures++;
    console.error(`[${name}] FAILED:`, err?.message ?? err);
  }
}
process.exit(failures ? 1 : 0);
