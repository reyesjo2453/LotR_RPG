# Concord of the Veil

Mobile-first dark-fantasy action game (Three.js + TypeScript + Vite + GSAP).

```
npm install
npm run dev        # play (add ?seed=1234 for a fixed floor)
npm run build      # tsc --noEmit && vite build
```

Playable immediately: every character and prop has a procedural fallback.

## Optional cloud asset pipeline (Tripo3D)
```
cp .env.example .env     # set TRIPO_API_KEY
npm run gen:chars        # public/assets/models/<name>.glb (+ <name>.run/slash/hit.glb clips)
npm run gen:env          # public/assets/env/<name>.glb
```
Scripts exit cleanly without a key. Existing `.glb` files are picked up automatically at runtime.

## Controls
Keyboard/mouse: WASD, J/click attack, K/right-click special, Space dash, F/E parry, Tab/Shift veil shift, 1-2-3 swap, R new seed.
Gamepad (GameSir G8+): L-stick move, R-stick aim, A dash, B parry, X attack, Y special, L1/R1 swap, L2/R2 veil shift, Start new seed.
Touch: floating left joystick, glass button arc (right), tap hero cards to swap.
