import * as THREE from 'three';

const GROUND = 0.06;

function glyphTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.translate(128, 128); g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineCap = 'round';
  g.lineWidth = 5; g.beginPath(); g.arc(0, 0, 120, 0, Math.PI * 2); g.stroke();
  g.lineWidth = 2.5; g.beginPath(); g.arc(0, 0, 104, 0, Math.PI * 2); g.stroke();
  g.lineWidth = 3; g.beginPath(); g.arc(0, 0, 62, 0, Math.PI * 2); g.stroke();
  for (let i = 0; i < 24; i++) { g.save(); g.rotate((i / 24) * Math.PI * 2); g.fillRect(-2, -118, 4, i % 2 ? 9 : 15); g.restore(); }
  for (let k = 0; k < 2; k++) { g.save(); g.rotate(k * Math.PI / 3); g.beginPath(); for (let i = 0; i < 3; i++) { const a = (i / 3) * Math.PI * 2 - Math.PI / 2; g[i ? 'lineTo' : 'moveTo'](Math.cos(a) * 100, Math.sin(a) * 100); } g.closePath(); g.stroke(); g.restore(); }
  for (let i = 0; i < 8; i++) { g.save(); g.rotate((i / 8) * Math.PI * 2); g.translate(0, -82); g.fillRect(-2, -6, 4, 12); g.fillRect(-7, -1, 14, 3); g.restore(); }
  g.beginPath(); g.arc(0, 0, 14, 0, Math.PI * 2); g.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

interface Pooled<T> { obj: T; busy: boolean }

export class Glyph {
  mesh: THREE.Mesh; t = 0; life = 8; owner = 0; radius = 2.3; active = false;
  constructor(mesh: THREE.Mesh) { this.mesh = mesh; }
}
export class Telegraph {
  group: THREE.Group; ring: THREE.Mesh; disc: THREE.Mesh; busy = false; t = 0; dur = 0.45; r = 2;
  constructor(g: THREE.Group, ring: THREE.Mesh, disc: THREE.Mesh) { this.group = g; this.ring = ring; this.disc = disc; }
}

export class FX {
  readonly group = new THREE.Group();
  // CPU particle pool rendered as one Points draw call
  private N = 600;
  private pPos = new Float32Array(this.N * 3); private pCol = new Float32Array(this.N * 3);
  private pSize = new Float32Array(this.N); private pAlpha = new Float32Array(this.N);
  private pVel = new Float32Array(this.N * 3); private pLife = new Float32Array(this.N); private pMax = new Float32Array(this.N);
  private pGrav = new Float32Array(this.N);
  private pCursor = 0;
  private points: THREE.Points;
  private pointsMat: THREE.ShaderMaterial;

  private arcs: Array<{ g: THREE.Group; mat: THREE.ShaderMaterial; t: number; dur: number; busy: boolean }> = [];
  private rings: Array<{ mesh: THREE.Mesh; t: number; dur: number; max: number; busy: boolean }> = [];
  private ghosts: Array<{ mesh: THREE.Mesh; t: number; busy: boolean }> = [];
  private glyphs: Glyph[] = [];
  private teles: Telegraph[] = [];
  private bolts: Array<Pooled<THREE.Mesh>> = [];
  private beams: Array<{ line: THREE.Line; busy: boolean; pts: THREE.Vector3[] }> = [];
  private glyphTex = glyphTexture();
  private time = 0;

  constructor() {
    // particles
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.pCol, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.pSize, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.pAlpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.pointsMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uPR: { value: 1 } },
      vertexShader: 'attribute vec3 aColor; attribute float aSize; attribute float aAlpha; uniform float uPR; varying vec3 vC; varying float vA; void main(){ vC=aColor; vA=aAlpha; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); gl_PointSize=aSize*uPR; }',
      fragmentShader: 'varying vec3 vC; varying float vA; void main(){ float r=length(gl_PointCoord-0.5)*2.0; float a=smoothstep(1.0,0.2,r)*vA; if(a<0.01) discard; gl_FragColor=vec4(vC,a); }',
    });
    this.points = new THREE.Points(g, this.pointsMat);
    this.points.frustumCulled = false; this.points.renderOrder = 10;
    this.group.add(this.points);

    // slash arcs (ribbon sectors with a sweeping head)
    const arcGeo = new THREE.RingGeometry(0.45, 1, 28, 1, -1.05, 2.1);
    for (let i = 0; i < 8; i++) {
      const mat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        uniforms: { uT: { value: 1 }, uColor: { value: new THREE.Color(1, 1, 1) }, uArc: { value: 2.1 } },
        vertexShader: 'varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
        fragmentShader: `varying vec3 vP; uniform float uT, uArc; uniform vec3 uColor;
          void main(){ float a=(atan(vP.y,vP.x)+uArc*0.5)/uArc; float r=length(vP.xy);
            float head=uT*1.5; float tail=clamp(1.0-(head-a)/0.75,0.0,1.0)*step(a,head);
            float rad=smoothstep(0.45,0.8,r)*(1.0-smoothstep(0.93,1.0,r)*0.5);
            float al=tail*rad*(1.0-uT*uT); gl_FragColor=vec4(mix(uColor,vec3(1.0),tail*0.45)*1.4,al*0.95); }`,
      });
      const mesh = new THREE.Mesh(arcGeo, mat); mesh.rotation.x = -Math.PI / 2; mesh.position.y = 0.9; mesh.frustumCulled = false;
      const g2 = new THREE.Group(); g2.add(mesh); g2.visible = false; g2.renderOrder = 9; this.group.add(g2);
      this.arcs.push({ g: g2, mat, t: 1, dur: 0.3, busy: false });
    }
    // shock rings
    const ringGeo = new THREE.RingGeometry(0.88, 1, 40).rotateX(-Math.PI / 2);
    for (let i = 0; i < 12; i++) {
      const mesh = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
      mesh.visible = false; mesh.position.y = GROUND + 0.05; this.group.add(mesh);
      this.rings.push({ mesh, t: 1, dur: 0.4, max: 3, busy: false });
    }
    // afterimages
    const ghostGeo = new THREE.CapsuleGeometry(0.32, 0.9, 3, 8).translate(0, 0.95, 0);
    for (let i = 0; i < 10; i++) {
      const mesh = new THREE.Mesh(ghostGeo, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      mesh.visible = false; this.group.add(mesh); this.ghosts.push({ mesh, t: 1, busy: false });
    }
    // glyph decals
    const glyphGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    for (let i = 0; i < 6; i++) {
      const mesh = new THREE.Mesh(glyphGeo, new THREE.MeshBasicMaterial({ map: this.glyphTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      mesh.visible = false; mesh.position.y = GROUND; mesh.renderOrder = 1; this.group.add(mesh); this.glyphs.push(new Glyph(mesh));
    }
    // telegraph rings
    for (let i = 0; i < 10; i++) {
      const grp = new THREE.Group();
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xff2040, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
      const disc = new THREE.Mesh(new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xff1030, transparent: true, opacity: 0.2, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
      grp.add(disc, ring); grp.visible = false; grp.position.y = GROUND + 0.02; this.group.add(grp);
      this.teles.push(new Telegraph(grp, ring, disc));
    }
    // bolts
    const boltGeo = new THREE.IcosahedronGeometry(0.2, 1);
    for (let i = 0; i < 14; i++) {
      const mesh = new THREE.Mesh(boltGeo, new THREE.MeshBasicMaterial({ color: 0xcaa8ff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      mesh.visible = false; this.group.add(mesh); this.bolts.push({ obj: mesh, busy: false });
    }
    // tether beams
    for (let i = 0; i < 10; i++) {
      const pts = Array.from({ length: 18 }, () => new THREE.Vector3());
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x7affd0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      line.frustumCulled = false; line.visible = false; this.group.add(line); this.beams.push({ line, busy: false, pts });
    }
  }

  setPixelRatio(pr: number): void { this.pointsMat.uniforms.uPR.value = pr; }

  // ───── particles ─────
  private spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, c: THREE.Color, grav: number): void {
    const i = this.pCursor; this.pCursor = (this.pCursor + 1) % this.N;
    this.pPos.set([x, y, z], i * 3); this.pVel.set([vx, vy, vz], i * 3); this.pCol.set([c.r, c.g, c.b], i * 3);
    this.pLife[i] = life; this.pMax[i] = life; this.pSize[i] = size; this.pAlpha[i] = 1; this.pGrav[i] = grav;
  }
  burst(x: number, y: number, z: number, color: number, count = 18, speed = 6, life = 0.5, size = 9, grav = 6): void {
    const c = new THREE.Color(color);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, up = Math.random() * 0.9 + 0.1, s = speed * (0.4 + Math.random() * 0.8);
      this.spawn(x, y, z, Math.cos(a) * s, up * s, Math.sin(a) * s, life * (0.6 + Math.random() * 0.6), size * (0.6 + Math.random() * 0.8), c, grav);
    }
  }
  sparks(x: number, y: number, z: number, count = 26): void { this.burst(x, y, z, 0xfff2c0, count, 11, 0.4, 7, 14); this.burst(x, y, z, 0xffa040, count / 2, 6, 0.5, 9, 8); }

  // ───── slash ribbon ─────
  slashArc(x: number, z: number, yaw: number, color: number, radius: number, dur = 0.32): void {
    const a = this.arcs.find((s) => !s.busy); if (!a) return;
    a.busy = true; a.t = 0; a.dur = dur; a.g.visible = true;
    a.g.position.set(x, 0, z); a.g.rotation.y = yaw - Math.PI / 2; a.g.scale.setScalar(radius);
    a.mat.uniforms.uColor.value.set(color);
  }

  // ───── shockwave ─────
  shockwave(x: number, z: number, color: number, maxR = 4, dur = 0.45, y = 0): void {
    const r = this.rings.find((s) => !s.busy); if (!r) return;
    r.busy = true; r.t = 0; r.dur = dur; r.max = maxR; r.mesh.visible = true;
    r.mesh.position.set(x, GROUND + 0.05 + y, z); r.mesh.scale.setScalar(0.2);
    (r.mesh.material as THREE.MeshBasicMaterial).color.set(color);
  }

  afterimage(x: number, z: number, yaw: number, color: number): void {
    const gh = this.ghosts.find((s) => !s.busy); if (!gh) return;
    gh.busy = true; gh.t = 0; gh.mesh.visible = true; gh.mesh.position.set(x, 0, z); gh.mesh.rotation.y = yaw;
    (gh.mesh.material as THREE.MeshBasicMaterial).color.set(color);
  }

  // ───── glyph decals ─────
  addGlyph(x: number, z: number, color: number, owner: number): Glyph {
    // recycle: prefer free, else oldest
    let g = this.glyphs.find((s) => !s.active);
    if (!g) g = this.glyphs.reduce((a, b) => (a.t > b.t ? a : b));
    g.active = true; g.t = 0; g.life = 8; g.owner = owner; g.mesh.visible = true;
    g.mesh.position.set(x, GROUND, z);
    (g.mesh.material as THREE.MeshBasicMaterial).color.set(color);
    return g;
  }
  removeGlyph(g: Glyph): void { g.active = false; g.mesh.visible = false; }
  get activeGlyphs(): Glyph[] { return this.glyphs.filter((g) => g.active); }
  clearGlyphs(): void { this.glyphs.forEach((g) => this.removeGlyph(g)); }

  // ───── telegraph rings ─────
  telegraph(x: number, z: number, r: number, dur = 0.45): Telegraph | null {
    const t = this.teles.find((s) => !s.busy); if (!t) return null;
    t.busy = true; t.t = 0; t.dur = dur; t.r = r; t.group.visible = true; t.group.position.x = x; t.group.position.z = z;
    return t;
  }
  moveTelegraph(t: Telegraph, x: number, z: number): void { t.group.position.x = x; t.group.position.z = z; }
  releaseTelegraph(t: Telegraph | null): void { if (t) { t.busy = false; t.group.visible = false; } }

  // ───── projectiles / beams ─────
  acquireBolt(color: number): THREE.Mesh | null {
    const b = this.bolts.find((s) => !s.busy); if (!b) return null;
    b.busy = true; b.obj.visible = true; (b.obj.material as THREE.MeshBasicMaterial).color.set(color); return b.obj;
  }
  releaseBolt(m: THREE.Mesh): void { const b = this.bolts.find((s) => s.obj === m); if (b) { b.busy = false; m.visible = false; } }

  /** Draw a wavering spline tether beam for this frame. Returns false if the pool is exhausted. */
  beam(ax: number, ay: number, az: number, bx: number, by: number, bz: number, color: number): boolean {
    const b = this.beams.find((s) => !s.busy); if (!b) return false;
    b.busy = true; b.line.visible = true;
    const mid = new THREE.Vector3((ax + bx) / 2, Math.max(ay, by) + 0.9, (az + bz) / 2);
    const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(ax, ay, az), mid, new THREE.Vector3(bx, by, bz));
    const pos = b.line.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < b.pts.length; i++) {
      const u = i / (b.pts.length - 1); curve.getPoint(u, b.pts[i]);
      const w = Math.sin(u * Math.PI) * 0.18;
      pos.setXYZ(i, b.pts[i].x + Math.sin(this.time * 14 + u * 12) * w, b.pts[i].y + Math.cos(this.time * 11 + u * 9) * w, b.pts[i].z + Math.sin(this.time * 9 + u * 7) * w);
    }
    pos.needsUpdate = true;
    (b.line.material as THREE.LineBasicMaterial).color.set(color);
    return true;
  }

  update(dt: number): void {
    this.time += dt;
    // beams are re-requested every frame
    for (const b of this.beams) { if (!b.busy) b.line.visible = false; b.busy = false; }

    for (let i = 0; i < this.N; i++) {
      if (this.pLife[i] <= 0) { this.pAlpha[i] = 0; continue; }
      this.pLife[i] -= dt;
      const u = Math.max(0, this.pLife[i] / this.pMax[i]);
      this.pVel[i * 3 + 1] -= this.pGrav[i] * dt;
      this.pPos[i * 3] += this.pVel[i * 3] * dt; this.pPos[i * 3 + 1] = Math.max(0.03, this.pPos[i * 3 + 1] + this.pVel[i * 3 + 1] * dt); this.pPos[i * 3 + 2] += this.pVel[i * 3 + 2] * dt;
      this.pAlpha[i] = u;
    }
    for (const k of ['position', 'aColor', 'aSize', 'aAlpha'] as const) (this.points.geometry.getAttribute(k) as THREE.BufferAttribute).needsUpdate = true;

    for (const a of this.arcs) if (a.busy) {
      a.t += dt / a.dur;
      if (a.t >= 1) { a.busy = false; a.g.visible = false; continue; }
      a.mat.uniforms.uT.value = a.t;
    }
    for (const r of this.rings) if (r.busy) {
      r.t += dt / r.dur;
      if (r.t >= 1) { r.busy = false; r.mesh.visible = false; continue; }
      const e = 1 - Math.pow(1 - r.t, 3);
      r.mesh.scale.setScalar(0.2 + e * r.max);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - r.t) * 0.95;
    }
    for (const g of this.ghosts) if (g.busy) {
      g.t += dt / 0.35;
      if (g.t >= 1) { g.busy = false; g.mesh.visible = false; continue; }
      (g.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - g.t) * 0.45;
    }
    for (const g of this.glyphs) if (g.active) {
      g.t += dt;
      if (g.t >= g.life) { this.removeGlyph(g); continue; }
      const pop = Math.min(1, g.t / 0.18), fade = Math.min(1, (g.life - g.t) / 1.5);
      const s = g.radius * 2.2 * (0.6 + 0.4 * pop) * (1 + Math.sin(g.t * 5) * 0.025);
      g.mesh.scale.set(s, 1, s); g.mesh.rotation.y = g.t * 0.8;
      (g.mesh.material as THREE.MeshBasicMaterial).opacity = fade * (0.75 + 0.25 * Math.sin(g.t * 6));
    }
    for (const t of this.teles) if (t.busy) {
      t.t += dt;
      const u = Math.min(1, t.t / t.dur);
      const s = t.r * (2.0 - 1.0 * u);
      t.ring.scale.setScalar(s); t.disc.scale.setScalar(t.r);
      (t.ring.material as THREE.MeshBasicMaterial).opacity = 0.35 + 0.65 * u;
      (t.disc.material as THREE.MeshBasicMaterial).opacity = 0.08 + 0.3 * u;
    }
  }

  clearAll(): void {
    this.clearGlyphs();
    this.teles.forEach((t) => this.releaseTelegraph(t));
    this.bolts.forEach((b) => { b.busy = false; b.obj.visible = false; });
    this.pLife.fill(0);
  }
}
