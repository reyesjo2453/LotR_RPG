import type { EnvPropId } from '../assets/ProceduralAssetFallback';
/** Seeded Mulberry32 + deterministic sunken-fortress floor generator. */

export const GRID = 80;
export const TILE = 2.5;

export enum TileType { VOID = 0, FLOOR = 1, WALL = 2, SPECTRAL_BRIDGE = 3, PORTAL = 4 }
export type RoomKind = 'start' | 'combat' | 'boss';
export type RoomShape = 'rect' | 'octagon';
/** Dressing theme: drives props, floor finish and wall facades. 'sanctum' is the white-marble kit. */
export type RoomTheme = 'hall' | 'crypt' | 'ruin' | 'sanctum';

export class Rng {
  private a: number;
  constructor(seed: number | string) {
    let h = 1779033703 ^ 0;
    const s = String(seed);
    for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
    this.a = (h ^ (typeof seed === 'number' ? seed : 0)) >>> 0;
    if (this.a === 0) this.a = 0x9e3779b9;
  }
  /** Mulberry32 */
  next(): number {
    let t = (this.a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number { return a + this.next() * (b - a); }
  int(a: number, b: number): number { return Math.floor(this.range(a, b + 1)); }
  pick<T>(arr: T[]): T { return arr[Math.floor(this.next() * arr.length)]; }
}

export interface Vec2 { x: number; z: number }
/** Painted set dressing. r > 0 makes it solid (circle); `ghost` props only exist in the Unseen Realm. */
export interface Decor { id: EnvPropId; x: number; z: number; yaw: number; r: number; ghost?: boolean; y?: number }
export interface Room {
  id: number; kind: RoomKind; shape: RoomShape; theme: RoomTheme;
  x: number; y: number; w: number; h: number; // tile coords
  center: Vec2;                                // world coords
  pillars: Vec2[]; braziers: Vec2[]; monoliths: Vec2[]; spawners: Vec2[];
  decor: Decor[];
}
export interface Dungeon {
  seed: string; grid: Uint8Array; rooms: Room[];
  spawn: Vec2; portal: Vec2; bossRoom: number;
  bridgeTiles: Array<[number, number]>;
}

export const tileToWorld = (t: number): number => (t - GRID / 2) * TILE + TILE / 2;
export const worldToTile = (w: number): number => Math.floor(w / TILE + GRID / 2);

export function tileAt(d: Dungeon, tx: number, ty: number): TileType {
  if (tx < 0 || ty < 0 || tx >= GRID || ty >= GRID) return TileType.VOID;
  return d.grid[ty * GRID + tx];
}

/** Walkability. Bridges are only solid for the player while in the Unseen Realm. */
export function walkable(d: Dungeon, x: number, z: number, unseen: boolean): boolean {
  const t = tileAt(d, worldToTile(x), worldToTile(z));
  return t === TileType.FLOOR || t === TileType.PORTAL || (t === TileType.SPECTRAL_BRIDGE && unseen);
}

export function roomAt(d: Dungeon, x: number, z: number): Room | null {
  const tx = worldToTile(x), ty = worldToTile(z);
  for (const r of d.rooms) if (tx >= r.x && tx < r.x + r.w && ty >= r.y && ty < r.y + r.h) return r;
  return null;
}

// Snake path through a 3x3 cell layout keeps rooms apart and the chain connected.
const SNAKE: Array<[number, number]> = [[0, 0], [1, 0], [2, 0], [2, 1], [1, 1], [0, 1], [0, 2], [1, 2], [2, 2]];
const CELL = 26;

export function generateDungeon(seedIn: number | string): Dungeon {
  const seed = String(seedIn);
  let seedNum = 0; for (const ch of seed) seedNum = (seedNum * 31 + ch.charCodeAt(0)) % 9973;
  const rng = new Rng(seedIn);
  const grid = new Uint8Array(GRID * GRID);
  const set = (x: number, y: number, t: TileType) => { if (x > 0 && y > 0 && x < GRID - 1 && y < GRID - 1) grid[y * GRID + x] = t; };

  const count = rng.int(6, 8);
  // choose a contiguous prefix of the snake, always ending in a cell that can hold the boss arena
  const cells = SNAKE.slice(0, count);
  const rooms: Room[] = [];

  cells.forEach(([cx, cy], i) => {
    const last = i === count - 1;
    const kind: RoomKind = i === 0 ? 'start' : last ? 'boss' : 'combat';
    const w = last ? rng.int(17, 20) : kind === 'start' ? rng.int(9, 11) : rng.int(10, 15);
    const h = last ? rng.int(17, 20) : kind === 'start' ? rng.int(9, 11) : rng.int(10, 15);
    const x = Math.floor(cx * CELL + 2 + rng.range(0, CELL - 4 - w));
    const y = Math.floor(cy * CELL + 2 + rng.range(0, CELL - 4 - h));
    const shape: RoomShape = kind === 'combat' && rng.next() < 0.5 ? 'octagon' : kind === 'boss' ? 'octagon' : 'rect';
    rooms.push({ id: i, kind, shape, theme: kind === 'start' ? 'hall' : 'sanctum', x, y, w, h, center: { x: tileToWorld(x + w / 2 - 0.5), z: tileToWorld(y + h / 2 - 0.5) }, pillars: [], braziers: [], monoliths: [], spawners: [], decor: [] });
  });

  const inRoomShape = (r: Room, tx: number, ty: number): boolean => {
    if (tx < r.x || ty < r.y || tx >= r.x + r.w || ty >= r.y + r.h) return false;
    if (r.shape === 'rect') return true;
    const c = Math.floor(Math.min(r.w, r.h) / 4); // octagon corner cut
    const dx = Math.min(tx - r.x, r.x + r.w - 1 - tx), dy = Math.min(ty - r.y, r.y + r.h - 1 - ty);
    return dx + dy >= c;
  };
  for (const r of rooms) for (let ty = r.y; ty < r.y + r.h; ty++) for (let tx = r.x; tx < r.x + r.w; tx++) if (inRoomShape(r, tx, ty)) set(tx, ty, TileType.FLOOR);
  const inAnyRoom = (tx: number, ty: number) => rooms.some((r) => inRoomShape(r, tx, ty));

  // Corridors (3 wide, L-shaped). Bridge the middle of the long outside-room run on chosen links.
  const bridgeTiles: Array<[number, number]> = [];
  type Pt = [number, number, 'h' | 'v'];
  const candidates: Array<{ run: Pt[] }> = [];
  for (let i = 0; i < rooms.length - 1; i++) {
    const a = rooms[i], b = rooms[i + 1];
    const ax = Math.floor(a.x + a.w / 2), ay = Math.floor(a.y + a.h / 2);
    const bx = Math.floor(b.x + b.w / 2), by = Math.floor(b.y + b.h / 2);
    const legs: Pt[][] = [[], []];
    const sx = Math.sign(bx - ax) || 1, sy = Math.sign(by - ay) || 1;
    for (let x = ax; x !== bx + sx; x += sx) legs[0].push([x, ay, 'h']);
    for (let y = ay; y !== by + sy; y += sy) legs[1].push([bx, y, 'v']);
    for (const leg of legs) for (const [x, y, o] of leg) for (let k = -1; k <= 1; k++) {
      const px = o === 'h' ? x : x + k, py = o === 'h' ? y + k : y;
      if (grid[py * GRID + px] === TileType.VOID) set(px, py, TileType.FLOOR);
    }
    // longest straight run of centerline tiles clear of every room (1 tile margin)
    let best: Pt[] = [];
    for (const leg of legs) {
      let run: Pt[] = [];
      for (const t of leg) {
        const near = inAnyRoom(t[0], t[1]) || [-2, -1, 1, 2].some((d) => inAnyRoom(t[0] + d, t[1]) || inAnyRoom(t[0], t[1] + d));
        if (!near) { run.push(t); if (run.length > best.length) best = [...run]; } else run = [];
      }
    }
    candidates.push({ run: best });
  }
  // Bridge the (up to) three longest clear runs, always at least two when geometry allows.
  const chosen = candidates.map((c, i) => ({ i, n: c.run.length })).filter((c) => c.n >= 3).sort((a, b) => b.n - a.n || a.i - b.i).slice(0, 3);
  for (const { i } of chosen) {
    const run = candidates[i].run;
    const span = run.length >= 5 ? 5 : 3, from = Math.floor((run.length - span) / 2);
    for (const [x, y, o] of run.slice(from, from + span)) for (let k = -1; k <= 1; k++) {
      const px = o === 'h' ? x : x + k, py = o === 'h' ? y + k : y;
      grid[py * GRID + px] = TileType.SPECTRAL_BRIDGE;
      bridgeTiles.push([px, py]);
    }
  }

  // Room dressing
  for (const r of rooms) {
    const cx = r.x + r.w / 2 - 0.5, cy = r.y + r.h / 2 - 0.5;
    const W = (tx: number, ty: number): Vec2 => ({ x: tileToWorld(tx), z: tileToWorld(ty) });
    const free = (tx: number, ty: number) => grid[Math.round(ty) * GRID + Math.round(tx)] === TileType.FLOOR;
    // iron braziers near the corners
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      for (let k = 2; k < 6; k++) {
        const tx = Math.round(cx + sx * (r.w / 2 - k)), ty = Math.round(cy + sy * (r.h / 2 - k));
        if (free(tx, ty) && free(tx - sx, ty) && free(tx, ty - sy)) { r.braziers.push(W(tx, ty)); break; }
      }
    }
    if (r.kind === 'start') {
      r.braziers.push(W(Math.round(cx) - 2, Math.round(cy)), W(Math.round(cx) + 2, Math.round(cy)));
      continue;
    }
    // tactical pillar ring
    const ringR = r.kind === 'boss' ? 5.2 : Math.min(r.w, r.h) / 2 - 3.4;
    const n = r.kind === 'boss' ? 10 : rng.pick([4, 6, 8]);
    const rot = rng.range(0, Math.PI);
    for (let k = 0; k < n; k++) {
      const a = rot + (k / n) * Math.PI * 2;
      const tx = Math.round(cx + Math.cos(a) * ringR), ty = Math.round(cy + Math.sin(a) * ringR);
      if (free(tx, ty)) r.pillars.push(W(tx, ty));
    }
    // runestone monoliths (3 around the boss, 2 per combat room)
    const mN = r.kind === 'boss' ? 3 : 2, mR = r.kind === 'boss' ? 8.2 : ringR + 0.2 + (r.kind === 'combat' ? 0 : 0);
    const mRot = rng.range(0, Math.PI * 2);
    for (let k = 0; k < mN; k++) {
      const a = mRot + (k / mN) * Math.PI * 2;
      let tx = Math.round(cx + Math.cos(a) * mR), ty = Math.round(cy + Math.sin(a) * mR);
      if (!free(tx, ty)) { tx = Math.round(cx + Math.cos(a) * 3); ty = Math.round(cy + Math.sin(a) * 3); }
      if (free(tx, ty)) r.monoliths.push(W(tx, ty));
    }
    // wave spawners
    const sN = r.kind === 'boss' ? 2 : rng.int(2, 3);
    for (let k = 0; k < sN * 6 && r.spawners.length < sN; k++) {
      const tx = Math.round(r.x + 2 + rng.range(0, r.w - 4)), ty = Math.round(r.y + 2 + rng.range(0, r.h - 4));
      const p = W(tx, ty);
      const clear = [...r.pillars, ...r.monoliths].every((q) => Math.hypot(q.x - p.x, q.z - p.z) > 2.6);
      if (free(tx, ty) && clear && Math.hypot(p.x - r.center.x, p.z - r.center.z) > 3) r.spawners.push(p);
    }
  }

  // Painted set dressing: themed per room, placed with a hash-based RNG so the layout above is unchanged.
  const DECOR_R: Partial<Record<EnvPropId, number>> = { pillar_broken: 0.45, rubble_pile: 0.8, pillar_fallen: 0.7, pedestal_cracked: 0.4, statue_knight: 0.5, arch_fragment: 0.6, sarcophagus: 0.8, altar_offering: 0.9, obelisk_rune: 0.35, coffin_open: 0.6, offering_bowl: 0.4, barrels_stack: 0.55, throne_stone: 0.7, cage_iron: 0.65,
    candelabra: 0.35, crate_wood: 0.45, bones_pile: 0.4, stone_dais: 1.2, marble_chest: 0.55, marble_pedestal: 0.4, marble_column_spiral: 0.35, lotus_shrine: 0.6, rune_monolith: 0.5, marble_stairs: 1.0 };
  const hz = (a: number, b: number) => { const v = Math.sin(a * 127.1 + b * 311.7 + 7.7) * 43758.5453; return v - Math.floor(v); };
  // Zoned layout: every solid prop sits within two tiles of a wall, grouped into small vignettes, and the middle of the
  // room plus every doorway stays clear for combat. Hash-based RNG, so the layout above is unchanged.
  const isFloor = (tx: number, ty: number) => grid[ty * GRID + tx] === TileType.FLOOR;
  for (const r of rooms) {
    let n = 0;
    const rnd = () => hz(r.id * 31 + seedNum, n++);
    if (r.kind === 'combat') { const t = rnd(); r.theme = t < 0.35 ? 'crypt' : t < 0.65 ? 'sanctum' : 'ruin'; }
    const inRect = (tx: number, ty: number) => tx >= r.x && ty >= r.y && tx < r.x + r.w && ty < r.y + r.h;
    const near = (tx: number, ty: number, k: number, test: (x: number, y: number) => boolean) => {
      for (let dy = -k; dy <= k; dy++) for (let dx = -k; dx <= k; dx++) if (test(tx + dx, ty + dy)) return true;
      return false;
    };
    const nearWall = (tx: number, ty: number, k: number) => near(tx, ty, k, (x, y) => !isFloor(x, y) && grid[y * GRID + x] !== TileType.PORTAL);
    const nearDoor = (tx: number, ty: number) => near(tx, ty, 2, (x, y) => !inRect(x, y) && isFloor(x, y));
    const keepOut: Vec2[] = [...r.pillars, ...r.braziers, ...r.monoliths, ...r.spawners, r.center];
    const push = (id: EnvPropId, p: Vec2, yaw: number, ghost = false, y?: number, solid = true) => {
      const rad = ghost || !solid ? 0 : DECOR_R[id] ?? 0.5;
      r.decor.push({ id, x: p.x, z: p.z, yaw, r: rad, ghost: ghost || undefined, y });
      if (!ghost) keepOut.push(p);
    };
    /** Place one prop; `wall` = back against the wall facing the room, `at` = stay within ~2 tiles of that point (cluster). */
    const place = (id: EnvPropId, wall: boolean, ghost = false, at?: Vec2): Vec2 | null => {
      for (let tries = 0; tries < 40; tries++) {
        let tx: number, ty: number;
        if (at) { tx = worldToTile(at.x) + Math.round((rnd() - 0.5) * 4); ty = worldToTile(at.z) + Math.round((rnd() - 0.5) * 4); }
        else { tx = Math.floor(r.x + rnd() * r.w); ty = Math.floor(r.y + rnd() * r.h); }
        if (!inRect(tx, ty) || !isFloor(tx, ty)) continue;
        if (!ghost && (!nearWall(tx, ty, wall ? 1 : 2) || nearDoor(tx, ty))) continue;
        const p: Vec2 = { x: tileToWorld(tx) + (rnd() - 0.5) * 0.6, z: tileToWorld(ty) + (rnd() - 0.5) * 0.6 };
        const rad = ghost ? 0 : DECOR_R[id] ?? 0.5;
        if (!ghost && keepOut.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < rad + (at ? 1.1 : 1.7))) continue;
        if (r.kind === 'boss' && Math.hypot(p.x - r.center.x, p.z - r.center.z) < 4) continue;
        const yaw = wall ? Math.atan2(r.center.x - p.x, r.center.z - p.z) + (rnd() - 0.5) * 0.5 : rnd() * Math.PI * 2;
        push(id, p, yaw, ghost);
        return p;
      }
      return null;
    };
    /** A vignette: the first prop finds a wall spot, the rest gather around it. */
    const group = (ids: Array<[EnvPropId, boolean]>) => {
      const a = place(ids[0][0], ids[0][1]);
      for (const [id, wall] of ids.slice(1)) a ? place(id, wall, false, a) : place(id, wall);
    };
    /** Throne set piece against the back (-z) wall: dais, throne on top, candelabras, spiral columns, lotus shrines. */
    const throneRoom = () => {
      const ty = r.y + 1, cxT = Math.round(r.x + r.w / 2 - 0.5);
      for (const off of [0, 2, -2, 3, -3]) {
        const tx = cxT + off;
        if (!isFloor(tx, ty) || !isFloor(tx, ty + 1)) continue;
        const p = { x: tileToWorld(tx), z: tileToWorld(ty) };
        if ([...r.monoliths, ...r.spawners].some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 3.4)) continue;
        r.pillars = r.pillars.filter((q) => Math.hypot(q.x - p.x, q.z - p.z) > 3.6);
        r.braziers = r.braziers.filter((q) => Math.hypot(q.x - p.x, q.z - p.z) > 3.6);
        push('stone_dais', p, 0);
        push('throne_stone', { x: p.x, z: p.z - 0.55 }, 0, false, 0.67, false);
        for (const s of [-1, 1]) {
          push('candelabra', { x: p.x + s * 1.0, z: p.z + 0.75 }, 0, false, 0.67, false);
          push('marble_column_spiral', { x: p.x + s * 1.85, z: p.z - 0.6 }, 0);
          if (isFloor(tx + s * 3, ty)) push('lotus_shrine', { x: p.x + s * 3.4, z: p.z + 0.2 }, 0);
        }
        return true;
      }
      return false;
    };
    if (r.kind === 'start') {
      group([['barrels_stack', true], ['crate_wood', true], ['crate_wood', false]]);
      group([['rubble_pile', true], ['pillar_fallen', false]]);
      place('bones_pile', false); place('candelabra', true);
      continue;
    }
    if (r.kind === 'boss') {
      if (!throneRoom()) { place('stone_dais', false); place('throne_stone', true); }
      group([['statue_knight', true], ['obelisk_rune', true], ['candelabra', true]]);
      group([['statue_knight', true], ['obelisk_rune', true]]);
      group([['sarcophagus', true], ['offering_bowl', false], ['rubble_pile', true]]);
      group([['sarcophagus', true], ['altar_offering', true]]);
      group([['rune_monolith', true], ['marble_column_spiral', true]]);
      place('rune_monolith', true); place('rubble_pile', true);
    } else if (r.theme === 'crypt') {
      group([['sarcophagus', true], ['candelabra', true], ['bones_pile', false]]);
      group([['sarcophagus', true], ['coffin_open', true]]);
      group([['obelisk_rune', true], ['offering_bowl', false], ['candelabra', true]]);
      place('cage_iron', true); place('bones_pile', false);
    } else if (r.theme === 'sanctum') {
      group([['marble_column_spiral', true], ['marble_pedestal', true], ['marble_column_spiral', true]]);
      group([['lotus_shrine', false], ['rune_monolith', true]]);
      group([['marble_chest', true], ['candelabra', true]]);
      group([['statue_knight', true], ['marble_stairs', true]]);
      place('lotus_shrine', false);
    } else {
      group([['pillar_broken', true], ['rubble_pile', true], ['pillar_fallen', false]]);
      group([['barrels_stack', true], ['crate_wood', true], ['crate_wood', false]]);
      if (rnd() < 0.5) place('arch_fragment', true); else group([['pedestal_cracked', true], ['statue_knight', true]]);
      group([['marble_chest', true], ['bones_pile', false]]);
      place('rubble_pile', true);
    }
    place('arch_spectral', true, true); place('brazier_blue', false, true);
  }

  // Remove dressing that landed on bridge tiles, then wall off everything adjacent to walkable space
  const walls: number[] = [];
  for (let y = 1; y < GRID - 1; y++) for (let x = 1; x < GRID - 1; x++) {
    if (grid[y * GRID + x] !== TileType.VOID) continue;
    let adj = false;
    for (let dy = -1; dy <= 1 && !adj; dy++) for (let dx = -1; dx <= 1; dx++) if (grid[(y + dy) * GRID + x + dx] !== TileType.VOID && grid[(y + dy) * GRID + x + dx] !== TileType.WALL) { adj = true; break; }
    if (adj) walls.push(y * GRID + x);
  }
  for (const i of walls) grid[i] = TileType.WALL;

  const start = rooms[0], boss = rooms[rooms.length - 1];
  const portal: Vec2 = { x: boss.center.x, z: boss.center.z };
  const pt = [worldToTile(portal.x), worldToTile(portal.z)];
  for (let dy = -1; dy <= 0; dy++) for (let dx = -1; dx <= 0; dx++) grid[(pt[1] + dy) * GRID + pt[0] + dx] = TileType.PORTAL;

  return { seed, grid, rooms, spawn: { x: start.center.x, z: start.center.z }, portal, bossRoom: boss.id, bridgeTiles };
}
