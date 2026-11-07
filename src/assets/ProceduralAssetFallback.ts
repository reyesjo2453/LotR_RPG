import * as THREE from 'three';
import { createToonMaterial } from '../shaders/ToonRealm';

export type CharacterId = 'vaelen' | 'seraphina' | 'kaelen' | 'castellan_knight' | 'barrow_hound';
export type EnvPropId = 'pillar_elven' | 'wall_segment' | 'brazier_iron' | 'runestone_monolith' | 'bridge_broken' | 'archway_gate' | 'wall_corner' | 'wall_alcove' | 'floor_edge';
export type OneShot = 'slash' | 'hit' | 'combo' | 'stab' | 'dodge' | 'swing1' | 'swing2' | 'swing3' | 'swing4';

/** Unified animation controller: procedural rigs and GLB mixers both implement this. */
export interface Animator {
  readonly root: THREE.Group;
  readonly height: number;
  setMoveSpeed(v: number): void;
  play(state: OneShot, duration?: number): void;
  update(dt: number): void;
  /** World-space [base, tip] of each weapon blade (for the swing trail); only rigs with weapon nodes implement it. */
  blades?(): Array<[THREE.Vector3, THREE.Vector3]>;
}

const matCache = new Map<string, THREE.MeshLambertMaterial>();
function mat(color: number, glow = 0, rim = 1): THREE.MeshLambertMaterial {
  const key = `${color}|${glow}|${rim}`;
  let m = matCache.get(key);
  if (!m) {
    m = createToonMaterial({ color, rim, emissive: glow ? color : 0x000000, emissiveIntensity: glow });
    matCache.set(key, m);
  }
  return m;
}

type Geo = THREE.BufferGeometry;
function add(parent: THREE.Object3D, geo: Geo, m: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, m);
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}
const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const cyl = (rt: number, rb: number, h: number, s = 8) => new THREE.CylinderGeometry(rt, rb, h, s);
const sph = (r: number, s = 10) => new THREE.SphereGeometry(r, s, Math.max(6, s - 2));
const cone = (r: number, h: number, s = 6) => new THREE.ConeGeometry(r, h, s);
const grp = (parent: THREE.Object3D, x = 0, y = 0, z = 0) => { const g = new THREE.Group(); g.position.set(x, y, z); parent.add(g); return g; };

// ───────────────────────────── Rigs ─────────────────────────────

interface Rig {
  root: THREE.Group;
  kind: 'biped' | 'quad';
  height: number;
  parts: Record<string, THREE.Object3D>;
  tick?: (t: number, dt: number) => void;
}

interface HumanoidCfg {
  h: number; bulk: number; skin: number; cloth: number; armor: number; trim: number; glow: number; robe?: boolean; shoulders?: number;
}

function humanoid(c: HumanoidCfg): Rig {
  const root = new THREE.Group();
  const parts: Record<string, THREE.Object3D> = {};
  const b = c.bulk;
  const legL = grp(root, -0.15 * b, 0.85), legR = grp(root, 0.15 * b, 0.85);
  for (const leg of [legL, legR]) {
    if (!c.robe) {
      add(leg, box(0.2 * b, 0.8, 0.22 * b), mat(c.cloth), 0, -0.4, 0);
      add(leg, box(0.24 * b, 0.12, 0.34 * b), mat(c.armor), 0, -0.82, 0.04);
      add(leg, box(0.24 * b, 0.2, 0.26 * b), mat(c.armor), 0, -0.1, 0.01);
    } else {
      add(leg, box(0.16, 0.8, 0.18), mat(c.cloth), 0, -0.4, 0);
      add(leg, box(0.2, 0.1, 0.3), mat(c.armor), 0, -0.82, 0.04);
    }
  }
  const torso = grp(root, 0, 0.85);
  add(torso, box(0.58 * b, 0.62, 0.34 * b), mat(c.armor), 0, 0.38, 0);
  add(torso, box(0.5 * b, 0.2, 0.3 * b), mat(c.cloth), 0, 0.0, 0);                    // waist
  add(torso, box(0.18, 0.5, 0.02), mat(c.glow, 1.2, 0.4), 0, 0.4, 0.18 * b);            // chest glow strip
  if (c.robe) add(torso, cone(0.55, 1.0, 10), mat(c.cloth), 0, -0.3, 0).scale.set(1, 1, 0.8);
  const head = grp(torso, 0, 0.9);
  add(head, sph(0.19), mat(c.skin));
  add(head, box(0.1, 0.03, 0.02), mat(c.glow, 2.0, 0), 0, 0.02, 0.18);                  // glowing eye slit
  const shoulderY = 0.62, sx = 0.4 * b + 0.02;
  const armL = grp(torso, -sx, shoulderY), armR = grp(torso, sx, shoulderY);
  for (const arm of [armL, armR]) {
    add(arm, box(0.15 * b, 0.62, 0.16 * b), mat(c.cloth), 0, -0.3, 0);
    add(arm, box(0.19 * b, 0.26, 0.2 * b), mat(c.armor), 0, -0.1, 0);
    add(arm, sph(0.1), mat(c.skin), 0, -0.66, 0);
    add(arm, sph((c.shoulders ?? 0.14) * b + 0.05, 7), mat(c.armor), 0, 0.04, 0);        // pauldron
  }
  const handL = grp(armL, 0, -0.66), handR = grp(armR, 0, -0.66);
  Object.assign(parts, { torso, head, armL, armR, legL, legR, handL, handR });
  root.scale.setScalar(c.h / 1.85);
  return { root, kind: 'biped', height: c.h, parts };
}

const crescent = (r: number, arc: number, color: number, glow: number): THREE.Mesh =>
  new THREE.Mesh(new THREE.TorusGeometry(r, 0.035, 5, 14, arc), mat(color, glow, 0.6));

function buildVaelen(): Rig {
  const r = humanoid({ h: 1.9, bulk: 0.85, skin: 0xd9c3a8, cloth: 0x1b1b26, armor: 0xb7c2d4, trim: 0x40e0ff, glow: 0x40e0ff });
  for (const [hand, s] of [[r.parts.handL, -1], [r.parts.handR, 1]] as const) {
    const blade = crescent(0.5, Math.PI * 0.75, 0xcfeeff, 1.3);
    blade.position.set(0, -0.1, 0.3); blade.rotation.set(0, s * 0.3, Math.PI * 0.6 * s - 0.2);
    hand.add(blade);
    add(hand, cyl(0.025, 0.025, 0.28, 5), mat(0x1a1a24), 0, -0.04, 0.04).rotation.x = Math.PI / 2;
  }
  add(r.parts.head, cone(0.12, 0.38, 5), mat(0xb7c2d4), 0, 0.28, -0.04);                 // circlet crest
  add(r.parts.head, box(0.07, 0.4, 0.07), mat(0xe9eef5), 0, -0.08, -0.2).rotation.x = 0.35; // silver hair
  const cape = add(r.parts.torso, box(0.5, 0.95, 0.04), mat(0x20222e), 0, 0.12, -0.22);
  cape.rotation.x = 0.12;
  return r;
}

function buildSeraphina(): Rig {
  const r = humanoid({ h: 1.8, bulk: 0.8, skin: 0xe2cdb8, cloth: 0x4a2a8c, armor: 0x2f1b60, trim: 0x39e6a0, glow: 0x39e6a0, robe: true });
  add(r.parts.head, cone(0.27, 0.46, 8), mat(0x35206e), 0, 0.12, -0.04);                 // hood
  add(r.parts.head, sph(0.22, 8), mat(0x35206e), 0, 0.02, -0.05).scale.set(1, 1, 0.9);
  const staff = grp(r.parts.handR, 0, 0, 0.05);
  add(staff, cyl(0.025, 0.025, 2.0, 5), mat(0x6b5a3a), 0, 0.15, 0);
  add(staff, sph(0.11, 8), mat(0x39e6a0, 1.8, 0.4), 0, 1.2, 0);
  add(staff, new THREE.TorusGeometry(0.17, 0.02, 4, 10), mat(0xb99cff, 1.4, 0.3), 0, 1.2, 0);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.03, 5, 28), mat(0xb36bff, 1.6, 0.2));
  const ring2 = new THREE.Mesh(new THREE.TorusGeometry(0.72, 0.02, 4, 28), mat(0x39e6a0, 1.6, 0.2));
  const runes = new THREE.Group();
  for (let i = 0; i < 6; i++) { const q = add(runes, box(0.08, 0.12, 0.02), mat(0xdab8ff, 2, 0)); const a = (i / 6) * Math.PI * 2; q.position.set(Math.cos(a) * 0.67, Math.sin(a) * 0.67, 0); q.rotation.z = a; }
  const halo = new THREE.Group(); halo.position.set(0, 1.0, -0.35); halo.add(ring, ring2, runes); r.root.add(halo);
  r.parts.halo = halo;
  r.tick = (t) => { ring.rotation.z = t * 0.8; ring2.rotation.z = -t * 1.1; runes.rotation.z = t * 0.8; halo.position.y = 1.0 + Math.sin(t * 2) * 0.05; halo.rotation.y = Math.sin(t * 0.7) * 0.3; };
  return r;
}

function buildKaelen(): Rig {
  const r = humanoid({ h: 1.55, bulk: 1.45, skin: 0xcba583, cloth: 0x3a2a1a, armor: 0xd2a63a, trim: 0x3ad7ff, glow: 0x3ad7ff, shoulders: 0.2 });
  add(r.parts.head, sph(0.22, 8), mat(0x8e8f98), 0, 0.06, 0).scale.set(1, 0.7, 1);       // helm
  add(r.parts.head, box(0.3, 0.3, 0.1), mat(0xa05a1a), 0, -0.16, 0.14);                    // beard
  for (const s of [-1, 1]) add(r.parts.head, cone(0.05, 0.22, 4), mat(0xd2a63a), s * 0.22, 0.14, 0).rotation.z = -s * 0.7;
  const hammer = grp(r.parts.handR, 0, 0, 0.1);
  add(hammer, cyl(0.04, 0.04, 1.25, 6), mat(0x5a4328), 0, 0.25, 0);
  add(hammer, box(0.55, 0.34, 0.34), mat(0x6b6d78), 0, 0.9, 0);
  add(hammer, box(0.57, 0.08, 0.36), mat(0xd2a63a), 0, 0.9, 0);
  add(hammer, box(0.1, 0.2, 0.02), mat(0x3ad7ff, 1.6, 0), 0, 0.9, 0.18);
  hammer.rotation.x = -0.6;
  const shield = add(r.parts.armL, box(0.14, 0.95, 0.55), mat(0x70727c), -0.18, -0.45, 0.08);
  add(shield, box(0.16, 0.25, 0.25), mat(0xd2a63a), -0.02, 0.1, 0);
  add(shield, box(0.16, 0.12, 0.06), mat(0x3ad7ff, 1.4, 0), -0.03, -0.1, 0.0);
  r.parts.shield = shield;
  return r;
}

function buildKnight(): Rig {
  const r = humanoid({ h: 2.7, bulk: 1.15, skin: 0x15131a, cloth: 0x15161c, armor: 0x2b2d36, trim: 0xe02040, glow: 0xff2850, shoulders: 0.22 });
  add(r.parts.head, box(0.4, 0.46, 0.4), mat(0x2b2d36), 0, 0.03, 0);
  for (const s of [-1, 1]) {
    const horn = add(r.parts.head, cone(0.07, 0.62, 5), mat(0xa9a5b4), s * 0.22, 0.34, 0);
    horn.rotation.z = -s * 0.55;
    const spike = add(r.parts.torso, cone(0.07, 0.4, 5), mat(0x3a3d4a), s * 0.55, 0.9, 0); spike.rotation.z = -s * 0.5;
    add(r.parts.armR, cone(0.05, 0.3, 4), mat(0x3a3d4a), s * 0.0, 0.0, s * 0.14).rotation.x = s * 1.2;
  }
  const blade = grp(r.parts.handR, 0, 0, 0.12);
  add(blade, box(0.07, 1.9, 0.02), mat(0x7a1030, 1.1, 0.3), 0, 1.0, 0);
  add(blade, box(0.1, 0.04, 0.03), mat(0xff2850, 2.2, 0), 0, 1.0, 0.0).scale.set(1, 38, 1);
  add(blade, box(0.5, 0.07, 0.07), mat(0x2b2d36), 0, 0.12, 0);
  blade.rotation.x = -0.4;
  const cape = add(r.parts.torso, box(0.8, 1.3, 0.05), mat(0x15101c), 0, 0.0, -0.25); cape.rotation.x = 0.1;
  return r;
}

function buildHound(): Rig {
  const root = new THREE.Group();
  const parts: Record<string, THREE.Object3D> = {};
  const body = grp(root, 0, 0.55);
  add(body, sph(0.36, 10), mat(0x14121c, 0, 1.4), 0, 0, 0).scale.set(0.8, 0.85, 1.7);
  for (let i = 0; i < 6; i++) add(body, cone(0.07, 0.3, 4), mat(0x52408a, 0.5, 0.5), 0, 0.3 - Math.abs(i - 2.5) * 0.02, -0.5 + i * 0.2);
  const head = grp(body, 0, 0.12, 0.62);
  add(head, box(0.3, 0.26, 0.3), mat(0x1c1828), 0, 0, 0);
  const jaw = add(head, box(0.22, 0.09, 0.3), mat(0x1c1828), 0, -0.11, 0.14);
  add(head, box(0.2, 0.14, 0.3), mat(0x14121c), 0, -0.01, 0.2);
  for (const s of [-1, 1]) {
    add(head, box(0.06, 0.04, 0.03), mat(0x39ff9c, 2.4, 0), s * 0.09, 0.06, 0.15);
    add(head, cone(0.05, 0.2, 4), mat(0x14121c), s * 0.1, 0.2, -0.05);
  }
  const tail = grp(body, 0, 0.1, -0.6); add(tail, cone(0.06, 0.6, 5), mat(0x14121c), 0, 0, -0.28).rotation.x = -Math.PI / 2 - 0.4;
  const mkLeg = (x: number, z: number) => { const l = grp(body, x, -0.1, z); add(l, box(0.1, 0.5, 0.12), mat(0x14121c), 0, -0.25, 0); add(l, box(0.12, 0.06, 0.18), mat(0x2a2440), 0, -0.5, 0.03); return l; };
  Object.assign(parts, { body, head, jaw, tail, legFL: mkLeg(-0.2, 0.42), legFR: mkLeg(0.2, 0.42), legBL: mkLeg(-0.2, -0.42), legBR: mkLeg(0.2, -0.42) });
  return { root, kind: 'quad', height: 1.05, parts };
}

export function buildCharacterRig(id: CharacterId): Rig {
  switch (id) {
    case 'vaelen': return buildVaelen();
    case 'seraphina': return buildSeraphina();
    case 'kaelen': return buildKaelen();
    case 'castellan_knight': return buildKnight();
    case 'barrow_hound': return buildHound();
  }
}

// ───────────────────────────── Procedural animation ─────────────────────────────

const ease = (u: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, u)), 3);
type Pose = Record<string, [number, number, number]>;

export class ProceduralAnimator implements Animator {
  readonly root: THREE.Group;
  readonly height: number;
  private rig: Rig;
  private t = Math.random() * 10;
  private phase = 0;
  private speed = 0;
  private shot: { state: OneShot; time: number; dur: number } | null = null;
  private punch = 0;
  private base = new Map<THREE.Object3D, number>();

  constructor(id: CharacterId) {
    this.rig = buildCharacterRig(id);
    this.root = new THREE.Group();
    this.root.add(this.rig.root);
    this.height = this.rig.height;
    for (const [k, p] of Object.entries(this.rig.parts)) if (k === 'torso' || k === 'body') this.base.set(p, p.position.y);
  }

  setMoveSpeed(v: number): void { this.speed = v; }

  play(state: OneShot, duration = state === 'slash' ? 0.35 : 0.3): void {
    if (state === 'dodge') return; // no procedural dodge pose
    if (state === 'combo' || state === 'stab' || state.startsWith('swing')) state = 'slash';
    this.shot = { state, time: 0, dur: duration };
    if (state === 'hit') this.punch = 1;
  }

  update(dt: number): void {
    this.t += dt;
    this.rig.tick?.(this.t, dt);
    const sp = Math.min(1, this.speed / 6);
    this.phase += dt * (5 + sp * 6) * (sp > 0.05 ? 1 : 0);
    let pose: Pose = {};
    let fast = 14;
    if (this.shot) {
      this.shot.time += dt;
      const u = this.shot.time / this.shot.dur;
      if (u >= 1) this.shot = null;
      else { pose = this.shotPose(this.shot.state, u); fast = 34; }
    }
    if (!this.shot) pose = this.locomotionPose(sp);
    const k = 1 - Math.exp(-dt * fast);
    for (const [name, [x, y, z]] of Object.entries(pose)) {
      const p = this.rig.parts[name];
      if (!p) continue;
      p.rotation.x += (x - p.rotation.x) * k;
      p.rotation.y += (y - p.rotation.y) * k;
      p.rotation.z += (z - p.rotation.z) * k;
    }
    this.punch = Math.max(0, this.punch - dt * 6);
    const s = 1 + this.punch * 0.12;
    this.rig.root.scale.y = (this.rig.root.scale.x) * s * (1 - this.punch * 0.05);
  }

  private locomotionPose(sp: number): Pose {
    const b = Math.sin(this.t * 2.2), ph = this.phase, sw = Math.sin(ph) * sp;
    if (this.rig.kind === 'quad') {
      const body = this.rig.parts.body, head = this.rig.parts.head;
      body.position.y = (this.base.get(body) ?? 0.55) + Math.abs(Math.sin(ph)) * 0.1 * sp + b * 0.012;
      head.position.z = 0.62;
      return {
        legFL: [sw * 0.9, 0, 0], legBR: [sw * 0.9, 0, 0], legFR: [-sw * 0.9, 0, 0], legBL: [-sw * 0.9, 0, 0],
        head: [0.1 * sp + Math.sin(this.t * 1.3) * 0.05, Math.sin(this.t * 0.9) * 0.15, 0],
        tail: [0.2, Math.sin(this.t * 3) * 0.5, 0], jaw: [0.05 + Math.max(0, Math.sin(this.t * 0.8)) * 0.1, 0, 0], body: [0, 0, 0],
      };
    }
    const torso = this.rig.parts.torso;
    torso.position.y = (this.base.get(torso) ?? 0.85) + Math.abs(Math.sin(ph)) * 0.07 * sp;
    torso.scale.y = 1 + 0.02 * b * (1 - sp);
    return {
      legL: [sw * 0.95, 0, 0], legR: [-sw * 0.95, 0, 0],
      armL: [-sw * 0.8 + 0.05 * b, 0, 0.1], armR: [sw * 0.8 - 0.05 * b, 0, -0.1],
      torso: [0.2 * sp, Math.sin(ph) * 0.12 * sp, 0], head: [-0.05, Math.sin(this.t * 0.7) * 0.1 * (1 - sp), 0],
    };
  }

  private shotPose(state: OneShot, u: number): Pose {
    const e = ease(u);
    if (this.rig.kind === 'quad') {
      if (state === 'slash') { const l = Math.sin(Math.min(1, u * 1.2) * Math.PI); return { body: [0.4 * l, 0, 0], head: [-0.5 * l, 0, 0], jaw: [0.9 * l, 0, 0], legFL: [-1.0 * l, 0, 0], legFR: [-1.0 * l, 0, 0], legBL: [0.6 * l, 0, 0], legBR: [0.6 * l, 0, 0], tail: [0.5, 0, 0] }; }
      const h = 1 - u; return { body: [-0.45 * h, 0, 0.2 * h], head: [0.6 * h, 0, 0], jaw: [0.6 * h, 0, 0], tail: [0.8, 0, 0], legFL: [0.4 * h, 0, 0], legFR: [0.4 * h, 0, 0], legBL: [-0.3 * h, 0, 0], legBR: [-0.3 * h, 0, 0] };
    }
    if (state === 'slash') {
      return {
        armR: [-2.7 + 3.0 * e, 0, -0.3], armL: [-1.7 + 1.8 * e, 0, 0.3], torso: [0.1, 0.9 - 1.7 * e, 0], head: [0, -0.3 + 0.6 * e, 0],
        legL: [0.5 - 0.3 * e, 0, 0], legR: [-0.6 + 0.3 * e, 0, 0],
      };
    }
    const h = 1 - u;
    return { torso: [-0.55 * h, 0, 0.15 * h], head: [0.5 * h, 0, 0], armL: [0.8 * h, 0, 0.6 * h], armR: [0.8 * h, 0, -0.6 * h], legL: [0.3 * h, 0, 0], legR: [-0.3 * h, 0, 0] };
  }
}

// ───────────────────────────── Environment props ─────────────────────────────

const STONE = 0x4a4654, DARK = 0x1a1822, OBSIDIAN = 0x14121c, SILVER = 0xb9c4d6, IRON = 0x34353e;

export function buildEnvProp(id: EnvPropId): THREE.Group {
  const g = new THREE.Group();
  switch (id) {
    case 'pillar_elven': {
      add(g, box(1.0, 0.25, 1.0), mat(STONE), 0, 0.125, 0);
      add(g, cyl(0.32, 0.4, 3.0, 8), mat(0x5a5566), 0, 1.75, 0);
      add(g, cyl(0.42, 0.34, 0.22, 8), mat(STONE), 0, 3.35, 0);
      add(g, box(1.0, 0.2, 1.0), mat(STONE), 0, 3.55, 0);
      for (const y of [0.9, 1.7, 2.5]) add(g, new THREE.TorusGeometry(0.37, 0.02, 4, 16), mat(SILVER, 0.5, 0.8), 0, y, 0).rotation.x = Math.PI / 2;
      add(g, box(0.05, 2.4, 0.03), mat(SILVER, 0.4), 0.33, 1.8, 0.1);
      add(g, box(0.18, 0.5, 0.2), mat(DARK), -0.3, 2.9, 0.2).rotation.z = 0.5;   // crack
      return g;
    }
    case 'wall_corner':
    case 'wall_alcove':
    case 'floor_edge':
    case 'wall_segment': {
      add(g, box(2.5, 2.0, 2.5), mat(OBSIDIAN), 0, 1.0, 0);
      add(g, box(2.58, 0.18, 2.58), mat(0x2b2838), 0, 2.05, 0);
      add(g, box(2.58, 0.25, 2.58), mat(0x2b2838), 0, 0.12, 0);
      for (const x of [-0.7, 0.7]) { add(g, box(0.7, 1.1, 0.12), mat(0x07060b), x, 0.85, 1.27); add(g, cyl(0.35, 0.35, 0.12, 8, ), mat(0x07060b), x, 1.4, 1.27).rotation.x = Math.PI / 2; }
      return g;
    }
    case 'brazier_iron': {
      for (let i = 0; i < 3; i++) { const a = (i / 3) * Math.PI * 2; const l = add(g, cyl(0.04, 0.05, 1.0, 5), mat(IRON), Math.cos(a) * 0.2, 0.5, Math.sin(a) * 0.2); l.rotation.set(Math.sin(a) * 0.18, 0, -Math.cos(a) * 0.18); }
      add(g, new THREE.SphereGeometry(0.42, 12, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), mat(IRON, 0, 1.2), 0, 1.15, 0).scale.set(1, 0.8, 1);
      add(g, new THREE.TorusGeometry(0.42, 0.04, 5, 16), mat(0x22232a), 0, 1.15, 0).rotation.x = Math.PI / 2;
      add(g, new THREE.TorusGeometry(0.36, 0.015, 4, 12), mat(0xff9a3a, 1.3, 0), 0, 0.98, 0).rotation.x = Math.PI / 2;
      add(g, sph(0.3, 6), mat(0xff6a1a, 1.5, 0), 0, 1.15, 0).scale.set(1, 0.4, 1);
      return g;
    }
    case 'runestone_monolith': {
      add(g, cyl(0.7, 0.8, 0.18, 6), mat(0x2b2838), 0, 0.09, 0);
      add(g, cyl(0.28, 0.5, 2.8, 5), mat(OBSIDIAN, 0, 1.4), 0, 1.5, 0);
      add(g, cone(0.28, 0.5, 5), mat(OBSIDIAN, 0, 1.4), 0, 3.15, 0);
      for (const [y, w] of [[0.9, 0.12], [1.45, 0.2], [2.0, 0.14], [2.5, 0.1]] as const) add(g, box(w, 0.28, 0.03), mat(0x6bffc4, 2.2, 0), 0, y, 0.42 - y * 0.06);
      for (const s of [-1, 1]) add(g, cone(0.12, 0.4, 4), mat(0x8a5cff, 1.4, 0), s * 0.55, 1.6 + s * 0.2, 0.1);
      return g;
    }
    case 'bridge_broken': {
      add(g, box(2.5, 0.3, 2.5), mat(0x585468), 0, -0.15, 0);
      add(g, box(2.5, 0.06, 0.1), mat(SILVER, 0.7, 0), 0, 0.02, 1.15);
      add(g, box(2.5, 0.06, 0.1), mat(SILVER, 0.7, 0), 0, 0.02, -1.15);
      add(g, box(0.5, 0.1, 0.5), mat(0x3a3646), 0.6, 0.0, 0.3).rotation.y = 0.5;
      add(g, box(0.9, 0.04, 0.06), mat(DARK), -0.3, 0.02, 0.1).rotation.y = 0.4;
      return g;
    }
    case 'archway_gate': {
      for (const s of [-1, 1]) { add(g, box(0.7, 3.4, 0.8), mat(STONE), s * 1.6, 1.7, 0); add(g, box(0.9, 0.3, 1.0), mat(0x2b2838), s * 1.6, 0.15, 0); }
      add(g, new THREE.TorusGeometry(1.6, 0.4, 6, 14, Math.PI), mat(STONE), 0, 3.4, 0).scale.set(1, 1, 1.9);
      add(g, box(0.5, 0.6, 0.9), mat(SILVER, 0.3), 0, 5.1, 0);
      return g;
    }
  }
}
