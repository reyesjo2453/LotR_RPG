export type Device = 'keyboard' | 'touch' | 'gamepad';

/** Per-frame snapshot. Edge flags (`*Pressed`) are true for exactly one frame. */
export interface InputFrame {
  /** Screen-space movement: x right, y up, magnitude <= 1. */
  move: { x: number; y: number };
  /** Right-stick aim override (screen-space), or null. */
  aim: { x: number; y: number } | null;
  /** Mouse position in NDC when the keyboard/mouse is the active device. */
  mouse: { x: number; y: number } | null;
  attackPressed: boolean; attackHeld: boolean;
  dashPressed: boolean; specialPressed: boolean; parryPressed: boolean;
  realmPressed: boolean; newSeedPressed: boolean;
  /** 0..2 = direct hero swap, -1 = none */
  swapTo: number;
  /** +1 / -1 cycle, 0 none */
  swapCycle: number;
}

const DEAD = 0.2;

export class InputManager {
  device: Device = 'keyboard';
  gamepadName: string | null = null;
  onDeviceChange: (d: Device) => void = () => {};
  onFirstGesture: () => void = () => {};

  private keys = new Set<string>();
  private pressed = new Set<string>();
  private mouse = { x: 0, y: 0, has: false, down: false, right: false };
  private mousePressedAttack = false;
  private mousePressedSpecial = false;
  private touch = { move: { x: 0, y: 0 }, attackHeld: false, edges: new Set<string>(), swap: -1 };
  private padPrev: boolean[] = [];
  private touchRoot: HTMLElement;
  private stickBase!: HTMLElement;
  private stickKnob!: HTMLElement;
  private stickPointer = -1;
  private stickOrigin = { x: 0, y: 0 };
  readonly touchCapable = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

  constructor(private host: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (['Tab', ' ', 'Shift'].includes(e.key) || e.code === 'Space') e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code); this.pressed.add(e.code);
      this.setDevice('keyboard'); this.onFirstGesture();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    // pointer events so emulated mouse events from touches never flip the active device
    host.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      this.mouse.x = (e.clientX / innerWidth) * 2 - 1; this.mouse.y = -(e.clientY / innerHeight) * 2 + 1; this.mouse.has = true;
      if (this.device !== 'keyboard' && this.device !== 'gamepad') this.setDevice('keyboard');
    });
    host.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse') return;
      this.onFirstGesture(); this.setDevice('keyboard');
      if (e.button === 0) { this.mouse.down = true; this.mousePressedAttack = true; }
      if (e.button === 2) { this.mouse.right = true; this.mousePressedSpecial = true; }
    });
    window.addEventListener('pointerup', (e) => { if (e.button === 0) this.mouse.down = false; if (e.button === 2) this.mouse.right = false; });
    host.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('gamepadconnected', (e) => { this.gamepadName = (e as GamepadEvent).gamepad.id; });
    window.addEventListener('gamepaddisconnected', () => { this.gamepadName = null; if (this.device === 'gamepad') this.setDevice('keyboard'); });
    this.touchRoot = this.buildTouchUI();
    this.touchRoot.style.display = this.touchCapable ? 'block' : 'none';
    if (this.touchCapable) this.device = 'touch';
  }

  get gamepadConnected(): boolean { return this.gamepadName !== null; }

  private setDevice(d: Device): void {
    if (this.device === d) return;
    this.device = d;
    this.touchRoot.style.display = d === 'touch' ? 'block' : 'none';
    this.onDeviceChange(d);
  }

  // ───────── touch UI ─────────
  private buildTouchUI(): HTMLElement {
    const root = document.createElement('div');
    root.id = 'touch-ui';
    root.innerHTML = `
      <div id="stick-zone"></div>
      <div id="stick-base"><div id="stick-knob"></div></div>
      <div id="btn-arc">
        <button class="glass b-attack" data-act="attack"><span>ATTACK</span></button>
        <button class="glass b-dash" data-act="dash"><span>DASH</span></button>
        <button class="glass b-skill" data-act="special"><span>SKILL<br>GLYPH</span></button>
        <button class="glass b-parry" data-act="parry"><span>PARRY</span></button>
        <button class="glass b-realm" data-act="realm"><span>VEIL<br>SHIFT</span></button>
      </div>`;
    this.host.parentElement!.appendChild(root);
    this.stickBase = root.querySelector('#stick-base')!;
    this.stickKnob = root.querySelector('#stick-knob')!;
    const zone = root.querySelector('#stick-zone') as HTMLElement;
    const R = 56;
    zone.addEventListener('pointerdown', (e) => {
      if (this.stickPointer !== -1) return;
      this.stickPointer = e.pointerId; zone.setPointerCapture(e.pointerId);
      this.stickOrigin = { x: e.clientX, y: e.clientY };
      this.stickBase.style.display = 'block';
      this.stickBase.style.left = `${e.clientX}px`; this.stickBase.style.top = `${e.clientY}px`;
      this.stickKnob.style.transform = 'translate(-50%,-50%)';
      this.setDevice('touch'); this.onFirstGesture();
    });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.stickPointer) return;
      let dx = e.clientX - this.stickOrigin.x, dy = e.clientY - this.stickOrigin.y;
      const len = Math.hypot(dx, dy);
      if (len > R) { dx *= R / len; dy *= R / len; }
      this.stickKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      this.touch.move = { x: dx / R, y: -dy / R };
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.stickPointer) return;
      this.stickPointer = -1; this.touch.move = { x: 0, y: 0 }; this.stickBase.style.display = 'none';
    };
    zone.addEventListener('pointerup', end); zone.addEventListener('pointercancel', end);
    root.querySelectorAll<HTMLButtonElement>('button[data-act]').forEach((b) => {
      const act = b.dataset.act!;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault(); b.setPointerCapture(e.pointerId); b.classList.add('down');
        this.setDevice('touch'); this.onFirstGesture();
        this.touch.edges.add(act);
        if (act === 'attack') this.touch.attackHeld = true;
      });
      const up = () => { b.classList.remove('down'); if (act === 'attack') this.touch.attackHeld = false; };
      b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up);
    });
    return root;
  }

  /** Called by the hero portrait cards. */
  requestSwap(i: number): void { this.touch.swap = i; this.onFirstGesture(); }
  requestNewSeed(): void { this.touch.edges.add('newseed'); this.onFirstGesture(); }

  // ───────── polling ─────────
  poll(): InputFrame {
    const f: InputFrame = {
      move: { x: 0, y: 0 }, aim: null, mouse: null,
      attackPressed: false, attackHeld: false, dashPressed: false, specialPressed: false, parryPressed: false,
      realmPressed: false, newSeedPressed: false, swapTo: -1, swapCycle: 0,
    };
    const key = (c: string) => this.keys.has(c);
    const hit = (...c: string[]) => c.some((k) => this.pressed.has(k));

    // keyboard + mouse
    let kx = (key('KeyD') || key('ArrowRight') ? 1 : 0) - (key('KeyA') || key('ArrowLeft') ? 1 : 0);
    let ky = (key('KeyW') || key('ArrowUp') ? 1 : 0) - (key('KeyS') || key('ArrowDown') ? 1 : 0);
    if (kx && ky) { kx *= Math.SQRT1_2; ky *= Math.SQRT1_2; }
    f.move.x = kx; f.move.y = ky;
    f.attackPressed = this.mousePressedAttack || hit('KeyJ');
    f.attackHeld = this.mouse.down || key('KeyJ');
    f.specialPressed = this.mousePressedSpecial || hit('KeyK');
    f.dashPressed = hit('Space');
    f.parryPressed = hit('KeyF', 'KeyE');
    f.realmPressed = hit('Tab', 'ShiftLeft', 'ShiftRight');
    f.newSeedPressed = hit('KeyR');
    if (hit('Digit1')) f.swapTo = 0; else if (hit('Digit2')) f.swapTo = 1; else if (hit('Digit3')) f.swapTo = 2;
    if (this.mouse.has && this.device === 'keyboard') f.mouse = { x: this.mouse.x, y: this.mouse.y };

    // touch
    if (this.device === 'touch' || this.touch.edges.size || this.touch.swap >= 0 || this.touch.move.x || this.touch.move.y) {
      if (this.touch.move.x || this.touch.move.y) { f.move.x = this.touch.move.x; f.move.y = this.touch.move.y; }
      f.attackHeld ||= this.touch.attackHeld;
      const e = this.touch.edges;
      f.attackPressed ||= e.has('attack'); f.dashPressed ||= e.has('dash'); f.specialPressed ||= e.has('special');
      f.parryPressed ||= e.has('parry'); f.realmPressed ||= e.has('realm'); f.newSeedPressed ||= e.has('newseed');
      if (this.touch.swap >= 0) f.swapTo = this.touch.swap;
    }

    // gamepad (GameSir G8+ and anything exposing the standard mapping)
    this.pollGamepad(f);

    this.pressed.clear(); this.touch.edges.clear(); this.touch.swap = -1;
    this.mousePressedAttack = false; this.mousePressedSpecial = false;
    return f;
  }

  private pollGamepad(f: InputFrame): void {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = Array.from(pads).find((p): p is Gamepad => !!p && p.connected);
    if (!pad) { this.padPrev = []; return; }
    this.gamepadName = pad.id;
    const dz = (v: number) => (Math.abs(v) < DEAD ? 0 : v);
    const lx = dz(pad.axes[0] ?? 0), ly = dz(pad.axes[1] ?? 0), rx = dz(pad.axes[2] ?? 0), ry = dz(pad.axes[3] ?? 0);
    const down = pad.buttons.map((b) => b.pressed || b.value > 0.5);
    const edge = (i: number) => down[i] && !this.padPrev[i];
    let active = lx !== 0 || ly !== 0 || rx !== 0 || ry !== 0;
    for (let i = 0; i < down.length; i++) if (edge(i)) active = true;
    if (active) this.setDevice('gamepad');
    if (this.device === 'gamepad') {
      if (lx || ly) { const m = Math.min(1, Math.hypot(lx, ly)); const a = Math.atan2(ly, lx); f.move.x = Math.cos(a) * m; f.move.y = -Math.sin(a) * m; }
      if (rx || ry) f.aim = { x: rx, y: -ry };
      f.dashPressed ||= edge(0);
      f.parryPressed ||= edge(1);
      f.attackPressed ||= edge(2); f.attackHeld ||= !!down[2];
      f.specialPressed ||= edge(3);
      if (edge(4)) f.swapCycle = -1; if (edge(5)) f.swapCycle = 1;
      if (edge(6) || edge(7)) f.realmPressed = true;
      f.newSeedPressed ||= edge(9);
      this.onFirstGesture();
    }
    this.padPrev = down;
  }
}
