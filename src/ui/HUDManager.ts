import './hud.css';
import { GRID, TileType, type Dungeon, type Room, type Vec2 } from '../world/ProceduralDungeonGenerator';

export interface HeroHud { name: string; title: string; color: string; hp: number; maxHp: number; energy: number; maxEnergy: number; alive: boolean }
export interface BossHud { name: string; hp: number; maxHp: number; posture: number; maxPosture: number; tethers: number; maxTethers: number; broken: boolean }
export interface MinimapData { dungeon: Dungeon; explored: Uint8Array; player: Vec2; room: Room | null; monoliths: Array<{ pos: Vec2; alive: boolean }>; portalActive: boolean }
export interface HudState {
  heroes: HeroHud[]; active: number; unseen: boolean; blend: number; boss: BossHud | null;
  seed: string; floor: number; device: string; gamepadName: string | null; minimap: MinimapData;
}
export type FloatKind = 'dmg' | 'crit' | 'break' | 'sever' | 'harm' | 'hurt' | 'parry' | 'info';

export class HUDManager {
  private el: HTMLElement;
  private mm!: HTMLCanvasElement; private mmCtx!: CanvasRenderingContext2D;
  private mmImg!: HTMLCanvasElement; private mmImgCtx!: CanvasRenderingContext2D;
  private mmTimer = 0;
  private banner!: HTMLElement; private boss!: HTMLElement; private toastEl!: HTMLElement; private hint!: HTMLElement;
  private cards: HTMLElement[] = [];
  private lastUnseen: boolean | null = null;
  private padBadge!: HTMLElement; private seedInfo!: HTMLElement; private vig!: HTMLElement;
  private toastTimer = 0;
  private floats = 0;

  readonly centerTop!: HTMLElement;
  readonly root!: HTMLElement;

  constructor(parent: HTMLElement, private cb: { onSwap(i: number): void; onNewSeed(): void; onTutorial(): void }) {
    this.el = document.createElement('div');
    this.el.id = 'hud';
    this.el.innerHTML = `
      <div id="vignette"></div>
      <div id="minimap" class="glass"><canvas width="160" height="160"></canvas><div class="lbl">THE SUNKEN CONCORD</div></div>
      <div id="center-top">
        <div id="realm-banner" class="glass"></div>
        <div id="boss" class="glass"><div class="nm"></div><div class="bar hp"><i></i></div><div class="bar post"><i></i></div><div class="bar teth"><i></i></div><div class="tl"><span>POSTURE</span><span class="tt"></span></div></div>
      </div>
      <div id="top-right">
        <button id="seed-btn" class="glass">NEW SEED / FLOOR</button>
        <button id="tut-btn" class="glass">REPLAY TUTORIAL</button>
        <div id="seed-info"></div>
        <div id="pad-badge" class="glass"></div>
      </div>
      <div id="cards"></div>
      <div id="toast"></div>
      <div id="hint"></div>`;
    parent.appendChild(this.el);
    const q = <T extends HTMLElement>(s: string) => this.el.querySelector(s) as T;
    this.mm = q<HTMLCanvasElement>('#minimap canvas'); this.mmCtx = this.mm.getContext('2d')!;
    this.mmImg = document.createElement('canvas'); this.mmImg.width = this.mmImg.height = GRID; this.mmImgCtx = this.mmImg.getContext('2d')!;
    this.banner = q('#realm-banner'); this.boss = q('#boss'); this.toastEl = q('#toast'); this.hint = q('#hint');
    this.padBadge = q('#pad-badge'); this.seedInfo = q('#seed-info'); this.vig = q('#vignette');
    (this as { centerTop: HTMLElement }).centerTop = q('#center-top'); (this as { root: HTMLElement }).root = this.el;
    q('#tut-btn').addEventListener('pointerdown', (e) => { e.preventDefault(); this.cb.onTutorial(); });
    const btn = q('#seed-btn');
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); this.cb.onNewSeed(); });
    const cards = q('#cards');
    for (let i = 0; i < 3; i++) {
      const c = document.createElement('div');
      c.className = 'card glass';
      c.innerHTML = `<span class="k">${i + 1}</span><div class="pt"><div class="av"></div><div class="nm"></div></div><div class="bar hp"><i></i></div><div class="bar en"><i></i></div>`;
      c.addEventListener('pointerdown', (e) => { e.preventDefault(); this.cb.onSwap(i); });
      cards.appendChild(c); this.cards.push(c);
    }
  }

  toast(text: string, ms = 2200): void {
    this.toastEl.textContent = text; this.toastEl.classList.add('on'); this.toastTimer = ms / 1000;
  }
  showHint(text: string): void { this.hint.textContent = text; this.hint.classList.add('on'); setTimeout(() => this.hint.classList.remove('on'), 9000); }
  hurtFlash(): void { this.vig.classList.remove('hurt'); void this.vig.offsetWidth; this.vig.classList.add('hurt'); }

  /** Floating calligraphic combat text at a screen position (px). */
  floatText(x: number, y: number, text: string, kind: FloatKind = 'dmg'): void {
    if (this.floats > 36) return;
    const d = document.createElement('div');
    d.className = `ft ${kind}`; d.textContent = text;
    d.style.left = `${x + (Math.random() - 0.5) * 24}px`; d.style.top = `${y}px`;
    this.el.appendChild(d); this.floats++;
    setTimeout(() => { d.remove(); this.floats--; }, 1000);
  }

  update(dt: number, s: HudState): void {
    if (this.toastTimer > 0 && (this.toastTimer -= dt) <= 0) this.toastEl.classList.remove('on');
    if (s.unseen !== this.lastUnseen) {
      this.lastUnseen = s.unseen;
      this.banner.textContent = s.unseen ? 'UNSEEN REALM: THE PALE SHIFTING' : 'PHYSICAL REALM: WAKING STONE';
      this.banner.classList.toggle('unseen', s.unseen);
    }
    this.seedInfo.textContent = `FLOOR ${s.floor} · SEED ${s.seed}`;
    if (s.gamepadName) {
      this.padBadge.classList.add('on');
      this.padBadge.textContent = /gamesir/i.test(s.gamepadName) ? '◈ GAMESIR G8+ · GAMEPAD READY' : '◈ GAMEPAD READY';
    } else this.padBadge.classList.remove('on');

    s.heroes.forEach((h, i) => {
      const c = this.cards[i];
      c.style.setProperty('--c', h.color);
      c.classList.toggle('active', i === s.active); c.classList.toggle('dead', !h.alive);
      const nm = c.querySelector('.nm') as HTMLElement;
      if (nm.dataset.n !== h.name) { nm.dataset.n = h.name; nm.innerHTML = `${h.name}<small>${h.title}</small>`; }
      (c.querySelector('.hp i') as HTMLElement).style.transform = `scaleX(${Math.max(0, h.hp / h.maxHp)})`;
      (c.querySelector('.en i') as HTMLElement).style.transform = `scaleX(${Math.max(0, h.energy / h.maxEnergy)})`;
    });

    if (s.boss) {
      this.boss.classList.add('on');
      (this.boss.querySelector('.nm') as HTMLElement).textContent = s.boss.name;
      (this.boss.querySelector('.hp i') as HTMLElement).style.transform = `scaleX(${Math.max(0, s.boss.hp / s.boss.maxHp)})`;
      (this.boss.querySelector('.post i') as HTMLElement).style.transform = `scaleX(${Math.min(1, s.boss.posture / s.boss.maxPosture)})`;
      const teth = this.boss.querySelector('.teth') as HTMLElement;
      teth.style.display = s.boss.maxTethers ? 'block' : 'none';
      (teth.querySelector('i') as HTMLElement).style.transform = `scaleX(${s.boss.maxTethers ? s.boss.tethers / s.boss.maxTethers : 0})`;
      (this.boss.querySelector('.tt') as HTMLElement).textContent = s.boss.broken ? 'BROKEN!' : s.boss.tethers ? `TETHERED ×${s.boss.tethers} (−85% PHYSICAL)` : 'TETHER SEVERED';
    } else this.boss.classList.remove('on');

    this.mmTimer -= dt;
    if (this.mmTimer <= 0) { this.mmTimer = 0.12; this.drawMinimap(s.minimap, s.unseen); }
  }

  private drawMinimap(m: MinimapData, unseen: boolean): void {
    const d = m.dungeon, img = this.mmImgCtx.createImageData(GRID, GRID), px = img.data;
    const set = (i: number, r: number, g: number, b: number, a = 255) => { px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = a; };
    const floorC = unseen ? [60, 120, 128] : [96, 88, 124], curC = unseen ? [90, 190, 190] : [150, 136, 190];
    const roomOf = (tx: number, ty: number) => m.room && tx >= m.room.x - 1 && tx <= m.room.x + m.room.w && ty >= m.room.y - 1 && ty <= m.room.y + m.room.h;
    for (let i = 0; i < GRID * GRID; i++) {
      if (!m.explored[i]) continue;
      const t = d.grid[i], tx = i % GRID, ty = (i / GRID) | 0;
      if (t === TileType.FLOOR) { const c = roomOf(tx, ty) ? curC : floorC; set(i, c[0], c[1], c[2]); }
      else if (t === TileType.SPECTRAL_BRIDGE) set(i, 90, 255, 220);
      else if (t === TileType.PORTAL) m.portalActive ? set(i, 120, 255, 160) : set(i, floorC[0], floorC[1], floorC[2]);
      else if (t === TileType.WALL) set(i, 34, 30, 52, 230);
    }
    this.mmImgCtx.putImageData(img, 0, 0);
    const c = this.mmCtx, S = this.mm.width / GRID;
    c.clearRect(0, 0, this.mm.width, this.mm.height);
    c.fillStyle = 'rgba(6,5,14,.6)'; c.fillRect(0, 0, this.mm.width, this.mm.height);
    c.imageSmoothingEnabled = false; c.drawImage(this.mmImg, 0, 0, this.mm.width, this.mm.height);
    const boss = d.rooms[d.bossRoom];
    c.strokeStyle = m.explored[(boss.y + 1) * GRID + boss.x + 1] ? 'rgba(255,60,90,.95)' : 'rgba(255,60,90,.55)'; c.lineWidth = 1.5;
    c.setLineDash(m.explored[(boss.y + 1) * GRID + boss.x + 1] ? [] : [3, 3]);
    c.strokeRect(boss.x * S, boss.y * S, boss.w * S, boss.h * S); c.setLineDash([]);
    const toMap = (p: Vec2): [number, number] => [(p.x / 2.5 + GRID / 2) * S, (p.z / 2.5 + GRID / 2) * S];
    for (const mo of m.monoliths) { const [x, y] = toMap(mo.pos); if (!m.explored[Math.floor(y / S) * GRID + Math.floor(x / S)]) continue; c.fillStyle = mo.alive ? '#b07cff' : '#444'; c.fillRect(x - 2, y - 2, 4, 4); }
    if (m.portalActive) { const [x, y] = toMap(d.portal); c.fillStyle = '#7dffa0'; c.beginPath(); c.arc(x, y, 4, 0, 7); c.fill(); }
    const [px0, py0] = toMap(m.player);
    c.fillStyle = '#ffe08a'; c.strokeStyle = '#000'; c.lineWidth = 1; c.beginPath(); c.moveTo(px0, py0 - 5); c.lineTo(px0 + 4, py0); c.lineTo(px0, py0 + 5); c.lineTo(px0 - 4, py0); c.closePath(); c.fill(); c.stroke();
  }

  setHint(device: string): void {
    if (device === 'keyboard') this.showHint('WASD move · J / Click attack · K / R-Click special · Space dash · F parry · Tab veil shift · 1-2-3 swap · R new seed');
    else if (device === 'gamepad') this.showHint('L-Stick move · R-Stick aim · X attack · Y special · A dash · B parry · L1/R1 swap · L2/R2 veil shift · Start new seed');
  }
}
