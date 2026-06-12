import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { GmpMap, MAP_SIZE, TileAnimation } from '../gta2/gmp';
import { Sty } from '../gta2/sty';
import { buildTileAtlas } from '../gta2/atlas';
import { buildChunkGeometry, CHUNK, computeTransparentTiles, GeomArrays } from '../gta2/citymesh';

/**
 * Renders the GTA2 block city with a perspective camera looking straight
 * down — exactly how the original gets its 2.5D look: walls of tall
 * buildings lean away from the screen centre.
 */

export interface RenderEntity {
  key: string; // 'car:12', 'ped:7', 'player', 'pickup:3', ...
  sprite: number; // STY sprite index
  remapPhys?: number; // physical palette override (car colours, ped skins)
  /** sprite delta overlays to composite (car damage dents) */
  deltas?: number[];
  x: number; // block units
  y: number;
  z: number;
  angle: number; // heading, 0 = +x
  /** extra multiplier on the natural sprite size */
  scale?: number;
  /** colour multiplier, e.g. 0x333333 to darken wrecks */
  tint?: number;
  /** extra art-orientation correction in radians (rarely needed) */
  angleOffset?: number;
  /** ground slope gradient at the entity (sim coords) for hill tilting */
  dzdx?: number;
  dzdy?: number;
  /** GTA2 drop shadow (cars/peds): dark copy offset down-right */
  shadow?: boolean;
  /** dusk/dawn: render headlight cone + tail-light glow for this car */
  headlights?: boolean;
}

const Z_UP = new THREE.Vector3(0, 0, 1);
const NORMAL = new THREE.Vector3();
const QA = new THREE.Quaternion();
const QB = new THREE.Quaternion();

export interface FxSpawn {
  kind: 'muzzle' | 'blood' | 'bloodspray' | 'explosion' | 'smoke' | 'spark' | 'dust' | 'fire' | 'electro';
  x: number;
  y: number;
  z: number;
}

export type TracerKind = 'bullet' | 'rocket' | 'grenade' | 'molotov' | 'flame';

export interface TracerInfo {
  id: number;
  kind: TracerKind;
  x: number;
  y: number;
  z: number;
  angle: number;
  /** 0..1 age fraction, used to scale flame puffs as they fly */
  age?: number;
}

const TRACER_STYLE: Record<TracerKind, { w: number; h: number }> = {
  bullet: { w: 0.06, h: 0.42 },
  rocket: { w: 0.12, h: 0.5 },
  grenade: { w: 0.09, h: 0.09 },
  molotov: { w: 0.1, h: 0.16 },
  flame: { w: 0.3, h: 0.3 },
};

interface Effect {
  mesh: THREE.Mesh;
  ttl: number;
  life: number;
  vx: number;
  vy: number;
  grow: number;
  fade: boolean;
}

const EYE_FOOT = 6.5; // camera height above ground in blocks, walking
const EYE_DRIVE = 10; // max while driving fast

/** Optional GPU post-processing (FX panel "shaders"). */
export interface ShaderFx {
  bloom: number; // 0..1
  vignette: number; // 0..1
  aberration: number; // 0..1
}

/** Final grading pass: radial chromatic aberration + vignette. */
const FinalShader = {
  uniforms: {
    tDiffuse: { value: null },
    vig: { value: 0.35 },
    aber: { value: 0.012 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float vig;
    uniform float aber;
    varying vec2 vUv;
    void main() {
      vec2 c = vUv - 0.5;
      float d = length(c);
      vec2 off = c * d * aber;
      float r = texture2D(tDiffuse, vUv + off).r;
      float g = texture2D(tDiffuse, vUv).g;
      float b = texture2D(tDiffuse, vUv - off).b;
      vec3 col = vec3(r, g, b);
      col *= 1.0 - vig * smoothstep(0.35, 0.8, d);
      gl_FragColor = vec4(col, 1.0);
    }`,
};

export class CityRenderer {
  readonly three: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private sty: Sty;
  private mount: HTMLElement;
  private spriteTex = new Map<string, THREE.Texture>();
  private fxTex = new Map<string, THREE.Texture>();
  private entityMeshes = new Map<string, { mesh: THREE.Mesh; shadow?: THREE.Mesh; lights?: THREE.Group; sprite: number; remap?: number; tint?: number; deltaKey?: string }>();
  private effects: Effect[] = [];
  private decals: THREE.Mesh[] = [];
  /** fading tire-mark decals */
  private marks: { mesh: THREE.Mesh; ttl: number; life: number }[] = [];
  private markGeo: THREE.PlaneGeometry | null = null;
  private markMat: THREE.MeshBasicMaterial | null = null;
  private tracerMeshes = new Map<number, { mesh: THREE.Mesh; kind: TracerKind }>();
  private tracerTex = new Map<TracerKind, THREE.Texture>();
  private eye = EYE_FOOT;
  private shake = 0;
  /** city atlas texture + tile animations (ANIM chunk slot cycling) */
  private cityTex: THREE.DataTexture | null = null;
  private animStates: {
    anim: TileAnimation;
    slotX: number;
    slotY: number;
    frame: number;
    t: number;
    frames: (THREE.DataTexture | null)[];
  }[] = [];
  private leadX = 0;
  private leadY = 0;
  /** optional post-processing chain (null = plain render) */
  private composer: EffectComposer | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private finalPass: ShaderPass | null = null;
  /** pulsing world markers (phones, mission objective) */
  private markers = new Map<string, THREE.Mesh>();
  private markerTime = 0;

  /** original blood-splat sprites (codeObj 2-9) */
  private bloodSprites: number[] = [];

  private constructor(mount: HTMLElement, sty: Sty) {
    this.sty = sty;
    // codeObj 2-7 are the splats; 8/9 are GTA2 logo plates (not blood!)
    const codeObjBase = sty.spriteBase.car + sty.spriteBase.ped;
    for (let i = 2; i <= 7; i++) this.bloodSprites.push(codeObjBase + i);
    this.mount = mount;
    this.three = new THREE.WebGLRenderer({ antialias: false });
    this.three.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.three.setSize(mount.clientWidth, mount.clientHeight);
    mount.appendChild(this.three.domElement);
    // Map coords use y-south; render space negates y (north up, right-handed).
    this.camera = new THREE.PerspectiveCamera(55, mount.clientWidth / mount.clientHeight, 0.5, 64);
    this.scene.background = new THREE.Color(0x06080a);
    window.addEventListener('resize', this.onResize);
  }

  static create(mount: HTMLElement, gmp: GmpMap, sty: Sty): CityRenderer {
    const r = new CityRenderer(mount, sty);
    r.buildCity(gmp, sty);
    return r;
  }

  destroy(): void {
    window.removeEventListener('resize', this.onResize);
    this.three.dispose();
    this.three.domElement.remove();
  }

  private onResize = (): void => {
    const w = this.mount.clientWidth;
    const h = this.mount.clientHeight;
    this.three.setSize(w, h);
    this.composer?.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  /** Enable/adjust (or null = disable) the GPU post-processing chain. */
  setShaderFx(fx: ShaderFx | null): void {
    if (!fx) {
      this.composer = null;
      return;
    }
    if (!this.composer) {
      const w = this.mount.clientWidth;
      const h = this.mount.clientHeight;
      this.composer = new EffectComposer(this.three);
      this.composer.setSize(w, h);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 0.4, 0.5, 0.62);
      this.composer.addPass(this.bloomPass);
      this.finalPass = new ShaderPass(FinalShader);
      this.composer.addPass(this.finalPass);
    }
    this.bloomPass!.strength = fx.bloom * 1.1;
    this.finalPass!.uniforms.vig.value = fx.vignette * 0.9;
    this.finalPass!.uniforms.aber.value = fx.aberration * 0.035;
  }

  // ----------------------------------------------------------------- city

  private buildCity(gmp: GmpMap, sty: Sty): void {
    const atlas = buildTileAtlas(sty, gmp.animations);
    const tex = new THREE.DataTexture(atlas.data, atlas.size, atlas.size, THREE.RGBAFormat);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    this.cityTex = tex;

    // Tile animations: cycle each base's atlas slot through its frames.
    for (const anim of gmp.animations) {
      if (anim.tiles.length < 2 || !atlas.has(anim.base)) continue;
      const [slotX, slotY] = atlas.slotXY(anim.base);
      const frames = anim.tiles.map((t) => {
        if (t >= sty.tileCount) return null;
        const f = new THREE.DataTexture(sty.tileRGBA(t), 64, 64, THREE.RGBAFormat);
        f.colorSpace = THREE.SRGBColorSpace;
        f.needsUpdate = true;
        return f;
      });
      this.animStates.push({ anim, slotX, slotY, frame: 0, t: 0, frames });
    }

    const solidMat = new THREE.MeshBasicMaterial({ map: tex, vertexColors: true, side: THREE.DoubleSide });
    const cutoutMat = new THREE.MeshBasicMaterial({
      map: tex, vertexColors: true, side: THREE.DoubleSide, alphaTest: 0.5,
    });

    const transparent = computeTransparentTiles(sty);
    const chunks = MAP_SIZE / CHUNK;
    const group = new THREE.Group();
    for (let cy = 0; cy < chunks; cy++) {
      for (let cx = 0; cx < chunks; cx++) {
        const g = buildChunkGeometry(gmp, atlas, transparent, cx, cy);
        for (const [arrays, mat] of [[g.solid, solidMat], [g.cutout, cutoutMat]] as const) {
          if (arrays.indices.length === 0) continue;
          group.add(new THREE.Mesh(toGeometry(arrays), mat));
        }
      }
    }
    this.scene.add(group);
  }

  // -------------------------------------------------------------- sprites

  /** Texture for an STY sprite (optionally palette-remapped), cached. */
  private spriteTexture(sprite: number, remapPhys?: number, deltas?: number[]): THREE.Texture {
    const key = `${sprite}:${remapPhys ?? -1}:${deltas?.join('.') ?? ''}`;
    let tex = this.spriteTex.get(key);
    if (tex) return tex;
    const { w, h, data } = this.sty.spriteRGBA(sprite, remapPhys, deltas);
    // Flip rows so image-top ends up at the plane's +y edge.
    const flipped = new Uint8Array(data.length);
    for (let y = 0; y < h; y++) {
      flipped.set(data.subarray(y * w * 4, (y + 1) * w * 4), (h - 1 - y) * w * 4);
    }
    tex = new THREE.DataTexture(flipped, w, h, THREE.RGBAFormat);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    this.spriteTex.set(key, tex);
    return tex;
  }

  /** Sync the entity sprite meshes to the given list (diff by key). */
  syncEntities(entities: RenderEntity[]): void {
    const seen = new Set<string>();
    for (const e of entities) {
      seen.add(e.key);
      const deltaKey = e.deltas?.join('.') ?? '';
      let rec = this.entityMeshes.get(e.key);
      if (rec && (rec.sprite !== e.sprite || rec.remap !== e.remapPhys || rec.tint !== e.tint || rec.deltaKey !== deltaKey)) {
        this.scene.remove(rec.mesh);
        disposeMesh(rec.mesh);
        if (rec.shadow) this.scene.remove(rec.shadow);
        if (rec.lights) this.scene.remove(rec.lights);
        rec = undefined;
        this.entityMeshes.delete(e.key);
      }
      if (!rec) {
        const tex = this.spriteTexture(e.sprite, e.remapPhys, e.deltas);
        const entry = this.sty.sprites[e.sprite];
        const geo = new THREE.PlaneGeometry(entry.w / 64, entry.h / 64);
        const mat = new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.4, side: THREE.DoubleSide });
        if (e.tint !== undefined) mat.color.set(e.tint);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.renderOrder = 2;
        this.scene.add(mesh);
        rec = { mesh, sprite: e.sprite, remap: e.remapPhys, tint: e.tint, deltaKey };
        if (e.shadow) {
          // GTA2 drop shadow: same silhouette, black, offset down-right.
          const smat = new THREE.MeshBasicMaterial({
            map: tex, alphaTest: 0.4, side: THREE.DoubleSide,
            color: 0x000000, transparent: true, opacity: 0.42, depthWrite: false,
          });
          const smesh = new THREE.Mesh(geo, smat);
          smesh.renderOrder = 1;
          this.scene.add(smesh);
          rec.shadow = smesh;
        }
        this.entityMeshes.set(e.key, rec);
      }
      // headlights appear/disappear with the dusk setting
      if (e.headlights && !rec.lights) {
        // twin beams from the front corners + two small tail dots, sized
        // from the car sprite so they sit exactly at the bumpers
        const entry2 = this.sty.sprites[e.sprite];
        const halfLen = entry2.h / 128;
        const halfW = entry2.w / 128;
        const group = new THREE.Group();
        const beamMat = new THREE.MeshBasicMaterial({
          map: this.effectTexture('headlight'), transparent: true,
          depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.55,
        });
        for (const side of [-1, 1]) {
          const beam = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 1.5), beamMat);
          // beam texture base at canvas-bottom; rotate so the base meets the bumper
          beam.rotation.z = -Math.PI / 2;
          beam.position.set(halfLen + 0.68, side * halfW * 0.55, 0);
          group.add(beam);
        }
        const tailMat = new THREE.MeshBasicMaterial({
          map: this.effectTexture('taillight'), transparent: true,
          depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.7,
        });
        for (const side of [-1, 1]) {
          const dot = new THREE.Mesh(new THREE.PlaneGeometry(0.17, 0.17), tailMat);
          dot.position.set(-halfLen + 0.02, side * halfW * 0.6, 0);
          group.add(dot);
        }
        group.renderOrder = 3;
        this.scene.add(group);
        rec.lights = group;
      } else if (!e.headlights && rec.lights) {
        this.scene.remove(rec.lights);
        rec.lights = undefined;
      }
      rec.mesh.position.set(e.x, -e.y, e.z);
      // GTA2 sprite art faces image-bottom (player-confirmed: cars drove
      // visually backwards with the image-top assumption).
      const phi = -(e.angle + (e.angleOffset ?? 0)) + Math.PI / 2;
      if (e.dzdx !== undefined || e.dzdy !== undefined) {
        // Tilt the quad to the ground slope so cars/peds don't sink into hills.
        NORMAL.set(-(e.dzdx ?? 0), e.dzdy ?? 0, 1).normalize();
        QA.setFromUnitVectors(Z_UP, NORMAL);
        QB.setFromAxisAngle(Z_UP, phi);
        rec.mesh.quaternion.copy(QA).multiply(QB);
      } else {
        rec.mesh.rotation.set(0, 0, phi);
      }
      const s = e.scale ?? 1;
      rec.mesh.scale.set(s, s, 1);
      if (rec.shadow) {
        rec.shadow.position.set(e.x + 0.07, -e.y - 0.07, Math.max(0.01, e.z - 0.018));
        rec.shadow.quaternion.copy(rec.mesh.quaternion);
        rec.shadow.scale.set(s, s, 1);
      }
      if (rec.lights) {
        rec.lights.position.set(e.x, -e.y, e.z + 0.012);
        rec.lights.rotation.z = -e.angle; // local +x = car forward
      }
    }
    for (const [key, rec] of this.entityMeshes) {
      if (!seen.has(key)) {
        this.scene.remove(rec.mesh);
        disposeMesh(rec.mesh);
        if (rec.shadow) this.scene.remove(rec.shadow);
        if (rec.lights) this.scene.remove(rec.lights);
        this.entityMeshes.delete(key);
      }
    }
  }

  /**
   * Pulsing ground markers (ringing phones, mission objective). Diffed by
   * key like entities; kind picks the colour (phone cyan, objective yellow).
   */
  syncMarkers(markers: { key: string; x: number; y: number; z: number; kind: 'phone' | 'objective' }[]): void {
    const seen = new Set<string>();
    for (const mk of markers) {
      seen.add(mk.key);
      let mesh = this.markers.get(mk.key);
      if (!mesh) {
        const tex = this.effectTexture(mk.kind === 'phone' ? 'marker-phone' : 'marker-objective');
        const geo = new THREE.PlaneGeometry(0.8, 0.8);
        const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
        mesh = new THREE.Mesh(geo, mat);
        mesh.renderOrder = 4;
        this.scene.add(mesh);
        this.markers.set(mk.key, mesh);
      }
      mesh.position.set(mk.x, -mk.y, mk.z + 0.04);
    }
    for (const [key, mesh] of this.markers) {
      if (!seen.has(key)) {
        this.scene.remove(mesh);
        disposeMesh(mesh);
        this.markers.delete(key);
      }
    }
  }

  /** Persistent fading tire-mark decal at a wheel position. */
  addSkidMark(x: number, y: number, z: number, angle: number): void {
    if (!this.markGeo) this.markGeo = new THREE.PlaneGeometry(0.055, 0.16);
    if (!this.markMat) {
      this.markMat = new THREE.MeshBasicMaterial({
        color: 0x101010, transparent: true, opacity: 0.5, depthWrite: false,
      });
    }
    // Material is cloned so each mark fades independently.
    const mesh = new THREE.Mesh(this.markGeo, this.markMat.clone());
    mesh.position.set(x, -y, z + 0.012);
    mesh.rotation.z = -angle + Math.PI / 2;
    this.scene.add(mesh);
    this.marks.push({ mesh, ttl: 14, life: 14 });
    if (this.marks.length > 600) {
      const old = this.marks.shift()!;
      this.scene.remove(old.mesh);
      (old.mesh.material as THREE.Material).dispose();
    }
  }

  // -------------------------------------------------------------- effects

  private effectTexture(kind: string): THREE.Texture {
    let tex = this.fxTex.get(kind);
    if (tex) return tex;
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext('2d')!;
    if (kind === 'blood') {
      // irregular splatter: overlapping blots, not a soft ball
      for (let i = 0; i < 11; i++) {
        const a = Math.random() * Math.PI * 2;
        const d = Math.random() * 20;
        const r = i < 4 ? 7 + Math.random() * 6 : 1.5 + Math.random() * 3.5;
        ctx.fillStyle = `rgba(${120 + Math.random() * 40},12,12,${0.75 + Math.random() * 0.25})`;
        ctx.beginPath();
        ctx.arc(32 + Math.cos(a) * d * (i < 4 ? 0.4 : 1), 32 + Math.sin(a) * d * (i < 4 ? 0.4 : 1), r, 0, Math.PI * 2);
        ctx.fill();
      }
      tex = new THREE.CanvasTexture(c);
      this.fxTex.set(kind, tex);
      return tex;
    }
    const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 32);
    switch (kind) {
      case 'muzzle':
      case 'spark':
        grad.addColorStop(0, 'rgba(255,250,220,1)');
        grad.addColorStop(0.4, 'rgba(255,190,60,0.9)');
        grad.addColorStop(1, 'rgba(255,120,0,0)');
        break;
      case 'explosion':
        grad.addColorStop(0, 'rgba(255,240,180,1)');
        grad.addColorStop(0.5, 'rgba(255,130,20,0.95)');
        grad.addColorStop(1, 'rgba(180,30,0,0)');
        break;
      case 'smoke':
        grad.addColorStop(0, 'rgba(70,70,70,0.85)');
        grad.addColorStop(1, 'rgba(60,60,60,0)');
        break;
      case 'dust':
        grad.addColorStop(0, 'rgba(170,160,140,0.8)');
        grad.addColorStop(1, 'rgba(150,140,120,0)');
        break;
      case 'fire':
        grad.addColorStop(0, 'rgba(255,245,200,1)');
        grad.addColorStop(0.35, 'rgba(255,160,30,0.95)');
        grad.addColorStop(0.7, 'rgba(230,70,10,0.7)');
        grad.addColorStop(1, 'rgba(180,30,0,0)');
        break;
      case 'fire0':
      case 'fire1':
      case 'fire2': {
        // irregular flame: overlapping hot blobs, brighter near the base
        for (let i = 0; i < 10; i++) {
          const a = Math.random() * Math.PI * 2;
          const d = Math.random() * 16;
          const r = 5 + Math.random() * 11;
          const bg = ctx.createRadialGradient(
            32 + Math.cos(a) * d, 34 + Math.sin(a) * d * 0.7, 1,
            32 + Math.cos(a) * d, 34 + Math.sin(a) * d * 0.7, r,
          );
          const hot = Math.random();
          bg.addColorStop(0, hot > 0.6 ? 'rgba(255,250,210,0.9)' : 'rgba(255,180,40,0.85)');
          bg.addColorStop(0.6, 'rgba(255,110,15,0.55)');
          bg.addColorStop(1, 'rgba(200,40,0,0)');
          ctx.fillStyle = bg;
          ctx.fillRect(0, 0, 64, 64);
        }
        tex = new THREE.CanvasTexture(c);
        this.fxTex.set(kind, tex);
        return tex;
      }
      case 'bloodspray':
        grad.addColorStop(0, 'rgba(190,25,25,1)');
        grad.addColorStop(0.6, 'rgba(150,15,15,0.8)');
        grad.addColorStop(1, 'rgba(120,10,10,0)');
        break;
      case 'electro':
        grad.addColorStop(0, 'rgba(240,250,255,1)');
        grad.addColorStop(0.4, 'rgba(120,180,255,0.95)');
        grad.addColorStop(1, 'rgba(60,90,255,0)');
        break;
      case 'marker-phone':
      case 'marker-objective': {
        const col = kind === 'marker-phone' ? '90,220,255' : '255,215,40';
        ctx.strokeStyle = `rgba(${col},0.95)`;
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.arc(32, 32, 24, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = `rgba(${col},0.30)`;
        ctx.beginPath();
        ctx.arc(32, 32, 20, 0, Math.PI * 2);
        ctx.fill();
        tex = new THREE.CanvasTexture(c);
        this.fxTex.set(kind, tex);
        return tex;
      }
      case 'headlight': {
        // forward light cone: narrow bright base widening into a soft pool
        const lg = ctx.createLinearGradient(32, 64, 32, 0);
        lg.addColorStop(0, 'rgba(255,250,220,0.85)');
        lg.addColorStop(0.45, 'rgba(255,245,200,0.4)');
        lg.addColorStop(1, 'rgba(255,240,180,0)');
        ctx.fillStyle = lg;
        ctx.beginPath();
        ctx.moveTo(22, 64);
        ctx.lineTo(42, 64);
        ctx.lineTo(58, 4);
        ctx.lineTo(6, 4);
        ctx.closePath();
        ctx.fill();
        tex = new THREE.CanvasTexture(c);
        this.fxTex.set(kind, tex);
        return tex;
      }
      case 'taillight': {
        const tg = ctx.createRadialGradient(32, 32, 1, 32, 32, 30);
        tg.addColorStop(0, 'rgba(255,60,40,0.9)');
        tg.addColorStop(0.5, 'rgba(220,30,20,0.45)');
        tg.addColorStop(1, 'rgba(180,20,10,0)');
        ctx.fillStyle = tg;
        ctx.fillRect(0, 0, 64, 64);
        tex = new THREE.CanvasTexture(c);
        this.fxTex.set(kind, tex);
        return tex;
      }
      case 'debris': {
        // burning fragment with a trailing tail (drawn along canvas y)
        const lin = ctx.createLinearGradient(0, 0, 0, 64);
        lin.addColorStop(0, 'rgba(255,120,10,0)');
        lin.addColorStop(0.55, 'rgba(255,150,30,0.75)');
        lin.addColorStop(0.85, 'rgba(255,220,120,1)');
        lin.addColorStop(1, 'rgba(255,255,220,1)');
        ctx.fillStyle = lin;
        ctx.fillRect(26, 0, 12, 64);
        tex = new THREE.CanvasTexture(c);
        this.fxTex.set(kind, tex);
        return tex;
      }
      case 'blood':
        grad.addColorStop(0, 'rgba(150,15,15,0.95)');
        grad.addColorStop(0.7, 'rgba(120,10,10,0.7)');
        grad.addColorStop(1, 'rgba(100,8,8,0)');
        break;
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    tex = new THREE.CanvasTexture(c);
    this.fxTex.set(kind, tex);
    return tex;
  }

  spawnFx(fx: FxSpawn): void {
    if (fx.kind === 'blood') {
      this.addBloodDecal(fx, 0.9 + Math.random() * 0.5);
      return;
    }
    if (fx.kind === 'explosion') {
      this.shake = Math.max(this.shake, 0.4);
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2;
        const sp = 0.5 + Math.random() * 1.6;
        this.addEffect(fx, 'explosion', 0.45 + Math.random() * 0.3, {
          size: 0.6, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, grow: 2.4, additive: true,
        });
      }
      for (let i = 0; i < 6; i++) {
        this.addEffect(fx, 'smoke', 1.1 + Math.random() * 0.7, {
          size: 0.7, vx: (Math.random() - 0.5), vy: (Math.random() - 0.5), grow: 2.2,
        });
      }
      // Burning debris streaks fly far out of the blast (reference video:
      // orange comets crossing half the screen, frames closeup/exp12-20).
      for (let i = 0; i < 12; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 2.5 + Math.random() * 4.5;
        const vx = Math.cos(a) * sp;
        const vy = Math.sin(a) * sp;
        this.addEffect(
          { x: fx.x, y: fx.y, z: fx.z + 0.1 + Math.random() * 0.3 },
          'debris',
          0.45 + Math.random() * 0.45,
          { size: 0.16 + Math.random() * 0.1, vx, vy, rot: -a + Math.PI / 2, additive: true },
        );
      }
      return;
    }
    if (fx.kind === 'bloodspray') {
      // GTA2-style blood spurt: a burst of droplets + a small original splat.
      for (let i = 0; i < 7; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 0.4 + Math.random() * 1.4;
        this.addEffect(fx, 'bloodspray', 0.16 + Math.random() * 0.16, {
          size: 0.06 + Math.random() * 0.07,
          vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        });
      }
      if (Math.random() < 0.6) this.addBloodDecal(fx, 0.35 + Math.random() * 0.25);
      return;
    }
    if (fx.kind === 'fire') {
      // flickering multi-shape flames, additive so overlaps glow
      this.addEffect(fx, `fire${Math.floor(Math.random() * 3)}`, 0.28 + Math.random() * 0.2, {
        size: 0.26 + Math.random() * 0.16, grow: 1.3,
        vx: (Math.random() - 0.5) * 0.3, vy: (Math.random() - 0.5) * 0.3,
        additive: true,
      });
      return;
    }
    const size = fx.kind === 'muzzle' ? 0.38 : fx.kind === 'spark' ? 0.16 : fx.kind === 'dust' ? 0.22 : 0.45;
    const ttl = fx.kind === 'muzzle' ? 0.07 : fx.kind === 'spark' ? 0.12 : fx.kind === 'dust' ? 0.3 : 0.5;
    const additive = fx.kind === 'muzzle' || fx.kind === 'spark' || fx.kind === 'electro';
    this.addEffect(fx, fx.kind, ttl, { size, grow: fx.kind === 'smoke' ? 1.5 : fx.kind === 'dust' ? 1.8 : 0.4, additive });
  }

  /** A permanent blood splat from the original art, randomly rotated. */
  private addBloodDecal(at: { x: number; y: number; z: number }, scale: number): void {
    const sprite = this.bloodSprites[Math.floor(Math.random() * this.bloodSprites.length)];
    const entry = this.sty.sprites[sprite];
    if (!entry) return;
    const tex = this.spriteTexture(sprite);
    const geo = new THREE.PlaneGeometry((entry.w / 64) * scale, (entry.h / 64) * scale);
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(at.x, -at.y, at.z + 0.012);
    mesh.rotation.z = Math.random() * Math.PI * 2;
    this.scene.add(mesh);
    this.decals.push(mesh);
    if (this.decals.length > 200) {
      const old = this.decals.shift()!;
      this.scene.remove(old);
      disposeMesh(old);
    }
  }

  private tracerTexture(kind: TracerKind): THREE.Texture {
    let tex = this.tracerTex.get(kind);
    if (tex) return tex;
    const c = document.createElement('canvas');
    c.width = 16;
    c.height = 32;
    const ctx = c.getContext('2d')!;
    switch (kind) {
      case 'bullet':
      case 'rocket': {
        // bright head at canvas bottom = the leading end (art faces
        // image-bottom, like all sprites here); the tail fades out behind
        const grad = ctx.createLinearGradient(0, 0, 0, 32);
        grad.addColorStop(0, kind === 'rocket' ? 'rgba(255,120,20,0)' : 'rgba(255,180,60,0)');
        grad.addColorStop(0.5, 'rgba(255,230,150,0.9)');
        grad.addColorStop(1, 'rgba(255,255,240,1)');
        ctx.fillStyle = grad;
        ctx.fillRect(4, 0, 8, 32);
        break;
      }
      case 'grenade':
        ctx.fillStyle = '#28321e';
        ctx.beginPath();
        ctx.arc(8, 16, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#46543a';
        ctx.beginPath();
        ctx.arc(6, 14, 2.5, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'molotov': {
        ctx.fillStyle = '#3f7a4a';
        ctx.fillRect(5, 8, 6, 18);
        ctx.fillStyle = '#ffba30';
        ctx.beginPath();
        ctx.arc(8, 5, 4, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'flame': {
        const grad = ctx.createRadialGradient(8, 16, 1, 8, 16, 8);
        grad.addColorStop(0, 'rgba(255,245,190,1)');
        grad.addColorStop(0.5, 'rgba(255,150,30,0.9)');
        grad.addColorStop(1, 'rgba(220,60,0,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 16, 32);
        break;
      }
    }
    tex = new THREE.CanvasTexture(c);
    this.tracerTex.set(kind, tex);
    return tex;
  }

  /** Sync projectile meshes (bullets, rockets, grenades, flames) to the sim. */
  syncTracers(tracers: TracerInfo[]): void {
    const seen = new Set<number>();
    for (const t of tracers) {
      seen.add(t.id);
      let rec = this.tracerMeshes.get(t.id);
      if (rec && rec.kind !== t.kind) {
        this.scene.remove(rec.mesh);
        rec.mesh.geometry.dispose();
        rec = undefined;
        this.tracerMeshes.delete(t.id);
      }
      if (!rec) {
        const style = TRACER_STYLE[t.kind];
        const geo = new THREE.PlaneGeometry(style.w, style.h);
        const mat = new THREE.MeshBasicMaterial({
          map: this.tracerTexture(t.kind), transparent: true, depthWrite: false,
        });
        const mesh = new THREE.Mesh(geo, mat);
        this.scene.add(mesh);
        rec = { mesh, kind: t.kind };
        this.tracerMeshes.set(t.id, rec);
      }
      rec.mesh.position.set(t.x, -t.y, t.z);
      rec.mesh.rotation.z = -t.angle + Math.PI / 2;
      if (t.kind === 'flame') {
        const s = 0.5 + (t.age ?? 0) * 1.6; // flames swell as they fly
        rec.mesh.scale.set(s, s, 1);
        (rec.mesh.material as THREE.MeshBasicMaterial).opacity = 1 - (t.age ?? 0) * 0.6;
      }
    }
    for (const [id, rec] of this.tracerMeshes) {
      if (!seen.has(id)) {
        this.scene.remove(rec.mesh);
        rec.mesh.geometry.dispose();
        this.tracerMeshes.delete(id);
      }
    }
  }

  /** Jagged ElectroGun beam: short-lived sparks scattered along the ray. */
  drawBeam(x0: number, y0: number, x1: number, y1: number, z: number): void {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(3, Math.floor(len / 0.22));
    const px = -(y1 - y0) / (len || 1);
    const py = (x1 - x0) / (len || 1);
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      const jitter = (Math.random() - 0.5) * 0.16;
      this.addEffect(
        {
          x: x0 + (x1 - x0) * f + px * jitter,
          y: y0 + (y1 - y0) * f + py * jitter,
          z,
        },
        'electro',
        0.09,
        { size: 0.12 + Math.random() * 0.08, additive: true },
      );
    }
  }

  private flatQuad(at: { x: number; y: number; z: number }, size: number, kind: string, lift: number, additive = false): THREE.Mesh {
    const geo = new THREE.PlaneGeometry(size, size);
    const mat = new THREE.MeshBasicMaterial({
      map: this.effectTexture(kind), transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(at.x, -at.y, at.z + lift);
    return mesh;
  }

  private addEffect(at: { x: number; y: number; z: number }, kind: string, ttl: number, opts: { size: number; vx?: number; vy?: number; grow?: number; rot?: number; additive?: boolean }): void {
    const mesh = this.flatQuad(at, opts.size, kind, 0.05 + Math.random() * 0.02, opts.additive);
    if (opts.rot !== undefined) mesh.rotation.z = opts.rot;
    this.scene.add(mesh);
    this.effects.push({
      mesh, ttl, life: ttl,
      vx: opts.vx ?? 0, vy: opts.vy ?? 0,
      grow: opts.grow ?? 0, fade: true,
    });
  }

  /**
   * Big green LCD score popup in world space (reference video: "900" behind
   * the action, fading out). Optionally a yellow label line above it.
   */
  spawnScore(x: number, y: number, z: number, amount: number, label?: string): void {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 128;
    const ctx = c.getContext('2d')!;
    ctx.textAlign = 'center';
    ctx.font = 'bold 72px "Courier New", monospace';
    ctx.fillStyle = 'rgba(20,60,20,0.85)';
    ctx.fillText(String(amount), 131, 95);
    ctx.fillStyle = 'rgba(90,220,90,0.95)';
    ctx.fillText(String(amount), 128, 92);
    if (label) {
      ctx.font = 'bold 26px Arial';
      ctx.fillStyle = '#ffd700';
      ctx.strokeStyle = '#7a1010';
      ctx.lineWidth = 4;
      ctx.strokeText(label, 128, 26);
      ctx.fillText(label, 128, 26);
    }
    const tex = new THREE.CanvasTexture(c);
    const geo = new THREE.PlaneGeometry(2.2, 1.1);
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, -y, z + 0.4);
    mesh.renderOrder = 5;
    this.scene.add(mesh);
    this.effects.push({ mesh, ttl: 1.6, life: 1.6, vx: 0, vy: 0, grow: 0.35, fade: true });
  }

  // ---------------------------------------------------------------- frame

  /** Advance ANIM tile cycling: blit the next frame into the base's slot. */
  private updateTileAnims(dt: number): void {
    if (!this.cityTex) return;
    const pos = new THREE.Vector2();
    for (const st of this.animStates) {
      // frameRate is in game ticks (30/s) per animation frame
      const frameDur = Math.max(1, st.anim.frameRate) / 30;
      st.t += dt;
      if (st.t < frameDur) continue;
      st.t %= frameDur;
      st.frame = (st.frame + 1) % st.frames.length;
      const tex = st.frames[st.frame];
      if (!tex) continue;
      pos.set(st.slotX, st.slotY);
      this.three.copyTextureToTexture(tex, this.cityTex, null, pos);
    }
  }

  /** Per-frame: advance effects and position the chase camera. */
  update(dt: number, focus: { x: number; y: number; z: number; speed: number; driving: boolean; vx?: number; vy?: number }): void {
    this.updateTileAnims(dt);
    this.markerTime += dt;
    const pulse = 1 + Math.sin(this.markerTime * 5) * 0.18;
    for (const mesh of this.markers.values()) mesh.scale.set(pulse, pulse, 1);
    // Tire marks persist, then fade away over their last 4 seconds.
    this.marks = this.marks.filter((m) => {
      m.ttl -= dt;
      if (m.ttl <= 0) {
        this.scene.remove(m.mesh);
        (m.mesh.material as THREE.Material).dispose();
        return false;
      }
      if (m.ttl < 4) (m.mesh.material as THREE.MeshBasicMaterial).opacity = 0.5 * (m.ttl / 4);
      return true;
    });

    this.effects = this.effects.filter((e) => {
      e.ttl -= dt;
      if (e.ttl <= 0) {
        this.scene.remove(e.mesh);
        disposeMesh(e.mesh);
        return false;
      }
      const t = 1 - e.ttl / e.life;
      e.mesh.position.x += e.vx * dt;
      e.mesh.position.y += e.vy * dt;
      if (e.grow) {
        const s = 1 + t * e.grow;
        e.mesh.scale.set(s, s, 1);
      }
      if (e.fade) (e.mesh.material as THREE.MeshBasicMaterial).opacity = 1 - t;
      return true;
    });

    const targetEye = focus.driving ? EYE_FOOT + Math.min(EYE_DRIVE - EYE_FOOT, focus.speed * 0.45) : EYE_FOOT;
    this.eye += (targetEye - this.eye) * Math.min(1, dt * 2);
    this.shake = Math.max(0, this.shake - dt);
    const sx = this.shake > 0 ? (Math.random() - 0.5) * this.shake * 0.5 : 0;
    const sy = this.shake > 0 ? (Math.random() - 0.5) * this.shake * 0.5 : 0;

    // GTA2's camera looks ahead of a moving car.
    const clamp = (v: number, m: number) => Math.max(-m, Math.min(m, v));
    const tlx = clamp((focus.vx ?? 0) * 0.55, 2.6);
    const tly = clamp((focus.vy ?? 0) * 0.55, 2.6);
    const ease = Math.min(1, dt * 1.6);
    this.leadX += (tlx - this.leadX) * ease;
    this.leadY += (tly - this.leadY) * ease;

    const cx = focus.x + this.leadX + sx;
    const cy = -(focus.y + this.leadY) + sy;
    this.camera.position.set(cx, cy, focus.z + this.eye);
    this.camera.lookAt(cx, cy, focus.z);
    if (this.composer) this.composer.render();
    else this.three.render(this.scene, this.camera);
  }
}

function toGeometry(a: GeomArrays): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(a.positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(a.uvs, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(a.colors, 3));
  geo.setIndex(a.indices);
  return geo;
}

function disposeMesh(mesh: THREE.Mesh): void {
  mesh.geometry.dispose();
}
