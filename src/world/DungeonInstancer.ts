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
/** One instance of a distance-culled set: position, yaw, optional lift/scale, and its colour (k, else from h). */
type Cull = { x: number; z: number; yaw: number; h: number; y?: number; sc?: number; k?: number };
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
  private slabSets: Array<{ mesh: THREE.InstancedMesh; list: Cull[] }> = [];
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
    // One continuous flagstone texture mapped in world space: the image spans 2x2 tiles, so each tile uses one quadrant
    // chosen by its grid parity and neighbouring tiles join with no seam (no per-tile rotation, which would break it).
    const floorMap = tex('floor_c');
    const floorMat = own(lit(createToonMaterial({ color: 0xffffff, map: floorMap, veins: 0.6, rim: 0.4, band: 0.2 }), floorMap, 0.3));
    const floorGeos = [0, 1, 2, 3].map((q) => {
      const g = new THREE.BoxGeometry(TILE, 0.4, TILE).translate(0, -0.2, 0);
      const pos = g.attributes.position as THREE.BufferAttribute, uv = g.attributes.uv as THREE.BufferAttribute;
      const px = q & 1, pz = q >> 1;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, (px + pos.getX(i) / TILE + 0.5) / 2, 1 - (pz + pos.getZ(i) / TILE + 0.5) / 2);
      return own(g);
    });
    // white-marble sanctum rooms get the marble kit's floor, baked flat from marble_floor_tile (12 tris a tile, not 2.4k)
    const roomOf = (x: number, y: number) => d.rooms.find((q) => x >= q.x && x < q.x + q.w && y >= q.y && y < q.y + q.h);
    // medallion tiles form a cross-shaped aisle through the room's centre; the rest is pale flagstone
    const isSanctum = (idx: number) => {
      const x = idx % GRID, y = (idx / GRID) | 0, r = roomOf(x, y);
      if (r?.theme !== 'sanctum') return false;
      const cx = Math.floor(r.x + r.w / 2), cy = Math.floor(r.y + r.h / 2);
      return x === cx || y === cy;
    };
    const marbleTiles = floorTiles.filter(isSanctum);
    if (marbleTiles.length) {
      const mMap = tex('floor_marble'), mNrm = tex('floor_marble_n'); mNrm.colorSpace = THREE.NoColorSpace;
      const mMat = own(lit(createToonMaterial({ color: 0xffffff, map: mMap, rim: 0.4, band: 0.2 }), mMap, 0.3));
      mMat.normalMap = mNrm; mMat.normalScale.set(0.8, 0.8);
      const mGeo = own(new THREE.BoxGeometry(TILE, 0.4, TILE).translate(0, -0.2, 0));
      const mm = add(new THREE.InstancedMesh(mGeo, mMat, marbleTiles.length));
      marbleTiles.forEach((idx, n) => {
        const x = idx % GRID, y = (idx / GRID) | 0, h = hash(x, y);
        put(mm, n, tileToWorld(x), 0, tileToWorld(y), Math.floor(hash(y * 1.3, x * 0.7) * 4) * Math.PI / 2);
        mm.setColorAt(n, c.setScalar(0.94 + h * 0.08));
      });
    }
    const stoneTiles = marbleTiles.length ? floorTiles.filter((i) => !isSanctum(i)) : floorTiles;
    const floorVariants = floorGeos.map((geo, q) => ({ geo, tiles: stoneTiles.filter((idx) => ((idx % GRID) & 1) + 2 * (((idx / GRID) | 0) & 1) === q) }));
    // per-room floor tint: warm start hall, cool crypts, teal-leaning boss hall; plus worn / cracked tiles
    const roomTint = (x: number, y: number): [number, number, number] => {
      const r = d.rooms.find((q) => x >= q.x && x < q.x + q.w && y >= q.y && y < q.y + q.h);
      if (!r) return [0.9, 0.9, 0.92];
      if (r.kind === 'start') return [1.08, 0.98, 0.84];
      if (r.kind === 'boss') return [0.92, 1.0, 1.1];
      if (r.theme === 'sanctum') return [1.3, 1.27, 1.2];
      return r.theme === 'crypt' ? [0.9, 1.02, 1.1] : [1.04, 1.0, 0.94];
    };
    for (const { geo, tiles } of floorVariants) {
      const mesh = add(new THREE.InstancedMesh(geo, floorMat, Math.max(1, tiles.length)));
      mesh.count = tiles.length;
      tiles.forEach((idx, n) => {
        const x = idx % GRID, y = (idx / GRID) | 0, h = hash(x, y), w = hash(x * 1.7 + 3, y * 2.3 + 1);
        put(mesh, n, tileToWorld(x), 0, tileToWorld(y));
        const k = (w < 0.1 ? 0.88 : 1.0 + h * 0.1) * 0.72, [tr, tg, tb] = roomTint(x, y);
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
      const nrm = assets.getEnvNormal(id); if (nrm) { m.normalMap = nrm; m.normalScale.set(0.8, 0.8); } // baked surface relief (marble kit)
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
    const paintedCap = assets.hasEnv('wall_ledge_cap');
    const ledgeGeo = own(mergeGeometries(paintedCap ? [new THREE.BoxGeometry(TILE, 1.0, TILE)] : [
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
    if (paintedCap && lowTiles.length) { // painted stone coping on every cut-down wall (static, one draw call)
      const cap = add(new THREE.InstancedMesh(...propFor('wall_ledge_cap'), lowTiles.length)); cap.count = 0;
      this.slabSets.push({ mesh: cap, list: lowTiles.map((idx) => {
        const x = idx % GRID, y = (idx / GRID) | 0;
        return { x: tileToWorld(x), y: 0.5, z: tileToWorld(y), yaw: Math.floor(hash(x, y) * 4) * Math.PI / 2, h: 0, k: 0.95 + hash(y, x) * 0.2 };
      }) });
    }
    type Face = { x: number; z: number; yaw: number; kind: 'wall_segment' | 'wall_alcove' | 'wall_pilaster_rune' | 'marble_wall' | 'marble_window'; h: number };
    const faces: Face[] = [];
    const corners: Array<{ x: number; z: number; yaw: number; h: number }> = [];
    const slabOut = TILE / 2 + 0.2 - 0.225; // the brick plane sits ~0.2 behind the slab's outer edge, so push the slab out until it clears the core box
    for (const idx of facade ? tallTiles : []) {
      const x = idx % GRID, y = (idx / GRID) | 0;
      for (const [dx, dz] of [[1, 0], [0, 1]]) { // only the camera-facing (room-interior) faces are ever seen
        if (!walkable(x + dx, y + dz)) continue;
        const h = hash(x * 3 + dx * 7, y * 5 + dz * 11);
        const marble = roomOf(x + dx, y + dz)?.theme === 'sanctum' && assets.hasEnv('marble_wall');
        const alcove = !marble && h < 0.12 && assets.hasEnv('wall_alcove');
        const pilaster = !marble && !alcove && h >= 0.55 && h < 0.8 && assets.hasEnv('wall_pilaster_rune');
        const win = marble && h < 0.3 && assets.hasEnv('marble_window');
        faces.push({ x: tileToWorld(x) + dx * slabOut, z: tileToWorld(y) + dz * slabOut, yaw: Math.atan2(dx, dz), kind: win ? 'marble_window' : marble ? 'marble_wall' : alcove ? 'wall_alcove' : pilaster ? 'wall_pilaster_rune' : 'wall_segment', h });
        if (!alcove && (marble ? h > 0.3 && h < 0.5 : h > 0.12 && h < 0.3) && (x + y) % 2 === 0) this.torches.push({ x: tileToWorld(x) + dx * (TILE / 2 + 0.3), z: tileToWorld(y) + dz * (TILE / 2 + 0.3), yaw: Math.atan2(dx, dz) });
      }
    }
    if (assets.hasEnv('wall_corner_column')) for (const idx of tallTiles) { // outer corners of a wall mass get a painted column
      const x = idx % GRID, y = (idx / GRID) | 0;
      if (walkable(x + 1, y) && walkable(x, y + 1) && walkable(x + 1, y + 1)) corners.push({ x: tileToWorld(x) + TILE / 2 - 0.05, z: tileToWorld(y) + TILE / 2 - 0.05, yaw: 0, h: hash(x, y) });
    }
    // Only slabs near the player are drawn (re-selected a few times a second): bounds the triangle load on phones.
    const sets: Array<[EnvPropId, Array<{ x: number; z: number; yaw: number; h: number }>]> = [['wall_segment', faces.filter((f) => f.kind === 'wall_segment')], ['wall_alcove', faces.filter((f) => f.kind === 'wall_alcove')], ['wall_pilaster_rune', faces.filter((f) => f.kind === 'wall_pilaster_rune')],
      ['marble_wall', faces.filter((f) => f.kind === 'marble_wall')], ['marble_window', faces.filter((f) => f.kind === 'marble_window')], ['wall_corner_column', corners]];
    for (const [kind, list] of sets) {
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
    const bridge = add(new THREE.InstancedMesh(bridgeGeo, this.bridgeMat, Math.max(1, bridgeTiles.length))); bridge.count = 0;
    this.slabSets.push({ mesh: bridge, list: bridgeTiles.map((idx) => ({ x: tileToWorld(idx % GRID), z: tileToWorld((idx / GRID) | 0), yaw: 0, h: 0, k: 1 })) });
    bridge.renderOrder = 2;

    // props
    const pillars: Vec2[] = [], monos: Array<{ p: Vec2; r: Room }> = [];
    for (const r of d.rooms) {
      pillars.push(...r.pillars);
      this.braziers.push(...r.braziers);
      r.monoliths.forEach((p) => monos.push({ p, r }));
    }
    // pillars, braziers and dressing are drawn only near the player, like the wall slabs (phones can't take the whole floor)
    const culled = (id: EnvPropId, list: Cull[], mat?: THREE.Material) => {
      if (!list.length) return null;
      const [geo, m] = propFor(id);
      const mesh = add(new THREE.InstancedMesh(geo, mat ?? m, list.length)); mesh.count = 0;
      this.slabSets.push({ mesh, list });
      return mesh;
    };
    culled('pillar_elven', pillars.map((p) => ({ x: p.x, z: p.z, yaw: hash(p.x, p.z) * 6.28, h: 0, sc: 0.72, k: 1 })));
    culled('brazier_iron', this.braziers.map((p) => ({ x: p.x, z: p.z, yaw: hash(p.z, p.x) * 6.28, h: 0, k: 1 })));
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
      const mesh = add(new THREE.InstancedMesh(geo, mat, list.length)); mesh.count = 0;
      this.slabSets.push({ mesh, list: list.map((q) => ({ x: q.x, y: q.y, z: q.z, yaw: q.yaw, h: 0, k: 0.85 + hash(q.x, q.z) * 0.15 })) });
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
      // painted sconce GLB when present (back plate on the wall, torch head at the flame), else the old box + cup bracket
      const sconce = assets.hasEnv('wall_torch_sconce');
      const [bracket, bracketMat] = sconce
        ? ((): [THREE.BufferGeometry, THREE.Material] => { const [g, m] = propFor('wall_torch_sconce'); return [own(g.clone().translate(0, 1.03, -0.27)), m]; })()
        : [own(mergeGeometries([
          new THREE.BoxGeometry(0.1, 0.1, 0.34).translate(0, 1.3, -0.1),
          new THREE.CylinderGeometry(0.13, 0.08, 0.2, 8).translate(0, 1.42, 0.08),
        ])!), own(createToonMaterial({ color: 0x2a2622, rim: 0.4, emissive: 0x000000 }))];
      const bm2 = add(new THREE.InstancedMesh(bracket, bracketMat, nT));
      const flameGeo = own(sconce ? new THREE.ConeGeometry(0.1, 0.4, 7).translate(0, 1.79, 0) : new THREE.ConeGeometry(0.13, 0.42, 7).translate(0, 1.76, 0.08));
      this.flameMat = own(new THREE.MeshBasicMaterial({ color: 0xffa83a }));
      const fm = add(new THREE.InstancedMesh(flameGeo, this.flameMat, nT));
      const tl = this.torches.map((t) => ({ x: t.x, z: t.z, yaw: t.yaw, h: 0, k: 1 }));
      bm2.count = fm.count = 0; this.slabSets.push({ mesh: bm2, list: tl }, { mesh: fm, list: tl });
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
        put(mesh, n, f.x, f.y ?? 0, f.z, f.yaw, f.sc ?? 1);
        mesh.setColorAt(n, c.setScalar(f.k ?? 0.82 + f.h * 0.18));
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
