#!/usr/bin/env node
// Image -> 3D mesh with fal's Trellis (fal-ai/trellis, ~$0.02 per generation).
//
// usage: node scripts/fal-trellis.mjs <image.png|jpg|https-url> <name> [--out file.glb] [--texture 512|1024|2048]
//                                      [--seed N] [--compress] [--dry-run]
//
//   default output   mixamo/generated/<name>.glb  (raw, ready for Mixamo / further cleanup)
//   --compress       weld + simplify + meshopt for the game (use with --out public/assets/env/<name>.glb)
//   --dry-run        validate the input and show what would be sent, without a billable request
//
// FAL_KEY comes from .env (git-ignored) or the environment. It never leaves this server-side script.
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

// Node's fetch ignores proxy variables unless told otherwise (needed in sandboxed/cloud shells).
if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY && !process.env.FAL_REEXEC) {
  const r = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1', FAL_REEXEC: '1' } });
  process.exit(r.status ?? 1);
}

const { fal } = await import('@fal-ai/client');
const { ROOT, loadEnv, download, compressGlb } = await import('./lib/pipeline.mjs');
loadEnv();

const ENDPOINT = 'fal-ai/trellis';
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const bool = (n) => { const i = args.indexOf(n); if (i < 0) return false; args.splice(i, 1); return true; };
const outArg = flag('--out'), texture = flag('--texture') ?? '1024', seed = flag('--seed');
const compress = bool('--compress'), dry = bool('--dry-run');
const [src, name] = args;
if (!src || !name || !['512', '1024', '2048'].includes(texture)) {
  console.error('usage: node scripts/fal-trellis.mjs <image|url> <name> [--out file.glb] [--texture 512|1024|2048] [--seed N] [--compress] [--dry-run]');
  process.exit(1);
}
const outPath = resolve(ROOT, outArg ?? `mixamo/generated/${name}.glb`);

const isUrl = /^https:\/\//.test(src);
if (!isUrl && !existsSync(src)) { console.error(`image not found: ${src}`); process.exit(1); }
const input = { texture_size: Number(texture), ...(seed !== undefined ? { seed: Number(seed) } : {}) };

if (dry) {
  console.log(`[dry-run] ${ENDPOINT} (~$0.02)\n  image: ${src}\n  input: ${JSON.stringify(input)}\n  output: ${outPath}${compress ? ' (compressed)' : ''}\n  FAL_KEY: ${process.env.FAL_KEY ? 'present' : 'ABSENT'}`);
  process.exit(0);
}
if (!process.env.FAL_KEY) { console.error('FAL_KEY is not set (put it in .env or the environment). Nothing generated.'); process.exit(1); }
fal.config({ credentials: process.env.FAL_KEY });

try {
  let imageUrl = src;
  if (!isUrl) {
    const ext = src.toLowerCase().split('.').pop();
    const type = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
    // inline data URI: no separate storage-upload host needed (fal accepts base64 data URIs for file inputs)
    imageUrl = `data:${type};base64,${readFileSync(src).toString('base64')}`;
    console.log(`[${name}] sending ${basename(src)} inline`);
  }
  // One submit = one billable job. Never retried automatically: on an unclear result, check the request id first.
  const { request_id } = await fal.queue.submit(ENDPOINT, { input: { image_url: imageUrl, ...input } });
  console.log(`[${name}] queued request ${request_id}`);
  let last = '';
  await fal.queue.subscribeToStatus(ENDPOINT, { requestId: request_id, logs: false, onQueueUpdate: (u) => { if (u.status !== last) { last = u.status; console.log(`[${name}] ${u.status}`); } } });
  const { data } = await fal.queue.result(ENDPOINT, { requestId: request_id });
  const url = data?.model_mesh?.url;
  if (!url) throw new Error(`no model_mesh.url in result (request ${request_id})`);
  if (!new URL(url).hostname.endsWith('fal.media') && !new URL(url).hostname.endsWith('fal.run') && !new URL(url).hostname.endsWith('fal.ai')) throw new Error(`unexpected result host ${new URL(url).hostname}`);
  const raw = await download(url);
  mkdirSync(dirname(outPath), { recursive: true });
  if (compress) {
    const size = await compressGlb(raw, outPath);
    console.log(`[${name}] wrote ${outPath} (${(size / 1024).toFixed(0)} KB, compressed)`);
  } else {
    await writeFile(outPath, raw);
    console.log(`[${name}] wrote ${outPath} (${(raw.byteLength / 1024).toFixed(0)} KB, raw)`);
  }
} catch (err) {
  const status = err?.status ?? err?.response?.status;
  const body = typeof err?.body === 'object' ? JSON.stringify(err.body) : String(err?.body ?? err?.message ?? err);
  if (status === 403) console.error(`fal refused the request (403): ${body.slice(0, 300)}\nIf it says the balance is exhausted, add credits at https://fal.ai/dashboard/usage-billing/credits`);
  else console.error(`failed: ${body.slice(0, 400)}`);
  process.exit(1);
}
