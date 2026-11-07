import * as THREE from 'three';
import { realm } from '../world/RealmManager';

/** Uniform objects shared by reference across every patched material. */
export const sharedUniforms = {
  uRealmBlend: { value: 0 },
  uTime: { value: 0 },
};

const VORONOI = /* glsl */ `
vec2 hash22(vec2 p){ p=vec2(dot(p,vec2(127.1,311.7)),dot(p,vec2(269.5,183.3))); return fract(sin(p)*43758.5453); }
// x = F2-F1 (edge distance), y = cell id
vec2 voroEdge(vec2 x){
  vec2 n=floor(x), f=fract(x); float d1=8.0, d2=8.0; float id=0.0;
  for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++){
    vec2 g=vec2(float(i),float(j)); vec2 h=hash22(n+g);
    vec2 o=0.5+0.5*sin(uTime*0.5+6.2831*h); vec2 r=g+o-f; float d=dot(r,r);
    if(d<d1){ d2=d1; d1=d; id=h.x; } else if(d<d2){ d2=d; }
  }
  return vec2(sqrt(d2)-sqrt(d1), id);
}`;

const GRADE = /* glsl */ `
#ifdef OPAQUE
diffuseColor.a = 1.0;
#endif
vec3 col = outgoingLight;
float lum = dot(col, vec3(0.299,0.587,0.114));
float ql = floor(clamp(lum,0.0,1.3)*3.0+0.5)/3.0;   // crisp 3-step cel bands
col *= mix(1.0, (ql+0.07)/(lum+0.07), uBand);
float un = uRealmBlend;
vec3 seenC = col * vec3(1.08,0.97,0.86);
float g = dot(col, vec3(0.299,0.587,0.114));
vec3 unseenC = mix(vec3(g), col, 0.2) * vec3(0.60,0.66,1.22) + vec3(0.015,0.02,0.06);
col = mix(seenC, unseenC, un);
if (uVein > 0.0 && un > 0.001) {
  vec2 v = voroEdge(vWPos.xz*0.5);
  float e = smoothstep(0.075, 0.0, v.x);
  vec3 vc = mix(vec3(0.10,1.0,0.55), vec3(0.68,0.28,1.0), step(0.5, v.y));
  col += vc * e * un * uVein * (0.75 + 0.35*sin(uTime*2.0 + v.y*9.0));
}
float rim = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)),0.0,1.0), 3.0);
col += smoothstep(0.30,0.46,rim) * uRim * mix(vec3(0.50,0.40,0.15), vec3(0.45,1.0,0.85)*1.3, un);
gl_FragColor = vec4(col, diffuseColor.a);
`;

export interface ToonOpts {
  color?: THREE.ColorRepresentation;
  veins?: number;
  /** 1 = full 3-step cel banding, lower keeps more of a painted texture's detail */
  band?: number;
  rim?: number;
  vertexColors?: boolean;
  transparent?: boolean;
  opacity?: number;
  emissive?: THREE.ColorRepresentation;
  emissiveIntensity?: number;
  map?: THREE.Texture | null;
  side?: THREE.Side;
}

/** Attach the Toon + Rim + uRealmBlend injection to any MeshLambertMaterial (instanced, skinned or plain). */
export function injectRealmShader(mat: THREE.MeshLambertMaterial, veins = 0, rim = 1, band = 1): THREE.MeshLambertMaterial {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRealmBlend = sharedUniforms.uRealmBlend;
    shader.uniforms.uTime = sharedUniforms.uTime;
    shader.uniforms.uVein = { value: veins };
    shader.uniforms.uRim = { value: rim };
    shader.uniforms.uBand = { value: band };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 wp4 = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          wp4 = instanceMatrix * wp4;
        #endif
        vWPos = (modelMatrix * wp4).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWPos;\nuniform float uRealmBlend; uniform float uTime; uniform float uVein; uniform float uRim; uniform float uBand;\n${VORONOI}`)
      .replace('#include <opaque_fragment>', GRADE);
  };
  mat.customProgramCacheKey = () => 'toonrealm';
  return mat;
}

export function createToonMaterial(o: ToonOpts = {}): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({
    color: o.color ?? 0xffffff,
    vertexColors: o.vertexColors ?? false,
    transparent: o.transparent ?? false,
    opacity: o.opacity ?? 1,
    emissive: o.emissive ?? 0x000000,
    emissiveIntensity: o.emissiveIntensity ?? 1,
    map: o.map ?? null,
    side: o.side ?? THREE.FrontSide,
  });
  return injectRealmShader(mat, o.veins ?? 0, o.rim ?? 1, o.band ?? 1);
}

/** Convert imported glTF materials so characters share the same toon/realm look. */
export function toonifyObject(root: THREE.Object3D, lift = 0): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const conv = (src: THREE.Material): THREE.Material => {
      const s = src as THREE.MeshStandardMaterial;
      const out = createToonMaterial({ color: s.color ?? 0xffffff, map: s.map ?? null, vertexColors: !!(m.geometry.getAttribute('color')), emissive: s.emissive ?? 0, emissiveIntensity: s.emissiveIntensity ?? 1, transparent: s.transparent, opacity: s.opacity, side: s.side }) as THREE.MeshLambertMaterial;
      // lift: self-lit fraction of the albedo texture so dark imported art stays readable in shadow
      if (lift > 0 && s.map) { out.emissiveMap = s.map; out.emissive = new THREE.Color(1, 1, 1); out.emissiveIntensity = lift; }
      return out;
    };
    m.material = Array.isArray(m.material) ? m.material.map(conv) : conv(m.material);
  });
}

/** Screen-space Voronoi stained-glass ripple, drawn over the scene during a Veil Shift. */
export class VeilRippleOverlay {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mat: THREE.ShaderMaterial;
  constructor() {
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthTest: false, depthWrite: false,
      uniforms: { uT: { value: 1 }, uAspect: { value: 1 }, uToUnseen: { value: 1 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.0,1.0); }',
      fragmentShader: /* glsl */ `
        precision highp float; varying vec2 vUv; uniform float uT, uAspect, uToUnseen;
        vec2 h22(vec2 p){ p=vec2(dot(p,vec2(127.1,311.7)),dot(p,vec2(269.5,183.3))); return fract(sin(p)*43758.5453); }
        void main(){
          vec2 p=(vUv-0.5)*vec2(uAspect,1.0);
          float r=length(p), ring=uT*1.35;
          float band=exp(-pow((r-ring)*5.0,2.0));
          vec2 x=p*9.0, n=floor(x), f=fract(x); float d1=8.0,d2=8.0; float id=0.0;
          for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++){ vec2 g=vec2(float(i),float(j)); vec2 h=h22(n+g); vec2 rr=g+h-f; float d=dot(rr,rr);
            if(d<d1){d2=d1;d1=d;id=h.x;} else if(d<d2){d2=d;} }
          float edge=smoothstep(0.09,0.0,sqrt(d2)-sqrt(d1));
          vec3 glassA = mix(vec3(0.10,0.95,0.60), vec3(0.65,0.30,1.0), id);
          vec3 glassB = mix(vec3(1.0,0.78,0.30), vec3(1.0,0.45,0.20), id);
          vec3 glass = mix(glassB, glassA, uToUnseen);
          vec3 col = glass*(0.45+0.55*id) + vec3(0.9)*edge*0.9;
          float a = band*(1.0-uT)*(0.55+0.45*edge);
          gl_FragColor=vec4(col,a);
        }`,
    });
    const tri = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    tri.frustumCulled = false;
    this.scene.add(tri);
  }
  render(renderer: THREE.WebGLRenderer, aspect: number): void {
    if (realm.flashT >= 1) return;
    this.mat.uniforms.uT.value = realm.flashT;
    this.mat.uniforms.uAspect.value = aspect;
    this.mat.uniforms.uToUnseen.value = realm.isUnseenRealm ? 1 : 0;
    renderer.render(this.scene, this.camera);
  }
}
