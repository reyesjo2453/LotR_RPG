import * as THREE from 'three';
import { gsap } from 'gsap';
import { assets } from './assets/AssetRegistry';
import type { Animator, CharacterId } from './assets/ProceduralAssetFallback';
import { FX, type Glyph, type Telegraph } from './combat/FX';
import { HEROES, type Strike } from './combat/heroes';
import { sfx } from './audio/SoundFX';
import { InputManager, type InputFrame } from './input/InputManager';
import { sharedUniforms, VeilRippleOverlay } from './shaders/ToonRealm';
import { HUDManager, type BossHud, type FloatKind } from './ui/HUDManager';
import { Tutorial } from './tutorial/Tutorial';
import { TutorialUI } from './ui/TutorialUI';
import { DungeonInstancer, type MonolithRef } from './world/DungeonInstancer';
import { generateDungeon, GRID, roomAt, tileAt, TileType, walkable, worldToTile, type Dungeon, type Room } from './world/ProceduralDungeonGenerator';
import { realm } from './world/RealmManager';

type EKind = 'hound' | 'knight' | 'boss';
type EState = 'spawn' | 'chase' | 'telegraph' | 'recover' | 'broken';

interface Enemy {
  kind: EKind; name: string; anim: Animator; root: THREE.Group;
  x: number; z: number; kx: number; kz: number; yaw: number;
  hp: number; maxHp: number; posture: number; maxPosture: number;
  state: EState; t: number; brokenDur: number; cd: number;
  speed: number; dmg: number; range: number; radius: number; height: number;
  tele: Telegraph | null; slam: boolean; attacks: number;
  room: Room; links: MonolithRef[]; dead: boolean; summons: number;
  bar: THREE.Group; barHp: THREE.Mesh; barPost: THREE.Mesh; hitFlash: number;
  tut?: 'effigy' | 'shade'; marks: number;
}
interface Bolt { mesh: THREE.Mesh; x: number; z: number; dx: number; dz: number; life: number; hit: Set<Enemy | MonolithRef> }
interface Atk { strike: Strike; special: boolean; t: number; hit: boolean; yaw: number }
interface HeroState { hp: number; energy: number; alive: boolean }
interface RoomRun { entered: boolean; wave: number; cleared: boolean }

const MAX_ENERGY = 100;
const PHYS_TETHER_FACTOR = 0.15; // 85% reduced physical damage
const CAM_OFFSET = (() => {
  const pitch = 30 * Math.PI / 180, yaw = 45 * Math.PI / 180, d = 40;
  return new THREE.Vector3(Math.cos(pitch) * Math.sin(yaw) * d, Math.sin(pitch) * d, Math.cos(pitch) * Math.cos(yaw) * d);
})();
const S2 = Math.SQRT1_2;

const lerpAngle = (a: number, b: number, t: number) => { let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI; if (d < -Math.PI) d += Math.PI * 2; return a + d * t; };
const angDiff = (a: number, b: number) => { let d = ((a - b + Math.PI) % (Math.PI * 2)) - Math.PI; if (d < -Math.PI) d += Math.PI * 2; return Math.abs(d); };

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 1, 200);
  private overlay = new VeilRippleOverlay();
  private fx = new FX();
  private hud: HUDManager;
  private tut!: Tutorial;
  private tutWanted = Tutorial.shouldRun();
  private tutRestart = false;
  private tutTarget: Enemy | null = null;
  private input: InputManager;
  private inst!: DungeonInstancer;
  private dungeon!: Dungeon;
  private hemi = new THREE.HemisphereLight(0xd6c9bb, 0x2a2434, 0.9);
  private sun = new THREE.DirectionalLight(0xffe8c8, 0.8);
  private enemyLayer = new THREE.Group();
  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  // run state
  floor = 1; seed = '';
  private heroes: HeroState[] = [];
  private enemies: Enemy[] = [];
  private bolts: Bolt[] = [];
  private runs = new Map<number, RoomRun>();
  private explored = new Uint8Array(GRID * GRID);
  private portalActive = false;
  private gameOverT = -1;

  // player
  private p = {
    x: 0, z: 0, ix: 0, iz: 0, yaw: 0, hero: 0, root: new THREE.Group(), anims: [] as Animator[],
    dashT: 0, dashCd: 0, dashDir: { x: 0, z: 1 }, ghostT: 0, iframes: 0, atk: null as Atk | null, comboIdx: 0, comboT: 0, buffered: 0,
    momentum: 0, momT: 0, momCd: 0, crits: 0, dashStrikeT: 0, dashI: 0, charge: 0, charging: false, chargePulse: 0, guard: false, guardT: 0, counterT: 0, stunT: 0, dashHit: new Set<Enemy>(), guardFx: 0,
    parryT: 0, parryCd: 0, flurryT: 0, flurryTick: 0, swapCd: 0, boltCd: 0, speedNow: 0, mouseAim: false, hurtT: 0, shield: new THREE.Group(),
  };

  // juice
  private hitstop = 0; private punch = { x: 0, z: 0 }; private zoomPulse = 0; private slow = 0; private trauma = 0; private camPos = new THREE.Vector3(); private time = 0;
  private barGeo = new THREE.PlaneGeometry(1, 1).translate(0.5, 0, 0);
  private barBg = new THREE.MeshBasicMaterial({ color: 0x050308, transparent: true, opacity: 0.8, depthTest: false });
  private barHpMat = new THREE.MeshBasicMaterial({ color: 0xff3a50, depthTest: false });
  private barPostMat = new THREE.MeshBasicMaterial({ color: 0xffd25a, depthTest: false });
  private frameCount = 0; private fpsAcc = 0; fps = 0;
  private running = true;

  constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.autoClear = false;
    this.scene.background = new THREE.Color(0x07060a);
    this.scene.fog = new THREE.Fog(0x07060a, 45, 90);
    this.sun.position.set(-6, 14, 4);
    this.scene.add(this.hemi, this.sun, this.fx.group, this.enemyLayer, this.p.root);

    this.input = new InputManager(canvas);
    this.hud = new HUDManager(uiRoot, { onSwap: (i) => this.input.requestSwap(i), onNewSeed: () => this.input.requestNewSeed(), onTutorial: () => this.restartTutorial() });
    this.tut = new Tutorial({
      scene: this.scene,
      spawnTarget: (k) => this.spawnTutorialTarget(k),
      clearTargets: () => this.clearTutorialTargets(),
      targetPos: () => (this.tutTarget && !this.tutTarget.dead ? { x: this.tutTarget.x, z: this.tutTarget.z } : null),
      refillEnergy: () => this.heroes.forEach((h) => { h.energy = MAX_ENERGY; }),
      restoreHeroes: () => this.heroes.forEach((h, i) => { h.hp = HEROES[i].maxHp; h.energy = MAX_ENERGY; h.alive = true; }),
      project: (x, y, z) => { const v = new THREE.Vector3(x, y, z).project(this.camera); return { x: (v.x * 0.5 + 0.5) * window.innerWidth, y: (-v.y * 0.5 + 0.5) * window.innerHeight, behind: v.z > 1 }; },
      onFinish: () => { this.tutWanted = false; setTimeout(() => this.tut.tip('vaelen'), 7500); },
    }, new TutorialUI(this.hud.centerTop, this.hud.root, { onSkip: () => this.tut.skip(), onDismiss: () => this.tut.dismissTip() }));
    this.input.onFirstGesture = () => sfx.unlock();
    this.input.onDeviceChange = (d) => this.hud.setHint(d);
    realm.onShift((u) => { this.tut.lastUnseen = u; this.tut.emit('realm'); sfx.realmShift(u); this.addTrauma(0.35); this.fx.shockwave(this.p.x, this.p.z, u ? 0x5dffc0 : 0xffc94a, 14, 0.8); });

    // player rigs: all three exist, only the active one is visible
    HEROES.forEach((h, i) => { const a = assets.createCharacter(h.id as CharacterId); a.root.visible = i === 0; this.p.root.add(a.root); this.p.anims.push(a); });
    this.resize();
    this.initZoomControls();
    window.addEventListener('resize', () => this.resize());
    window.visualViewport?.addEventListener('resize', () => this.resize());

    const urlSeed = new URLSearchParams(location.search).get('seed');
    this.newRun(urlSeed ?? String(Math.floor(Math.random() * 1_000_000)));
    this.hud.toast('CONCORD OF THE VEIL', 3200);
    this.hud.setHint(this.input.device);
    if (!this.tutWanted) setTimeout(() => this.tut.tip('vaelen'), 2500);
    // debugging / verification hook
    (window as unknown as { __game: Game }).__game = this;
  }

  // ───────────────────────── display ─────────────────────────
  /** Camera zoom multiplier on the view width: <1 closer, >1 farther. Persisted per device. */
  private zoom = (() => { try { const v = Number(localStorage.getItem('cotv.zoom')); return v >= 0.5 && v <= 1.8 ? v : 1; } catch { return 1; } })();
  setZoom(z: number): void {
    this.zoom = Math.min(1.8, Math.max(0.5, z));
    try { localStorage.setItem('cotv.zoom', String(this.zoom)); } catch { /* ignore */ }
    this.resize();
  }
  private initZoomControls(): void {
    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;right:calc(10px + env(safe-area-inset-right,0px));top:50%;transform:translateY(-50%);z-index:20;display:flex;flex-direction:column;gap:8px';
    for (const [label, f] of [['+', 0.85], ['−', 1 / 0.85]] as const) {
      const b = document.createElement('button');
      b.textContent = label; b.setAttribute('aria-label', f < 1 ? 'Zoom in' : 'Zoom out');
      b.style.cssText = 'width:44px;height:44px;border-radius:12px;border:1px solid rgba(220,200,140,.45);background:rgba(15,12,30,.55);color:#e8d9a8;font:600 22px Georgia,serif;touch-action:manipulation;cursor:pointer;-webkit-tap-highlight-color:transparent';
      b.addEventListener('click', () => this.setZoom(this.zoom * f));
      bar.appendChild(b);
    }
    document.body.appendChild(bar);
    window.addEventListener('wheel', (e) => { e.preventDefault(); this.setZoom(this.zoom * Math.exp(e.deltaY * 0.0012)); }, { passive: false });
    window.addEventListener('keydown', (e) => { if (e.key === '=' || e.key === '+') this.setZoom(this.zoom * 0.9); else if (e.key === '-' || e.key === '_') this.setZoom(this.zoom / 0.9); });
    // two-finger pinch anywhere that isn't the stick or a button
    let d0 = 0, z0 = 1;
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const free = (t: TouchList) => [...Array.from(t)].every((x) => !(x.target as HTMLElement).closest?.('#stick-zone, button, .card'));
    window.addEventListener('touchstart', (e) => { if (e.touches.length === 2 && free(e.touches)) { d0 = dist(e.touches); z0 = this.zoom; } else d0 = 0; }, { passive: true });
    window.addEventListener('touchmove', (e) => { if (d0 > 0 && e.touches.length === 2) this.setZoom(z0 * (d0 / Math.max(1, dist(e.touches)))); }, { passive: true });
    window.addEventListener('touchend', () => { d0 = 0; }, { passive: true });
  }

  resize(): void {
    const w = window.innerWidth, h = window.innerHeight, aspect = w / h;
    const pr = Math.min(window.devicePixelRatio || 1, 2.0);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.fx.setPixelRatio(pr); this.inst?.setPixelRatio(pr);
    // Frame ≥20 world-units across and ≥14 down so folded cover (10:16), unfolded tablet (4:3) and landscape all fit.
    const halfW = Math.max(6.4, 4.2 * aspect) * this.zoom, halfH = halfW / aspect;
    const shift = aspect < 1 ? 0.14 : 0.04; // keep the hero clear of the bottom thumb zones
    this.camera.left = -halfW; this.camera.right = halfW;
    this.camera.top = halfH * (1 - shift); this.camera.bottom = -halfH * (1 + shift);
    this.camera.updateProjectionMatrix();
  }

  /** Swing trail: follow each weapon blade while the hero is striking. */
  private feedTrails(): void {
    const p = this.p;
    if (!p.atk && p.flurryT <= 0) return;
    const blades = p.anims[p.hero].blades?.();
    blades?.forEach(([b, t], i) => this.fx.trailPush(i, b, t, this.def.color));
  }
  private addTrauma(v: number): void { this.trauma = Math.min(1, this.trauma + v); }
  private toScreen(x: number, y: number, z: number): { x: number; y: number } {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * window.innerWidth, y: (-v.y * 0.5 + 0.5) * window.innerHeight };
  }
  private say(x: number, y: number, z: number, text: string, kind: FloatKind = 'dmg'): void { const s = this.toScreen(x, y, z); this.hud.floatText(s.x, s.y, text, kind); }

  // ───────────────────────── floor lifecycle ─────────────────────────
  newRun(seed: string, keepHeroes = false): void {
    this.seed = seed;
    this.dungeon = generateDungeon(seed);
    this.inst?.dispose();
    this.inst = new DungeonInstancer(this.dungeon);
    this.inst.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.scene.add(this.inst.group);
    for (const e of this.enemies) this.removeEnemy(e, false);
    this.enemies = [];
    this.bolts.forEach((b) => this.fx.releaseBolt(b.mesh)); this.bolts = [];
    this.fx.clearAll();
    realm.reset();
    this.runs.clear(); this.explored.fill(0); this.portalActive = false; this.gameOverT = -1;
    if (!keepHeroes || this.heroes.length === 0) {
      this.heroes = HEROES.map((h) => ({ hp: h.maxHp, energy: 60, alive: true }));
      this.floor = keepHeroes ? this.floor : 1;
      this.setHero(0, true);
    } else this.heroes.forEach((s, i) => { if (s.alive) s.hp = Math.min(HEROES[i].maxHp, s.hp + HEROES[i].maxHp * 0.35); });
    this.p.x = this.dungeon.spawn.x; this.p.z = this.dungeon.spawn.z; this.p.ix = this.p.iz = 0;
    this.p.atk = null; this.p.comboIdx = 0; this.p.dashT = 0; this.p.flurryT = 0; this.p.iframes = 1;
    this.camPos.set(this.p.x, 0, this.p.z);
    this.tutTarget = null;
    if (this.tutWanted && this.floor === 1) { this.tut.begin(this.dungeon, this.tutRestart || !this.tut.active); this.tutRestart = false; }
    else this.hud.toast(`FLOOR ${this.floor} · THE SUNKEN CONCORD`, 2400);
    sfx.portal();
  }

  realmUnseen(): boolean { return realm.isUnseenRealm; }

  private restartTutorial(): void { this.tutWanted = true; this.tutRestart = true; this.rollSeed(); }

  private spawnTutorialTarget(kind: 'effigy' | 'shade'): void {
    if (this.tutTarget && !this.tutTarget.dead) return;
    const room = this.dungeon.rooms[0];
    const e = this.spawnEnemy('knight', room.center.x + 3.6, room.center.z, room);
    e.tut = kind; e.links = []; e.hp = e.maxHp = 99999;
    if (kind === 'effigy') { e.name = 'HOLLOW EFFIGY'; e.cd = 1e9; e.speed = 0; e.maxPosture = 1e9; }
    else { e.name = 'SPARRING SHADE'; e.dmg = 2; e.cd = 1.4; e.speed = 2.2; }
    this.tutTarget = e;
  }
  private clearTutorialTargets(): void { for (const e of this.enemies) if (e.tut && !e.dead) this.removeEnemy(e); this.tutTarget = null; }

  private nextFloor(): void { this.floor++; this.newRun(String(Math.floor(Math.random() * 1_000_000)), true); }
  private rollSeed(): void { this.floor = 1; this.heroes = []; this.newRun(String(Math.floor(Math.random() * 1_000_000))); }

  // ───────────────────────── enemies ─────────────────────────
  private spawnEnemy(kind: EKind, x: number, z: number, room: Room): Enemy {
    const id: CharacterId = kind === 'hound' ? 'barrow_hound' : 'castellan_knight';
    const anim = assets.createCharacter(id);
    const root = new THREE.Group(); root.add(anim.root);
    const boss = kind === 'boss', scale = boss ? 1.45 : 1;
    root.scale.setScalar(0.01);
    this.enemyLayer.add(root);
    const bar = new THREE.Group(), barBg = new THREE.Mesh(this.barGeo, this.barBg), barHp = new THREE.Mesh(this.barGeo, this.barHpMat), barPost = new THREE.Mesh(this.barGeo, this.barPostMat);
    barBg.scale.set(1.24, 0.17, 1); barBg.position.set(-0.62, 0, 0);
    barHp.scale.set(1.2, 0.11, 1); barHp.position.set(-0.6, 0, 0.01);
    barPost.scale.set(0, 0.06, 1); barPost.position.set(-0.6, -0.1, 0.01);
    [barBg, barHp, barPost].forEach((m) => { m.renderOrder = 20; bar.add(m); });
    this.enemyLayer.add(bar);
    const links = this.inst.monoliths.filter((m) => m.room === room && m.alive)
      .sort((a, b) => Math.hypot(a.pos.x - x, a.pos.z - z) - Math.hypot(b.pos.x - x, b.pos.z - z));
    const e: Enemy = {
      kind, name: boss ? 'MORVATH, CASTELLAN OF THE VEIL' : kind === 'knight' ? 'CASTELLAN KNIGHT' : 'BARROW HOUND', anim, root, x, z, kx: 0, kz: 0, yaw: 0,
      hp: boss ? 640 : kind === 'knight' ? 130 : 40, maxHp: boss ? 640 : kind === 'knight' ? 130 : 40,
      posture: 0, maxPosture: boss ? 130 : kind === 'knight' ? 60 : 28,
      state: 'spawn', t: 0, brokenDur: 2.8, cd: 0.6, speed: boss ? 2.9 : kind === 'knight' ? 3.3 : 5.4,
      dmg: boss ? 22 : kind === 'knight' ? 16 : 8, range: boss ? 3.5 : kind === 'knight' ? 2.7 : 1.9,
      radius: boss ? 0.95 : kind === 'knight' ? 0.6 : 0.5, height: anim.height * scale,
      tele: null, slam: false, attacks: 0, room, links: boss ? links : kind === 'knight' ? links.slice(0, 1) : [], dead: false, summons: 0,
      bar, barHp, barPost, hitFlash: 0, marks: 0,
    };
    root.userData.scale = scale;
    this.enemies.push(e);
    this.fx.shockwave(x, z, 0x8a5cff, 2.4, 0.5); this.fx.burst(x, 0.2, z, 0x9a70ff, 14, 4, 0.7);
    return e;
  }

  private removeEnemy(e: Enemy, animate = true): void {
    e.dead = true; this.fx.releaseTelegraph(e.tele); e.tele = null;
    this.enemyLayer.remove(e.bar);
    const done = () => this.enemyLayer.remove(e.root);
    if (animate) gsap.to(e.root.scale, { x: 0.01, y: 0.01, z: 0.01, duration: 0.4, ease: 'back.in(2)', onComplete: done }); else done();
  }

  private spawnWave(room: Room, wave: number): void {
    const sp = room.spawners.length ? room.spawners : [room.center];
    if (room.kind === 'boss') {
      this.spawnEnemy('boss', room.center.x, room.center.z - 4, room);
      this.hud.toast('MORVATH, CASTELLAN OF THE VEIL', 3200);
      sp.forEach((s) => { this.spawnEnemy('hound', s.x, s.z, room); });
      return;
    }
    if (wave === 1) {
      this.spawnEnemy('knight', sp[0].x, sp[0].z, room);
      sp.slice(1).forEach((s, i) => { this.spawnEnemy('hound', s.x, s.z, room); if (i === 0 || room.id > 2) this.spawnEnemy('hound', s.x + 1.2, s.z + 0.6, room); });
      this.hud.toast('THE VEIL STIRS', 1600);
    } else {
      sp.forEach((s, i) => { this.spawnEnemy('hound', s.x, s.z, room); if (i % 2 === 0) this.spawnEnemy('hound', s.x - 1.2, s.z, room); });
      if (room.id >= 3) this.spawnEnemy('knight', sp[sp.length - 1].x, sp[sp.length - 1].z + 1.5, room);
      this.hud.toast('A SECOND WAVE RISES', 1600);
    }
  }

  private tetherCount(e: Enemy): number { let n = 0; for (const m of e.links) if (m.alive) n++; return n; }

  // ───────────────────────── collision ─────────────────────────
  private isWalk(x: number, z: number, player: boolean): boolean {
    return walkable(this.dungeon, x, z, player && realm.isUnseenRealm);
  }
  private blocked(x: number, z: number, r: number, player: boolean): boolean {
    return !this.isWalk(x - r, z - r, player) || !this.isWalk(x + r, z - r, player) || !this.isWalk(x - r, z + r, player) || !this.isWalk(x + r, z + r, player);
  }
  private slide(x: number, z: number, dx: number, dz: number, r: number, player: boolean): [number, number] {
    if (!this.blocked(x + dx, z, r, player)) x += dx;
    if (!this.blocked(x, z + dz, r, player)) z += dz;
    // solid props: pillars, braziers, standing runestones
    const room = roomAt(this.dungeon, x, z);
    if (room) {
      const push = (cx: number, cz: number, rad: number) => {
        const ox = x - cx, oz = z - cz, d = Math.hypot(ox, oz), min = rad + r;
        if (d < min && d > 1e-4) { const nx = x + (ox / d) * (min - d), nz = z + (oz / d) * (min - d); if (!this.blocked(nx, nz, r, player)) { x = nx; z = nz; } }
      };
      for (const q of room.pillars) push(q.x, q.z, 0.5);
      for (const q of room.braziers) push(q.x, q.z, 0.38);
      for (const m of this.inst.monoliths) if (m.alive && m.room === room) push(m.pos.x, m.pos.z, 0.6);
    }
    return [x, z];
  }

  // ───────────────────────── player actions ─────────────────────────
  private get def() { return HEROES[this.p.hero]; }
  private get hs() { return this.heroes[this.p.hero]; }
  private get astral(): boolean { return this.def.id === 'seraphina' || realm.isUnseenRealm; }

  private setHero(i: number, silent = false): void {
    this.p.hero = i;
    this.p.anims.forEach((a, k) => { a.root.visible = k === i; });
    if (!silent) {
      const c = HEROES[i].color;
      this.fx.shockwave(this.p.x, this.p.z, c, 5.5, 0.5); this.fx.burst(this.p.x, 1, this.p.z, c, 26, 7, 0.6);
      sfx.swap(); this.addTrauma(0.2);
    }
  }

  private swapHero(i: number): void {
    if (i === this.p.hero || !this.heroes[i]?.alive || this.p.swapCd > 0 || this.gameOverT >= 0) return;
    this.p.swapCd = 0.25; this.p.atk = null; this.p.comboIdx = 0; this.p.flurryT = 0; this.p.iframes = Math.max(this.p.iframes, 0.3);
    this.setHero(i);
    this.tut.emit('swap');
    this.tut.tip(HEROES[i].id as 'vaelen' | 'seraphina' | 'kaelen');
  }

  private aimDir(frame: InputFrame, assist: boolean): { x: number; z: number } | null {
    const toWorld = (v: { x: number; y: number }) => ({ x: S2 * (v.x - v.y), z: S2 * (-v.x - v.y) });
    if (frame.aim) { const w = toWorld(frame.aim), l = Math.hypot(w.x, w.z); if (l > 0.01) return { x: w.x / l, z: w.z / l }; }
    if (frame.mouse) {
      this.raycaster.setFromCamera(new THREE.Vector2(frame.mouse.x, frame.mouse.y), this.camera);
      const hit = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(this.groundPlane, hit)) { const dx = hit.x - this.p.x, dz = hit.z - this.p.z, l = Math.hypot(dx, dz); if (l > 0.3) return { x: dx / l, z: dz / l }; }
    }
    if (assist) {
      let best: { x: number; z: number } | null = null, bd = 6.5;
      for (const e of this.enemies) { if (e.dead || e.state === 'spawn') continue; const d = Math.hypot(e.x - this.p.x, e.z - this.p.z); if (d < bd) { bd = d; best = { x: (e.x - this.p.x) / d, z: (e.z - this.p.z) / d }; } }
      if (!best) for (const m of this.inst.monoliths) { if (!m.alive) continue; const d = Math.hypot(m.pos.x - this.p.x, m.pos.z - this.p.z); if (d < Math.min(bd, 4.5)) { bd = d; best = { x: (m.pos.x - this.p.x) / d, z: (m.pos.z - this.p.z) / d }; } }
      if (best) return best;
    }
    return null;
  }

  private startStrike(strike: Strike, special: boolean, frame: InputFrame): void {
    const dir = this.aimDir(frame, true) ?? { x: Math.sin(this.p.yaw), z: Math.cos(this.p.yaw) };
    this.p.yaw = Math.atan2(dir.x, dir.z);
    this.p.atk = { strike, special, t: 0, hit: false, yaw: this.p.yaw };
    this.p.anims[this.p.hero].play(strike === this.def.dashStrike ? 'stab' : special || this.def.ranged ? 'slash' : (`swing${(this.p.comboIdx % 4) + 1}` as 'swing1'), strike.dur);
    if (strike.lunge) { const k = 14; this.p.ix = dir.x * strike.lunge * k; this.p.iz = dir.z * strike.lunge * k; }
    if (!special && !this.def.ranged) {
      this.fx.slashArc(this.p.x, this.p.z, this.p.yaw, this.def.color, strike.radius * 0.98, strike.dur * 1.25, this.p.comboIdx % 2 === 1);
      sfx.swing();
    }
  }

  private tryAttack(frame: InputFrame, dt: number): void {
    if (this.def.ranged) { this.seraphinaAttack(frame, dt); return; }
    const wants = frame.attackPressed || frame.attackHeld;
    const a = this.p.atk;
    if (a) { if (frame.attackPressed && a.t > a.strike.dur * 0.4 && !a.special) this.p.buffered = 0.25; return; }
    if (!wants && this.p.buffered <= 0) return;
    this.p.buffered = 0;
    // Vaelen: attacking right after a dash lunges into a Dash Strike
    if (this.def.dashStrike && this.p.dashStrikeT > 0) {
      this.p.dashStrikeT = 0; this.p.comboIdx = 0;
      this.startStrike(this.def.dashStrike, false, frame);
      this.fx.slashArc(this.p.x, this.p.z, this.p.yaw, 0xffffff, 3.4, 0.3);
      this.say(this.p.x, 2.6, this.p.z, 'DASH STRIKE', 'info');
      return;
    }
    const idx = this.p.comboT > 0 ? this.p.comboIdx : 0;
    this.p.comboIdx = idx % this.def.combo.length;
    const base = this.def.combo[this.p.comboIdx];
    // Vaelen's combo accelerates with each link
    const strike = this.def.id === 'vaelen' ? { ...base, dur: base.dur * (1 - 0.09 * this.p.comboIdx) } : base;
    this.startStrike(strike, false, frame);
  }

  /** Seraphina: tap = arcane bolt (applies Unravel marks); hold = charge an Astral Lance. */
  private seraphinaAttack(f: InputFrame, dt: number): void {
    const p = this.p;
    const fire = () => { if (p.boltCd > 0 || p.atk) return; p.boltCd = 0.3; this.startStrike(this.def.combo[0], false, f); };
    if (f.attackPressed && !f.attackHeld) { p.charging = false; p.charge = 0; fire(); return; } // instant tap
    if (f.attackPressed && f.attackHeld && !p.atk) { p.charging = true; p.charge = 0; p.chargePulse = 0; }
    if (!p.charging) return;
    if (f.attackHeld) {
      p.charge += dt;
      p.chargePulse -= dt;
      if (p.charge > 0.25 && p.chargePulse <= 0) { p.chargePulse = 0.09; const a = Math.random() * 6.28; this.fx.burst(p.x + Math.cos(a) * 1.4, 1.1, p.z + Math.sin(a) * 1.4, 0xcaa8ff, 2, -3, 0.3, 7, 0); }
      if (p.charge >= 0.9 && p.charge - dt < 0.9) { this.fx.shockwave(p.x, p.z, 0xcaa8ff, 2.2, 0.3); sfx.glyph(); this.say(p.x, 2.6, p.z, 'LANCE READY', 'harm'); }
      return;
    }
    const charged = p.charge >= 0.9;
    p.charging = false; p.charge = 0;
    if (charged && this.hs.energy >= 15) { this.hs.energy -= 15; this.fireLance(f); } else fire();
  }

  private fireLance(f: InputFrame): void {
    const p = this.p;
    const dir = this.aimDir(f, true) ?? { x: Math.sin(p.yaw), z: Math.cos(p.yaw) };
    p.yaw = Math.atan2(dir.x, dir.z);
    p.atk = { strike: { dmg: 0, posture: 0, radius: 0, arc: 0, dur: 0.35, hitAt: 9, lunge: 0, kb: 0 }, special: true, t: 0, hit: true, yaw: p.yaw };
    p.anims[p.hero].play('slash', 0.35);
    const L = 15; let any = false;
    for (const e of [...this.enemies]) {
      if (e.dead || e.state === 'spawn') continue;
      const rx = e.x - p.x, rz = e.z - p.z, along = rx * dir.x + rz * dir.z, perp = Math.abs(rx * dir.z - rz * dir.x);
      if (along < 0 || along > L || perp > 1.0 + e.radius) continue;
      this.hitEnemy(e, { dmg: 40, posture: 26, astral: true, dx: dir.x, dz: dir.z, kb: 3, finisher: false });
      e.marks += 2; any = true; if (e.marks >= 3 && !e.dead) this.unravel(e);
    }
    for (const m of this.inst.monoliths) {
      if (!m.alive) continue;
      const rx = m.pos.x - p.x, rz = m.pos.z - p.z, along = rx * dir.x + rz * dir.z, perp = Math.abs(rx * dir.z - rz * dir.x);
      if (along > 0 && along < L && perp < 1.2) { this.hitMonolith(m, 65, true); any = true; }
    }
    for (let d = 1; d <= L; d += 1) this.fx.burst(p.x + dir.x * d, 1.3, p.z + dir.z * d, d % 2 ? 0xcaa8ff : 0x5dffc0, 3, 3, 0.45, 8, 0);
    this.fx.shockwave(p.x, p.z, 0xcaa8ff, 3, 0.4); this.fx.shockwave(p.x + dir.x * 3, p.z + dir.z * 3, 0x5dffc0, 4, 0.5);
    sfx.arcane(); sfx.shatter(); this.addTrauma(0.5);
    if (any) this.hitstop = Math.max(this.hitstop, 0.05);
    this.say(p.x, 2.8, p.z, 'ASTRAL LANCE', 'harm');
  }

  /** Three Unravel marks detonate in an astral burst. */
  private unravel(e: Enemy): void {
    e.marks = 0;
    this.fx.shockwave(e.x, e.z, 0xb36bff, 3.4, 0.45); this.fx.burst(e.x, e.height * 0.5, e.z, 0xb36bff, 24, 7, 0.6);
    sfx.arcane(); this.addTrauma(0.25);
    this.say(e.x, e.height + 1.1, e.z, 'UNRAVELED!', 'harm');
    for (const o of [...this.enemies]) {
      if (o.dead || o.state === 'spawn' || Math.hypot(o.x - e.x, o.z - e.z) > 2.8 + o.radius) continue;
      this.hitEnemy(o, { dmg: 26, posture: 22, astral: true, dx: o.x - e.x, dz: o.z - e.z, kb: 3, finisher: false, quiet: true });
    }
  }

  /** Vaelen's reward for dashing through a telegraphed strike. */
  private astralStep(): void {
    this.slow = 0.55; this.hs.energy = Math.min(MAX_ENERGY, this.hs.energy + 25);
    this.p.crits = 3; this.p.dashCd = 0; this.p.dashStrikeT = 0.6;
    this.fx.shockwave(this.p.x, this.p.z, 0x7fe8ff, 4, 0.5); this.fx.afterimage(this.p.x, this.p.z, this.p.yaw, 0x7fe8ff);
    sfx.swap(); this.addTrauma(0.2);
    this.say(this.p.x, 2.9, this.p.z, 'ASTRAL STEP!', 'parry');
  }

  private trySpecial(frame: InputFrame): void {
    const sp = this.def.special;
    if (this.p.atk && this.p.atk.special) return;
    if (this.p.flurryT > 0) return;
    if (this.hs.energy < sp.cost) { this.say(this.p.x, 2.4, this.p.z, 'NO ENERGY', 'info'); return; }
    this.hs.energy -= sp.cost;
    this.p.buffered = 0;
    // Harmonic detonation: Hero B special while standing in Hero A's glyph
    this.tryDetonate(sp.detBase);
    const dir = this.aimDir(frame, true) ?? { x: Math.sin(this.p.yaw), z: Math.cos(this.p.yaw) };
    this.p.yaw = Math.atan2(dir.x, dir.z);
    if (this.def.id === 'vaelen') {
      this.p.flurryT = sp.dur; this.p.flurryTick = 0; this.p.iframes = Math.max(this.p.iframes, sp.dur + 0.08);
      this.p.dashDir = dir; this.p.atk = null;
      this.p.anims[0].play('combo', sp.dur);
      sfx.dash(); sfx.clash(0.7);
      return;
    }
    this.p.atk = { strike: sp, special: true, t: 0, hit: false, yaw: this.p.yaw };
    this.p.anims[this.p.hero].play('slash', sp.dur);
    if (this.def.id === 'kaelen') this.fx.shockwave(this.p.x + dir.x, this.p.z + dir.z, 0xffd36a, 1.5, 0.5);
    else { this.fx.burst(this.p.x, 1.2, this.p.z, 0xb98cff, 20, 4, 0.5); sfx.arcane(); }
  }

  private dropGlyph(): void {
    const d = this.def;
    this.fx.addGlyph(this.p.x, this.p.z, d.glyphColor, this.p.hero);
    this.fx.burst(this.p.x, 0.3, this.p.z, d.glyphColor, 14, 3.5, 0.6);
    sfx.glyph(); this.tut.emit('glyph');
    this.say(this.p.x, 2.6, this.p.z, d.glyphName.toUpperCase(), 'info');
  }

  /** Consume a glyph dropped by another hero if standing inside it. */
  private tryDetonate(base: number): boolean {
    let found: Glyph | null = null;
    for (const g of this.fx.activeGlyphs) if (g.owner !== this.p.hero && Math.hypot(g.mesh.position.x - this.p.x, g.mesh.position.z - this.p.z) <= g.radius) { found = g; break; }
    if (!found) return false;
    const gx = found.mesh.position.x, gz = found.mesh.position.z, gc = (found.mesh.material as THREE.MeshBasicMaterial).color.getHex(), owner = found.owner;
    this.fx.removeGlyph(found);
    const R = 6.2, dmg = base * 2.5;
    for (const e of [...this.enemies]) {
      if (e.dead || e.state === 'spawn') continue;
      const dx = e.x - gx, dz = e.z - gz, d = Math.hypot(dx, dz);
      if (d <= R + e.radius) this.hitEnemy(e, { dmg, posture: 38, astral: true, dx: dx / (d || 1), dz: dz / (d || 1), kb: 10, finisher: false, quiet: true });
    }
    for (const m of this.inst.monoliths) if (m.alive && Math.hypot(m.pos.x - gx, m.pos.z - gz) <= R + 0.6) this.hitMonolith(m, 55, true);
    this.fx.shockwave(gx, gz, gc, R + 1, 0.6); this.fx.shockwave(gx, gz, HEROES[owner].color, R * 0.7, 0.45);
    this.fx.shockwave(gx, gz, this.def.color, R * 0.45, 0.35);
    this.fx.burst(gx, 0.6, gz, gc, 40, 12, 0.7); this.fx.burst(gx, 0.6, gz, 0xffffff, 18, 9, 0.5);
    this.hitstop = Math.max(this.hitstop, 0.06); this.addTrauma(0.85);
    sfx.detonate();
    this.say(gx, 2.9, gz, 'HARMONIC DETONATION!', 'harm');
    this.tut.emit('detonate');
    return true;
  }

  private tryDash(frame: InputFrame): void {
    if (this.p.dashCd > 0 || this.p.dashT > 0) return;
    let dx = frame.move.x, dz = frame.move.y;
    if (dx || dz) { const w = { x: S2 * (dx - dz), z: S2 * (-dx - dz) }, l = Math.hypot(w.x, w.z); dx = w.x / l; dz = w.z / l; } else { dx = Math.sin(this.p.yaw); dz = Math.cos(this.p.yaw); }
    const shield = this.def.id === 'kaelen'; // Shield Charge: super armor instead of i-frames
    this.p.dashDir = { x: dx, z: dz }; this.p.dashT = shield ? 0.26 : 0.18; this.p.dashCd = shield ? 0.9 : 0.6;
    if (!shield) { this.p.iframes = Math.max(this.p.iframes, 0.3); this.p.dashI = 0.26; }
    if (!shield) this.p.anims[this.p.hero].play('dodge', 0.3);
    this.p.dashHit.clear(); this.p.dashStrikeT = this.def.dashStrike ? 0.45 : 0;
    this.p.atk = null; this.p.comboIdx = 0; this.p.yaw = Math.atan2(dx, dz); this.p.ghostT = 0; this.p.charging = false;
    this.tut.emit('dash');
    this.fx.burst(this.p.x, 0.3, this.p.z, 0xffffff, 8, 3, 0.35);
    sfx.dash();
  }

  private tryParry(): void {
    if (this.p.parryCd > 0) return;
    const kael = this.def.id === 'kaelen';
    this.p.parryT = kael ? 0.5 : 0.35; this.p.parryCd = kael ? 0.35 : 0.55;
    this.fx.shockwave(this.p.x, this.p.z, kael ? 0x35e0ff : 0xbfe9ff, kael ? 2.4 : 1.8, 0.3);
    this.p.anims[this.p.hero].play('slash', 0.25);
    sfx.swing();
  }

  private tryRealm(): void {
    if (realm.isUnseenRealm && tileAt(this.dungeon, worldToTile(this.p.x), worldToTile(this.p.z)) === TileType.SPECTRAL_BRIDGE) {
      this.say(this.p.x, 2.4, this.p.z, 'THE BRIDGE HOLDS ONLY IN THE PALE', 'info'); return;
    }
    realm.toggle();
  }

  // ───────────────────────── damage ─────────────────────────
  private hitMonolith(m: MonolithRef, dmg: number, astral: boolean): void {
    if (!m.alive) return;
    const y = 1.6;
    if (!astral) { this.fx.sparks(m.pos.x, y, m.pos.z, 8); sfx.clash(0.4); this.say(m.pos.x, 3.2, m.pos.z, 'ASTRAL ONLY', 'info'); return; }
    m.hp -= dmg; this.fx.burst(m.pos.x, y, m.pos.z, 0x9affd8, 12, 5, 0.5); sfx.hit();
    if (m.hp > 0) return;
    this.inst.shatterMonolith(m.index);
    this.fx.shockwave(m.pos.x, m.pos.z, 0x5dffc0, 5, 0.6); this.fx.burst(m.pos.x, y, m.pos.z, 0x5dffc0, 36, 9, 0.8); this.fx.burst(m.pos.x, y, m.pos.z, 0x8a5cff, 20, 7, 0.8);
    sfx.shatter(); this.addTrauma(0.5); this.hitstop = Math.max(this.hitstop, 0.05);
    this.say(m.pos.x, 3.4, m.pos.z, 'TETHER SEVERED!', 'sever'); this.tut.emit('sever');
    for (const e of this.enemies) if (!e.dead && e.links.includes(m)) this.breakEnemy(e, this.tetherCount(e) === 0 ? 3.4 : 1.4, false);
  }

  private breakEnemy(e: Enemy, dur = 2.8, announce = true): void {
    if (e.dead || e.state === 'spawn') return;
    this.fx.releaseTelegraph(e.tele); e.tele = null;
    e.state = 'broken'; e.t = 0; e.brokenDur = dur; e.posture = e.maxPosture;
    e.anim.play('hit', 0.4);
    if (announce) { this.say(e.x, e.height + 0.8, e.z, 'BREAK!', 'break'); sfx.breakSfx(); this.addTrauma(0.3); if (!e.tut) this.tut.tip('break'); }
    this.fx.burst(e.x, e.height * 0.6, e.z, 0xffd25a, 20, 7, 0.5);
  }

  private hitEnemy(e: Enemy, o: { dmg: number; posture: number; astral: boolean; dx: number; dz: number; kb: number; finisher: boolean; quiet?: boolean; crit?: boolean }): void {
    if (e.dead || e.state === 'spawn') return;
    let dmg = o.dmg, post = o.posture;
    if (this.tetherCount(e) > 0 && !o.astral) { dmg *= PHYS_TETHER_FACTOR; post *= 0.3; }
    let label = '', kind: FloatKind = 'dmg';
    if (e.state === 'broken') {
      if (o.finisher) { dmg *= 3; label = 'FELLOWSHIP FINISHER! '; kind = 'crit'; e.state = 'recover'; e.t = 0; e.posture = 0; this.fx.shockwave(e.x, e.z, 0xffffff, 4, 0.5); HEROES.forEach((h, i) => this.fx.shockwave(e.x, e.z, h.color, 2.2 + i, 0.4 + i * 0.1)); sfx.detonate(); this.addTrauma(0.6); this.hitstop = Math.max(this.hitstop, 0.07); }
      else dmg *= 1.5;
    } else if (o.crit || Math.random() < 0.12) { dmg *= 1.6; label = 'CRIT! '; kind = 'crit'; }
    e.hp -= dmg;
    e.hitFlash = 0.12;
    if (e.tut === 'effigy') this.tut.emit('hit');
    e.kx += o.dx * o.kb * (e.kind === 'boss' ? 0.3 : e.kind === 'knight' ? 0.7 : 1.2); e.kz += o.dz * o.kb * (e.kind === 'boss' ? 0.3 : e.kind === 'knight' ? 0.7 : 1.2);
    {
      const power = (o.finisher ? 1.8 : label ? 1.4 : 1) * (e.kind === 'boss' ? 1.2 : 1);
      this.fx.impact(e.x - o.dx * e.radius * 0.5, e.height * 0.55, e.z - o.dz * e.radius * 0.5, o.dx, o.dz, o.astral ? 0xc6a0ff : this.def.color, power);
      this.punch.x += o.dx * 0.16 * power; this.punch.z += o.dz * 0.16 * power; // camera shoves along the blow
      this.zoomPulse = Math.min(0.06, this.zoomPulse + 0.018 * power);
      if (label) this.hitstop = Math.max(this.hitstop, 0.03 * power);
    }
    if (!o.quiet) { sfx.hit(); if (o.finisher || o.kb > 5) sfx.clash(1); }
    this.say(e.x, e.height + 0.4, e.z, `${label}${Math.max(1, Math.round(dmg))}`, kind);
    if (e.state !== 'broken' && e.state !== 'telegraph') e.anim.play('hit', 0.25);
    if (e.state !== 'broken') {
      e.posture += post;
      if (e.posture >= e.maxPosture) this.breakEnemy(e, e.kind === 'boss' ? 2.6 : 3);
    }
    if (e.kind === 'boss') {
      const frac = e.hp / e.maxHp;
      if ((e.summons === 0 && frac < 0.66) || (e.summons === 1 && frac < 0.33)) {
        e.summons++;
        this.say(e.x, e.height + 1.4, e.z, 'THE VEIL ANSWERS', 'info');
        for (let i = 0; i < 2; i++) { const a = Math.random() * 6.28; this.spawnEnemy('hound', e.x + Math.cos(a) * 4, e.z + Math.sin(a) * 4, e.room); }
      }
    }
    if (e.hp <= 0) this.killEnemy(e);
  }

  private killEnemy(e: Enemy): void {
    if (e.dead) return;
    this.fx.burst(e.x, e.height * 0.5, e.z, 0xb98cff, 34, 8, 0.8); this.fx.burst(e.x, e.height * 0.5, e.z, 0x5dffc0, 14, 5, 0.7);
    this.fx.shockwave(e.x, e.z, 0xb98cff, e.kind === 'boss' ? 8 : 3, 0.5);
    this.hitstop = Math.max(this.hitstop, e.kind === 'boss' ? 0.14 : 0.04);
    this.removeEnemy(e);
    for (const h of this.heroes) h.energy = Math.min(MAX_ENERGY, h.energy + (e.kind === 'hound' ? 4 : 10));
    if (e.kind === 'boss') {
      this.portalActive = true; this.inst.setPortalActive(true);
      this.slow = 0.9; this.addTrauma(1);
      for (const o of this.enemies) if (!o.dead && o !== e) this.killEnemy(o);
      this.hud.toast('THE CASTELLAN FALLS · THE VEIL PARTS', 4000); sfx.portal();
      this.say(e.x, 3.4, e.z, 'VICTORY!', 'crit');
    }
  }

  private hurtPlayer(dmg: number, fromX: number, fromZ: number): void {
    const hs = this.hs, kael = this.def.id === 'kaelen';
    const armor = kael && (this.p.atk !== null || this.p.dashT > 0); // super armor: swings and charges can't be interrupted
    if (kael) dmg *= 0.8;                                            // Fortitude
    if (armor) dmg *= 0.7;
    if (this.tut.active) dmg = Math.min(dmg, 3);
    hs.hp -= dmg;
    if (this.tut.active) hs.hp = Math.max(1, hs.hp);
    this.p.hurtT = 0.25; this.p.iframes = armor ? 0.35 : 0.5; this.p.momentum = 0;
    const dx = this.p.x - fromX, dz = this.p.z - fromZ, d = Math.hypot(dx, dz) || 1;
    if (!armor) { this.p.ix += (dx / d) * 9; this.p.iz += (dz / d) * 9; this.p.atk = null; this.p.anims[this.p.hero].play('hit', 0.3); }
    else this.say(this.p.x, 3.1, this.p.z, 'SUPER ARMOR', 'info');
    this.hud.hurtFlash(); sfx.hurt(); this.addTrauma(armor ? 0.25 : 0.45);
    this.say(this.p.x, 2.4, this.p.z, `-${Math.round(dmg)}`, 'hurt');
    this.fx.burst(this.p.x, 1, this.p.z, 0xff4060, 10, 5, 0.4);
    if (hs.hp <= 0) {
      hs.hp = 0; hs.alive = false;
      this.say(this.p.x, 3, this.p.z, `${this.def.name} FALLS`, 'hurt');
      const next = this.heroes.findIndex((h) => h.alive);
      if (next >= 0) { this.p.swapCd = 0; this.swapHero(next); this.p.iframes = 1.2; }
      else { this.gameOverT = 3.2; this.hud.toast('THE CONCORD FALLS', 3000); }
    }
  }

  /** Chip damage taken through Kaelen's shield (no flinch). */
  private hurtGuarded(dmg: number): void {
    const hs = this.hs;
    if (this.tut.active) dmg = Math.min(dmg, 1);
    hs.hp = Math.max(this.tut.active ? 1 : 0, hs.hp - dmg * 0.8);
    this.say(this.p.x, 2.2, this.p.z, `-${Math.round(dmg * 0.8)}`, 'hurt');
    if (hs.hp <= 0) { hs.hp = 0; hs.alive = false; const next = this.heroes.findIndex((h) => h.alive); if (next >= 0) { this.p.swapCd = 0; this.swapHero(next); } else { this.gameOverT = 3.2; this.hud.toast('THE CONCORD FALLS', 3000); } }
  }

  private perfectDeflect(e: Enemy): void {
    const mx = (this.p.x + e.x) / 2, mz = (this.p.z + e.z) / 2;
    sfx.parry(); this.fx.sparks(mx, 1.4, mz, 40); this.fx.shockwave(mx, mz, 0xffffff, 3.5, 0.4);
    this.slow = 0.35; this.addTrauma(0.4);
    this.say(this.p.x, 2.8, this.p.z, 'PERFECT DEFLECTION!', 'parry');
    this.breakEnemy(e, e.kind === 'boss' ? 3.2 : 3.6);
    this.hs.energy = Math.min(MAX_ENERGY, this.hs.energy + 20);
    this.p.parryT = 0;
    if (this.def.id === 'kaelen') { this.p.counterT = 2.2; this.say(this.p.x, 3.3, this.p.z, 'RIPOSTE READY', 'info'); }
    this.tut.emit('deflect');
  }

  // ───────────────────────── strike resolution ─────────────────────────
  private enemiesIn(x: number, z: number, radius: number, yaw: number, arc: number): Enemy[] {
    const out: Enemy[] = [];
    for (const e of this.enemies) {
      if (e.dead || e.state === 'spawn') continue;
      const dx = e.x - x, dz = e.z - z, d = Math.hypot(dx, dz);
      if (d > radius + e.radius) continue;
      if (arc < Math.PI * 2 - 0.01 && d > 0.6 && angDiff(Math.atan2(dx, dz), yaw) > arc / 2 + Math.atan2(e.radius, Math.max(d, 0.5))) continue;
      out.push(e);
    }
    return out;
  }

  private area(x: number, z: number, radius: number, yaw: number, arc: number, s: Strike, finisher: boolean, extraMono = 0): boolean {
    const astral = this.astral, p = this.p, id = this.def.id;
    const crit = id === 'vaelen' && p.crits > 0;
    const rip = id === 'kaelen' && p.counterT > 0;
    const dmgMul = (id === 'vaelen' ? 1 + 0.06 * p.momentum : 1) * (rip ? 1.6 : 1);
    let any = false;
    for (const e of this.enemiesIn(x, z, radius, yaw, arc)) {
      const dx = e.x - x, dz = e.z - z, d = Math.hypot(dx, dz) || 1;
      this.hitEnemy(e, { dmg: s.dmg * dmgMul, posture: s.posture * (rip ? 2.2 : 1), astral, dx: dx / d, dz: dz / d, kb: s.kb * (rip ? 1.5 : 1), finisher, crit });
      any = true;
    }
    if (any && id === 'vaelen' && p.momCd <= 0) { p.momCd = 0.12; p.momentum = Math.min(5, p.momentum + 1); p.momT = 4; }
    if (any && crit) p.crits--;
    if (any && rip) { p.counterT = 0; this.say(p.x, 2.8, p.z, 'RIPOSTE!', 'parry'); }
    for (const m of this.inst.monoliths) {
      if (!m.alive) continue;
      const dx = m.pos.x - x, dz = m.pos.z - z, d = Math.hypot(dx, dz);
      if (d > radius + 0.6) continue;
      if (arc < Math.PI * 2 - 0.01 && d > 0.8 && angDiff(Math.atan2(dx, dz), yaw) > arc / 2 + 0.3) continue;
      this.hitMonolith(m, s.dmg * 0.9 + extraMono, astral); any = true;
    }
    return any;
  }

  private resolveAtk(a: Atk): void {
    const s = a.strike, id = this.def.id;
    if (this.def.ranged && !a.special) {
      const mesh = this.fx.acquireBolt(0xcaa8ff);
      if (mesh) {
        const dx = Math.sin(a.yaw), dz = Math.cos(a.yaw);
        this.bolts.push({ mesh, x: this.p.x + dx * 0.8, z: this.p.z + dz * 0.8, dx, dz, life: 1.1, hit: new Set() });
        this.fx.burst(this.p.x + dx, 1.3, this.p.z + dz, 0xcaa8ff, 6, 3, 0.3);
        sfx.arcane();
      }
      return;
    }
    if (a.special) {
      const sp = this.def.special;
      if (id === 'seraphina') {
        this.area(this.p.x, this.p.z, sp.radius, 0, Math.PI * 2, sp, true, 40);
        this.fx.shockwave(this.p.x, this.p.z, 0xb98cff, sp.radius + 0.5, 0.55); this.fx.shockwave(this.p.x, this.p.z, 0x5dffc0, sp.radius * 0.7, 0.4);
        this.fx.burst(this.p.x, 1.2, this.p.z, 0xb98cff, 36, 9, 0.7); sfx.arcane(); sfx.shatter(); this.addTrauma(0.4);
      } else {
        const hx = this.p.x + Math.sin(a.yaw) * 1.4, hz = this.p.z + Math.cos(a.yaw) * 1.4;
        this.area(hx, hz, sp.radius, 0, Math.PI * 2, sp, true);
        this.fx.shockwave(hx, hz, 0xffd36a, sp.radius + 0.5, 0.5); this.fx.shockwave(hx, hz, 0x35e0ff, sp.radius * 0.6, 0.4);
        this.fx.burst(hx, 0.4, hz, 0xffd36a, 30, 8, 0.6, 10, 12); sfx.slam(); this.addTrauma(0.65); this.hitstop = Math.max(this.hitstop, 0.05);
      }
      this.dropGlyph();
      return;
    }
    if (s.finisher) this.tryDetonate(s.dmg);
    const any = this.area(this.p.x, this.p.z, s.radius, a.yaw, s.arc, s, !!s.finisher);
    const w = id === 'kaelen' ? 1.9 : id === 'vaelen' ? 0.8 : 1;
    if (any) { this.hitstop = Math.max(this.hitstop, (s.finisher ? 0.085 : 0.04) * w); this.addTrauma((s.finisher ? 0.35 : 0.15) * w); if (id === 'kaelen') sfx.slam(); else sfx.clash(s.finisher ? 1 : 0.6); this.fx.sparks(this.p.x + Math.sin(a.yaw) * s.radius * 0.7, 1.2, this.p.z + Math.cos(a.yaw) * s.radius * 0.7, s.finisher ? 22 : 10); }
  }

  // ───────────────────────── per-frame simulation ─────────────────────────
  private stepPlayer(dt: number, f0: InputFrame): void {
    const p = this.p, hs = this.hs, def = this.def;
    for (const k of ['dashCd', 'parryT', 'parryCd', 'swapCd', 'boltCd', 'iframes', 'comboT', 'buffered', 'hurtT', 'momCd', 'dashStrikeT', 'dashI', 'counterT', 'stunT'] as const) p[k] = Math.max(0, p[k] - dt);
    let f = f0;
    if (p.stunT > 0) f = { ...f0, move: { x: 0, y: 0 }, attackPressed: false, attackHeld: false, dashPressed: false, specialPressed: false, parryPressed: false, parryHeld: false };
    if (p.momentum > 0 && (p.momT -= dt) <= 0) p.momentum = 0;
    // Kaelen's shield guard: hold Parry
    const wasGuard = p.guard;
    p.guard = def.id === 'kaelen' && f.parryHeld && !p.atk && p.dashT <= 0 && p.flurryT <= 0;
    if (p.guard) { p.guardT += dt; p.guardFx -= dt; if (p.guardFx <= 0) { p.guardFx = 0.16; this.fx.burst(p.x + Math.sin(p.yaw) * 1.2, 1.2, p.z + Math.cos(p.yaw) * 1.2, 0x35e0ff, 2, 2, 0.3, 8, 0); } }
    else { p.guardT = 0; if (wasGuard) this.fx.shockwave(p.x, p.z, 0x35e0ff, 1.5, 0.2); }
    if (!p.charging && def.id !== 'seraphina') p.charge = 0;
    if (def.id !== 'seraphina') p.charging = false;

    if (f.swapTo >= 0) this.swapHero(f.swapTo);
    if (f.swapCycle) { for (let k = 1; k <= 3; k++) { const i = (p.hero + f.swapCycle * k + 9) % 3; if (this.heroes[i].alive) { this.swapHero(i); break; } } }
    if (f.realmPressed) this.tryRealm();
    if (f.parryPressed) this.tryParry();
    if (f.dashPressed) this.tryDash(f);
    if (f.specialPressed) this.trySpecial(f);
    this.tryAttack(f, dt);

    // movement
    let mx = f.move.x, mz = f.move.y;
    const ml = Math.hypot(mx, mz);
    let wx = 0, wz = 0;
    if (ml > 0.05) { const m = Math.min(1, ml); wx = S2 * (mx - mz) / ml * m; wz = S2 * (-mx - mz) / ml * m; }
    let vx = 0, vz = 0;
    if (p.dashT > 0) {
      p.dashT -= dt; const sp = def.id === 'kaelen' ? 18 : 24; vx = p.dashDir.x * sp; vz = p.dashDir.z * sp;
      p.ghostT -= dt; if (p.ghostT <= 0) { p.ghostT = 0.04; this.fx.afterimage(p.x, p.z, p.yaw, def.color); }
      if (def.id === 'kaelen') {
        for (const e of this.enemies) {
          if (e.dead || e.state === 'spawn' || p.dashHit.has(e) || Math.hypot(e.x - p.x, e.z - p.z) > 1.4 + e.radius) continue;
          p.dashHit.add(e);
          this.hitEnemy(e, { dmg: 12, posture: 22, astral: this.astral, dx: p.dashDir.x, dz: p.dashDir.z, kb: 10, finisher: false });
          this.fx.sparks(e.x, 1.2, e.z, 16); sfx.slam(); this.addTrauma(0.3); this.hitstop = Math.max(this.hitstop, 0.045);
        }
      }
    } else if (p.flurryT > 0) {
      p.flurryT -= dt; vx = p.dashDir.x * 15; vz = p.dashDir.z * 15;
      p.ghostT -= dt; if (p.ghostT <= 0) { p.ghostT = 0.035; this.fx.afterimage(p.x, p.z, p.yaw, def.color); }
      p.flurryTick -= dt;
      if (p.flurryTick <= 0) {
        p.flurryTick = 0.085;
        const sp = def.special, any = this.area(p.x, p.z, sp.radius, 0, Math.PI * 2, sp, false);
        this.fx.slashArc(p.x, p.z, p.yaw + (Math.random() - 0.5) * 2.4, def.color, 2.4, 0.2);
        if (any) { sfx.clash(0.5); this.addTrauma(0.08); }
      }
      if (p.flurryT <= 0) { this.dropGlyph(); this.fx.shockwave(p.x, p.z, def.glyphColor, 3, 0.35); }
    } else {
      const mul = (p.atk ? (p.atk.special ? 0.2 : 0.4) : 1) * (p.guard ? 0.45 : 1) * (p.charging && p.charge > 0.05 ? 0.5 : 1);
      vx = wx * def.speed * mul; vz = wz * def.speed * mul;
      if ((p.guard || p.charging) && !p.atk) { const d = this.aimDir(f, true); if (d) p.yaw = lerpAngle(p.yaw, Math.atan2(d.x, d.z), 1 - Math.exp(-dt * 16)); }
      else if (ml > 0.05 && !p.atk) p.yaw = lerpAngle(p.yaw, Math.atan2(wx, wz), 1 - Math.exp(-dt * 18));
      else if (!p.atk && f.mouse) { const d = this.aimDir(f, false); if (d) p.yaw = lerpAngle(p.yaw, Math.atan2(d.x, d.z), 1 - Math.exp(-dt * 14)); }
      else if (!p.atk && f.aim) { const d = this.aimDir(f, false); if (d) p.yaw = lerpAngle(p.yaw, Math.atan2(d.x, d.z), 1 - Math.exp(-dt * 14)); }
    }
    p.speedNow = Math.hypot(vx, vz) * (p.dashT > 0 || p.flurryT > 0 ? 0 : 1);
    const [nx, nz] = this.slide(p.x, p.z, (vx + p.ix) * dt, (vz + p.iz) * dt, 0.42, true);
    p.x = nx; p.z = nz;
    const decay = Math.exp(-dt * 14); p.ix *= decay; p.iz *= decay;

    // attack timeline
    if (p.atk) {
      const a = p.atk; a.t += dt;
      if (!a.hit && a.t >= a.strike.dur * a.strike.hitAt) { a.hit = true; this.resolveAtk(a); }
      if (a.t >= a.strike.dur) {
        if (!a.special && !def.ranged) { p.comboIdx = (p.comboIdx + 1) % def.combo.length; p.comboT = 0.5; }
        p.atk = null;
      }
    }
    if (p.parryT > 0 && Math.random() < 0.5) this.fx.burst(p.x, 1.2, p.z, 0xbfe9ff, 1, 2, 0.25, 6, 0);

    // energy / realm upkeep
    for (let i = 0; i < 3; i++) { const h = this.heroes[i]; if (!h.alive) continue; if (i !== p.hero) h.energy = Math.min(MAX_ENERGY, h.energy + 9 * dt); }
    if (realm.isUnseenRealm) {
      hs.energy = Math.max(0, hs.energy - (def.id === 'seraphina' ? 2 : 5) * dt); // Veil-Weaver is at home in the Pale
      const onBridge = tileAt(this.dungeon, worldToTile(p.x), worldToTile(p.z)) === TileType.SPECTRAL_BRIDGE;
      if (hs.energy <= 0 && !onBridge) { realm.set(false); this.say(p.x, 2.6, p.z, 'THE VEIL CLOSES', 'info'); }
    } else hs.energy = Math.min(MAX_ENERGY, hs.energy + 6 * dt);

    const anim = p.anims[p.hero];
    anim.setMoveSpeed(p.speedNow); anim.update(dt);
    p.root.position.set(p.x, 0, p.z); p.root.rotation.y = p.yaw;
    p.root.visible = !(p.iframes > 0 && Math.floor(this.time * 30) % 2 === 0 && p.dashT <= 0 && p.hurtT > 0);

    // portal
    if (this.portalActive && Math.hypot(p.x - this.dungeon.portal.x, p.z - this.dungeon.portal.z) < 2) { this.portalActive = false; sfx.portal(); this.nextFloor(); }
  }

  private stepBolts(dt: number): void {
    for (const b of this.bolts) {
      b.life -= dt;
      const nx = b.x + b.dx * 22 * dt, nz = b.z + b.dz * 22 * dt;
      if (!this.isWalk(nx, nz, true) && !(realm.isUnseenRealm)) b.life = 0;
      else if (!walkable(this.dungeon, nx, nz, true)) b.life = 0;
      b.x = nx; b.z = nz;
      b.mesh.position.set(b.x, 1.3, b.z); b.mesh.scale.setScalar(1 + Math.sin(this.time * 30) * 0.2);
      if (Math.random() < 0.8) this.fx.burst(b.x, 1.3, b.z, 0xb98cff, 1, 0.8, 0.3, 7, 0);
      for (const e of this.enemies) {
        if (e.dead || e.state === 'spawn' || b.hit.has(e) || Math.hypot(e.x - b.x, e.z - b.z) > e.radius + 0.35) continue;
        b.hit.add(e); this.hitEnemy(e, { dmg: this.def.combo[0].dmg, posture: 4, astral: true, dx: b.dx, dz: b.dz, kb: 1, finisher: false });
        if (!e.dead) { e.marks++; if (e.marks >= 3) this.unravel(e); else this.say(e.x, e.height + 1.0, e.z, '◈'.repeat(e.marks), 'harm'); }
      }
      for (const m of this.inst.monoliths) {
        if (!m.alive || b.hit.has(m) || Math.hypot(m.pos.x - b.x, m.pos.z - b.z) > 0.9) continue;
        b.hit.add(m); this.hitMonolith(m, 14, true);
      }
    }
    this.bolts = this.bolts.filter((b) => { if (b.life > 0) return true; this.fx.releaseBolt(b.mesh); return false; });
  }

  private stepEnemy(e: Enemy, dt: number): void {
    const p = this.p;
    e.hitFlash = Math.max(0, e.hitFlash - dt);
    const scale = e.root.userData.scale as number;
    if (e.state === 'spawn') {
      e.t += dt; const u = Math.min(1, e.t / 0.7), s = 1 + 2.2 * Math.pow(u - 1, 3) + 1.2 * Math.pow(u - 1, 2);
      e.root.scale.setScalar(Math.max(0.01, s) * scale);
      if (u >= 1) { e.state = 'chase'; e.t = 0; }
      e.root.position.set(e.x, 0, e.z); e.anim.update(dt); return;
    }
    if (Math.abs(e.kx) + Math.abs(e.kz) > 0.05) {
      [e.x, e.z] = this.slide(e.x, e.z, e.kx * dt, e.kz * dt, e.radius, false);
      const d = Math.exp(-dt * 6); e.kx *= d; e.kz *= d;
    }
    for (const o of this.enemies) { // soft separation
      if (o === e || o.dead) continue;
      const dx = e.x - o.x, dz = e.z - o.z, d = Math.hypot(dx, dz), min = e.radius + o.radius;
      if (d < min && d > 1e-3) [e.x, e.z] = this.slide(e.x, e.z, (dx / d) * (min - d) * 0.5 * Math.min(1, dt * 10), (dz / d) * (min - d) * 0.5 * Math.min(1, dt * 10), e.radius, false);
    }
    const dx = p.x - e.x, dz = p.z - e.z, dist = Math.hypot(dx, dz) || 1;
    e.cd -= dt; e.t += dt;
    let moving = 0;
    if (e.state !== 'broken') e.posture = Math.max(0, e.posture - 3 * dt);
    switch (e.state) {
      case 'chase': {
        e.yaw = lerpAngle(e.yaw, Math.atan2(dx, dz), 1 - Math.exp(-dt * 8));
        const stop = e.range * 0.8;
        if (dist > stop && this.gameOverT < 0) {
          [e.x, e.z] = this.slide(e.x, e.z, (dx / dist) * e.speed * dt, (dz / dist) * e.speed * dt, e.radius, false);
          moving = e.speed;
        }
        const slam = e.kind === 'boss' && e.attacks % 3 === 2;
        if (e.cd <= 0 && (slam ? dist < 5.2 : dist <= e.range + 0.2) && this.gameOverT < 0) {
          e.state = 'telegraph'; e.t = 0; e.slam = slam;
          e.tele = this.fx.telegraph(e.x, e.z, slam ? 5.2 : e.range + 0.45, 0.45);
          sfx.enemyTelegraph();
        }
        break;
      }
      case 'telegraph': {
        e.yaw = lerpAngle(e.yaw, Math.atan2(dx, dz), 1 - Math.exp(-dt * 5));
        if (e.tele) this.fx.moveTelegraph(e.tele, e.x, e.z);
        if (e.t >= 0.45) this.resolveEnemyStrike(e, dist, dx, dz);
        break;
      }
      case 'recover': if (e.t >= (e.kind === 'boss' ? 0.8 : 0.55)) { e.state = 'chase'; e.t = 0; } break;
      case 'broken': if (e.t >= e.brokenDur) { e.state = 'chase'; e.t = 0; e.posture = 0; e.cd = 0.4; } break;
      default: break;
    }
    e.anim.setMoveSpeed(moving);
    e.anim.update(dt);
    e.root.position.set(e.x, 0, e.z); e.root.rotation.y = e.yaw;
    if (e.state === 'broken') e.root.rotation.z = Math.sin(this.time * 40) * 0.04; else e.root.rotation.z = 0;
    // bars
    e.bar.position.set(e.x, e.height + 0.75, e.z); e.bar.quaternion.copy(this.camera.quaternion);
    e.barHp.scale.x = Math.max(0, 1.2 * e.hp / e.maxHp); e.barPost.scale.x = Math.min(1.2, 1.2 * e.posture / e.maxPosture);
  }

  private resolveEnemyStrike(e: Enemy, dist: number, dx: number, dz: number): void {
    this.fx.releaseTelegraph(e.tele); e.tele = null;
    e.anim.play('slash', 0.3);
    e.attacks++;
    e.state = 'recover'; e.t = 0; e.cd = e.tut === 'shade' ? 2.4 : (e.kind === 'hound' ? 0.5 : 1.0) + Math.random() * 0.6;
    if (e.kind === 'hound') { e.kx += (dx / dist) * 11; e.kz += (dz / dist) * 11; }
    if (e.slam) { this.fx.shockwave(e.x, e.z, 0xff3050, 5.4, 0.45); this.addTrauma(0.35); sfx.slam(); }
    else sfx.swing();
    const reach = e.slam ? 5.2 : e.range + 0.5 + (e.kind === 'hound' ? 1.4 : 0);
    if (this.p.dashI > 0 && dist <= reach + 4.5 && this.gameOverT < 0 && this.p.parryT <= 0) { this.say(this.p.x, 2.4, this.p.z, 'DODGE', 'info'); if (this.def.id === 'vaelen') this.astralStep(); return; }
    if (dist > reach || this.gameOverT >= 0) return;
    if (this.p.parryT > 0) { this.perfectDeflect(e); return; }
    if (this.p.dashI > 0) { this.say(this.p.x, 2.4, this.p.z, 'DODGE', 'info'); if (this.def.id === 'vaelen') this.astralStep(); return; }
    if (this.p.guard) {
      const hs = this.hs;
      if (hs.energy >= 8) {
        hs.energy -= 8; this.fx.sparks(this.p.x + Math.sin(this.p.yaw), 1.3, this.p.z + Math.cos(this.p.yaw), 18); sfx.clash(0.8); this.addTrauma(0.2);
        this.p.ix -= (dx / dist) * 3; this.p.iz -= (dz / dist) * 3;
        this.say(this.p.x, 2.6, this.p.z, 'BLOCKED', 'parry');
        this.hurtGuarded(e.dmg * 0.25);
      } else { this.say(this.p.x, 2.8, this.p.z, 'GUARD BROKEN', 'hurt'); this.p.stunT = 0.8; this.p.guard = false; this.hurtPlayer(e.dmg, e.x, e.z); }
      return;
    }
    if (this.p.iframes > 0) { this.say(this.p.x, 2.4, this.p.z, 'DODGE', 'info'); return; }
    this.hurtPlayer(e.dmg, e.x, e.z);
  }

  private stepRooms(): void {
    const room = roomAt(this.dungeon, this.p.x, this.p.z);
    this.currentRoom = room;
    if (room && room.kind !== 'start') {
      let run = this.runs.get(room.id);
      if (!run) { run = { entered: true, wave: 1, cleared: false }; this.runs.set(room.id, run); this.spawnWave(room, 1); if (room.kind === 'combat') this.tut.tip('tether'); }
    }
    for (const [id, run] of this.runs) {
      if (run.cleared) continue;
      const r = this.dungeon.rooms[id];
      if (this.enemies.some((e) => !e.dead && e.room === r)) continue;
      if (r.kind === 'combat' && run.wave < 2) { run.wave++; this.spawnWave(r, run.wave); }
      else { run.cleared = true; if (r.kind === 'combat') this.hud.toast('SANCTUARY CLEARED', 1800); }
    }
    // fog of war for the minimap
    const tx = worldToTile(this.p.x), ty = worldToTile(this.p.z);
    for (let y = ty - 7; y <= ty + 7; y++) for (let x = tx - 7; x <= tx + 7; x++) if (x >= 0 && y >= 0 && x < GRID && y < GRID && (x - tx) ** 2 + (y - ty) ** 2 <= 49) this.explored[y * GRID + x] = 1;
    if (room) for (let y = room.y - 1; y <= room.y + room.h; y++) for (let x = room.x - 1; x <= room.x + room.w; x++) if (x >= 0 && y >= 0 && x < GRID && y < GRID) this.explored[y * GRID + x] = 1;
  }
  private currentRoom: Room | null = null;

  private drawTethers(): void {
    const unseen = realm.uRealmBlend > 0.5;
    for (const e of this.enemies) {
      if (e.dead) continue;
      for (const m of e.links) if (m.alive) this.fx.beam(m.pos.x, 3.0, m.pos.z, e.x, e.height * 0.65, e.z, unseen ? 0x7affd0 : 0xb07cff);
    }
  }

  private updateEnvironment(): void {
    const b = realm.uRealmBlend;
    sharedUniforms.uRealmBlend.value = b; sharedUniforms.uTime.value = this.time;
    this.hemi.color.setHex(0xd6c9bb).lerp(new THREE.Color(0x8aa0ff), b);
    this.hemi.groundColor.setHex(0x2a2434).lerp(new THREE.Color(0x0a1438), b);
    this.hemi.intensity = 0.9 - 0.1 * b;
    this.sun.color.setHex(0xffe8c8).lerp(new THREE.Color(0xa8c8ff), b); this.sun.intensity = 0.8 - 0.1 * b;
    (this.scene.background as THREE.Color).setHex(0x07060a).lerp(new THREE.Color(0x040a1e), b);
    (this.scene.fog as THREE.Fog).color.copy(this.scene.background as THREE.Color);
  }

  private mergeFrame(acc: InputFrame | null, f: InputFrame): InputFrame {
    if (!acc) return f;
    return {
      ...f,
      attackPressed: acc.attackPressed || f.attackPressed, dashPressed: acc.dashPressed || f.dashPressed, specialPressed: acc.specialPressed || f.specialPressed,
      parryPressed: acc.parryPressed || f.parryPressed, realmPressed: acc.realmPressed || f.realmPressed, newSeedPressed: acc.newSeedPressed || f.newSeedPressed,
      swapTo: f.swapTo >= 0 ? f.swapTo : acc.swapTo, swapCycle: f.swapCycle || acc.swapCycle,
    };
  }
  private pending: InputFrame | null = null;

  private heroMeter(): { label: string; v: number } | null {
    const p = this.p;
    switch (this.def.id) {
      case 'vaelen': return p.crits > 0 ? { label: `ASTRAL CRITS ×${p.crits}`, v: p.crits / 3 } : { label: `MOMENTUM ${p.momentum}/5`, v: p.momentum / 5 };
      case 'seraphina': return { label: p.charge >= 0.9 ? 'LANCE READY' : 'ASTRAL LANCE (HOLD)', v: p.charge / 0.9 };
      case 'kaelen': return p.counterT > 0 ? { label: 'RIPOSTE READY', v: p.counterT / 2.2 } : { label: p.guard ? 'GUARDING' : 'GUARD (HOLD PARRY)', v: p.guard ? 1 : 0 };
      default: return null;
    }
  }

  private bossHud(): BossHud | null {
    const room = this.currentRoom;
    if (!room || room.kind === 'start') return null;
    const es = this.enemies.filter((e) => !e.dead && e.room === room && e.kind !== 'hound');
    if (!es.length) return null;
    const e = es.sort((a, b) => b.maxHp - a.maxHp)[0];
    return { name: e.name, hp: e.hp, maxHp: e.maxHp, posture: e.posture, maxPosture: e.maxPosture, tethers: this.tetherCount(e), maxTethers: e.links.length, broken: e.state === 'broken' };
  }

  // ───────────────────────── main loop ─────────────────────────
  start(): void {
    let last = performance.now();
    this.renderer.setAnimationLoop((now: number) => {
      if (!this.running) return;
      const real = Math.min(0.05, (now - last) / 1000); last = now;
      try { this.frame(real); } catch (err) { this.reportError(err); }
    });
  }

  private errShown = false;
  /** A thrown error would kill the render loop (frozen screen): keep running and show it on screen so it can be reported. */
  private reportError(err: unknown): void {
    console.error(err);
    if (this.errShown) return;
    this.errShown = true;
    const d = document.createElement('pre');
    d.style.cssText = 'position:fixed;left:8px;top:8px;right:8px;z-index:9999;max-height:40vh;overflow:auto;margin:0;padding:8px;background:rgba(120,0,0,.85);color:#fff;font:11px monospace;white-space:pre-wrap;pointer-events:none';
    d.textContent = 'ERROR: ' + (err instanceof Error ? (err.stack ?? err.message) : String(err)).slice(0, 900);
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 15000);
  }

  private frame(real: number): void {
    this.time += real;
    this.fpsAcc += real; this.frameCount++;
    if (this.fpsAcc >= 0.5) { this.fps = Math.round(this.frameCount / this.fpsAcc); this.fpsAcc = 0; this.frameCount = 0; }
    const f = this.mergeFrame(this.pending, this.input.poll());
    if (f.newSeedPressed) { this.pending = null; this.rollSeed(); return; }

    let dt = real;
    if (this.hitstop > 0) { this.hitstop -= real; dt = 0; }
    else if (this.slow > 0) { this.slow -= real; dt = real * 0.25; }

    realm.update(real);
    if (dt > 0) {
      this.pending = null;
      if (this.gameOverT >= 0) { this.gameOverT -= real; if (this.gameOverT < 0) { this.rollSeed(); return; } }
      this.stepPlayer(dt, this.gameOverT >= 0 ? { ...f, move: { x: 0, y: 0 }, attackPressed: false, attackHeld: false, specialPressed: false, dashPressed: false } : f);
      for (const e of [...this.enemies]) this.stepEnemy(e, dt);
      this.enemies = this.enemies.filter((e) => !e.dead);
      this.stepBolts(dt);
      this.feedTrails();
      this.stepRooms();
      this.drawTethers();
      this.fx.update(dt);
    } else this.pending = f;
    this.tut.update({
      dt: real, x: this.p.x, z: this.p.z, device: this.input.device, unseen: realm.isUnseenRealm,
      onBridge: tileAt(this.dungeon, worldToTile(this.p.x), worldToTile(this.p.z)) === TileType.SPECTRAL_BRIDGE, glyphs: this.fx.activeGlyphs.length,
    });
    this.updateEnvironment();
    this.inst.update(real, this.p);

    // camera: smooth follow + trauma shake
    this.camPos.lerp(new THREE.Vector3(this.p.x, 0, this.p.z), 1 - Math.exp(-real * 7));
    this.trauma = Math.max(0, this.trauma - real * 1.7);
    const amp = this.trauma * this.trauma * 0.7;
    let sx = (Math.random() - 0.5) * 2 * amp, sz = (Math.random() - 0.5) * 2 * amp;
    const damp = Math.exp(-real * 16);
    this.punch.x *= damp; this.punch.z *= damp; this.zoomPulse *= Math.exp(-real * 10);
    sx += this.punch.x; sz += this.punch.z;
    const zp = 1 + this.zoomPulse;
    if (Math.abs(this.camera.zoom - zp) > 1e-4) { this.camera.zoom = zp; this.camera.updateProjectionMatrix(); }
    this.camera.position.set(this.camPos.x + CAM_OFFSET.x + sx, CAM_OFFSET.y, this.camPos.z + CAM_OFFSET.z + sz);
    this.camera.lookAt(this.camPos.x + sx, 0, this.camPos.z + sz);

    this.hud.update(real, {
      heroes: HEROES.map((h, i) => ({ meter: i === this.p.hero ? this.heroMeter() : null, name: h.name, title: h.title, color: h.css, hp: this.heroes[i].hp, maxHp: h.maxHp, energy: this.heroes[i].energy, maxEnergy: MAX_ENERGY, alive: this.heroes[i].alive })),
      active: this.p.hero, unseen: realm.isUnseenRealm, blend: realm.uRealmBlend, boss: this.bossHud(), seed: this.seed, floor: this.floor,
      device: this.input.device, gamepadName: this.input.gamepadName,
      minimap: { dungeon: this.dungeon, explored: this.explored, player: this.p, room: this.currentRoom, monoliths: this.inst.monoliths.map((m) => ({ pos: m.pos, alive: m.alive })), portalActive: this.portalActive },
    });

    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.overlay.render(this.renderer, window.innerWidth / window.innerHeight);
  }
}

