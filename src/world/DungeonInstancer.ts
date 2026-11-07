import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { assets } from '../assets/AssetRegistry';
import type { EnvPropId } from '../assets/ProceduralAssetFallback';
import { createToonMaterial, sharedUniforms } from '../shaders/ToonRealm';
import { GRID, TILE, TileType, tileToWorld, type Dungeon, type Room, type Vec2 } from './ProceduralDungeonGenerator';
import { realm } from './RealmManager';
import { BlobShadows, radialTexture } from './Shadows';

const NUM_LIGHTS = 5;
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
  private pools!: THREE.InstancedMesh;
  private halos!: THREE.Points;
  private haloMat!: THREE.PointsMaterial;
  private poolMat!: THREE.MeshBasicMaterial;
  private haloBase = 120;
  private flickerSeed: number[] = [];
  private owned: Array<{ dispose(): void }> = [];
  drawCalls = 0;
  private slabSets: Array<{ mesh: THREE.InstancedMesh; list: Array<{ x: number; z: number; yaw: number; h: number }> }> = [];
  private slabTimer = 0;
  private ghostMats: THREE.MeshLambertMaterial[] = [];
  private ghostMeshes: THREE.InstancedMesh[] = [];
  private decorShadows: Array<{ x: number; z: number; r: number }> = [];
  private slabAt = new THREE.Vector2(1e9, 1e9);
  /** wall torches: x,z of the flame, wall-normal yaw */
  private lightSrc: Array<{ x: number; y: number; z: number }> = [];
  readonly torches: Array<{ x: number; z: number; yaw: number }> = [];
  private flameMat!: THREE.MeshBasicMaterial;
  private inlayMat?: THREE.MeshBasicMaterial;

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

    // painted tile textures (seamless; made by scripts/make-tile.mjs). Floor alternates between two
    // variants and each tile is rotated in 90° steps so the repeat is hard to spot.
    const loader = new THREE.TextureLoader();
    const tex = (n: string) => {
      const t = loader.load(`${import.meta.env.BASE_URL}assets/tex/${n}.jpg`);
      t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4;
      return own(t);
    };
    const lit = (m: THREE.MeshLambertMaterial, map: THREE.Texture, k: number) => { m.emissiveMap = map; m.emissive = new THREE.Color(1, 1, 1); m.emissiveIntensity = k; return m; };
    const c = new THREE.Color();
    const floorGeo = own(new THREE.BoxGeometry(TILE, 0.4, TILE).translate(0, -0.2, 0));
    const floorVariants = ['floor_a', 'floor_b'].map((n, v) => {
      const map = tex(n);
      const mat = own(lit(createToonMaterial({ color: 0xffffff, map, veins: 1, rim: 0.4, band: 0.2 }), map, 0.9));
      const tiles = floorTiles.filter((idx) => ((hash(idx % GRID, (idx / GRID) | 0) * 7) | 0) % 2 === v);
      return { mat, tiles };
    });
    // per-room floor tint: warm start hall, cool crypts, teal-leaning boss hall; plus worn / cracked tiles
    const roomTint = (x: number, y: number): [number, number, number] => {
      const r = d.rooms.find((q) => x >= q.x && x < q.x + q.w && y >= q.y && y < q.y + q.h);
      if (!r) return [0.9, 0.9, 0.92];
      if (r.kind === 'start') return [1.08, 0.98, 0.84];
      if (r.kind === 'boss') return [0.92, 1.0, 1.1];
      return r.decor.some((q) => q.id === 'sarcophagus') ? [0.9, 1.02, 1.1] : [1.04, 1.0, 0.94];
    };
    for (const { mat, tiles } of floorVariants) {
      const mesh = add(new THREE.InstancedMesh(floorGeo, mat, Math.max(1, tiles.length)));
      mesh.count = tiles.length;
      tiles.forEach((idx, n) => {
        const x = idx % GRID, y = (idx / GRID) | 0, h = hash(x, y), w = hash(x * 1.7 + 3, y * 2.3 + 1);
        put(mesh, n, tileToWorld(x), 0, tileToWorld(y), Math.floor(hash(y, x) * 4) * Math.PI / 2);
        const k = (w < 0.1 ? 0.7 : 1.0 + h * 0.3) * 1.12, [tr, tg, tb] = roomTint(x, y);
        mesh.setColorAt(n, c.setRGB(k * tr, k * tg, k * tb));
      });
    }
    // inlaid rune rings / borders: one merged glow mesh for every room
    const inlay: THREE.BufferGeometry[] = [];
    const ring = (cx: number, cz: number, r0: number, r1: number, seg = 64) => inlay.push(new THREE.RingGeometry(r0, r1, seg).rotateX(-Math.PI / 2).translate(cx, 0.03, cz));
    for (const r of d.rooms) {
      if (r.kind === 'start') { ring(r.center.x, r.center.z, 2.9, 3.0); continue; }
      const { x: cx, z: cz } = r.center;
      if (r.kind === 'boss') {
        ring(cx, cz, 3.3, 3.45); ring(cx, cz, 4.7, 4.8); ring(cx, cz, 6.4, 6.5);
        for (let a = 0; a < 8; a++) inlay.push(new THREE.PlaneGeometry(0.1, 3.2).rotateX(-Math.PI / 2).translate(0, 0, -4.7).rotateY(a * Math.PI / 4 + Math.PI / 8).translate(cx, 0.03, cz));
      } else {
        ring(cx, cz, 2.1, 2.2, 48);
      }
      if (r.shape === 'rect') { // stone-inlay border two tiles in from the walls
        const hw = (r.w / 2 - 2) * TILE, hh = (r.h / 2 - 2) * TILE;
        if (hw > 2 && hh > 2) for (const [sx, sz, w, h] of [[0, -hh, hw * 2, 0.1], [0, hh, hw * 2, 0.1], [-hw, 0, 0.1, hh * 2], [hw, 0, 0.1, hh * 2]] as number[][]) inlay.push(new THREE.PlaneGeometry(w, h).rotateX(-Math.PI / 2).translate(cx + sx, 0.03, cz + sz));
      }
    }
    if (inlay.length) {
      this.inlayMat = own(new THREE.MeshBasicMaterial({ color: 0x35e0ff, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
      const im = new THREE.Mesh(own(mergeGeometries(inlay.map((g) => { g.deleteAttribute('uv'); g.deleteAttribute('normal'); return g; }))!), this.inlayMat);
      im.frustumCulled = false; im.renderOrder = 1; this.group.add(im); this.drawCalls++;
    }
    const vcMat = own(createToonMaterial({ vertexColors: true, rim: 1 }));
    // props with an imported painted texture get their own lit material; procedural ones use vertex colours
    const propFor = (id: EnvPropId): [THREE.BufferGeometry, THREE.Material] => {
      const geo = assets.getEnvGeometry(id), map = assets.getEnvMap(id);
      if (!map) return [geo, vcMat];
      const m = own(createToonMaterial({ map, rim: 1, band: 0.5 })) as THREE.MeshLambertMaterial;
      m.emissiveMap = map; m.emissive = new THREE.Color(1, 1, 1); m.emissiveIntensity = 0.4; // keep dark art readable
      return [geo, m];
    };
    // walls: a solid core per tile, dressed with painted facade slabs on every face that borders open ground
    const facade = assets.hasEnv('wall_segment');
    const walkable = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= GRID || y >= GRID) return false;
      const t = d.grid[y * GRID + x];
      return t === TileType.FLOOR || t === TileType.PORTAL || t === TileType.SPECTRAL_BRIDGE;
    };
    // Cutaway: the camera looks toward -x,-z, so walls with open floor on their +x/+z side (the far walls) stay tall and
    // show their painted faces; every other wall is cut down to a capped ledge so the room interior is visible.
    const isTall = (x: number, y: number) => walkable(x + 1, y) || walkable(x, y + 1) || walkable(x + 1, y + 1);
    const tallTiles = wallTiles.filter((i) => isTall(i % GRID, (i / GRID) | 0));
    const lowTiles = wallTiles.filter((i) => !isTall(i % GRID, (i / GRID) | 0));
    const wallGeo = own(new THREE.BoxGeometry(TILE, 2.4, TILE).translate(0, facade ? 0.5 : 0.8, 0));
    const ledgeGeo = own(mergeGeometries([
      new THREE.BoxGeometry(TILE, 1.0, TILE).translate(0, 0.0, 0),
      new THREE.BoxGeometry(TILE + 0.1, 0.16, TILE + 0.1).translate(0, 0.58, 0),
    ])!);
    const wallMap = tex('wall');
    const wallMat = own(lit(createToonMaterial({ color: 0xffffff, map: wallMap, rim: 0.7, band: 0.2 }), wallMap, 0.5));
    const walls = add(new THREE.InstancedMesh(wallGeo, wallMat, tallTiles.length));
    tallTiles.forEach((idx, n) => {
      const x = idx % GRID, y = (idx / GRID) | 0, h = hash(y, x);
      put(walls, n, tileToWorld(x), 0, tileToWorld(y));
      walls.setColorAt(n, c.setScalar(0.78 + h * 0.18));
    });
    if (lowTiles.length) {
      const ledge = add(new THREE.InstancedMesh(ledgeGeo, wallMat, lowTiles.length));
      lowTiles.forEach((idx, n) => {
        const x = idx % GRID, y = (idx / GRID) | 0, h = hash(y, x);
        put(ledge, n, tileToWorld(x), 0, tileToWorld(y));
        ledge.setColorAt(n, c.setScalar(0.95 + h * 0.2));
      });
    }
    const faces: Array<{ x: number; z: number; yaw: number; alcove: boolean; h: number }> = [];
    const slabOut = TILE / 2 + 0.2 - 0.225; // the brick plane sits ~0.2 behind the slab's outer edge, so push the slab out until it clears the core box
    for (const idx of facade ? tallTiles : []) {
      const x = idx % GRID, y = (idx / GRID) | 0;
      for (const [dx, dz] of [[1, 0], [0, 1]]) { // only the camera-facing (room-interior) faces are ever seen
        if (!walkable(x + dx, y + dz)) continue;
        const h = hash(x * 3 + dx * 7, y * 5 + dz * 11);
        const alcove = h < 0.12 && assets.hasEnv('wall_alcove');
        faces.push({ x: tileToWorld(x) + dx * slabOut, z: tileToWorld(y) + dz * slabOut, yaw: Math.atan2(dx, dz), alcove, h });
        if (!alcove && h > 0.12 && h < 0.3 && (x + y) % 2 === 0) this.torches.push({ x: tileToWorld(x) + dx * (TILE / 2 + 0.3), z: tileToWorld(y) + dz * (TILE / 2 + 0.3), yaw: Math.atan2(dx, dz) });
      }
    }
    // Only slabs near the player are drawn (re-selected a few times a second): bounds the triangle load on phones.
    for (const kind of ['wall_segment', 'wall_alcove'] as const) {
      const list = faces.filter((f) => f.alcove === (kind === 'wall_alcove'));
      if (!list.length) continue;
      const mesh = add(new THREE.InstancedMesh(...propFor(kind), list.length));
      mesh.count = 0;
      this.slabSets.push({ mesh, list });
    }

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

    // painted set dressing (solid decor casts a contact shadow; ghost decor only exists in the Unseen Realm)
    const decorAll = d.rooms.flatMap((r) => r.decor).filter((q) => assets.hasEnv(q.id));
    this.ghostMats = [];
    for (const id of [...new Set(decorAll.map((q) => q.id))]) {
      const list = decorAll.filter((q) => q.id === id);
      const ghost = list[0].ghost;
      let [geo, mat] = propFor(id);
      if (!ghost && (mat as THREE.MeshLambertMaterial).emissiveMap) (mat as THREE.MeshLambertMaterial).emissiveIntensity = 0.8; // painted dressing should read, not sink into the dark
      if (ghost) {
        const gm = own(createToonMaterial({ map: assets.getEnvMap(id) ?? undefined, rim: 1.4, band: 0.5, transparent: true, opacity: 0, emissive: 0x2a5a7a })) as THREE.MeshLambertMaterial;
        gm.depthWrite = false; gm.emissiveIntensity = 0.5; this.ghostMats.push(gm); mat = gm;
      }
      const mesh = add(new THREE.InstancedMesh(geo, mat, list.length));
      list.forEach((q, i) => { put(mesh, i, q.x, 0, q.z, q.yaw); mesh.setColorAt(i, c.setScalar(0.85 + hash(q.x, q.z) * 0.15)); });
      if (ghost) { mesh.visible = false; mesh.renderOrder = 2; this.ghostMeshes.push(mesh); }
    }
    this.decorShadows = decorAll.filter((q) => q.r > 0);

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

    // grounding: contact shadows under every prop, warm light pools and glow halos around fires and runes
    const sh = new BlobShadows(Math.max(1, pillars.length + this.braziers.length + monos.length + this.decorShadows.length + 1), 0.55);
    sh.begin();
    pillars.forEach((p) => sh.add(p.x, p.z, 1.05));
    this.braziers.forEach((p) => sh.add(p.x, p.z, 0.85));
    monos.forEach(({ p }) => sh.add(p.x, p.z, 1.2));
    this.decorShadows.forEach((q) => sh.add(q.x, q.z, q.r * 1.5));
    sh.end(); this.group.add(sh.mesh); this.drawCalls++; own(sh);
    // wall torches: iron bracket + cup, and an emissive flame that follows the realm colour
    if (this.torches.length) {
      const nT = this.torches.length;
      const bracket = own(mergeGeometries([
        new THREE.BoxGeometry(0.1, 0.1, 0.34).translate(0, 1.3, -0.1),
        new THREE.CylinderGeometry(0.13, 0.08, 0.2, 8).translate(0, 1.42, 0.08),
      ])!);
      const bm2 = add(new THREE.InstancedMesh(bracket, own(createToonMaterial({ color: 0x2a2622, rim: 0.4, emissive: 0x000000 })), nT));
      const flameGeo = own(new THREE.ConeGeometry(0.13, 0.42, 7).translate(0, 1.76, 0.08));
      this.flameMat = own(new THREE.MeshBasicMaterial({ color: 0xffa83a }));
      const fm = add(new THREE.InstancedMesh(flameGeo, this.flameMat, nT));
      this.torches.forEach((t, i) => { put(bm2, i, t.x, 0, t.z, t.yaw); put(fm, i, t.x, 0, t.z, t.yaw); });
    }
    this.lightSrc = [...this.braziers.map((p) => ({ x: p.x, y: 1.7, z: p.z })), ...this.torches.map((t) => ({ x: t.x, y: 1.55, z: t.z }))];
    this.poolMat = own(new THREE.MeshBasicMaterial({ map: radialTexture(), color: 0xffa050, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.pools = add(new THREE.InstancedMesh(own(new THREE.PlaneGeometry(2, 2)), this.poolMat, Math.max(1, this.lightSrc.length)));
    this.pools.count = this.lightSrc.length; this.pools.renderOrder = 1;
    this.lightSrc.forEach((p, i) => this.pools.setMatrixAt(i, _m.compose(_p.set(p.x, 0.035, p.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)), _s.set(i < this.braziers.length ? 3.4 : 2.6, i < this.braziers.length ? 3.4 : 2.6, 3))));
    const hp: number[] = [];
    this.braziers.forEach((p) => hp.push(p.x, 1.35, p.z));
    this.torches.forEach((t) => hp.push(t.x, 1.8, t.z));
    monos.forEach(({ p }) => hp.push(p.x, 1.8, p.z));
    const hg = own(new THREE.BufferGeometry()); hg.setAttribute('position', new THREE.Float32BufferAttribute(hp, 3));
    this.haloMat = own(new THREE.PointsMaterial({ map: radialTexture(), color: 0xffa050, size: 120, sizeAttenuation: false, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.halos = new THREE.Points(hg, this.haloMat); this.halos.frustumCulled = false; this.halos.renderOrder = 10;
    this.group.add(this.halos); this.drawCalls++;

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

  setPixelRatio(pr: number): void { this.emberMat.uniforms.uSize.value = 5 * pr; this.haloBase = 120 * pr; this.haloMat.size = this.haloBase; }

  setPortalActive(on: boolean): void { for (const o of this.portalMeshes) o.visible = on; }

  shatterMonolith(i: number): void {
    const m = this.monoliths[i];
    if (!m || !m.alive) return;
    m.alive = false;
    this.monolithMesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
    this.monolithMesh.instanceMatrix.needsUpdate = true;
  }

  /** Fill the slab instance buffers with the faces within view range of the player. */
  private selectSlabs(px: number, pz: number): void {
    const R2 = 30 * 30, c = new THREE.Color();
    for (const { mesh, list } of this.slabSets) {
      let n = 0;
      for (const f of list) {
        const dx = f.x - px, dz = f.z - pz;
        if (dx * dx + dz * dz > R2) continue;
        put(mesh, n, f.x, 0, f.z, f.yaw);
        mesh.setColorAt(n, c.setScalar(0.82 + f.h * 0.18));
        n++;
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    this.slabAt.set(px, pz);
  }

  update(dt: number, player: Vec2): void {
    this.slabTimer -= dt;
    if (this.slabSets.length && (this.slabTimer <= 0 || this.slabAt.x > 1e8)) {
      this.slabTimer = 0.4;
      if (Math.hypot(player.x - this.slabAt.x, player.z - this.slabAt.y) > 2 || this.slabAt.x > 1e8) this.selectSlabs(player.x, player.z);
    }
    // bridge solidity visual: ghost 0.12 -> glowing silver-emerald
    const b = realm.uRealmBlend;
    this.bridgeMat.opacity = 0.12 + (0.88 * b);
    this.bridgeMat.emissive.setRGB(0.45 * b, 1.0 * b, 0.75 * b);
    this.bridgeMat.emissiveIntensity = 0.6;
    for (const m of this.ghostMats) m.opacity = 0.9 * b;
    for (const g of this.ghostMeshes) g.visible = b > 0.02;

    this.lightTimer -= dt;
    if (this.lightTimer <= 0) {
      this.lightTimer = 0.25;
      const near = this.lightSrc
        .map((p) => ({ p, d: (p.x - player.x) ** 2 + (p.z - player.z) ** 2 }))
        .sort((a, c) => a.d - c.d).slice(0, NUM_LIGHTS);
      for (let i = 0; i < NUM_LIGHTS; i++) {
        const n = near[i];
        if (n && n.d < 26 * 26) { this.lights[i].position.set(n.p.x, n.p.y, n.p.z); this.lights[i].userData.on = 1; this.emberCenters[i].set(n.p.x, n.p.y - 1.7, n.p.z); }
        else { this.lights[i].userData.on = 0; this.emberCenters[i].set(0, -50, 0); }
      }
    }
    const t = sharedUniforms.uTime.value;
    { // fire glow breathes; it shifts from amber to spectral teal with the realm
      const fl = 0.85 + 0.15 * Math.sin(t * 7.1) * Math.sin(t * 3.7);
      this.poolMat.color.setHex(0xffa050).lerp(new THREE.Color(0x3fffd0), b); this.poolMat.opacity = 0.5 * fl;
      this.haloMat.color.setHex(0xffa050).lerp(new THREE.Color(0x7affd0), b); this.haloMat.opacity = 0.5 * fl; this.haloMat.size = this.haloBase * (0.95 + 0.1 * fl);
    }
    if (this.inlayMat) { this.inlayMat.opacity = 0.34 + 0.12 * Math.sin(t * 1.4); this.inlayMat.color.setHex(0x35e0ff).lerp(new THREE.Color(0x9affc8), b); }
    if (this.flameMat) this.flameMat.color.setHex(0xffa83a).lerp(new THREE.Color(0x7affd0), b);
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
