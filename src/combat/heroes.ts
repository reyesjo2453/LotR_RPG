import type { CharacterId } from '../assets/ProceduralAssetFallback';

export interface Strike {
  dmg: number; posture: number; radius: number; arc: number;
  dur: number; hitAt: number; lunge: number; kb: number; finisher?: boolean;
}

export interface HeroDef {
  id: CharacterId; name: string; title: string;
  color: number; css: string; glyphColor: number; glyphName: string;
  maxHp: number; speed: number;
  combo: Strike[]; ranged: boolean;
  special: Strike & { name: string; cost: number; detBase: number };
}

const DEG = Math.PI / 180;

export const HEROES: HeroDef[] = [
  {
    id: 'vaelen', name: 'VAELEN', title: 'ASTRAL BLADE-WARDEN', color: 0x7fe8ff, css: '#7fe8ff',
    glyphColor: 0xffc94a, glyphName: 'Solar Glyph', maxHp: 100, speed: 6.8, ranged: false,
    combo: [
      { dmg: 14, posture: 6, radius: 2.6, arc: 130 * DEG, dur: 0.26, hitAt: 0.35, lunge: 0.9, kb: 2.5 },
      { dmg: 15, posture: 6, radius: 2.6, arc: 130 * DEG, dur: 0.26, hitAt: 0.35, lunge: 0.9, kb: 2.5 },
      { dmg: 24, posture: 14, radius: 3.1, arc: 200 * DEG, dur: 0.4, hitAt: 0.4, lunge: 1.6, kb: 5, finisher: true },
    ],
    special: { name: 'Dash Flurry', cost: 30, detBase: 36, dmg: 11, posture: 6, radius: 2.5, arc: Math.PI * 2, dur: 0.34, hitAt: 0, lunge: 0, kb: 2 },
  },
  {
    id: 'seraphina', name: 'SERAPHINA', title: 'VEIL-WEAVER', color: 0xb98cff, css: '#b98cff',
    glyphColor: 0xb36bff, glyphName: 'Astral Glyph', maxHp: 80, speed: 6.2, ranged: true,
    combo: [{ dmg: 11, posture: 4, radius: 0, arc: 0, dur: 0.3, hitAt: 0.4, lunge: 0, kb: 1 }],
    special: { name: 'Spectral Sever', cost: 30, detBase: 28, dmg: 28, posture: 55, radius: 5, arc: Math.PI * 2, dur: 0.42, hitAt: 0.3, lunge: 0, kb: 5 },
  },
  {
    id: 'kaelen', name: 'KAELEN', title: 'RUNESMITH VANGUARD', color: 0xffd36a, css: '#ffd36a',
    glyphColor: 0x35e0ff, glyphName: 'Resonance Glyph', maxHp: 140, speed: 5.6, ranged: false,
    combo: [
      { dmg: 24, posture: 18, radius: 2.9, arc: 160 * DEG, dur: 0.52, hitAt: 0.5, lunge: 0.7, kb: 4.5 },
      { dmg: 38, posture: 30, radius: 3.3, arc: 220 * DEG, dur: 0.64, hitAt: 0.55, lunge: 1.1, kb: 8, finisher: true },
    ],
    special: { name: 'Seismic Anvil Slam', cost: 35, detBase: 32, dmg: 32, posture: 55, radius: 4.3, arc: Math.PI * 2, dur: 0.58, hitAt: 0.55, lunge: 0, kb: 9 },
  },
];
