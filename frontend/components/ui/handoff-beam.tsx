"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";
import { LiveRegion } from "./handoff-beam-utils/a11y";
import { useElementSize } from "./handoff-beam-utils/canvas";
import { useVisibleLoop } from "./handoff-beam-utils/loop";
import { BJORK_PALETTE, type BjorkTone } from "./handoff-beam-utils/palette";
import { valueNoise1D } from "./handoff-beam-utils/random";
import { stepSpring, type SpringState } from "./handoff-beam-utils/spring";
import { useBjorkTone } from "./handoff-beam-utils/tone";

/**
 * HandoffBeam: a glowing hairline along the bottom edge of its children that shows who has the
 * floor. listening = crests drawing inward (level reactive), thinking = a shimmer travelling
 * along the line, speaking = calm outward ripples, idle = a faint breathing dot.
 */

export type BeamPhase = "idle" | "listening" | "thinking" | "speaking";
type Bands = [number, number, number];
type LevelSource = number | (() => number | Bands);

export interface HandoffBeamProps {
  phase: BeamPhase;
  /** A 0..1 level, or a function returning a level / [low, mid, high] (called every frame). */
  level?: LevelSource;
  analyser?: AnalyserNode | null;
  children?: ReactNode;
  radius?: number;
  /** Height in px of the strip the beam may use. */
  reach?: number;
  intensity?: number;
  palette?: "ember" | "mono" | string[];
  /** Horizontal centre of the beam, 0..1 of the host width. */
  gatherOffset?: number;
  /** Level held while thinking. */
  heldLevel?: number;
  /** Envelope attack / release in ms. */
  attack?: number;
  release?: number;
  threshold?: number;
  sensitivity?: number;
  phaseLabels?: Partial<Record<BeamPhase, string>>;
  tone?: BjorkTone;
  /** Cycle through the phases on its own until the user interacts. */
  attract?: boolean;
  className?: string;
}

const PHASES: BeamPhase[] = ["idle", "listening", "thinking", "speaking"];
const MORPH = { stiffness: 64, damping: 16, mass: 1 };
const SPAN = [0.16, 0.6, 0.3, 0.5];
const BRIGHT = [0.42, 0.55, 0.85, 0.62];
const BRIGHT_GAIN = [0, 0.45, 0, 0.35];
const POINTS = 96;
const RAMP = 96;
const SHIMMER_S = 1.5;
const SHIMMER_W = 0.22;
const IDLE_BREATH_HZ = 0.2;
const LISTEN_FLOOR = 0.07;
const STATIC_CLOCK = 0.8;
const STATIC_RAW: Bands = [0.6, 0.45, 0.3];
const ATTRACT: { phase: BeamPhase; s: number }[] = [
  { phase: "listening", s: 3 },
  { phase: "thinking", s: 2 },
  { phase: "speaking", s: 3 },
  { phase: "idle", s: 1.5 },
];
const ATTRACT_TOTAL = ATTRACT.reduce((a, p) => a + p.s, 0);
const ATTRACT_PAUSE_MS = 4000;

const DEFAULT_LABELS: Record<BeamPhase, string> = {
  idle: "Idle",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
};

/** One colour per phase (idle, listening, thinking, speaking), core and edge. */
const EMBER = {
  core: ["#ec5c13", "#ff7a2e", "#ffd1a1", "#ff8a3d"],
  edge: ["#ec5c13", "#ff5ea8", "#ff8a3d", "#ffb36b"],
};
const MONO_DARK = { core: ["#f2ede4", "#ffffff", "#ffffff", "#f2ede4"], edge: ["#a8a29e", "#d6d3d1", "#e7e5e4", "#d6d3d1"] };
const MONO_LIGHT = { core: ["#1d1a16", "#000000", "#000000", "#1d1a16"], edge: ["#57534e", "#44403c", "#292524", "#44403c"] };

type Rgb = [number, number, number];
const hexToRgb = (hex: string): Rgb => {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.replace(/(.)/g, "$1$1");
  const n = parseInt(h, 16);
  return Number.isNaN(n) ? [255, 255, 255] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

function resolvePalette(p: "ember" | "mono" | string[], tone: BjorkTone) {
  let core: string[];
  let edge: string[];
  if (Array.isArray(p) && p.length) {
    core = PHASES.map((_, i) => p[i % p.length]);
    edge = PHASES.map((_, i) => p[(i + 1) % p.length]);
  } else if (p === "mono") {
    ({ core, edge } = tone === "light" ? MONO_LIGHT : MONO_DARK);
  } else {
    ({ core, edge } = EMBER);
  }
  return { core: core.map(hexToRgb), edge: edge.map(hexToRgb) };
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (x: number) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};
const bump = (p: number) => 0.5 + 0.5 * Math.cos(2 * Math.PI * p);

/** A syllable-like [low, mid, high] signal for demos and the attract mode. */
export function createSimulatedVoice(seed = 1): (x: number) => Bands {
  const pitch = valueNoise1D(seed + 11);
  const phrase = valueNoise1D(seed + 23);
  const nLow = valueNoise1D(seed + 37);
  const nMid = valueNoise1D(seed + 41);
  const nHigh = valueNoise1D(seed + 53);
  const out: Bands = [0, 0, 0];
  return (x: number) => {
    const carrier = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3.1 * x + 1.7 * pitch(0.6 * x));
    const speaking = clamp01(phrase(0.7 * x) * 2);
    const env = carrier * carrier * speaking;
    out[0] = clamp01(env * (0.9 + (nLow(x * 1.3) - 0.5) * 0.3));
    out[1] = clamp01(env * (0.7 + (nMid(x * 1.7) - 0.5) * 0.3));
    out[2] = clamp01(env * (0.45 + (nHigh(x * 2.1) - 0.5) * 0.3));
    return out;
  };
}

interface Engine {
  w: SpringState[];
  env: Bands;
  lvl: Bands;
  clock: number;
  ys: Float32Array;
  freq: Uint8Array | null;
  raw: Bands;
  sim: (x: number) => Bands;
  rampCanvas: HTMLCanvasElement | null;
  rampImage: ImageData | null;
  attractPausedUntil: number;
}

const createEngine = (): Engine => ({
  w: PHASES.map((_, i) => ({ x: i === 0 ? 1 : 0, v: 0 })),
  env: [0, 0, 0],
  lvl: [0, 0, 0],
  clock: 0,
  ys: new Float32Array(POINTS),
  freq: null,
  raw: [0, 0, 0],
  sim: createSimulatedVoice(7),
  rampCanvas: null,
  rampImage: null,
  attractPausedUntil: 0,
});

function readAnalyser(an: AnalyserNode, eng: Engine, out: Bands) {
  const n = an.frequencyBinCount;
  if (!eng.freq || eng.freq.length !== n) eng.freq = new Uint8Array(n);
  an.getByteFrequencyData(eng.freq as Uint8Array<ArrayBuffer>);
  const hz = an.context.sampleRate / an.fftSize;
  const ranges = [
    [80, 300],
    [300, 2000],
    [2000, 6000],
  ];
  for (let b = 0; b < 3; b++) {
    const lo = Math.max(1, Math.floor(ranges[b][0] / hz));
    const hi = Math.min(n - 1, Math.max(lo, Math.ceil(ranges[b][1] / hz)));
    let sum = 0;
    for (let i = lo; i <= hi; i++) sum += eng.freq[i];
    out[b] = sum / (hi - lo + 1) / 255;
  }
}

export function HandoffBeam({
  phase,
  level,
  analyser,
  children,
  radius = 32,
  reach = 22,
  intensity = 1,
  palette = "ember",
  gatherOffset = 0.5,
  heldLevel = 0.45,
  attack = 70,
  release = 260,
  threshold = 0.06,
  sensitivity = 1.4,
  phaseLabels,
  tone: toneProp,
  attract = false,
  className,
}: HandoffBeamProps) {
  const reduced = useReducedMotion();
  const tone = useBjorkTone(toneProp);
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { width, height } = useElementSize(hostRef);
  const engRef = useRef<Engine | null>(null);
  const getEng = useCallback(() => (engRef.current ??= createEngine()), []);
  const [attractPhase, setAttractPhase] = useState<BeamPhase | null>(null);

  const colors = useMemo(() => resolvePalette(palette, tone), [palette, tone]);
  const labels = { ...DEFAULT_LABELS, ...phaseLabels };
  const dpr = typeof window === "undefined" ? 1 : Math.min(window.devicePixelRatio || 1, 2);
  const H = Math.max(0, Math.min(reach, height));
  const px = Math.round(width * dpr);
  const py = Math.round(H * dpr);

  const settings = useRef({ phase, level, analyser, intensity, gatherOffset, heldLevel, attack, release, threshold, sensitivity, attract, colors });
  useEffect(() => {
    settings.current = { phase, level, analyser, intensity, gatherOffset, heldLevel, attack, release, threshold, sensitivity, attract, colors };
  });

  const pauseAttract = useCallback(() => {
    getEng().attractPausedUntil = performance.now() + ATTRACT_PAUSE_MS;
  }, [getEng]);

  /** Draw the current engine state. */
  const draw = useCallback(() => {
    const eng = getEng();
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || width <= 0 || H <= 0) return;
    const s = settings.current;
    const { w, ys } = eng;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, H);

    let wSum = 0;
    for (let i = 0; i < 4; i++) wSum += clamp01(w[i].x);
    wSum = Math.max(wSum, 1e-3);
    const wn = (i: number) => clamp01(w[i].x) / wSum;
    const wI = wn(0), wL = wn(1), wT = wn(2), wS = wn(3);

    let span = 0;
    let bright = 0;
    let gainSum = 0;
    for (let i = 0; i < 4; i++) {
      span += wn(i) * SPAN[i];
      bright += wn(i) * BRIGHT[i];
      gainSum += wn(i) * BRIGHT_GAIN[i];
    }
    const [low, mid, high] = eng.lvl;
    const lift = (low + mid + high) / 3;
    const glow = 1 + gainSum * lift * 2;

    const spanPx = Math.max(2, width * span);
    const x0 = Math.min(Math.max(width * s.gatherOffset - spanPx / 2, 0), width - spanPx);
    const base = H - 1.25;
    const amp = Math.max(0, H - 3.5);
    const t = eng.clock;

    const speakAmp = 0.55 + 0.45 * lift;
    const held = s.heldLevel;
    const shimmerPos = ((t / SHIMMER_S) % 1) * 2.6 - 1.3;
    const breath = 0.5 + 0.5 * Math.sin(2 * Math.PI * IDLE_BREATH_HZ * t);

    for (let i = 0; i < POINTS; i++) {
      const u = (i / (POINTS - 1)) * 2 - 1;
      const d = Math.abs(u);
      const win = (1 - u * u) * (1 - u * u);
      const listen =
        LISTEN_FLOOR * bump(1.1 * d + 0.55 * t) +
        low * 0.75 * bump(1.1 * d + 0.55 * t) +
        mid * 0.4 * bump(2.3 * d + 0.95 * t + 0.18 * u) +
        high * 0.24 * bump(3.8 * d + 1.5 * t - 0.3 * u);
      const speak = speakAmp * (0.22 + 0.5 * bump(1.25 * d - 0.62 * t) + 0.12 * bump(2.6 * d - 1.24 * t));
      const sd = (u - shimmerPos) / SHIMMER_W;
      const think = held * (0.12 + 0.4 * Math.exp(-sd * sd));
      const idle = 0.1 + 0.08 * breath;
      ys[i] = amp * win * (wI * idle + wL * listen + wS * speak + wT * think);
    }

    const stepX = spanPx / (POINTS - 1);

    // Shapes are drawn in white; the colour ramp below tints them via "source-in".
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    const hazes: [number, number][] = [
      [1, 0.05],
      [0.62, 0.07],
      [0.3, 0.1],
    ];
    for (const [k, a] of hazes) {
      ctx.beginPath();
      ctx.moveTo(x0, base);
      for (let i = 0; i < POINTS; i++) ctx.lineTo(x0 + i * stepX, base - ys[i] * k);
      ctx.lineTo(x0 + spanPx, base);
      ctx.closePath();
      ctx.fillStyle = `rgba(255,255,255,${(a * glow).toFixed(3)})`;
      ctx.fill();
    }
    const ribbons: [number, number][] = [
      [5.5, 0.07],
      [2.2, 0.26],
      [0.85, 1],
    ];
    ctx.beginPath();
    for (let i = 0; i < POINTS; i++) {
      const x = x0 + i * stepX;
      const y = base - ys[i];
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    for (const [half, a] of ribbons) {
      ctx.lineWidth = half * 2;
      ctx.strokeStyle = `rgba(255,255,255,${clamp01(a * glow).toFixed(3)})`;
      ctx.stroke();
    }
    if (wT > 0.02) {
      ctx.lineWidth = 3.2;
      for (let i = 1; i < POINTS; i++) {
        const u = (i / (POINTS - 1)) * 2 - 1;
        const sd = (u - shimmerPos) / SHIMMER_W;
        const a = wT * Math.exp(-sd * sd);
        if (a < 0.03) continue;
        ctx.strokeStyle = `rgba(255,255,255,${a.toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(x0 + (i - 1) * stepX, base - ys[i - 1]);
        ctx.lineTo(x0 + i * stepX, base - ys[i]);
        ctx.stroke();
      }
    }

    // Colour ramp: core to edge, faded toward the ends of the span.
    if (!eng.rampCanvas) {
      const rc = document.createElement("canvas");
      rc.width = RAMP;
      rc.height = 1;
      eng.rampCanvas = rc;
      eng.rampImage = rc.getContext("2d")?.createImageData(RAMP, 1) ?? null;
    }
    const rctx = eng.rampCanvas.getContext("2d");
    const img = eng.rampImage;
    if (rctx && img) {
      const { core, edge } = s.colors;
      for (let i = 0; i < RAMP; i++) {
        const d = Math.abs((2 * i) / (RAMP - 1) - 1);
        const tt = smoothstep((d - 0.15) / 0.75);
        let r = 0, g = 0, b = 0;
        for (let p = 0; p < 4; p++) {
          const wp = wn(p);
          r += wp * (core[p][0] + (edge[p][0] - core[p][0]) * tt);
          g += wp * (core[p][1] + (edge[p][1] - core[p][1]) * tt);
          b += wp * (core[p][2] + (edge[p][2] - core[p][2]) * tt);
        }
        const falloff = Math.pow(Math.max(0, 1 - d * d), 1.5);
        const a = clamp01(bright * glow * s.intensity * falloff * (1 + 0.55 * lift));
        const o = i * 4;
        img.data[o] = r;
        img.data[o + 1] = g;
        img.data[o + 2] = b;
        img.data[o + 3] = Math.round(a * 255);
      }
      rctx.putImageData(img, 0, 0);
      ctx.globalCompositeOperation = "source-in";
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(eng.rampCanvas, x0, 0, spanPx, H);
      ctx.globalCompositeOperation = "source-over";
    }
  }, [getEng, width, H, dpr]);

  /** Advance springs, envelopes and the clock. */
  const step = useCallback(
    (dt: number) => {
      const eng = getEng();
      const s = settings.current;
      let ph = s.phase;
      const now = performance.now();
      if (s.attract && now > eng.attractPausedUntil) {
        let at = (now / 1000) % ATTRACT_TOTAL;
        ph = ATTRACT[ATTRACT.length - 1].phase;
        for (const seg of ATTRACT) {
          if (at < seg.s) {
            ph = seg.phase;
            break;
          }
          at -= seg.s;
        }
      }
      const target = PHASES.indexOf(ph);
      for (let i = 0; i < 4; i++) stepSpring(eng.w[i], i === target ? 1 : 0, MORPH, dt);

      // Raw level.
      const raw = eng.raw;
      raw[0] = raw[1] = raw[2] = 0;
      const src = s.level;
      if (s.attract && now > eng.attractPausedUntil) {
        if (ph === "listening" || ph === "speaking") {
          const v = eng.sim(now / 1000);
          raw[0] = v[0];
          raw[1] = v[1];
          raw[2] = v[2];
        }
      } else if (s.analyser) {
        readAnalyser(s.analyser, eng, raw);
      } else if (typeof src === "function") {
        const v = src();
        if (typeof v === "number") {
          raw[0] = v;
          raw[1] = v * 0.7;
          raw[2] = v * 0.45;
        } else {
          raw[0] = v[0];
          raw[1] = v[1];
          raw[2] = v[2];
        }
      } else if (typeof src === "number") {
        raw[0] = src;
        raw[1] = src * 0.7;
        raw[2] = src * 0.45;
      }

      const wS = clamp01(eng.w[3].x);
      const tauSmooth = 0.07 + 0.2 * wS;
      for (let b = 0; b < 3; b++) {
        let v = clamp01(raw[b] * s.sensitivity);
        v = v < s.threshold ? 0 : (v - s.threshold) / (1 - s.threshold);
        const tau = (v > eng.env[b] ? s.attack : s.release) / 1000;
        eng.env[b] += (v - eng.env[b]) * (1 - Math.exp(-dt / tau));
        eng.lvl[b] += (eng.env[b] - eng.lvl[b]) * (1 - Math.exp(-dt / tauSmooth));
      }
      eng.clock += dt;
    },
    [getEng],
  );

  useVisibleLoop(
    hostRef,
    (dt) => {
      step(dt);
      draw();
    },
    { enabled: !reduced },
  );

  // Reduced motion: a single static frame per state change.
  useEffect(() => {
    if (!reduced) return;
    const eng = getEng();
    const target = PHASES.indexOf(phase);
    for (let i = 0; i < 4; i++) {
      eng.w[i].x = i === target ? 1 : 0;
      eng.w[i].v = 0;
    }
    const lit = phase === "listening" || phase === "speaking";
    for (let b = 0; b < 3; b++) {
      eng.lvl[b] = lit ? STATIC_RAW[b] : 0;
      eng.env[b] = eng.lvl[b];
    }
    eng.clock = STATIC_CLOCK;
    draw();
  }, [reduced, phase, getEng, draw, px, py, colors, intensity]);

  // Show the attract phase label for assistive tech only while it is the one being drawn.
  useEffect(() => {
    if (!attract) {
      setAttractPhase(null);
      return;
    }
    const id = window.setInterval(() => {
      if (performance.now() < getEng().attractPausedUntil) return setAttractPhase(null);
      let at = (performance.now() / 1000) % ATTRACT_TOTAL;
      for (const seg of ATTRACT) {
        if (at < seg.s) return setAttractPhase(seg.phase);
        at -= seg.s;
      }
    }, 500);
    return () => window.clearInterval(id);
  }, [attract, getEng]);

  const shown = attractPhase ?? phase;

  return (
    <div
      ref={hostRef}
      className={cn("relative w-full overflow-hidden", className)}
      style={{ borderRadius: radius }}
      onPointerDown={attract ? pauseAttract : undefined}
      onKeyDown={attract ? pauseAttract : undefined}
    >
      {children}
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        width={px}
        height={py}
        className="pointer-events-none absolute bottom-0 left-0"
        style={{ width, height: H }}
      />
      <LiveRegion message={labels[shown]} />
    </div>
  );
}

export default HandoffBeam;
export { BJORK_PALETTE };
