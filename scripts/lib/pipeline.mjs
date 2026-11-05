// Shared helpers for the Tripo3D asset scripts.
// Run on demand (npm run gen:chars / gen:env). Never invoked by `npm run build`.
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TripoClient } from '@vastai/tripo-sdk';
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import { weld, simplify, meshopt, prune } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier, MeshoptDecoder } from 'meshoptimizer';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Minimal .env loader (no dependency). Real environment variables win. */
export function loadEnv() {
  const file = resolve(ROOT, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

export function makeClient() {
  loadEnv();
  if (!process.env.TRIPO_API_KEY) {
    console.error('TRIPO_API_KEY is not set (put it in .env or the environment). Nothing generated.');
    console.error('The game still runs: it uses procedural fallbacks until .glb files exist in public/assets/.');
    process.exit(0); // not an error: assets are optional
  }
  return new TripoClient({ baseUrl: process.env.TRIPO_BASE_URL || 'https://openapi.tripo3d.ai/v3', timeoutMs: 120_000 });
}

export const log = (name, msg) => console.log(`[${name}] ${msg}`);

export async function runTask(client, name, label, submit) {
  const id = await submit();
  log(name, `${label}: task ${id}`);
  let last = -1;
  return client.waitForTask(id, {
    pollingIntervalMs: 3000,
    timeoutMs: 15 * 60_000,
    onProgress: (t) => {
      const p = Math.round(t.progress ?? 0);
      if (p !== last && p % 25 === 0) { last = p; log(name, `${label}: ${t.status} ${p}%`); }
    },
  });
}

/** Collect every downloadable model URL from a finished task's output. */
export function modelUrls(task) {
  const o = task.output ?? {};
  const urls = [];
  const push = (v) => { if (typeof v === 'string') urls.push(v); };
  if (Array.isArray(o.model_urls)) o.model_urls.forEach((u) => push(typeof u === 'string' ? u : u?.url));
  else if (o.model_urls && typeof o.model_urls === 'object') Object.values(o.model_urls).forEach(push);
  push(o.pbr_model); push(o.model_url); push(o.model);
  return [...new Set(urls)];
}

export async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

let ioPromise;
async function getIO() {
  ioPromise ??= (async () => {
    await Promise.all([MeshoptEncoder.ready, MeshoptSimplifier.ready, MeshoptDecoder.ready]);
    return new NodeIO()
      .registerExtensions(KHRONOS_EXTENSIONS)
      .registerExtensions([EXTMeshoptCompression])
      .registerDependencies({
        'meshopt.decoder': MeshoptDecoder,
        'meshopt.encoder': MeshoptEncoder,
      });
  })();
  return ioPromise;
}

/**
 * Mobile compression: weld -> simplify(0.75) -> meshopt(medium).
 * `animationOnly` strips meshes (keeps skeleton + clips) for retarget clip files.
 */
export async function compressGlb(buffer, outPath, { animationOnly = false } = {}) {
  const io = await getIO();
  const document = await io.readBinary(buffer);
  if (animationOnly) {
    document.getRoot().listMeshes().forEach((m) => m.dispose());
    await document.transform(prune());
  } else {
    await document.transform(
      weld(),
      simplify({ simplifier: MeshoptSimplifier, ratio: 0.75, error: 0.001 }),
      meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
    );
  }
  const out = await io.writeBinary(document);
  mkdirSync(dirname(outPath), { recursive: true });
  await writeFile(outPath, out);
  return out.byteLength;
}
