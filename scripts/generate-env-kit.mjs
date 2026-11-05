#!/usr/bin/env node
// Usage: node scripts/generate-env-kit.mjs [name ...]
import { resolve } from 'node:path';
import { ROOT, makeClient, runTask, modelUrls, download, compressGlb, log } from './lib/pipeline.mjs';

const PROPS = {
  pillar_elven: 'Ancient cracked elven stone pillar with silver filigree, flat base, isolated game prop',
  wall_segment: 'Modular dark obsidian dungeon wall block with carved gothic arches, flat base, isolated prop',
  brazier_iron: 'Dark iron gothic standing brazier bowl with runes, no fire, isolated game prop',
  runestone_monolith: 'Fractured obsidian monolith runestone etched with glowing sigils, isolated game prop',
  bridge_broken: 'Ancient stone dungeon bridge slab with cracked edges, modular floor tile',
  archway_gate: 'Massive ruined gothic stone archway door frame, dark fantasy prop',
};

const client = makeClient();
const only = process.argv.slice(2);
const outDir = resolve(ROOT, 'public/assets/env');
let failures = 0;

for (const [name, prompt] of Object.entries(PROPS)) {
  if (only.length && !only.includes(name)) continue;
  try {
    const base = await runTask(client, name, 'text-to-model', () =>
      client.textToModel({ prompt, model: 'v3.1-20260211', texture: true, texture_quality: 'standard' }));
    const dec = await runTask(client, name, 'decimate', () =>
      client.decimateMesh({ input: base.task_id, model: 'v3.0', face_limit: 2000, smart_uv: true }));
    const url = modelUrls(dec)[0];
    if (!url) throw new Error('no model URL in task output');
    const size = await compressGlb(await download(url), resolve(outDir, `${name}.glb`));
    log(name, `wrote env/${name}.glb (${(size / 1024).toFixed(0)} KB)`);
  } catch (err) {
    failures++;
    console.error(`[${name}] FAILED:`, err?.message ?? err);
  }
}
process.exit(failures ? 1 : 0);
