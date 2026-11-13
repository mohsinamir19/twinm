import * as THREE from "three";
import type { NodeId, ToolId } from "@/lib/nodes";

/** Live world positions of every node, mutated in each node's useFrame. */
const positions = new Map<NodeId, THREE.Vector3>();

export function nodePos(id: NodeId, init?: readonly number[]): THREE.Vector3 {
  let v = positions.get(id);
  if (!v) {
    v = new THREE.Vector3();
    if (init) v.set(init[0], init[1], init[2]);
    positions.set(id, v);
  }
  return v;
}

/** prefers-reduced-motion flag (written by Scene). */
export const motion = { reduced: false };

export const damp = THREE.MathUtils.damp;

export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

/* ---------- slowly breathing body (no cursor interaction) ---------- */

export interface Body {
  id: NodeId;
  base: THREE.Vector3;
  pos: THREE.Vector3;
  wx: number;
  wy: number;
  wz: number;
  /** scale-breathing angular speed */
  ws: number;
  px: number;
  py: number;
  pz: number;
}

const frac = (n: number) => n - Math.floor(n);
const TAU = Math.PI * 2;

export function createBody(id: NodeId, base: readonly number[], seed: number): Body {
  return {
    id,
    base: new THREE.Vector3(base[0], base[1], base[2]),
    pos: nodePos(id, base),
    // periods between 11 and 25 seconds: very slow
    wx: TAU / (11 + frac(seed * 1.7 + 0.13) * 14),
    wy: TAU / (11 + frac(seed * 2.3 + 0.41) * 14),
    wz: TAU / (11 + frac(seed * 3.1 + 0.77) * 14),
    ws: TAU / (7 + frac(seed * 4.3 + 0.29) * 5),
    px: seed * 1.9,
    py: seed * 2.7,
    pz: seed * 3.3,
  };
}

/** Drift amplitude in world units (spec: ~0.15-0.25). */
const AMP = 0.2;

export function stepBody(b: Body, t: number) {
  const amp = AMP * (motion.reduced ? 0.3 : 1);
  b.pos.set(
    b.base.x + Math.sin(b.wx * t + b.px) * amp,
    b.base.y + Math.cos(b.wy * t + b.py) * amp,
    b.base.z + Math.sin(b.wz * t + b.pz) * amp * 0.5,
  );
}

/** +-2% scale breathing. */
export function breathe(b: Body, t: number) {
  return motion.reduced ? 1 : 1 + 0.02 * Math.sin(b.ws * t + b.px);
}

/* ---------- flexible connectors: spring-driven ropes ---------- */

/** Rest curvature of the core -> tool connection, signed per tool. */
export const BEND: Record<ToolId, number> = {
  memory: 0.1,
  schedule: -0.14,
  tasks: 0.14,
  notify: -0.1,
  notes: -0.14,
  email: 0.14,
};

export const ENERGY = [new THREE.Color("#F5A524"), new THREE.Color("#FACC15"), new THREE.Color("#34D399")];

/** Cycles amber -> yellow -> green -> amber for s in 0..1. */
export function energyColor(s: number, out: THREE.Color) {
  const x = (((s % 1) + 1) % 1) * 3;
  const i = Math.floor(x);
  return out.copy(ENERGY[i]).lerp(ENERGY[(i + 1) % 3], x - i);
}

/** Per-connector energy glow, written by the Pulses director, smoothed by the line. */
export interface LineFx {
  target: number;
  energy: number;
}
const fxMap = new Map<ToolId, LineFx>();
export function fxOf(id: ToolId): LineFx {
  let f = fxMap.get(id);
  if (!f) {
    f = { target: 0, energy: 0 };
    fxMap.set(id, f);
  }
  return f;
}

/** The face halo pulses when a return pulse lands. */
export const faceFx = { kickAt: -10 };

interface Rope {
  cp: THREE.Vector3;
  cv: THREE.Vector3;
  init: boolean;
  nx: number;
  ny: number;
  amp: number;
}
const ropes = new Map<ToolId, Rope>();
function ropeOf(id: ToolId): Rope {
  let r = ropes.get(id);
  if (!r) {
    r = { cp: new THREE.Vector3(), cv: new THREE.Vector3(), init: false, nx: 0, ny: 1, amp: 0 };
    ropes.set(id, r);
  }
  return r;
}

const STIFF = 40;
const DAMP = 7;
const ROPE_Z = -0.25;

/** Advance one connector's spring. Call once per frame per rope. */
export function stepRope(id: ToolId, t: number, dt: number, seed: number) {
  const r = ropeOf(id);
  const a = nodePos("core");
  const b = nodePos(id);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.max(Math.hypot(dx, dy), 0.01);
  r.nx = -dy / len;
  r.ny = dx / len;
  const sway = 0.05 * Math.sin(t * 0.8 + seed * 1.7) + 0.025 * Math.sin(t * 1.9 + seed * 0.6);
  const off = len * BEND[id] * 0.5 + (motion.reduced ? 0 : sway);
  const tx = (a.x + b.x) / 2 + r.nx * off;
  const ty = (a.y + b.y) / 2 + r.ny * off;
  if (!r.init) {
    r.init = true;
    r.cp.set(tx, ty, (a.z + b.z) / 2);
  }
  r.cp.z = (a.z + b.z) / 2;
  r.cv.x += (-STIFF * (r.cp.x - tx) - DAMP * r.cv.x) * dt;
  r.cv.y += (-STIFF * (r.cp.y - ty) - DAMP * r.cv.y) * dt;
  r.cp.x += r.cv.x * dt;
  r.cp.y += r.cv.y * dt;
  r.amp = damp(r.amp, 0, 1.8, dt);
}

/** A small kick: velocity impulse across the line plus a travelling wobble. */
export function kickRope(id: ToolId, amp: number) {
  if (motion.reduced) return;
  const r = ropeOf(id);
  r.amp = Math.max(r.amp, amp);
  r.cv.x += r.nx * amp * 7;
  r.cv.y += r.ny * amp * 7;
}

/** Point on connector `id` at u (0 = pod centre, 1 = tile centre). Slightly behind both. */
export function ropeAt(id: ToolId, u: number, out: THREE.Vector3, t: number) {
  const r = ropeOf(id);
  quadAt(out, nodePos("core"), r.cp, nodePos(id), u);
  const w = r.amp * Math.sin(Math.PI * u) * Math.sin(u * 12 - t * 14);
  out.x += r.nx * w;
  out.y += r.ny * w;
  out.z += ROPE_Z;
  return out;
}

export function quadAt(
  out: THREE.Vector3,
  a: THREE.Vector3,
  c: THREE.Vector3,
  b: THREE.Vector3,
  t: number,
) {
  const u = 1 - t;
  const w0 = u * u;
  const w1 = 2 * u * t;
  const w2 = t * t;
  out.set(
    w0 * a.x + w1 * c.x + w2 * b.x,
    w0 * a.y + w1 * c.y + w2 * b.y,
    w0 * a.z + w1 * c.z + w2 * b.z,
  );
  return out;
}

/* ---------- shared soft radial sprite texture ---------- */

let glowTex: THREE.CanvasTexture | null = null;
export function getGlowTexture() {
  if (!glowTex) {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d")!;
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, "rgba(255,255,255,1)");
    gr.addColorStop(0.35, "rgba(255,255,255,0.35)");
    gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr;
    g.fillRect(0, 0, 64, 64);
    glowTex = new THREE.CanvasTexture(c);
    glowTex.colorSpace = THREE.SRGBColorSpace;
  }
  return glowTex;
}

export function disposeGlowTexture() {
  glowTex?.dispose();
}
