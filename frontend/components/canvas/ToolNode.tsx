"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Html, RoundedBox, useCursor, useTexture } from "@react-three/drei";
import * as THREE from "three";
import type { ToolNodeDef } from "@/lib/nodes";
import { useTwin } from "@/store/twin";
import { NodeCard, CARD_W, iconUrl } from "./NodeCard";
import { breathe, createBody, damp, energyColor, fxOf, getGlowTexture, motion, stepBody } from "./physics";

const SIZE = 1.2;
const DEPTH = 0.26;
const HALF = SIZE / 2;
const ICON = SIZE * 0.68;

const AMBER = new THREE.Color("#F5A524");
const ENERGY = new THREE.Color();
const PORCELAIN = new THREE.Color("#efe9df");
const PORCELAIN_DIM = new THREE.Color("#857f76");
const EMISSIVE = new THREE.Color("#c9b99f");
const EMISSIVE_DIM = new THREE.Color("#403a33");

const MARGIN = 12;
const CARD_H = 320;
const MAX_TILT = THREE.MathUtils.degToRad(8);

function roundedRectPath(p: THREE.Path, w: number, h: number, r: number) {
  const x = -w / 2;
  const y = -h / 2;
  p.moveTo(x + r, y);
  p.lineTo(x + w - r, y);
  p.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
  p.lineTo(x + w, y + h - r);
  p.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false);
  p.lineTo(x + r, y + h);
  p.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false);
  p.lineTo(x, y + r);
  p.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
}

/** Rounded-rect outline of the given thickness; offset pushes it outward from the tile. */
function outline(offset: number, thick: number) {
  const outer = new THREE.Shape();
  roundedRectPath(outer, SIZE + 2 * (offset + thick), SIZE + 2 * (offset + thick), 0.28 + offset + thick);
  const hole = new THREE.Path();
  roundedRectPath(hole, SIZE + 2 * offset, SIZE + 2 * offset, 0.28 + offset);
  outer.holes.push(hole);
  return new THREE.ShapeGeometry(outer, 8);
}

/** Thin crisp core line plus two faint wider bands: a cheap soft glow falloff. */
const RING_LAYERS = [
  { offset: 0.05, thick: 0.014, k: 0.85 },
  { offset: 0.04, thick: 0.05, k: 0.18 },
  { offset: 0.03, thick: 0.11, k: 0.07 },
];
function createRingGeometries() {
  return RING_LAYERS.map((l) => outline(l.offset, l.thick));
}

/** Desaturated copy of an icon for nodes that are not connected. */
function grayscaleTexture(src: THREE.Texture): THREE.Texture {
  const img = src.image as CanvasImageSource & { width: number; height: number };
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext("2d")!;
  g.filter = "grayscale(1) contrast(0.9)";
  g.drawImage(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function ToolNode({ def }: { def: ToolNodeDef }) {
  const group = useRef<THREE.Group>(null);
  const tiltGroup = useRef<THREE.Group>(null);
  const tileMat = useRef<THREE.MeshPhysicalMaterial>(null);
  const glowMat = useRef<THREE.SpriteMaterial>(null);
  const ringGroup = useRef<THREE.Group>(null);
  const ringMats = useRef<(THREE.MeshBasicMaterial | null)[]>([]);
  const cardPos = useRef<HTMLDivElement>(null);
  const hoverRef = useRef(false);
  const mix = useRef({ m: 0, s: 1, rx: 0, ry: 0, lx: 1e9, ly: 1e9 });
  const [hovered, setHovered] = useState(false);
  const selected = useTwin((s) => s.selected === def.id);
  const selectedRef = useRef(selected);
  useCursor(hovered);

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  const base = useTexture(iconUrl(def));
  const iconTex = useMemo(() => (def.connected ? base : grayscaleTexture(base)), [def.connected, base]);
  useEffect(() => {
    base.colorSpace = THREE.SRGBColorSpace;
    base.anisotropy = 8;
    base.generateMipmaps = true;
    base.minFilter = THREE.LinearMipmapLinearFilter;
    base.needsUpdate = true;
    return () => {
      if (iconTex !== base) iconTex.dispose();
      base.dispose();
    };
  }, [base, iconTex]);

  const body = useMemo(() => createBody(def.id, def.position, def.seed), [def]);
  const glowMap = useMemo(() => getGlowTexture(), []);
  const ringGeos = useMemo(() => createRingGeometries(), []);
  useEffect(() => () => ringGeos.forEach((g) => g.dispose()), [ringGeos]);

  // pop-up opens toward the screen edge, away from the face
  const side: 1 | -1 = def.position[0] > 0 ? 1 : -1;
  const ndc = useMemo(() => new THREE.Vector3(), []);
  const dim = def.connected ? 1 : 0.55;

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const t = state.clock.elapsedTime;
        stepBody(body, t);
    group.current?.position.copy(body.pos);

    const st = mix.current;
    const fx = fxOf(def.id);
    st.m = damp(st.m, def.connected ? fx.energy : 0, 6, dt);
    st.s = damp(st.s, hoverRef.current ? 1.1 : 1, 8, dt);

    // tilt toward the cursor (max 8deg), damped
    const cam = state.camera as THREE.PerspectiveCamera;
    const halfH = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * cam.position.z;
    const halfW = halfH * (state.size.width / Math.max(state.size.height, 1));
    const dx = THREE.MathUtils.clamp((state.pointer.x * halfW - body.pos.x) / 4, -1, 1);
    const dy = THREE.MathUtils.clamp((state.pointer.y * halfH - body.pos.y) / 4, -1, 1);
    const k = motion.reduced ? 0 : 1;
    st.ry = damp(st.ry, dx * MAX_TILT * k, 6, dt);
    st.rx = damp(st.rx, -dy * MAX_TILT * k, 6, dt);
    const tg = tiltGroup.current;
    if (tg) {
      tg.rotation.set(st.rx, st.ry, 0);
      tg.scale.setScalar(st.s * breathe(body, t));
    }

    const pulse = motion.reduced ? 0.5 : 0.5 + 0.5 * Math.sin(t * 2.2);
    const mat = tileMat.current;
    if (mat) {
      mat.color.copy(def.connected ? PORCELAIN : PORCELAIN_DIM);
      energyColor(t * 0.25, ENERGY);
      mat.emissive.copy(def.connected ? EMISSIVE : EMISSIVE_DIM).lerp(ENERGY, st.m * 0.6);
      mat.emissiveIntensity = (def.connected ? 0.2 : 0.1) + st.m * (0.1 + 0.1 * pulse) + (hoverRef.current ? 0.05 : 0);
    }
    if (glowMat.current) {
      glowMat.current.color.copy(AMBER).lerp(ENERGY, st.m);
      glowMat.current.opacity = (def.connected ? 0.13 : 0.05) + st.m * 0.1 + (hoverRef.current ? 0.05 : 0);
    }
    if (ringGroup.current) {
      ringGroup.current.visible = st.m > 0.01;
      for (let i = 0; i < RING_LAYERS.length; i++) {
        const rm = ringMats.current[i];
        if (rm) {
          energyColor(t * 0.35 + i * 0.08, rm.color);
          rm.opacity = st.m * RING_LAYERS[i].k * (0.7 + 0.3 * pulse);
        }
      }
    }

    // pop-up placement (only while open): beside the node, clamped into the canvas
    const el = cardPos.current;
    if (el && selectedRef.current) {
      ndc.copy(body.pos).project(cam);
      const sx = (ndc.x * 0.5 + 0.5) * state.size.width;
      const sy = (-ndc.y * 0.5 + 0.5) * state.size.height;
      const dist = Math.max(0.1, cam.position.z - body.pos.z);
      const ppu = state.size.height / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * dist);
      const gap = HALF * 1.3 * ppu + 12;
      // Prefer the outer side; flip toward the face when the edge leaves no room.
      let left = side > 0 ? sx + gap : sx - gap - CARD_W;
      if (left < MARGIN || left + CARD_W > state.size.width - MARGIN) {
        left = side > 0 ? sx - gap - CARD_W : sx + gap;
      }
      left = Math.min(Math.max(left, MARGIN), Math.max(MARGIN, state.size.width - CARD_W - MARGIN));
      const h = Math.min(CARD_H, state.size.height - MARGIN * 2);
      const top = Math.min(Math.max(sy - h / 2, MARGIN), Math.max(MARGIN, state.size.height - h - MARGIN));
      const ox = Math.round((left - sx) * 2) / 2;
      const oy = Math.round((top - sy) * 2) / 2;
      if (ox !== st.lx || oy !== st.ly) {
        st.lx = ox;
        st.ly = oy;
        el.style.transform = `translate3d(${ox}px, ${oy}px, 0)`;
      }
    }
  });

  return (
    <group ref={group} position={def.position}>
      {/* soft contact glow behind the tile */}
      <sprite scale={[SIZE * 2.3, SIZE * 2.3, 1]} position={[0, -0.06, -0.45]} renderOrder={0}>
        <spriteMaterial
          ref={glowMat}
          map={glowMap}
          color="#F5A524"
          transparent
          opacity={0.2}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </sprite>

      <group ref={tiltGroup}>
        <RoundedBox args={[SIZE, SIZE, DEPTH]} radius={0.28} smoothness={4} creaseAngle={0.4}>
          <meshPhysicalMaterial
            ref={tileMat}
            color={PORCELAIN}
            roughness={0.28}
            metalness={0}
            clearcoat={1}
            clearcoatRoughness={0.08}
            emissive={EMISSIVE}
            emissiveIntensity={0.2}
            envMapIntensity={1.1}
          />
        </RoundedBox>

        {/* icon just in front of the face */}
        <mesh position={[0, 0, DEPTH / 2 + 0.004]} renderOrder={2}>
          <planeGeometry args={[ICON, ICON]} />
          <meshBasicMaterial map={iconTex} transparent toneMapped={false} depthWrite={false} opacity={dim} color={def.connected ? "#ffffff" : "#b8bec7"} />
        </mesh>

        {/* active halo ring */}
        <group ref={ringGroup} visible={false} position={[0, 0, -0.02]}>
          {ringGeos.map((g, i) => (
            <mesh key={i} geometry={g} renderOrder={1}>
              <meshBasicMaterial
                ref={(m) => {
                  ringMats.current[i] = m;
                }}
                color="#F5A524"
                transparent
                opacity={0}
                depthWrite={false}
                blending={THREE.AdditiveBlending}
              />
            </mesh>
          ))}
        </group>

        {/* invisible, larger hit target (~1.3x) */}
        <mesh
          onClick={(e) => {
            e.stopPropagation();
            const s = useTwin.getState();
            s.select(s.selected === def.id ? null : def.id);
          }}
          onPointerOver={(e) => {
            e.stopPropagation();
            hoverRef.current = true;
            setHovered(true);
          }}
          onPointerOut={() => {
            hoverRef.current = false;
            setHovered(false);
          }}
        >
          <boxGeometry args={[SIZE * 1.3, SIZE * 1.3, DEPTH * 2]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} />
        </mesh>
      </group>

      <Html center position={[0, def.id === "memory" ? HALF + 0.42 : -(HALF + 0.42), 0]} pointerEvents="none" zIndexRange={[10, 0]} style={{ pointerEvents: "none" }}>
        <div className="pointer-events-none select-none whitespace-nowrap rounded-full border border-white/10 bg-stone-800/60 px-3 py-1 text-xs font-medium text-stone-100 backdrop-blur-md">
          {def.label}
        </div>
      </Html>

      <Html position={[0, 0, 0]} zIndexRange={[30, 20]} style={{ pointerEvents: "none" }}>
        <div ref={cardPos} className="absolute left-0 top-0" style={{ willChange: "transform" }}>
          <NodeCard def={def} open={selected} side={side} onClose={() => useTwin.getState().select(null)} />
        </div>
      </Html>
    </group>
  );
}
