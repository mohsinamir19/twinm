"use client";

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { TOOLS, type ToolId } from "@/lib/nodes";
import { useTwin, type Phase } from "@/store/twin";
import {
  damp,
  easeInOut,
  easeOut,
  energyColor,
  faceFx,
  fxOf,
  getGlowTexture,
  kickRope,
  motion,
  nodePos,
  quadAt,
  ropeAt,
  stepRope,
} from "./physics";

const CREAM = new THREE.Color("#f2ede4");
const SEG = 36;
const TRAIL = 12;
const LINE_W = 2.5;

/* ------------------------------------------------------------------ */
/* Flexible connector pod -> tile, with an energy gradient that flows  */
/* toward the tool while the tool is active. Buffers updated in place. */
/* ------------------------------------------------------------------ */

function ConnLine({ id, seed }: { id: ToolId; seed: number }) {
  const { main, glow, geo, mat, gmat, pos, col } = useMemo(() => {
    const geo = new LineGeometry();
    geo.setPositions(new Float32Array((SEG + 1) * 3));
    geo.setColors(new Float32Array((SEG + 1) * 3));
    const mat = new LineMaterial({
      color: 0xffffff,
      linewidth: LINE_W,
      vertexColors: true,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    const gmat = new LineMaterial({
      color: 0xffffff,
      linewidth: 6,
      vertexColors: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const main = new Line2(geo, mat);
    const glow = new Line2(geo, gmat);
    for (const l of [main, glow]) l.frustumCulled = false;
    glow.renderOrder = 0;
    main.renderOrder = 1;
    glow.visible = false;
    const pos = (geo.getAttribute("instanceStart") as THREE.InterleavedBufferAttribute).data;
    const col = (geo.getAttribute("instanceColorStart") as THREE.InterleavedBufferAttribute).data;
    return { main, glow, geo, mat, gmat, pos, col };
  }, []);

  const tmp = useMemo(() => new THREE.Vector3(), []);
  const prev = useMemo(() => new THREE.Vector3(), []);
  const c = useMemo(() => new THREE.Color(), []);
  const fx = fxOf(id);

  useEffect(
    () => () => {
      geo.dispose();
      mat.dispose();
      gmat.dispose();
    },
    [geo, mat, gmat],
  );

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const t = state.clock.elapsedTime;
    mat.resolution.set(state.size.width, state.size.height);
    gmat.resolution.set(state.size.width, state.size.height);
    stepRope(id, t, dt, seed);
    fx.energy = damp(fx.energy, fx.target, fx.target > fx.energy ? 6 : 3, dt);
    const e = fx.energy < 0.003 ? 0 : fx.energy;

    const pa = pos.array as Float32Array;
    const ca = col.array as Float32Array;
    const flow = motion.reduced ? 0 : t * 0.7;
    for (let i = 0; i <= SEG; i++) {
      const u = i / SEG;
      ropeAt(id, u, tmp, t);
      energyColor(u * 1.4 - flow, c);
      const r = CREAM.r + (c.r - CREAM.r) * e;
      const g = CREAM.g + (c.g - CREAM.g) * e;
      const b = CREAM.b + (c.b - CREAM.b) * e;
      if (i > 0) {
        const o = (i - 1) * 6;
        pa[o] = prev.x;
        pa[o + 1] = prev.y;
        pa[o + 2] = prev.z;
        pa[o + 3] = tmp.x;
        pa[o + 4] = tmp.y;
        pa[o + 5] = tmp.z;
        ca[o + 3] = r;
        ca[o + 4] = g;
        ca[o + 5] = b;
      }
      if (i < SEG) {
        const o = i * 6;
        ca[o] = r;
        ca[o + 1] = g;
        ca[o + 2] = b;
      }
      prev.copy(tmp);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;

    mat.opacity = 0.55 + 0.4 * e;
    glow.visible = e > 0.01;
    gmat.opacity = 0.18 * e;
  });

  return (
    <>
      <primitive object={glow} />
      <primitive object={main} />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* A bright dot with a short fading comet along the rope.              */
/* ------------------------------------------------------------------ */

interface SparkState {
  on: boolean;
  /** 0..1 progress along the curve. */
  t: number;
}

type CurveFn = (t: number, out: THREE.Vector3) => void;

interface Tint {
  halo: string;
  head: string;
  trail: [number, number, number];
}
const WARM: Tint = { halo: "#F5A524", head: "#fff6dc", trail: [1, 0.68, 0.2] };
const RETURN: Tint = { halo: "#bef264", head: "#f7fee7", trail: [0.7, 0.95, 0.3] };

function Spark({ state, curve, tint }: { state: SparkState; curve: CurveFn; tint: Tint }) {
  const group = useRef<THREE.Group>(null);
  const trail = useRef<THREE.InstancedMesh>(null);
  const tmp = useMemo(() => new THREE.Vector3(), []);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const glowMap = useMemo(() => getGlowTexture(), []);

  useLayoutEffect(() => {
    const tr = trail.current;
    if (!tr) return;
    const col = new THREE.Color();
    for (let i = 0; i < TRAIL; i++) {
      const f = 1 - (i + 1) / (TRAIL + 1);
      col.setRGB(tint.trail[0] * f * f, tint.trail[1] * f * f, tint.trail[2] * f * f);
      tr.setColorAt(i, col);
    }
    if (tr.instanceColor) tr.instanceColor.needsUpdate = true;
  }, [tint]);

  useFrame(() => {
    const g = group.current;
    if (!g) return;
    g.visible = state.on;
    if (!state.on) return;
    curve(state.t, tmp);
    g.position.copy(tmp);

    const tr = trail.current;
    if (!tr) return;
    tr.visible = !motion.reduced;
    if (motion.reduced) return;
    for (let i = 0; i < TRAIL; i++) {
      curve(Math.min(1, Math.max(0, state.t - (i + 1) * 0.018)), tmp);
      dummy.position.set(tmp.x - g.position.x, tmp.y - g.position.y, tmp.z - g.position.z);
      dummy.scale.setScalar(0.34 * (1 - (i + 1) / (TRAIL + 1)) + 0.06);
      dummy.updateMatrix();
      tr.setMatrixAt(i, dummy.matrix);
    }
    tr.instanceMatrix.needsUpdate = true;
  });

  return (
    <group ref={group} visible={false} renderOrder={5}>
      <sprite scale={[0.62, 0.62, 1]}>
        <spriteMaterial map={glowMap} color={tint.halo} transparent opacity={0.75} depthWrite={false} blending={THREE.AdditiveBlending} />
      </sprite>
      <mesh renderOrder={7}>
        <circleGeometry args={[0.062, 24]} />
        <meshBasicMaterial color={tint.head} toneMapped={false} />
      </mesh>
      <instancedMesh ref={trail} args={[undefined, undefined, TRAIL]} frustumCulled={false} renderOrder={5}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial map={glowMap} transparent depthWrite={false} toneMapped={false} blending={THREE.AdditiveBlending} />
      </instancedMesh>
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Director: turns store phase/runId into the energy-flow sequence.    */
/*  outbound: pulses pod -> tools, tools glow, hold, setPhase(returning)*/
/*  returning: pulses tools -> pod, glow fades, finishRun()             */
/* ------------------------------------------------------------------ */

const INBOUND_S = 0.9;
const TRAVEL = 0.8;
const RETURN_S = 0.7;
const STAGGER = 0.1;
const HOLD = 1.4;
const SAFETY = 8;
const MAX = TOOLS.length;
const SEEDS = new Map(TOOLS.map((t) => [t.id, t.seed]));

export function Pulses() {
  const inbound = useMemo<SparkState>(() => ({ on: false, t: 0 }), []);
  const outs = useMemo<SparkState[]>(() => Array.from({ length: MAX }, () => ({ on: false, t: 0 })), []);
  const rets = useMemo<SparkState[]>(() => Array.from({ length: MAX }, () => ({ on: false, t: 0 })), []);
  const ids = useRef<(ToolId | null)[]>(Array.from({ length: MAX }, () => null));
  const inStart = useMemo(() => new THREE.Vector3(), []);
  const inCtrl = useMemo(() => new THREE.Vector3(), []);
  const inEnd = useRef(0.8);
  const run = useRef({
    runId: -1,
    phase: "idle" as Phase,
    t0: 0,
    n: 0,
    done: false,
    allAt: -1,
    finished: false,
    landed: Array.from({ length: MAX }, () => false),
    started: Array.from({ length: MAX }, () => false),
    landedCount: 0,
  });

  const clock = useRef(0);

  useEffect(
    () => () => {
      for (const t of TOOLS) {
        const f = fxOf(t.id);
        f.target = 0;
        f.energy = 0;
      }
    },
    [],
  );

  const inCurve = useMemo<CurveFn>(
    () => (t, out) => {
      quadAt(out, inStart, inCtrl, nodePos("core"), t * inEnd.current);
    },
    [inStart, inCtrl],
  );

  const outCurves = useMemo<CurveFn[]>(
    () =>
      outs.map((_, i) => (t, out) => {
        const id = ids.current[i];
        if (!id) return void out.set(0, 0, 0);
        ropeAt(id, t, out, clock.current);
      }),
    [outs],
  );
  const retCurves = useMemo<CurveFn[]>(
    () =>
      rets.map((_, i) => (t, out) => {
        const id = ids.current[i];
        if (!id) return void out.set(0, 0, 0);
        ropeAt(id, 1 - t, out, clock.current);
      }),
    [rets],
  );

  useFrame((state) => {
    const now = state.clock.elapsedTime;
    clock.current = now;
    const s = useTwin.getState();
    const r = run.current;

    if (s.runId !== r.runId || s.phase !== r.phase) {
      const sameRun = s.runId === r.runId;
      r.runId = s.runId;
      r.phase = s.phase;
      r.t0 = now;
      r.done = false;
      r.finished = false;
      r.allAt = -1;
      r.landedCount = 0;
      r.landed.fill(false);
      r.started.fill(false);
      inbound.on = false;
      for (const o of outs) o.on = false;
      for (const o of rets) o.on = false;

      if (s.phase === "inbound") {
        for (const t of TOOLS) fxOf(t.id).target = 0;
        const cam = state.camera as THREE.PerspectiveCamera;
        const h = 2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * cam.position.z;
        const w = h * (state.size.width / state.size.height);
        inStart.set(-(w / 2) - 1, -(h / 2) * 0.7, 0.3);
        inCtrl.set(-w * 0.12, inStart.y * 0.9, 0.3);
        inEnd.current = Math.max(0.5, 1 - 1.55 / Math.max(inStart.length(), 1));
        inbound.t = 0;
        inbound.on = true;
      } else if (s.phase === "outbound" || (s.phase === "returning" && !sameRun)) {
        const list = s.targets.slice(0, MAX);
        r.n = list.length;
        for (let i = 0; i < MAX; i++) ids.current[i] = list[i] ?? null;
        if (r.n === 0) r.allAt = now;
      } else if (s.phase === "idle" || s.phase === "thinking") {
        for (const t of TOOLS) fxOf(t.id).target = 0;
      }
    }

    const busy = r.phase === "outbound" || r.phase === "returning";
    const finish = () => {
      r.finished = true;
      const cur = useTwin.getState();
      if (cur.runId === r.runId && (cur.phase === "outbound" || cur.phase === "returning")) cur.finishRun();
    };

    if (r.phase === "inbound") {
      const u = (now - r.t0) / INBOUND_S;
      inbound.t = easeInOut(Math.min(u, 1));
      if (u >= 1 && !r.done) {
        r.done = true;
        inbound.on = false;
        if (s.runId === r.runId && s.phase === "inbound") s.setPhase("thinking");
      }
    } else if (r.phase === "outbound") {
      for (let i = 0; i < r.n; i++) {
        const id = ids.current[i];
        const o = outs[i];
        const local = (now - r.t0 - i * STAGGER) / TRAVEL;
        if (local < 0) continue;
        if (!r.started[i]) {
          r.started[i] = true;
          if (id) kickRope(id, 0.05);
        }
        const p = Math.min(local, 1);
        o.t = easeOut(p);
        o.on = p < 1;
        if (p >= 1 && !r.landed[i]) {
          r.landed[i] = true;
          r.landedCount++;
          if (id) {
            if (s.runId === r.runId && s.phase === "outbound") s.activate(id);
            fxOf(id).target = 1;
            kickRope(id, 0.1);
          }
          if (r.landedCount >= r.n) r.allAt = now;
        }
      }
      if (r.allAt >= 0 && !r.finished && now - r.allAt >= (r.n === 0 ? 0.4 : HOLD)) {
        r.finished = true;
        const cur = useTwin.getState();
        if (cur.runId === r.runId && cur.phase === "outbound") cur.setPhase("returning");
      }
    } else if (r.phase === "returning") {
      if (r.n === 0 && !r.finished && now - r.t0 > 0.3) finish();
      for (let i = 0; i < r.n; i++) {
        const id = ids.current[i];
        const o = rets[i];
        const local = (now - r.t0 - i * STAGGER) / RETURN_S;
        if (local < 0) continue;
        if (!r.started[i]) {
          r.started[i] = true;
          if (id) {
            fxOf(id).target = 0;
            kickRope(id, 0.08);
          }
        }
        const p = Math.min(local, 1);
        o.t = easeInOut(p);
        o.on = p < 1;
        if (p >= 1 && !r.landed[i]) {
          r.landed[i] = true;
          r.landedCount++;
          faceFx.kickAt = now;
          if (r.landedCount >= r.n && !r.finished) finish();
        }
      }
    }

    // safety: never leave the phase stuck
    if (busy && !r.finished && now - r.t0 > SAFETY) finish();
  });

  return (
    <>
      {TOOLS.map((t) => (
        <ConnLine key={t.id} id={t.id} seed={SEEDS.get(t.id) ?? 0} />
      ))}
      <Spark state={inbound} curve={inCurve} tint={WARM} />
      {outs.map((o, i) => (
        <Spark key={`o${i}`} state={o} curve={outCurves[i]} tint={WARM} />
      ))}
      {rets.map((o, i) => (
        <Spark key={`r${i}`} state={o} curve={retCurves[i]} tint={RETURN} />
      ))}
    </>
  );
}
