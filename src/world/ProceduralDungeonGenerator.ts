/** Seeded Mulberry32 + deterministic sunken-fortress floor generator. */

export const GRID = 80;
export const TILE = 2.5;

export enum TileType { VOID = 0, FLOOR = 1, WALL = 2, SPECTRAL_BRIDGE = 3, PORTAL = 4 }
export type RoomKind = 'start' | 'combat' | 'boss';
export type RoomShape = 'rect' | 'octagon';

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
export interface Room {
  id: number; kind: RoomKind; shape: RoomShape;
  x: number; y: number; w: number; h: number; // tile coords
  center: Vec2;                                // world coords
  pillars: Vec2[]; braziers: Vec2[]; monoliths: Vec2[]; spawners: Vec2[];
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
    rooms.push({ id: i, kind, shape, x, y, w, h, center: { x: tileToWorld(x + w / 2 - 0.5), z: tileToWorld(y + h / 2 - 0.5) }, pillars: [], braziers: [], monoliths: [], spawners: [] });
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
