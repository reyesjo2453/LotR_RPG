import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshoptDecoder } from 'meshoptimizer';
import {
  type Animator, type CharacterId, type EnvPropId, type OneShot,
  ProceduralAnimator, buildEnvProp,
} from './ProceduralAssetFallback';
import { toonifyObject } from '../shaders/ToonRealm';

const CHARACTERS: CharacterId[] = ['vaelen', 'seraphina', 'kaelen', 'castellan_knight', 'barrow_hound'];
const ENV: EnvPropId[] = ['pillar_elven', 'wall_segment', 'brazier_iron', 'runestone_monolith', 'bridge_broken', 'archway_gate'];
const CLIP_SUFFIXES = ['idle', 'run', 'slash', 'hit'] as const;
const TARGET_HEIGHT: Record<CharacterId, number> = { vaelen: 1.9, seraphina: 1.8, kaelen: 1.55, castellan_knight: 2.7, barrow_hound: 1.05 };

interface CharacterAsset { scene: THREE.Group; clips: Record<string, THREE.AnimationClip> }

/** Merge every mesh of a prop into one vertex-coloured geometry so it can be drawn as a single InstancedMesh. */
export function mergeToGeometry(group: THREE.Object3D): THREE.BufferGeometry {
  group.updateMatrixWorld(true);
  const parts: THREE.BufferGeometry[] = [];
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    let g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    g.applyMatrix4(m.matrixWorld);
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'color') g.deleteAttribute(k);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    if (!g.getAttribute('color')) {
      const src = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshLambertMaterial;
      const c = (src.color ? src.color.clone() : new THREE.Color(1, 1, 1));
      if (src.emissive && src.emissive.getHex() !== 0) c.add(src.emissive.clone().multiplyScalar(src.emissiveIntensity));
      const n = g.getAttribute('position').count, arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    }
    parts.push(g);
  });
  const merged = mergeGeometries(parts, false);
  if (!merged) throw new Error('mergeToGeometry: nothing to merge');
  return merged;
}

class MixerAnimator implements Animator {
  readonly root = new THREE.Group();
  readonly height: number;
  private mixer: THREE.AnimationMixer;
  private actions: Partial<Record<'idle' | 'run' | OneShot, THREE.AnimationAction>> = {};
  private current: THREE.AnimationAction | null = null;
  private shotTime = 0;
  private speed = 0;

  constructor(asset: CharacterAsset, id: CharacterId) {
    const model = cloneSkinned(asset.scene) as THREE.Group;
    toonifyObject(model, 0.45);
    model.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) o.frustumCulled = false;
      // closed fists around the grips (the Mixamo clips animate open hands), held blades angled out of the fist
      const f = /Hand(Thumb|Index|Middle|Ring|Pinky)\d$/.exec(o.name);
      if (f) o.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), f[1] === 'Thumb' ? 0 : 1.05));
      const w = /^sword_(Left|Right)Hand$/.exec(o.name);
      if (w) { o.position.set(0, 0.03, 0); o.quaternion.setFromEuler(new THREE.Euler(0, 0, (w[1] === 'Left' ? 1 : -1) * 40 * Math.PI / 180)); }
    });
    this.root.add(model);
    this.height = TARGET_HEIGHT[id];
    this.mixer = new THREE.AnimationMixer(model);
    for (const [name, srcClip] of Object.entries(asset.clips)) {
      // rotation-only: clip translations come from a differently-scaled skeleton and would collapse the rig into the floor
      const clip = srcClip.clone();
      clip.tracks = clip.tracks.filter((tr) => !/\.(position|scale)$/.test(tr.name) && !/Hand(Thumb|Index|Middle|Ring|Pinky)\d\./.test(tr.name));
      const a = this.mixer.clipAction(clip);
      if (name === 'idle' || name === 'run') a.setLoop(THREE.LoopRepeat, Infinity);
      else { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
      this.actions[name as 'idle'] = a;
    }
    this.fadeTo(this.actions.idle ?? null);
    // fit using the posed (idle) skeleton, not the bind pose, so the feet sit on the ground
    this.mixer.update(0);
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model, true);
    const h = Math.max(1e-6, box.max.y - box.min.y);
    const s = TARGET_HEIGHT[id] / h;
    model.scale.multiplyScalar(s);
    model.position.y -= box.min.y * s;
    model.position.x -= (box.min.x + box.max.x) / 2 * s;
    model.position.z -= (box.min.z + box.max.z) / 2 * s;
  }

  private fadeTo(a: THREE.AnimationAction | null, t = 0.12): void {
    if (!a || a === this.current) return;
    a.reset().fadeIn(t).play();
    this.current?.fadeOut(t);
    this.current = a;
  }
  setMoveSpeed(v: number): void { this.speed = v; }
  play(state: OneShot, duration?: number): void {
    const a = this.actions[state];
    if (!a) return;
    this.shotTime = duration ?? a.getClip().duration;
    a.setEffectiveTimeScale(a.getClip().duration / this.shotTime);
    if (a === this.current) a.reset().play(); // retrigger (combo) instead of staying clamped at the end
    else this.fadeTo(a, 0.05);
  }
  update(dt: number): void {
    this.mixer.update(dt);
    if (this.shotTime > 0) { this.shotTime -= dt; if (this.shotTime > 0) return; }
    this.fadeTo((this.speed > 0.5 ? this.actions.run : null) ?? this.actions.idle ?? null);
  }
}

/** Rigless imported mesh (e.g. image-to-3D output): animated with whole-body procedural motion. */
class StaticModelAnimator implements Animator {
  readonly root = new THREE.Group();
  readonly height: number;
  private body = new THREE.Group();
  private t = Math.random() * 10;
  private phase = 0;
  private speed = 0;
  private shot: { state: OneShot; time: number; dur: number } | null = null;
  private cur = { rx: 0, ry: 0, rz: 0, y: 0, z: 0, sy: 1 };

  constructor(asset: CharacterAsset, id: CharacterId) {
    const model = cloneSkinned(asset.scene) as THREE.Group;
    toonifyObject(model);
    const box = new THREE.Box3().setFromObject(model);
    const h = Math.max(0.01, box.max.y - box.min.y);
    const s = TARGET_HEIGHT[id] / h;
    model.scale.multiplyScalar(s);
    model.position.set(-(box.min.x + box.max.x) / 2 * s, -box.min.y * s, -(box.min.z + box.max.z) / 2 * s);
    this.body.add(model);
    this.root.add(this.body);
    this.height = TARGET_HEIGHT[id];
  }
  setMoveSpeed(v: number): void { this.speed = v; }
  play(state: OneShot, duration = state === 'slash' ? 0.35 : 0.3): void { this.shot = { state, time: 0, dur: duration }; }

  update(dt: number): void {
    this.t += dt;
    const sp = Math.min(1, this.speed / 6);
    this.phase += dt * (6 + sp * 6) * (sp > 0.05 ? 1 : 0);
    const tgt = { rx: 0, ry: 0, rz: 0, y: 0, z: 0, sy: 1 };
    let fast = 14;
    if (this.shot) {
      this.shot.time += dt;
      const u = this.shot.time / this.shot.dur;
      if (u >= 1) this.shot = null;
      else {
        fast = 36;
        if (this.shot.state === 'slash') {
          // wind-up (0..0.3) then lunge and twist through the target
          if (u < 0.3) { const w = u / 0.3; tgt.rx = -0.22 * w; tgt.ry = 0.7 * w; tgt.z = -0.12 * w; tgt.sy = 1 + 0.03 * w; }
          else { const w = Math.sin(Math.min(1, (u - 0.3) / 0.7) * Math.PI * 0.85); tgt.rx = 0.4 * w; tgt.ry = 0.7 - 1.6 * Math.min(1, (u - 0.3) / 0.35); tgt.z = 0.3 * w; tgt.sy = 1 - 0.04 * w; }
        } else { const h = 1 - u; tgt.rx = -0.4 * h; tgt.rz = 0.15 * h; tgt.z = -0.18 * h; tgt.sy = 1 + 0.08 * h; }
      }
    }
    if (!this.shot) {
      const b = Math.sin(this.t * 2.2), sw = Math.sin(this.phase);
      tgt.y = Math.abs(sw) * 0.12 * sp + b * 0.01 * (1 - sp);
      tgt.rx = 0.2 * sp + 0.015 * b;
      tgt.rz = sw * 0.09 * sp + Math.sin(this.t * 1.1) * 0.015 * (1 - sp);
      tgt.ry = sw * 0.12 * sp + Math.sin(this.t * 0.7) * 0.04 * (1 - sp);
      tgt.sy = 1 + 0.012 * b * (1 - sp) - Math.abs(Math.cos(this.phase)) * 0.03 * sp;
    }
    const k = 1 - Math.exp(-dt * fast), c = this.cur;
    c.rx += (tgt.rx - c.rx) * k; c.ry += (tgt.ry - c.ry) * k; c.rz += (tgt.rz - c.rz) * k;
    c.y += (tgt.y - c.y) * k; c.z += (tgt.z - c.z) * k; c.sy += (tgt.sy - c.sy) * k;
    this.body.rotation.set(c.rx, c.ry, c.rz);
    this.body.position.set(0, c.y, c.z);
    this.body.scale.set(1 / Math.sqrt(c.sy), c.sy, 1 / Math.sqrt(c.sy));
  }
}

class AssetRegistry {
  private loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  private chars = new Map<CharacterId, CharacterAsset>();
  private env = new Map<EnvPropId, THREE.Group>();
  private envGeo = new Map<EnvPropId, THREE.BufferGeometry>();
  /** Which assets were found on disk (everything else is procedural). */
  readonly loaded: string[] = [];

  /** Probe public/assets for .glb files. Missing files are normal: the procedural fallback covers them. */
  async init(): Promise<void> {
    const base = import.meta.env.BASE_URL;
    await Promise.all([
      ...CHARACTERS.map((id) => this.loadCharacter(id, base)),
      ...ENV.map((id) => this.loadEnv(id, base)),
    ]);
  }

  private async fetchGlb(url: string): Promise<GLTF | null> {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      // Vite's SPA fallback answers 200 with index.html for missing files: check the glTF magic.
      if (buf.byteLength < 12 || new TextDecoder().decode(new Uint8Array(buf, 0, 4)) !== 'glTF') return null;
      return await this.loader.parseAsync(buf, '');
    } catch { return null; }
  }

  private nameClips(gltf: GLTF, want: string): THREE.AnimationClip | undefined {
    const lc = want.toLowerCase();
    return gltf.animations.find((c) => c.name.toLowerCase().includes(lc)) ?? (gltf.animations.length === 1 ? gltf.animations[0] : undefined);
  }

  private async loadCharacter(id: CharacterId, base: string): Promise<void> {
    const main = await this.fetchGlb(`${base}assets/models/${id}.glb`);
    if (!main) return;
    const clips: Record<string, THREE.AnimationClip> = {};
    const idle = this.nameClips(main, 'idle'); if (idle) clips.idle = idle;
    await Promise.all(CLIP_SUFFIXES.map(async (s) => {
      const g = await this.fetchGlb(`${base}assets/models/${id}.${s}.glb`);
      const c = g ? this.nameClips(g, s) ?? g.animations[0] : this.nameClips(main, s);
      if (c) clips[s] = c;
    }));
    this.chars.set(id, { scene: main.scene, clips });
    this.loaded.push(`models/${id}.glb`);
  }

  private async loadEnv(id: EnvPropId, base: string): Promise<void> {
    const gltf = await this.fetchGlb(`${base}assets/env/${id}.glb`);
    if (!gltf) return;
    this.env.set(id, gltf.scene);
    this.loaded.push(`env/${id}.glb`);
  }

  /** New animated actor. Uses the .glb + AnimationMixer when present, otherwise the procedural rig. */
  createCharacter(id: CharacterId): Animator {
    const asset = this.chars.get(id);
    if (!asset) return new ProceduralAnimator(id);
    return Object.keys(asset.clips).length ? new MixerAnimator(asset, id) : new StaticModelAnimator(asset, id);
  }

  /** Single merged vertex-coloured geometry for InstancedMesh use (cached). */
  getEnvGeometry(id: EnvPropId): THREE.BufferGeometry {
    let g = this.envGeo.get(id);
    if (!g) {
      const src = this.env.get(id) ?? buildEnvProp(id);
      g = mergeToGeometry(src);
      // normalise imported props to the footprint of the procedural kit
      if (this.env.has(id)) { g.computeBoundingBox(); const bb = g.boundingBox!; g.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2); }
      this.envGeo.set(id, g);
    }
    return g;
  }
}

export const assets = new AssetRegistry();
