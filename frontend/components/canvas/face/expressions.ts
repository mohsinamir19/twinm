import type { FaceState } from "@/store/twin";

/**
 * Parametric eye model. Every face state is one row in EXPRESSIONS; the Face
 * damps the live parameters toward the row each frame, so adding a state is:
 * add a row here (+ optionally a behaviour below).
 *
 * Units are pixels on the 512x256 screen texture, centred at (256, 128).
 * Per-eye params exist for the left (L) and right (R) eye.
 */
export interface ExpressionTarget {
  /** Distance between the two eye centres. */
  gap: number;
  /** Rounded-bar body of each eye. r is 0 (square) .. 1 (capsule). */
  wL: number; hL: number; rL: number; tL: number;
  wR: number; hR: number; rR: number; tR: number;
  /** Brow: visible 0..1, angle (rad, + = outer end up on L), length, extra y offset, curvature (0 bar .. 1 arc). */
  bL: number; baL: number; blL: number; byL: number; bcL: number;
  bR: number; baR: number; blR: number; byR: number; bcR: number;
  /** Lid closure 0..1 (blinks squash the bar to a thin line). */
  lid: number;
  /** -1 "⌒"  0 off  +1 "‿"; blends the bar into a closed arc. */
  arc: number;
  /** Arc stroke width in px. */
  aw: number;
  /** "x x" amount 0..1 and its half-size. */
  cross: number;
  cs: number;
  /** "> <" amount 0..1. */
  chev: number;
  /** Gaze -1..1, and extra pixel offsets (bob / shake). */
  gx: number; gy: number; ox: number; oy: number;
  /** Mouth: visible 0..1, opening height px (0 = line), width px, curve -1 frown..+1 smile, wave 0..1 (wavy line). */
  mouthV: number;
  mouthOpen: number;
  mouthW: number;
  mouthCurve: number;
  mouthWave: number;
  /** Screen brightness multiplier and colour tint blends. */
  bright: number;
  mint: number;
  rose: number;
}

export type ParamKey = keyof ExpressionTarget;

const BASE: ExpressionTarget = {
  gap: 112,
  wL: 32, hL: 76, rL: 1, tL: 0,
  wR: 32, hR: 76, rR: 1, tR: 0,
  bL: 0, baL: 0, blL: 46, byL: 12, bcL: 0,
  bR: 0, baR: 0, blR: 46, byR: 12, bcR: 0,
  lid: 0,
  arc: 0,
  aw: 54,
  cross: 0,
  cs: 20,
  chev: 0,
  gx: 0, gy: 0, ox: 0, oy: 0,
  mouthV: 0.8, mouthOpen: 0, mouthW: 34, mouthCurve: 0.6, mouthWave: 0,
  bright: 1.12,
  mint: 0,
  rose: 0,
};

export const PARAM_KEYS = Object.keys(BASE) as ParamKey[];

const mk = (o: Partial<ExpressionTarget>): ExpressionTarget => ({ ...BASE, ...o });

export function cloneExpression(src: ExpressionTarget, dst: ExpressionTarget = { ...BASE }) {
  for (const k of PARAM_KEYS) dst[k] = src[k];
  return dst;
}

/** Sheet reference rows are noted per state. */
export const EXPRESSIONS: Record<FaceState, ExpressionTarget> = {
  // row 2 col 3: two vertical bars
  idle: mk({}),
  // row 1 col 2: taller bars with small raised brow arcs
  listening: mk({
    hL: 90, hR: 90, gap: 118, bright: 1.25, mouthV: 0.35, mouthW: 22, mouthCurve: 0.1,
    bL: 1, blL: 34, byL: 14, bcL: 1, bR: 1, blR: 34, byR: 14, bcR: 1,
  }),
  // row 1 col 3 / row 2 col 2: slanted brow over small bar | rounded square
  thinking: mk({
    gap: 124, mouthV: 0.8, mouthW: 26, mouthCurve: 0,
    wL: 26, hL: 34, rL: 0.7, wR: 46, hR: 46, rR: 0.38,
    bL: 1, baL: 0.34, blL: 62, byL: 11,
    bR: 0, bcR: 0, byR: 12,
    bright: 1.12,
  }),
  // row 2 col 1: determined flat brows over rounded squares
  working: mk({
    gap: 118, mouthV: 0.8, mouthW: 32, mouthCurve: 0,
    wL: 48, hL: 34, rL: 0.32, wR: 48, hR: 34, rR: 0.32,
    bL: 1, baL: 0.15, blL: 64, byL: 7, bR: 1, baR: -0.15, blR: 64, byR: 7,
    mint: 1, bright: 1.18,
  }),
  // row 3 col 2: closed smiling arcs
  answering: mk({ arc: 1, aw: 56, gap: 118, bright: 1.15, mouthW: 38, mouthCurve: 0.8 }),
  // reserved for TTS: bars driven by a waveform (see behaviours)
  speaking: mk({ mouthV: 1, mouthW: 46, mouthCurve: 0.5, wL: 30, wR: 30, hL: 56, hR: 56, bright: 1.2 }),
  // row 4 col 1: x x
  error: mk({ mouthV: 1, mouthW: 46, mouthCurve: 0, mouthWave: 1, cross: 1, cs: 19, gap: 124, rose: 1, bright: 1.08 }),
};

/** One-shot expression after a finished run (row 3 col 1: "^ ^"). Not a store state. */
export const HAPPY: ExpressionTarget = mk({ mouthW: 46, mouthCurve: 1, arc: -1, aw: 58, gap: 122, bright: 1.2 });

/** Damp speed per parameter (default 10). */
export const LAMBDA: Partial<Record<ParamKey, number>> = {
  lid: 28,
  gx: 7,
  gy: 7,
  ox: 40,
  oy: 14,
  mouthOpen: 30,
  mouthW: 18,
};

/* ------------------------------------------------------------------ */
/* Behaviours: small time-based functions layered over the target.     */
/* ------------------------------------------------------------------ */

export interface BehaviourCtx {
  reduced: boolean;
  /** Pointer -1..1. */
  px: number;
  py: number;
  init: boolean;
  nextBlink: number;
  blinkEnd: number;
  nextSquint: number;
  squintEnd: number;
  gazeNext: number;
  gazeSide: 1 | -1;
  enteredAt: number;
  happyUntil: number;
  /** Voice: smoothed mic level, agent level (real or simulated), high-band flutter, flags. */
  mic: number;
  lvl: number;
  flutter: number;
  userSpeaking: boolean;
  voice: boolean;
}

export const createCtx = (): BehaviourCtx => ({
  reduced: false,
  px: 0,
  py: 0,
  init: false,
  nextBlink: 0,
  blinkEnd: 0,
  nextSquint: 0,
  squintEnd: 0,
  gazeNext: 0,
  gazeSide: 1,
  enteredAt: -10,
  happyUntil: -1,
  mic: 0,
  lvl: 0,
  flutter: 0,
  userSpeaking: false,
  voice: false,
});

type Behaviour = (t: number, c: BehaviourCtx, o: ExpressionTarget) => void;

function blink(t: number, c: BehaviourCtx, o: ExpressionTarget) {
  if (t >= c.nextBlink) {
    c.blinkEnd = t + 0.13;
    c.nextBlink = t + 3 + Math.random() * 3;
  }
  if (t < c.blinkEnd) o.lid = 1;
}

export const BEHAVIOURS: Record<FaceState, Behaviour> = {
  idle: (t, c, o) => {
    blink(t, c, o);
    if (t >= c.nextSquint) {
      c.squintEnd = t + 1;
      c.nextSquint = t + 12 + Math.random() * 8;
    }
    if (t < c.squintEnd) o.arc = -1;
    const drift = c.reduced ? 0 : 1;
    o.gx = Math.sin(t * 0.37) * 0.22 * drift + c.px * 0.55;
    o.gy = Math.cos(t * 0.29) * 0.12 * drift - c.py * 0.4;
  },
  listening: (t, c, o) => {
    // wider, taller eyes and lifted brows follow the user's voice level
    const m = c.mic;
    o.hL += m * 16;
    o.hR += m * 16;
    o.byL += m * 8;
    o.byR += m * 8;
    o.bright += m * 0.2;
    if (c.userSpeaking) {
      // lock on: no blink, steady gaze, brighter screen
      o.hL += 6;
      o.hR += 6;
      o.bright += 0.15;
      o.gx = 0;
      o.gy = -0.05;
      o.mouthV = 0.15;
      return;
    }
    blink(t, c, o);
    const drift = c.reduced ? 0 : 1;
    o.gx = c.px * 0.4 + Math.sin(t * 1.3) * 0.1 * drift;
    o.gy = -c.py * 0.3 - 0.1 + Math.cos(t * 1.7) * 0.07 * drift;
  },
  thinking: (t, c, o) => {
    if (t >= c.gazeNext) {
      c.gazeSide = c.gazeSide === 1 ? -1 : 1;
      c.gazeNext = t + 0.7 + Math.random() * 0.5;
    }
    o.gx = c.gazeSide * 0.75;
    o.gy = -0.8;
  },
  working: (t, c, o) => {
    o.gx = c.reduced ? 0 : Math.sin(t * 2.1) * 0.9;
    o.gy = 0.05;
  },
  answering: (t, c, o) => {
    o.oy = c.reduced ? 0 : Math.sin(t * 2.6) * 4.5;
  },
  speaking: (t, c, o) => {
    // mouth follows the voice level; eyes relax, gentle happy arcs when quiet
    const l = Math.min(1, c.lvl);
    const talking = l > 0.06;
    o.mouthV = 1;
    o.mouthOpen = talking ? 4 + l * 32 : 0;
    o.mouthW = (talking ? 52 - l * 14 : 46) + c.flutter * 3;
    o.mouthCurve = talking ? 0 : 0.5;
    o.arc = Math.max(0, 0.8 - l * 5);
    o.hL = 52 - l * 6;
    o.hR = 52 - l * 6;
    o.bright += l * 0.12;
    o.gx = 0;
    o.gy = 0.04;
  },
  error: (t, c, o) => {
    if (c.reduced) return;
    const u = t - c.enteredAt;
    if (u >= 0 && u < 0.7) o.ox = Math.exp(-u * 5) * Math.sin(u * 46) * 12;
  },
};
