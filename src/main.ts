import { assets } from './assets/AssetRegistry';
import { Game } from './Game';

async function boot(): Promise<void> {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const root = document.getElementById('ui') as HTMLElement;
  // Probe public/assets for generated .glb files; anything missing is covered by the procedural fallback.
  await assets.init();
  if (assets.loaded.length) console.info('[assets] loaded', assets.loaded.join(', '));
  else console.info('[assets] no .glb files found, using procedural fallbacks');
  const game = new Game(canvas, root);
  game.start();
}

void boot();
