import * as THREE from 'three';
import { sfx } from '../audio/SoundFX';
import { TutorialUI, chips, type TutDevice } from '../ui/TutorialUI';
import { GRID, TileType, tileToWorld, worldToTile, type Dungeon, type Vec2 } from '../world/ProceduralDungeonGenerator';

const KEY = 'cotv.tutorial.v1';
const TIP_PREFIX = 'cotv.tip.';
const store = {
  get: (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string): void => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
export const tutorialStatus = (): string | null => store.get(KEY);

export type TutEvent = 'dash' | 'hit' | 'swap' | 'glyph' | 'detonate' | 'deflect' | 'realm' | 'sever' | 'break';

/** Everything the tutorial needs from the game, kept narrow on purpose. */
export interface TutHost {
  scene: THREE.Scene;
  spawnTarget(kind: 'effigy' | 'shade'): void;
  clearTargets(): void;
  targetPos(): Vec2 | null;
  refillEnergy(): void;
  restoreHeroes(): void;
  project(x: number, y: number, z: number): { x: number; y: number; behind: boolean };
  onFinish(): void;
}

export interface TutCtx { dt: number; time?: number; x: number; z: number; device: TutDevice; unseen: boolean; onBridge: boolean; glyphs: number }

interface Step {
  id: string; title: string; flavor: string;
  text: (d: TutDevice, c: TutCtx) => string;
  hl?: Partial<Record<TutDevice, string[]>>;
  need?: number;
  enter?: (t: Tutorial) => void;
  done?: (t: Tutorial, c: TutCtx) => boolean;
  event?: TutEvent;
  beacon?: 'target' | 'bridge';
}

const STEPS: Step[] = [
  { id: 'move', title: 'MOVEMENT', flavor: '“The Concord remembers its wardens. Walk, and be remembered.”', need: 6,
    text: (d) => d === 'keyboard' ? 'Move with [[W]] [[A]] [[S]] [[D]].' : d === 'gamepad' ? 'Move with the [[L-STICK]]. The [[R-STICK]] aims your strikes.' : 'Drag your <b>left thumb</b> anywhere on the left half of the screen.',
    hl: { touch: ['#stick-zone'] },
    done: (t) => t.moved >= 6 },
  { id: 'dash', title: 'PHASE-DASH', flavor: '“Be where the blade is not.”', event: 'dash',
    text: (d) => `${d === 'keyboard' ? 'Press [[SPACE]]' : d === 'gamepad' ? 'Press [[A]]' : 'Tap [[DASH]]'} to Phase-Dash. You are <b>untouchable</b> for an instant — and leave afterimages.`,
    hl: { touch: ['.b-dash'] } },
  { id: 'strike', title: 'STRIKE', flavor: '“Steel remembers what the heart forgets.”', event: 'hit', need: 5, beacon: 'target',
    enter: (t) => t.host.spawnTarget('effigy'),
    text: (d) => `Strike the <b>Hollow Effigy</b> with ${d === 'keyboard' ? '[[J]] or <b>click</b>' : d === 'gamepad' ? '[[X]]' : '[[ATTACK]]'}. Chain presses — the <b>third blow</b> is a heavy finisher.`,
    hl: { touch: ['.b-attack'] } },
  { id: 'swap', title: 'TRI-WARDEN SWAP', flavor: '“Three blades, one oath.”', event: 'swap', beacon: 'target',
    text: (d) => d === 'keyboard' ? 'Press [[1]] [[2]] or [[3]] to swap Wardens <b>instantly</b> — even mid-combo.' : d === 'gamepad' ? 'Press [[L1]] / [[R1]] to cycle Wardens <b>instantly</b> — even mid-combo.' : 'Tap another <b>hero card</b> to swap instantly — even mid-combo.',
    hl: { touch: ['.card:not(.active)'], keyboard: ['.card:not(.active)'], gamepad: [] } },
  { id: 'glyph', title: 'GLYPH SKILL', flavor: '“Every warden leaves a mark upon the stone.”', event: 'glyph', beacon: 'target',
    enter: (t) => t.host.refillEnergy(),
    text: (d) => `Use your Skill with ${d === 'keyboard' ? '[[K]] or <b>right-click</b>' : d === 'gamepad' ? '[[Y]]' : '[[SKILL]]'}. It leaves a <b>Glyph</b> on the floor for 8 seconds.`,
    hl: { touch: ['.b-skill'] } },
  { id: 'harmony', title: 'HARMONIC DETONATION', flavor: '“Two voices, one chord.”', event: 'detonate', beacon: 'target',
    enter: (t) => t.host.refillEnergy(),
    text: (d, c) => (c.glyphs ? '' : '<i>The glyph faded — drop another.</i> ') + (d === 'keyboard' ? 'Stand <b>inside the glyph</b>, swap Wardens with [[1]] [[2]] [[3]], then use their Skill [[K]] — <b>2.5× damage</b> burst.' : d === 'gamepad' ? 'Stand <b>inside the glyph</b>, swap with [[L1]] / [[R1]], then press [[Y]] — <b>2.5× damage</b> burst.' : 'Stand <b>inside the glyph</b>, tap another <b>hero card</b>, then tap [[SKILL]] — <b>2.5× damage</b> burst.'),
    hl: { touch: ['.card:not(.active)', '.b-skill'], keyboard: ['.card:not(.active)'] },
    done: (t, c) => { if (!c.glyphs && t.stepTime > 0.6) t.back('glyph'); return false; } },
  { id: 'parry', title: 'PERFECT DEFLECTION', flavor: '“Meet the strike, and turn it back.”', event: 'deflect', beacon: 'target',
    enter: (t) => { t.host.clearTargets(); t.host.spawnTarget('shade'); },
    text: (d, c) => `When a <b>crimson ring</b> closes in on you, press ${d === 'keyboard' ? '[[F]]' : d === 'gamepad' ? '[[B]]' : '[[PARRY]]'} <b>just before it lands</b>.` + ((c.time ?? 0) > 14 ? ' <i>Wait until the ring is almost closed.</i>' : ''),
    hl: { touch: ['.b-parry'] } },
  { id: 'veil', title: 'THE VEIL SHIFT', flavor: '“Two realms share one stone.”', event: 'realm',
    enter: (t) => t.host.clearTargets(),
    text: (d) => `${d === 'keyboard' ? 'Press [[TAB]]' : d === 'gamepad' ? 'Press [[L2]] or [[R2]]' : 'Tap [[VEIL SHIFT]]'} to enter the <b>Unseen Realm</b>. It slowly drains energy while you stay.`,
    hl: { touch: ['.b-realm'] } },
  { id: 'bridge', title: 'SPECTRAL BRIDGE', flavor: '“What the waking world denies, the Pale allows.”', beacon: 'bridge',
    text: (_d, c) => c.unseen ? 'Follow the <b>beacon</b> and walk onto the Spectral Bridge. It only holds in the Unseen Realm.' : 'You slipped back. <b>Shift into the Unseen Realm</b> again, then follow the beacon.',
    done: (_t, c) => c.onBridge && c.unseen },
];

const TIPS: Record<string, { title: string; body: string; ttl: number }> = {
  tether: { title: 'TETHERED ELITE', ttl: 16, body: 'Physical blows barely scratch it (<b>−85%</b>). Shift into the <b>Unseen Realm</b> or use <b>Seraphina</b>, then shatter the glowing <b>Runestone</b> to sever the tether.' },
  break: { title: 'POSTURE BROKEN', ttl: 10, body: 'Finish it with a <b>Skill</b> or a heavy finisher for a <b>Fellowship Finisher</b> — triple damage.' },
};

export class Tutorial {
  active = false;
  moved = 0;
  stepTime = 0;
  private i = 0;
  private count = 0;
  private transitioning = false;
  private device: TutDevice = 'keyboard';
  private lastPos: Vec2 | null = null;
  private hlTimer = 0;
  private bridgePos: Vec2 | null = null;
  private tipId: string | null = null;
  private beacon: THREE.Group;
  private beamMat: THREE.ShaderMaterial;
  private ring: THREE.Mesh;
  private time = 0;
  private lastBody = '';

  constructor(readonly host: TutHost, private ui: TutorialUI) {
    this.beamMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uT: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: 'varying vec2 vUv; uniform float uT; void main(){ float a=pow(1.0-vUv.y,1.6)*(0.55+0.25*sin(uT*3.0+vUv.y*9.0)); gl_FragColor=vec4(mix(vec3(1.0,0.82,0.35),vec3(0.4,1.0,0.8),vUv.y),a); }',
    });
    this.beacon = new THREE.Group();
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.9, 14, 20, 1, true).translate(0, 7, 0), this.beamMat);
    beam.frustumCulled = false;
    this.ring = new THREE.Mesh(new THREE.RingGeometry(1.1, 1.35, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffd36a, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    this.ring.position.y = 0.08;
    this.beacon.add(beam, this.ring);
    this.beacon.visible = false;
    host.scene.add(this.beacon);
  }

  get stepIndex(): number { return this.i; }
  static shouldRun(): boolean { return new URLSearchParams(location.search).has('tutorial') || tutorialStatus() === null; }

  /** Begin (or resume the current step on a rerolled floor). */
  begin(dungeon: Dungeon, restart: boolean): void {
    this.bridgePos = this.findFirstBridge(dungeon);
    this.tipId = null;
    if (restart || !this.active) { this.i = 0; }
    this.active = true; this.lastPos = null; this.moved = 0;
    this.enterStep(true);
  }

  /** Nearest (by walking distance) spectral-bridge tile reachable without crossing one. */
  private findFirstBridge(d: Dungeon): Vec2 | null {
    const w = (v: number) => worldToTile(v);
    const start = w(d.spawn.z) * GRID + w(d.spawn.x), seen = new Set<number>([start]);
    const q = [start];
    for (let h = 0; h < q.length; h++) {
      const c = q[h], x = c % GRID, y = (c / GRID) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) continue;
        const n = ny * GRID + nx; if (seen.has(n)) continue; seen.add(n);
        const t = d.grid[n];
        if (t === TileType.SPECTRAL_BRIDGE) return { x: tileToWorld(nx), z: tileToWorld(ny) };
        if (t === TileType.FLOOR || t === TileType.PORTAL) q.push(n);
      }
    }
    return null;
  }

  private get step(): Step { return STEPS[this.i]; }

  private enterStep(first = false): void {
    this.count = 0; this.stepTime = 0; this.transitioning = false;
    const s = this.step;
    s.enter?.(this);
    const html = chips(s.text(this.device, { dt: 0, x: 0, z: 0, device: this.device, unseen: false, onBridge: false, glyphs: this.glyphsNow }), this.device);
    this.lastBody = html;
    this.ui.showStep(this.i, STEPS.length, s.title, s.flavor, html, !!s.need);
    if (!first) sfx.tutorialPrompt();
  }
  private glyphsNow = 0;

  private render(c: TutCtx, force = false): void {
    const html = chips(this.step.text(this.device, c), this.device);
    if (force || html !== this.lastBody) { this.lastBody = html; this.ui.setBody(html); }
  }

  back(id: string): void {
    const k = STEPS.findIndex((s) => s.id === id);
    if (k >= 0 && !this.transitioning) { this.i = k; this.enterStep(); }
  }

  private progress(): void {
    const s = this.step;
    if (!s.need) return;
    const v = s.id === 'move' ? Math.min(1, this.moved / s.need) : this.count / s.need;
    this.ui.setProgress(v, s.id === 'move' ? '' : `${Math.min(this.count, s.need)} / ${s.need}`);
  }

  private async advance(): Promise<void> {
    if (this.transitioning) return;
    this.transitioning = true;
    sfx.tutorialStep();
    await this.ui.complete();
    if (!this.active) return;
    if (this.i >= STEPS.length - 1) { this.finish(); return; }
    this.i++;
    this.enterStep();
  }

  private finish(): void {
    store.set(KEY, 'done');
    this.active = false;
    this.beacon.visible = false;
    this.host.clearTargets(); this.host.restoreHeroes();
    this.ui.highlight([]); this.ui.setArrow(null);
    this.ui.showFinale('THE VEIL IS YOURS', '“Go, warden. The Castellan waits below.”',
      'Heroes restored. Sever tethers, deflect strikes, chain glyphs — and find the <b>Boss Sanctum</b> (red outline on the minimap).');
    sfx.tutorialDone();
    setTimeout(() => this.ui.hide(), 6500);
    this.host.onFinish();
  }

  skip(): void {
    if (!this.active) return;
    store.set(KEY, 'skipped');
    this.active = false; this.beacon.visible = false;
    this.host.clearTargets();
    this.ui.hide();
    this.host.onFinish();
  }

  /** Game → tutorial notifications. */
  emit(e: TutEvent): void {
    if (this.tipId && e === 'sever' && this.tipId === 'tether') { this.dismissTip(); }
    if (!this.active || this.transitioning) return;
    const s = this.step;
    if (s.event !== e) return;
    if (e === 'realm' && s.id === 'veil' && !this.lastUnseen) return;
    this.count++;
    this.progress();
    if (!s.need || this.count >= s.need) void this.advance();
  }
  lastUnseen = false;

  // ── contextual field notes after the tutorial ──
  tip(id: 'tether' | 'break'): void {
    if (this.active || tutorialStatus() === 'skipped' || store.get(TIP_PREFIX + id) || this.tipId) return;
    store.set(TIP_PREFIX + id, '1');
    this.tipId = id;
    this.ui.showTip(TIPS[id].title, chips(TIPS[id].body, this.device), TIPS[id].ttl);
    sfx.tutorialPrompt();
  }
  dismissTip(): void { if (this.tipId) { this.tipId = null; this.ui.hide(); } }

  update(c: TutCtx): void {
    this.time += c.dt;
    this.beamMat.uniforms.uT.value = this.time;
    if (c.device !== this.device) { this.device = c.device; if (this.active) this.render(c, true); }
    if (!this.active) return;
    this.stepTime += c.dt; this.glyphsNow = c.glyphs;
    if (this.lastPos) { const d = Math.hypot(c.x - this.lastPos.x, c.z - this.lastPos.z); if (d < 3) this.moved += d; }
    this.lastPos = { x: c.x, z: c.z };
    if (this.step.id === 'move') this.progress();
    this.lastUnseen = c.unseen;
    if (!this.transitioning) {
      this.render({ ...c, time: this.stepTime });
      if (this.step.done?.(this, c)) void this.advance();
    }
    if (this.step.beacon === 'target' && !this.transitioning && !this.host.targetPos()) this.host.spawnTarget(this.step.id === 'parry' ? 'shade' : 'effigy');
    // keep highlights in sync (hero cards change as you swap)
    this.hlTimer -= c.dt;
    if (this.hlTimer <= 0) { this.hlTimer = 0.35; this.ui.highlight(this.step.hl?.[this.device] ?? []); }

    // beacon + off-screen arrow
    let tp: Vec2 | null = null;
    if (!this.transitioning || this.step.beacon) tp = this.step.beacon === 'bridge' ? this.bridgePos : this.step.beacon === 'target' ? this.host.targetPos() : null;
    if (this.step.id === 'bridge' && !c.unseen) tp = this.bridgePos;
    this.beacon.visible = !!tp;
    if (tp) {
      this.beacon.position.set(tp.x, 0, tp.z);
      const sc = this.step.beacon === 'bridge' ? 1 : 0.55;
      this.beacon.scale.set(sc, this.step.beacon === 'bridge' ? 1 : 0.35, sc);
      this.ring.scale.setScalar(1 + 0.12 * Math.sin(this.time * 4));
      const p = this.host.project(tp.x, 1.2, tp.z);
      const W = window.innerWidth, H = window.innerHeight, m = 46;
      const off = p.behind || p.x < m || p.x > W - m || p.y < m + 90 || p.y > H - m - 120;
      if (off) {
        const cx = W / 2, cy = H / 2;
        let dx = p.x - cx, dy = p.y - cy; if (p.behind) { dx = -dx; dy = -dy; }
        const k = Math.min((W / 2 - m) / (Math.abs(dx) || 1), (H / 2 - m - 40) / (Math.abs(dy) || 1));
        this.ui.setArrow({ x: cx + dx * k, y: cy + dy * k, angle: Math.atan2(dy, dx), label: `${Math.round(Math.hypot(tp.x - c.x, tp.z - c.z))}m` });
      } else this.ui.setArrow(null);
    } else this.ui.setArrow(null);
  }
}
