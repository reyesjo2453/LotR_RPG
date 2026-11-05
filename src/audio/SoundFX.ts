/** Zero-dependency Web Audio synthesizer. Everything is generated at runtime. */
export class SoundFX {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noiseBuf!: AudioBuffer;
  private drone: { osc: OscillatorNode[]; gain: GainNode; filter: BiquadFilterNode } | null = null;
  muted = false;
  private last = new Map<string, number>();

  /** Must be called from a user gesture at least once. */
  unlock(): void {
    if (!this.ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.55;
      const comp = this.ctx.createDynamicsCompressor();
      this.master.connect(comp).connect(this.ctx.destination);
      const n = this.ctx.sampleRate * 1.5;
      this.noiseBuf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      this.startDrone();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  private ok(name: string, gap = 0.03): boolean {
    if (!this.ctx || this.muted) return false;
    const now = this.ctx.currentTime;
    if (now - (this.last.get(name) ?? -1) < gap) return false;
    this.last.set(name, now);
    return true;
  }

  private env(g: GainNode, t: number, peak: number, atk: number, dec: number): void {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t + atk + dec);
  }

  private tone(type: OscillatorType, f0: number, f1: number, t: number, atk: number, dec: number, peak: number, dest: AudioNode = this.master): void {
    const o = this.ctx!.createOscillator(), g = this.ctx!.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + atk + dec);
    this.env(g, t, peak, atk, dec);
    o.connect(g).connect(dest);
    o.start(t); o.stop(t + atk + dec + 0.05);
  }

  private noise(t: number, dur: number, peak: number, type: BiquadFilterType, f0: number, f1: number, q = 1): void {
    const s = this.ctx!.createBufferSource(), f = this.ctx!.createBiquadFilter(), g = this.ctx!.createGain();
    s.buffer = this.noiseBuf; f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    this.env(g, t, peak, 0.004, dur);
    s.connect(f).connect(g).connect(this.master);
    s.start(t, Math.random()); s.stop(t + dur + 0.05);
  }

  /** Metallic sword clash: inharmonic partials + bright noise. */
  clash(power = 1): void {
    if (!this.ok('clash')) return;
    const t = this.ctx!.currentTime, base = 1100 + Math.random() * 500;
    for (const r of [1, 1.51, 2.27, 3.13]) this.tone('square', base * r, base * r * 0.97, t, 0.002, 0.18 + 0.1 * power, 0.05 / r);
    this.noise(t, 0.12, 0.22 * power, 'highpass', 5000, 2500);
  }
  swing(): void {
    if (!this.ok('swing', 0.05)) return;
    this.noise(this.ctx!.currentTime, 0.18, 0.12, 'bandpass', 600, 3200, 1.5);
  }
  /** Arcane chime / bolt */
  arcane(): void {
    if (!this.ok('arcane', 0.04)) return;
    const t = this.ctx!.currentTime, f = [880, 1320, 1760][Math.floor(Math.random() * 3)];
    this.tone('sine', f, f * 1.01, t, 0.004, 0.45, 0.14);
    this.tone('triangle', f * 2.01, f * 2, t, 0.004, 0.25, 0.05);
    this.tone('sine', f * 0.5, f * 0.25, t, 0.002, 0.2, 0.1);
  }
  /** Heavy warhammer slam */
  slam(): void {
    if (!this.ok('slam', 0.1)) return;
    const t = this.ctx!.currentTime;
    this.tone('sine', 120, 38, t, 0.003, 0.55, 0.7);
    this.noise(t, 0.4, 0.4, 'lowpass', 1800, 90);
    this.tone('square', 330, 250, t, 0.002, 0.12, 0.08);
  }
  /** Perfect-deflection bell */
  parry(): void {
    if (!this.ok('parry', 0.1)) return;
    const t = this.ctx!.currentTime;
    for (const [r, v] of [[1, 0.22], [2.76, 0.12], [5.4, 0.07], [8.9, 0.04]] as const) this.tone('sine', 1560 * r, 1560 * r, t, 0.002, 1.1 / Math.sqrt(r), v);
    this.noise(t, 0.08, 0.3, 'highpass', 6000, 4000);
  }
  hit(): void {
    if (!this.ok('hit', 0.04)) return;
    const t = this.ctx!.currentTime;
    this.tone('sine', 220, 70, t, 0.002, 0.14, 0.4);
    this.noise(t, 0.09, 0.2, 'bandpass', 1500, 400);
  }
  hurt(): void {
    if (!this.ok('hurt', 0.1)) return;
    const t = this.ctx!.currentTime;
    this.tone('sawtooth', 180, 60, t, 0.004, 0.3, 0.25);
    this.noise(t, 0.2, 0.2, 'lowpass', 900, 100);
  }
  dash(): void {
    if (!this.ok('dash', 0.1)) return;
    this.noise(this.ctx!.currentTime, 0.22, 0.18, 'bandpass', 400, 4000, 0.8);
  }
  swap(): void {
    if (!this.ok('swap', 0.1)) return;
    const t = this.ctx!.currentTime;
    this.tone('sine', 300, 900, t, 0.01, 0.25, 0.2);
    this.tone('triangle', 600, 1800, t, 0.01, 0.2, 0.08);
  }
  glyph(): void {
    if (!this.ok('glyph', 0.1)) return;
    const t = this.ctx!.currentTime;
    this.tone('sine', 523, 523, t, 0.01, 0.5, 0.15); this.tone('sine', 784, 784, t + 0.08, 0.01, 0.5, 0.12);
  }
  detonate(): void {
    if (!this.ok('det', 0.1)) return;
    const t = this.ctx!.currentTime;
    this.tone('sine', 90, 30, t, 0.003, 0.9, 0.9);
    this.noise(t, 0.7, 0.5, 'lowpass', 4000, 120);
    for (const f of [440, 660, 990]) this.tone('sawtooth', f, f * 2, t, 0.003, 0.4, 0.06);
  }
  breakSfx(): void {
    if (!this.ok('break', 0.1)) return;
    const t = this.ctx!.currentTime;
    this.noise(t, 0.35, 0.45, 'highpass', 3000, 800);
    for (let i = 0; i < 5; i++) this.tone('triangle', 1800 + Math.random() * 2500, 700, t + i * 0.015, 0.001, 0.15, 0.05);
  }
  shatter(): void {
    if (!this.ok('shatter', 0.1)) return;
    const t = this.ctx!.currentTime;
    this.tone('sine', 70, 25, t, 0.004, 0.9, 0.7);
    this.noise(t, 0.8, 0.5, 'bandpass', 2400, 200, 0.6);
    this.tone('sine', 1760, 880, t, 0.003, 0.6, 0.1);
  }
  enemyTelegraph(): void {
    if (!this.ok('tele', 0.2)) return;
    const t = this.ctx!.currentTime;
    this.tone('sawtooth', 140, 520, t, 0.01, 0.4, 0.08);
  }
  portal(): void {
    if (!this.ok('portal', 0.5)) return;
    const t = this.ctx!.currentTime;
    for (const [i, f] of [392, 494, 587, 784].entries()) this.tone('sine', f, f, t + i * 0.1, 0.02, 1.2, 0.12);
  }

  tutorialPrompt(): void {
    if (!this.ok('tp', 0.2)) return;
    const t = this.ctx!.currentTime;
    this.tone('sine', 660, 660, t, 0.01, 0.35, 0.09); this.tone('sine', 990, 990, t + 0.07, 0.01, 0.4, 0.07);
  }
  tutorialStep(): void {
    if (!this.ok('ts', 0.2)) return;
    const t = this.ctx!.currentTime;
    for (const [i, f] of [523, 659, 784].entries()) { this.tone('triangle', f, f, t + i * 0.07, 0.008, 0.5, 0.13); this.tone('sine', f * 2, f * 2, t + i * 0.07, 0.008, 0.4, 0.05); }
  }
  tutorialDone(): void {
    if (!this.ok('td', 0.5)) return;
    const t = this.ctx!.currentTime;
    for (const [i, f] of [392, 494, 587, 784, 988].entries()) { this.tone('triangle', f, f, t + i * 0.1, 0.01, 1.4, 0.13); this.tone('sine', f / 2, f / 2, t + i * 0.1, 0.01, 1.6, 0.1); }
    this.noise(t, 0.9, 0.06, 'highpass', 6000, 3000);
  }

  /** Persistent sub-bass drone; opens up in the Unseen Realm. */
  private startDrone(): void {
    const c = this.ctx!;
    const gain = c.createGain(), filter = c.createBiquadFilter();
    filter.type = 'lowpass'; filter.frequency.value = 120; gain.gain.value = 0.0;
    const osc = [c.createOscillator(), c.createOscillator(), c.createOscillator()];
    osc[0].frequency.value = 41; osc[0].type = 'sine';
    osc[1].frequency.value = 41.6; osc[1].type = 'sawtooth';
    osc[2].frequency.value = 82.4; osc[2].type = 'triangle';
    const lfo = c.createOscillator(), lg = c.createGain();
    lfo.frequency.value = 0.18; lg.gain.value = 18; lfo.connect(lg).connect(filter.frequency); lfo.start();
    osc.forEach((o) => { o.connect(filter); o.start(); });
    filter.connect(gain).connect(this.master);
    gain.gain.setTargetAtTime(0.05, c.currentTime, 1.5);
    this.drone = { osc, gain, filter };
  }

  /** Deep Voronoi realm-shift boom + drone retune. */
  realmShift(toUnseen: boolean): void {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    this.tone('sine', toUnseen ? 110 : 55, toUnseen ? 28 : 90, t, 0.01, 1.1, 0.8);
    this.noise(t, 0.9, 0.35, 'bandpass', toUnseen ? 300 : 3000, toUnseen ? 3000 : 300, 2);
    for (let i = 0; i < 8; i++) this.tone('triangle', 1200 + Math.random() * 3000, 600, t + 0.05 + i * 0.045, 0.002, 0.2, 0.035);
    if (this.drone) {
      this.drone.filter.frequency.setTargetAtTime(toUnseen ? 380 : 120, t, 0.4);
      this.drone.gain.gain.setTargetAtTime(toUnseen ? 0.11 : 0.05, t, 0.5);
      this.drone.osc[0].frequency.setTargetAtTime(toUnseen ? 36 : 41, t, 0.6);
    }
  }
}

export const sfx = new SoundFX();
