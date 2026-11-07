import * as THREE from 'three';
import { assets } from '../assets/AssetRegistry';
import type { EnvPropId } from '../assets/ProceduralAssetFallback';
import { createToonMaterial, sharedUniforms } from '../shaders/ToonRealm';
import { GRID, TILE, TileType, tileToWorld, type Dungeon, type Room, type Vec2 } from './ProceduralDungeonGenerator';
import { realm } from './RealmManager';

const NUM_LIGHTS = 4;
const EMBERS_PER_SLOT = 36;

export interface MonolithRef { pos: Vec2; room: Room; index: number; alive: boolean; hp: number; maxHp: number }

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _e = new THREE.Euler();
function put(mesh: THREE.InstancedMesh, i: number, x: number, y: number, z: number, yaw = 0, sc = 1): void {
  _q.setFromEuler(_e.set(0, yaw, 0));
  mesh.setMatrixAt(i, _m.compose(_p.set(x, y, z), _q, _s.set(sc, sc, sc)));
}
function hash(x: number, y: number): number { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }

/**
 * Renders the whole floor with ~9 draw calls: floor, wall, bridge, pillar, brazier, monolith,
 * gate, portal disc, embers. Torch PointLights are pooled and re-assigned to the nearest braziers.
 */
export class DungeonInstancer {
  readonly group = new THREE.Group();
  readonly monoliths: MonolithRef[] = [];
  readonly braziers: Vec2[] = [];
  readonly lights: THREE.PointLight[] = [];
  private monolithMesh!: THREE.InstancedMesh;
  private bridgeMat: THREE.MeshLambertMaterial;
  private portalMeshes: THREE.Object3D[] = [];
  private embers: THREE.Points;
  private emberCenters: THREE.Vector3[];
  private emberMat: THREE.ShaderMaterial;
  private lightTimer = 0;
  private flickerSeed: number[] = [];
  private owned: Array<{ dispose(): void }> = [];
  drawCalls = 0;

  constructor(readonly dungeon: Dungeon) {
    const d = dungeon;
    const floorTiles: number[] = [], wallTiles: number[] = [], bridgeTiles: number[] = [];
    for (let i = 0; i < d.grid.length; i++) {
      const t = d.grid[i];
      if (t === TileType.FLOOR || t === TileType.PORTAL) floorTiles.push(i);
      else if (t === TileType.WALL) wallTiles.push(i);
      else if (t === TileType.SPECTRAL_BRIDGE) bridgeTiles.push(i);
    }
    const own = <T extends { dispose(): void }>(o: T): T => { this.owned.push(o); return o; };
    const add = (m: THREE.InstancedMesh) => { m.frustumCulled = false; this.group.add(m); this.drawCalls++; return m; };

    // floor slabs
    const floorGeo = own(new THREE.BoxGeometry(TILE, 0.4, TILE).translate(0, -0.2, 0));
    const floorMat = own(createToonMaterial({ color: 0xffffff, veins: 1, rim: 0.4 }));
    const floor = add(new THREE.InstancedMesh(floorGeo, floorMat, floorTiles.length));
    const c = new THREE.Color();
    floorTiles.forEach((idx, n) => {
      const x = idx % GRID, y = (idx / GRID) | 0, h = hash(x, y);
      put(floor, n, tileToWorld(x), 0, tileToWorld(y));
      floor.setColorAt(n, c.setHSL(0.72, 0.12, 0.2 + h * 0.07 + (((x + y) & 1) ? 0.025 : 0)));
    });
    // wall segments
    const wallGeo = own(new THREE.BoxGeometry(TILE, 2.4, TILE).translate(0, 0.8, 0));
    const wallMat = own(createToonMaterial({ color: 0xffffff, rim: 0.7 }));
    const walls = add(new THREE.InstancedMesh(wallGeo, wallMat, wallTiles.length));
    wallTiles.forEach((idx, n) => {
      const x = idx % GRID, y = (idx / GRID) | 0, h = hash(y, x);
      put(walls, n, tileToWorld(x), 0, tileToWorld(y));
      walls.setColorAt(n, c.setHSL(0.74, 0.18, 0.1 + h * 0.05));
    });
    // spectral bridge slabs
    this.bridgeMat = own(createToonMaterial({ vertexColors: true, transparent: true, opacity: 0.12, rim: 1.4, emissive: 0x000000 }));
    this.bridgeMat.depthWrite = false;
    const bridgeGeo = assets.getEnvGeometry('bridge_broken');
    const bridgeMap = assets.getEnvMap('bridge_broken');
    if (bridgeMap) { this.bridgeMat.vertexColors = false; (this.bridgeMat as THREE.MeshLambertMaterial).map = bridgeMap; this.bridgeMat.needsUpdate = true; }
    const bridge = add(new THREE.InstancedMesh(bridgeGeo, this.bridgeMat, bridgeTiles.length));
    bridgeTiles.forEach((idx, n) => put(bridge, n, tileToWorld(idx % GRID), 0, tileToWorld((idx / GRID) | 0)));
    bridge.renderOrder = 2;

    // props
    const vcMat = own(createToonMaterial({ vertexColors: true, rim: 1 }));
    // props with an imported painted texture get their own lit material; procedural ones use vertex colours
    const propFor = (id: EnvPropId): [THREE.BufferGeometry, THREE.Material] => {
      const geo = assets.getEnvGeometry(id), map = assets.getEnvMap(id);
      if (!map) return [geo, vcMat];
      const m = own(createToonMaterial({ map, rim: 1 })) as THREE.MeshLambertMaterial;
      m.emissiveMap = map; m.emissive = new THREE.Color(1, 1, 1); m.emissiveIntensity = 0.4; // keep dark art readable
      return [geo, m];
    };
    const pillars: Vec2[] = [], monos: Array<{ p: Vec2; r: Room }> = [];
    for (const r of d.rooms) {
      pillars.push(...r.pillars);
      this.braziers.push(...r.braziers);
      r.monoliths.forEach((p) => monos.push({ p, r }));
    }
    const pm = add(new THREE.InstancedMesh(...propFor('pillar_elven'), Math.max(1, pillars.length)));
    pm.count = pillars.length;
    pillars.forEach((p, i) => put(pm, i, p.x, 0, p.z, hash(p.x, p.z) * 6.28, 0.72));
    const bm = add(new THREE.InstancedMesh(...propFor('brazier_iron'), Math.max(1, this.braziers.length)));
    bm.count = this.braziers.length;
    this.braziers.forEach((p, i) => put(bm, i, p.x, 0, p.z, hash(p.z, p.x) * 6.28));
    this.monolithMesh = add(new THREE.InstancedMesh(...propFor('runestone_monolith'), Math.max(1, monos.length)));
    this.monolithMesh.count = monos.length;
    monos.forEach(({ p, r }, i) => {
      put(this.monolithMesh, i, p.x, 0, p.z, hash(p.x, p.z) * 6.28, 0.85);
      this.monoliths.push({ pos: p, room: r, index: i, alive: true, hp: r.kind === 'boss' ? 90 : 55, maxHp: r.kind === 'boss' ? 90 : 55 });
    });

    // portal (hidden until the boss falls)
    const gateMesh = add(new THREE.InstancedMesh(...propFor('archway_gate'), 1));
    put(gateMesh, 0, d.portal.x, 0, d.portal.z - 0.5, Math.PI / 4, 0.85);
    gateMesh.visible = false;
    const discMat = own(createToonMaterial({ color: 0x55ffc0, emissive: 0x55ffc0, emissiveIntensity: 1.6, transparent: true, opacity: 0.55, side: THREE.DoubleSide, rim: 0 }));
    const discGeo = own(new THREE.CircleGeometry(1.7, 24));
    const disc = add(new THREE.InstancedMesh(discGeo, discMat, 1));
    put(disc, 0, d.portal.x, 1.8, d.portal.z - 0.5, Math.PI / 4, 1);
    disc.scale.set(1, 1, 1);
    disc.visible = false;
    this.portalMeshes = [gateMesh, disc];

    // torch lights
    for (let i = 0; i < NUM_LIGHTS; i++) {
      const l = new THREE.PointLight(0xffa24a, 0, 11, 1.8);
      l.position.set(0, 1.6, 0);
      this.group.add(l);
      this.lights.push(l);
      this.flickerSeed.push(Math.random() * 100);
    }

    // GPU embers
    const n = NUM_LIGHTS * EMBERS_PER_SLOT;
    const g = own(new THREE.BufferGeometry());
    const slot = new Float32Array(n), seed = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { slot[i] = Math.floor(i / EMBERS_PER_SLOT); seed[i * 3] = Math.random(); seed[i * 3 + 1] = Math.random(); seed[i * 3 + 2] = Math.random(); }
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('aSlot', new THREE.BufferAttribute(slot, 1));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
    this.emberCenters = Array.from({ length: NUM_LIGHTS }, () => new THREE.Vector3(0, -50, 0));
    this.emberMat = own(new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uCenters: { value: this.emberCenters }, uTime: sharedUniforms.uTime, uRealmBlend: sharedUniforms.uRealmBlend, uSize: { value: 5 } },
      vertexShader: /* glsl */ `
        attribute float aSlot; attribute vec3 aSeed; uniform vec3 uCenters[${NUM_LIGHTS}]; uniform float uTime, uSize; varying float vA; varying float vH;
        void main(){
          float life = fract(uTime*0.28*(0.6+aSeed.x*0.8) + aSeed.y);
          vec3 c = uCenters[int(aSlot+0.5)];
          vec3 p = c + vec3((aSeed.x-0.5)*0.55 + sin(uTime*1.7+aSeed.z*20.0)*0.3*life, 1.3 + life*2.8, (aSeed.z-0.5)*0.55 + cos(uTime*1.3+aSeed.x*20.0)*0.3*life);
          vA = (1.0-life)*smoothstep(0.0,0.08,life)*step(-10.0, c.y); vH = aSeed.y;
          gl_Position = projectionMatrix*viewMatrix*vec4(p,1.0);
          gl_PointSize = uSize*(0.5+aSeed.x)*(1.0-life*0.6);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uRealmBlend; varying float vA; varying float vH;
        void main(){ float r=length(gl_PointCoord-0.5)*2.0; float a=smoothstep(1.0,0.0,r)*vA; if(a<0.01) discard;
          vec3 warm=mix(vec3(1.0,0.45,0.1),vec3(1.0,0.8,0.3),vH), cold=mix(vec3(0.2,1.0,0.65),vec3(0.7,0.4,1.0),vH);
          gl_FragColor=vec4(mix(warm,cold,uRealmBlend)*1.4,a); }`,
    }));
    this.embers = new THREE.Points(g, this.emberMat);
    this.embers.frustumCulled = false;
    this.group.add(this.embers);
    this.drawCalls++;
  }

  setPixelRatio(pr: number): void { this.emberMat.uniforms.uSize.value = 5 * pr; }

  setPortalActive(on: boolean): void { for (const o of this.portalMeshes) o.visible = on; }

  shatterMonolith(i: number): void {
    const m = this.monoliths[i];
    if (!m || !m.alive) return;
    m.alive = false;
    this.monolithMesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
    this.monolithMesh.instanceMatrix.needsUpdate = true;
  }

  update(dt: number, player: Vec2): void {
    // bridge solidity visual: ghost 0.12 -> glowing silver-emerald
    const b = realm.uRealmBlend;
    this.bridgeMat.opacity = 0.12 + (0.88 * b);
    this.bridgeMat.emissive.setRGB(0.45 * b, 1.0 * b, 0.75 * b);
    this.bridgeMat.emissiveIntensity = 0.6;

    this.lightTimer -= dt;
    if (this.lightTimer <= 0) {
      this.lightTimer = 0.25;
      const near = this.braziers
        .map((p) => ({ p, d: (p.x - player.x) ** 2 + (p.z - player.z) ** 2 }))
        .sort((a, c) => a.d - c.d).slice(0, NUM_LIGHTS);
      for (let i = 0; i < NUM_LIGHTS; i++) {
        const n = near[i];
        if (n && n.d < 26 * 26) { this.lights[i].position.set(n.p.x, 1.7, n.p.z); this.lights[i].userData.on = 1; this.emberCenters[i].set(n.p.x, 0, n.p.z); }
        else { this.lights[i].userData.on = 0; this.emberCenters[i].set(0, -50, 0); }
      }
    }
    const t = sharedUniforms.uTime.value;
    const warm = new THREE.Color(0xff9a45), cold = new THREE.Color(0x4fffd0);
    for (let i = 0; i < NUM_LIGHTS; i++) {
      const l = this.lights[i];
      const f = 0.8 + 0.2 * Math.sin(t * 9 + this.flickerSeed[i]) * Math.sin(t * 5.3 + this.flickerSeed[i] * 2) + (Math.random() - 0.5) * 0.12;
      l.color.copy(warm).lerp(cold, b);
      l.intensity = (l.userData.on ? 20 : 0) * f;
    }
  }

  dispose(): void {
    this.group.parent?.remove(this.group);
    for (const o of this.owned) o.dispose();
    for (const o of this.group.children) (o as THREE.InstancedMesh).dispose?.();
  }
}
