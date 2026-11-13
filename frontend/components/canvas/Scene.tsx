"use client";

import { Suspense, useEffect } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Environment, Lightformer } from "@react-three/drei";
import * as THREE from "three";
import { TOOLS } from "@/lib/nodes";
import { useTwin } from "@/store/twin";
import { Face } from "./Face";
import { Pulses } from "./Pulses";
import { ToolNode } from "./ToolNode";
import { damp, disposeGlowTexture, motion } from "./physics";

/**
 * Decorative 3D canvas. The canvas element itself is aria-hidden; the
 * node pop-up (HTML overlay) is the accessible part. Shown only in Run My Day.
 * Parent must be a relatively positioned container with a fixed size.
 */

/** Marks the canvas aria-hidden and keeps all nodes in view on narrow viewports. */
function Rig() {
  const gl = useThree((s) => s.gl);

  useEffect(() => {
    gl.domElement.setAttribute("aria-hidden", "true");
  }, [gl]);

  useFrame((state, delta) => {
    const { camera, size } = state;
    const cam = camera as THREE.PerspectiveCamera;
    const aspect = size.width / Math.max(size.height, 1);
    const halfH = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    // composition extents: x +-5.1 (tiles + margin), y +-4.05 (tiles + labels)
    const needZ = Math.max(8, 5.1 / (halfH * aspect), 4.05 / halfH);
    cam.position.z = damp(cam.position.z, needZ, 4, Math.min(delta, 0.05));
  }, -1);

  return null;
}

export default function Scene() {
  useEffect(
    () => () => {
      useTwin.getState().select(null);
      disposeGlowTexture();
    },
    [],
  );

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      motion.reduced = mq.matches;
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && useTwin.getState().selected) useTwin.getState().select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <Canvas
      className="!absolute inset-0"
      dpr={[1, 1.75]}
      frameloop="always"
      camera={{ position: [0, 0, 10], fov: 45, near: 0.1, far: 60 }}
      gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      onCreated={({ gl }) => gl.setClearColor(0x000000, 0)}
      onPointerMissed={(e) => {
        const target = e.target as HTMLElement | null;
        if (target?.closest?.("[data-twin-card]")) return;
        if (useTwin.getState().selected) useTwin.getState().select(null);
      }}
    >
      <Rig />

      <ambientLight intensity={0.45} color="#d9c8b0" />
      <directionalLight position={[-4, 5, 6]} intensity={2.2} color="#ffe4bd" />
      <directionalLight position={[5, -3, 4]} intensity={0.3} color="#F5A524" />
      {/* offline warm lightformers, rendered once */}
      <Environment resolution={128} frames={1}>
        <Lightformer form="rect" intensity={1.8} position={[-4, 5, 3]} scale={[8, 3, 1]} color="#fff1dc" />
        <Lightformer form="rect" intensity={1.2} position={[0, 1, 6]} scale={[10, 4, 1]} color="#fff8ee" />
        <Lightformer form="rect" intensity={0.6} position={[5, -4, 2]} rotation-y={-0.5} scale={[6, 3, 1]} color="#F5A524" />
      </Environment>

      <Face />
      <Suspense fallback={null}>
        {TOOLS.map((t) => (
          <ToolNode key={t.id} def={t} />
        ))}
      </Suspense>
      <Pulses />
    </Canvas>
  );
}
