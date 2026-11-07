import * as THREE from 'three';

let _tex: THREE.CanvasTexture | null = null;
/** Soft radial falloff used by blob shadows (alpha) and floor glow pools. */
export function radialTexture(): THREE.CanvasTexture {
  if (_tex) return _tex;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.45, 'rgba(255,255,255,0.55)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  _tex = new THREE.CanvasTexture(c);
  return _tex;
}

/** Cheap contact shadows: dark soft discs on the floor, one draw call. Works at phone cost. */
export class BlobShadows {
  readonly mesh: THREE.InstancedMesh;
  private n = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
  constructor(private max: number, opacity = 0.6) {
    const mat = new THREE.MeshBasicMaterial({ map: radialTexture(), color: 0x000000, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(2, 2), mat, max);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 1; this.mesh.count = 0;
  }
  begin(): void { this.n = 0; }
  add(x: number, z: number, r: number): void {
    if (this.n >= this.max) return;
    this.mesh.setMatrixAt(this.n++, this.m.compose(new THREE.Vector3(x, 0.025, z), this.q, new THREE.Vector3(r, r, r)));
  }
  end(): void { this.mesh.count = this.n; this.mesh.instanceMatrix.needsUpdate = true; }
  dispose(): void { this.mesh.geometry.dispose(); (this.mesh.material as THREE.Material).dispose(); }
}
