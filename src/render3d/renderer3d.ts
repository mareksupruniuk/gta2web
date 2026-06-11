import * as THREE from 'three';
import { GmpMap, MAP_SIZE } from '../gta2/gmp';
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
}

const Z_UP = new THREE.Vector3(0, 0, 1);
const NORMAL = new THREE.Vector3();
const QA = new THREE.Quaternion();
const QB = new THREE.Quaternion();

export interface FxSpawn {
  kind: 'muzzle' | 'blood' | 'bloodspray' | 'explosion' | 'smoke' | 'spark' | 'dust' | 'fire';
  x: number;
  y: number;
  z: number;
}

export interface TracerInfo {
  id: number;
  x: number;
  y: number;
  z: number;
  angle: number;
}

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

export class CityRenderer {
  readonly three: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private sty: Sty;
  private mount: HTMLElement;
  private spriteTex = new Map<string, THREE.Texture>();
  private fxTex = new Map<string, THREE.Texture>();
  private entityMeshes = new Map<string, { mesh: THREE.Mesh; sprite: number; remap?: number; tint?: number }>();
  private effects: Effect[] = [];
  private decals: THREE.Mesh[] = [];
  private tracerMeshes = new Map<number, THREE.Mesh>();
  private tracerTex: THREE.Texture | null = null;
  private eye = EYE_FOOT;
  private shake = 0;
  private leadX = 0;
  private leadY = 0;

  private constructor(mount: HTMLElement, sty: Sty) {
    this.sty = sty;
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
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  // ----------------------------------------------------------------- city

  private buildCity(gmp: GmpMap, sty: Sty): void {
    const atlas = buildTileAtlas(sty);
    const tex = new THREE.DataTexture(atlas.data, atlas.size, atlas.size, THREE.RGBAFormat);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;

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
  private spriteTexture(sprite: number, remapPhys?: number): THREE.Texture {
    const key = `${sprite}:${remapPhys ?? -1}`;
    let tex = this.spriteTex.get(key);
    if (tex) return tex;
    const { w, h, data } = this.sty.spriteRGBA(sprite, remapPhys);
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
      let rec = this.entityMeshes.get(e.key);
      if (rec && (rec.sprite !== e.sprite || rec.remap !== e.remapPhys || rec.tint !== e.tint)) {
        this.scene.remove(rec.mesh);
        disposeMesh(rec.mesh);
        rec = undefined;
        this.entityMeshes.delete(e.key);
      }
      if (!rec) {
        const tex = this.spriteTexture(e.sprite, e.remapPhys);
        const entry = this.sty.sprites[e.sprite];
        const geo = new THREE.PlaneGeometry(entry.w / 64, entry.h / 64);
        const mat = new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.4, side: THREE.DoubleSide });
        if (e.tint !== undefined) mat.color.set(e.tint);
        const mesh = new THREE.Mesh(geo, mat);
        this.scene.add(mesh);
        rec = { mesh, sprite: e.sprite, remap: e.remapPhys, tint: e.tint };
        this.entityMeshes.set(e.key, rec);
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
    }
    for (const [key, rec] of this.entityMeshes) {
      if (!seen.has(key)) {
        this.scene.remove(rec.mesh);
        disposeMesh(rec.mesh);
        this.entityMeshes.delete(key);
      }
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
      case 'bloodspray':
        grad.addColorStop(0, 'rgba(190,25,25,1)');
        grad.addColorStop(0.6, 'rgba(150,15,15,0.8)');
        grad.addColorStop(1, 'rgba(120,10,10,0)');
        break;
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
      const mesh = this.flatQuad(fx, 0.45, 'blood', 0.002);
      mesh.rotation.z = Math.random() * Math.PI * 2;
      this.scene.add(mesh);
      this.decals.push(mesh);
      if (this.decals.length > 200) {
        const old = this.decals.shift()!;
        this.scene.remove(old);
        disposeMesh(old);
      }
      return;
    }
    if (fx.kind === 'explosion') {
      this.shake = Math.max(this.shake, 0.4);
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2;
        const sp = 0.5 + Math.random() * 1.6;
        this.addEffect(fx, 'explosion', 0.45 + Math.random() * 0.3, {
          size: 0.6, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, grow: 2.4,
        });
      }
      for (let i = 0; i < 6; i++) {
        this.addEffect(fx, 'smoke', 1.1 + Math.random() * 0.7, {
          size: 0.7, vx: (Math.random() - 0.5), vy: (Math.random() - 0.5), grow: 2.2,
        });
      }
      return;
    }
    if (fx.kind === 'bloodspray') {
      // GTA2-style blood spurt: a burst of small droplets + a small stain.
      for (let i = 0; i < 6; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 0.4 + Math.random() * 1.2;
        this.addEffect(fx, 'bloodspray', 0.15 + Math.random() * 0.15, {
          size: 0.07 + Math.random() * 0.06,
          vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        });
      }
      if (Math.random() < 0.5) {
        const mesh = this.flatQuad(fx, 0.2 + Math.random() * 0.15, 'blood', 0.002);
        mesh.rotation.z = Math.random() * Math.PI * 2;
        this.scene.add(mesh);
        this.decals.push(mesh);
      }
      return;
    }
    if (fx.kind === 'fire') {
      this.addEffect(fx, 'fire', 0.3 + Math.random() * 0.2, {
        size: 0.25 + Math.random() * 0.15, grow: 1.2,
        vx: (Math.random() - 0.5) * 0.3, vy: (Math.random() - 0.5) * 0.3,
      });
      return;
    }
    const size = fx.kind === 'muzzle' ? 0.28 : fx.kind === 'spark' ? 0.14 : fx.kind === 'dust' ? 0.22 : 0.45;
    const ttl = fx.kind === 'muzzle' ? 0.06 : fx.kind === 'spark' ? 0.12 : fx.kind === 'dust' ? 0.3 : 0.5;
    this.addEffect(fx, fx.kind, ttl, { size, grow: fx.kind === 'smoke' ? 1.5 : fx.kind === 'dust' ? 1.8 : 0.4 });
  }

  /** Sync visible bullet tracers (thin bright streaks) to the sim's bullets. */
  syncTracers(tracers: TracerInfo[]): void {
    if (!this.tracerTex) {
      const c = document.createElement('canvas');
      c.width = 8;
      c.height = 32;
      const ctx = c.getContext('2d')!;
      // bright head at canvas bottom = the end that leads (art faces
      // image-bottom, like all sprites here); the tail fades out behind
      const grad = ctx.createLinearGradient(0, 0, 0, 32);
      grad.addColorStop(0, 'rgba(255,180,60,0)');
      grad.addColorStop(0.5, 'rgba(255,230,150,0.9)');
      grad.addColorStop(1, 'rgba(255,255,240,1)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 8, 32);
      this.tracerTex = new THREE.CanvasTexture(c);
    }
    const seen = new Set<number>();
    for (const t of tracers) {
      seen.add(t.id);
      let mesh = this.tracerMeshes.get(t.id);
      if (!mesh) {
        const geo = new THREE.PlaneGeometry(0.045, 0.34);
        const mat = new THREE.MeshBasicMaterial({
          map: this.tracerTex, transparent: true, depthWrite: false,
        });
        mesh = new THREE.Mesh(geo, mat);
        this.scene.add(mesh);
        this.tracerMeshes.set(t.id, mesh);
      }
      mesh.position.set(t.x, -t.y, t.z);
      // streak tip at image-top; same orientation convention as sprites
      mesh.rotation.z = -t.angle + Math.PI / 2;
    }
    for (const [id, mesh] of this.tracerMeshes) {
      if (!seen.has(id)) {
        this.scene.remove(mesh);
        mesh.geometry.dispose();
        this.tracerMeshes.delete(id);
      }
    }
  }

  private flatQuad(at: { x: number; y: number; z: number }, size: number, kind: string, lift: number): THREE.Mesh {
    const geo = new THREE.PlaneGeometry(size, size);
    const mat = new THREE.MeshBasicMaterial({
      map: this.effectTexture(kind), transparent: true, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(at.x, -at.y, at.z + lift);
    return mesh;
  }

  private addEffect(at: { x: number; y: number; z: number }, kind: string, ttl: number, opts: { size: number; vx?: number; vy?: number; grow?: number }): void {
    const mesh = this.flatQuad(at, opts.size, kind, 0.05 + Math.random() * 0.02);
    this.scene.add(mesh);
    this.effects.push({
      mesh, ttl, life: ttl,
      vx: opts.vx ?? 0, vy: opts.vy ?? 0,
      grow: opts.grow ?? 0, fade: true,
    });
  }

  // ---------------------------------------------------------------- frame

  /** Per-frame: advance effects and position the chase camera. */
  update(dt: number, focus: { x: number; y: number; z: number; speed: number; driving: boolean; vx?: number; vy?: number }): void {
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
    this.three.render(this.scene, this.camera);
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
