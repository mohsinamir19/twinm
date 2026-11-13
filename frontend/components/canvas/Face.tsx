"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { selectFaceState, useTwin, type FaceState } from "@/store/twin";
import {
  BEHAVIOURS,
  EXPRESSIONS,
  HAPPY,
  LAMBDA,
  PARAM_KEYS,
  cloneExpression,
  createCtx,
  type ExpressionTarget,
} from "./face/expressions";
import { createScreen } from "./face/screen";
import { voiceLevels } from "@/lib/voice/levels";
import { damp, faceFx, getGlowTexture, motion } from "./physics";

export const ORB_R = 1.5;

/** Halo look per state: colour, pulse rate (Hz), resting opacity and pulse depth. */
interface HaloLook {
  color: THREE.Color;
  rate: number;
  base: number;
  depth: number;
}
const halo = (c: string, rate: number, base: number, depth: number): HaloLook => ({
  color: new THREE.Color(c),
  rate,
  base,
  depth,
});
const HALO: Record<FaceState, HaloLook> = {
  idle: halo("#F5A524", 0.17, 0.3, 0.08),
  listening: halo("#FACC15", 0.5, 0.34, 0.06),
  thinking: halo("#C2D42E", 1.5, 0.36, 0.14),
  working: halo("#34D399", 1.8, 0.38, 0.14),
  answering: halo("#F8B72A", 0.55, 0.34, 0.08),
  speaking: halo("#FACC15", 2.2, 0.34, 0.1),
  error: halo("#FB7185", 0.4, 0.32, 0.08),
};
const RIPPLE_PERIOD = 1.2;
const CREAM = new THREE.Color("#f2ede4");
const AMBER = new THREE.Color("#F5A524");

/** Curved screen patch hugging the front of the pod (UVs span the patch). */
function createScreenGeometry() {
  const half = THREE.MathUtils.degToRad(50);
  const vHalf = THREE.MathUtils.degToRad(24);
  return new THREE.SphereGeometry(ORB_R + 0.012, 64, 24, Math.PI / 2 - half, half * 2, Math.PI / 2 - vHalf, vHalf * 2);
}

/**
 * The agent: a matte graphite pod carrying the dot-matrix face screen, with one
 * living energy halo behind it. Animation lives in refs and a single useFrame.
 */
export function Face() {
  const faceState = useTwin(selectFaceState);
  const stateRef = useRef<FaceState>(faceState);
  useEffect(() => {
    stateRef.current = faceState;
  }, [faceState]);

  const root = useRef<THREE.Group>(null);
  const tilt = useRef<THREE.Group>(null);
  const haloSprite = useRef<THREE.Sprite>(null);
  const screenMat = useRef<THREE.MeshBasicMaterial>(null);
  const ring0 = useRef<THREE.Mesh>(null);
  const ring1 = useRef<THREE.Mesh>(null);
  const ring2 = useRef<THREE.Mesh>(null);

  const screen = useMemo(() => createScreen(), []);
  const screenGeo = useMemo(() => createScreenGeometry(), []);
  const glow = useMemo(() => getGlowTexture(), []);

  const sim = useMemo(
    () => ({
      cur: cloneExpression(EXPRESSIONS.idle),
      goal: cloneExpression(EXPRESSIONS.idle),
      ctx: createCtx(),
      prev: "idle" as FaceState,
      lastDraw: -1,
      listen: 0,
      voiceL: 0,
      rp: 0,
      micSm: 0,
      lvlSm: 0,
      scanOn: 0,
      sig: 0,
      hp: 0,
      hRate: 0.17,
      hBase: 0.3,
      hDepth: 0.08,
      hCol: new THREE.Color("#F5A524"),
    }),
    [],
  );

  useEffect(() => {
    screen.draw(sim.cur, -1);
    return () => {
      screen.dispose();
      screenGeo.dispose();
    };
  }, [screen, screenGeo, sim]);

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const t = state.clock.elapsedTime;
    const c = sim.ctx;
    const reduced = motion.reduced;
    c.reduced = reduced;
    c.px = state.pointer.x;
    c.py = state.pointer.y;
    if (!c.init) {
      c.init = true;
      c.nextBlink = t + 2.5;
      c.nextSquint = t + 12;
      c.gazeNext = t + 0.8;
    }

    // voice levels (mutable object, read only here)
    const store = useTwin.getState();
    const st = stateRef.current;
    const voice = store.voiceStatus === "live";
    const rawMic = voiceLevels.mic;
    sim.micSm = damp(sim.micSm, rawMic, rawMic > sim.micSm ? 25 : 5, dt);
    let lvl = voiceLevels.agent;
    if (st === "speaking" && lvl < 0.03) {
      // text mode: soft sine syllable pattern stands in for the voice
      lvl = Math.max(0, Math.sin(t * 9)) * 0.55 * (0.65 + 0.35 * Math.sin(t * 2.3));
    }
    sim.lvlSm = damp(sim.lvlSm, lvl, lvl > sim.lvlSm ? 30 : 9, dt);
    c.mic = reduced ? 0 : sim.micSm;
    c.lvl = reduced ? (st === "speaking" ? 0.2 : 0) : sim.lvlSm;
    c.flutter = reduced ? 0 : voiceLevels.agentBands[2] * Math.sin(t * 40);
    c.userSpeaking = store.userSpeaking;
    c.voice = voice;

    // state transitions
    if (st !== sim.prev) {
      if (st === "idle" && (sim.prev === "working" || sim.prev === "answering")) c.happyUntil = t + 1.4;
      if (st === "error") c.enteredAt = t;
      sim.prev = st;
    }
    const happy = st === "idle" && t < c.happyUntil;

    // goal = table row + behaviour layer, then damp every parameter
    cloneExpression(happy ? HAPPY : EXPRESSIONS[st], sim.goal);
    if (!happy) BEHAVIOURS[st](t, c, sim.goal);
    const cur = sim.cur;
    const goal = sim.goal;
    let sig = 0;
    for (let i = 0; i < PARAM_KEYS.length; i++) {
      const k = PARAM_KEYS[i] as keyof ExpressionTarget;
      cur[k] = damp(cur[k], goal[k], LAMBDA[k] ?? 10, dt);
      sig += cur[k] * (i + 1);
    }

    sim.scanOn = damp(sim.scanOn, st === "working" && !reduced ? 1 : 0, 6, dt);
    const scanning = sim.scanOn > 0.02;
    const scan = scanning ? (t * 0.45) % 1 : -1;

    // redraw: <= 30 fps, only when something changed
    if (t - sim.lastDraw >= 1 / 30 && (scanning || Math.abs(sig - sim.sig) > 0.002)) {
      screen.draw(cur, scan);
      sim.sig = sig;
      sim.lastDraw = t;
    }
    if (screenMat.current) {
      const b = cur.bright * 0.9;
      screenMat.current.color.setRGB(b, b, b);
    }

    // pod breathing + pointer tilt
    sim.voiceL = damp(sim.voiceL, st === "listening" && voice ? 1 : 0, 4, dt);
    root.current?.scale.setScalar(
      (reduced ? 1 : 1 + 0.015 * Math.sin((t * Math.PI * 2) / 6)) + sim.voiceL * (0.015 + c.mic * 0.035),
    );
    const tl = tilt.current;
    if (tl) {
      tl.rotation.y = damp(tl.rotation.y, reduced ? 0 : c.px * 0.14, 4, dt);
      tl.rotation.x = damp(tl.rotation.x, reduced ? 0 : -c.py * 0.1, 4, dt);
    }

    // the one living effect: energy halo (colour + pulse rate follow state)
    const look = HALO[st];
    const k = 1 - Math.exp(-5 * dt);
    sim.hCol.lerp(look.color, k);
    sim.hRate += (look.rate - sim.hRate) * k;
    sim.hBase += (look.base - sim.hBase) * k;
    sim.hDepth += (look.depth - sim.hDepth) * k;
    sim.hp += (reduced ? 0 : sim.hRate) * dt;
    const hs = haloSprite.current;
    if (hs) {
      const m = hs.material as THREE.SpriteMaterial;
      m.color.copy(sim.hCol);
      const kick = Math.exp(-Math.max(0, t - faceFx.kickAt) * 3.2);
      const sp = st === "speaking" ? c.lvl : 0;
      m.opacity = sim.hBase + sim.hDepth * Math.sin(sim.hp * Math.PI * 2) + 0.22 * kick + sim.voiceL * (0.1 + c.mic * 0.28) + sp * 0.3;
      hs.scale.setScalar(6.4 + 0.5 * kick + sim.voiceL * (0.3 + c.mic * 0.6) + sp * 0.7);
    }

    // listening: voice = rings gather inward toward the face; text mic = outward ripples
    sim.listen = damp(sim.listen, st === "listening" ? 1 : 0, 6, dt);
    sim.rp += (reduced ? 0 : dt / (1.9 - c.mic * 0.9));
    for (let i = 0; i < 3; i++) {
      const m = i === 0 ? ring0.current : i === 1 ? ring1.current : ring2.current;
      if (!m) continue;
      const mat = m.material as THREE.MeshBasicMaterial;
      if (sim.listen < 0.02 || (!voice && (i > 1 || reduced))) {
        m.visible = false;
        continue;
      }
      m.visible = true;
      if (voice) {
        if (reduced) {
          m.scale.setScalar(ORB_R * (1.2 + i * 0.22));
          mat.opacity = sim.listen * 0.12;
          mat.color.copy(CREAM);
        } else {
          const u = (((sim.rp + i / 3) % 1) + 1) % 1; // 0 = far, 1 = at the pod
          m.scale.setScalar(ORB_R * (1.95 - u * 0.85));
          mat.color.copy(CREAM).lerp(AMBER, u);
          mat.opacity = Math.sin(Math.PI * u) * (0.14 + c.mic * 0.55) * sim.listen;
        }
      } else {
        const u = (((t / RIPPLE_PERIOD + i * 0.5) % 1) + 1) % 1;
        m.scale.setScalar(ORB_R * (1.04 + u * 0.7));
        mat.color.set("#FACC15");
        mat.opacity = (1 - u) * (1 - u) * 0.4 * sim.listen;
      }
    }
  });

  return (
    <group ref={root}>
      {/* halo: one additive radial sprite behind the pod */}
      <sprite ref={haloSprite} scale={[6.4, 6.4, 1]} position={[0, 0, -1.7]} renderOrder={-1}>
        <spriteMaterial map={glow} color="#F5A524" transparent opacity={0.3} depthWrite={false} blending={THREE.AdditiveBlending} />
      </sprite>

      <group ref={tilt}>
        {/* matte graphite-ceramic pod */}
        <mesh>
          <sphereGeometry args={[ORB_R, 96, 64]} />
          <meshStandardMaterial color="#403a33" roughness={0.55} metalness={0.05} envMapIntensity={0.45} />
        </mesh>
        {/* face screen, curved onto the pod */}
        <mesh geometry={screenGeo} renderOrder={1}>
          <meshBasicMaterial
            ref={screenMat}
            map={screen.texture}
            transparent
            depthWrite={false}
            toneMapped={false}
            polygonOffset
            polygonOffsetFactor={-2}
            polygonOffsetUnits={-2}
          />
        </mesh>
      </group>

      {/* listening ripples */}
      {[ring0, ring1, ring2].map((r, i) => (
        <mesh key={i} ref={r} visible={false} position={[0, 0, -0.2]} renderOrder={0}>
          <ringGeometry args={[0.985, 1, 128]} />
          <meshBasicMaterial color="#FACC15" transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} />
        </mesh>
      ))}
    </group>
  );
}
