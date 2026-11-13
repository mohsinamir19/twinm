"use client";

import { motion } from "framer-motion";
import { selectFaceState, useTwin, type FaceState } from "@/store/twin";

export const FACE_LABEL: Record<FaceState, string> = {
  idle: "Ready",
  listening: "Listening",
  thinking: "Thinking",
  working: "Using tools",
  answering: "Replying",
  speaking: "Speaking",
  error: "Something broke",
};

type Eye = { w: number; h: number; r: number; y?: number; rot?: number; arc?: number };
/** Same vocabulary as the 3D face, drawn as 8-unit-wide glyphs inside a 44×28 screen. */
const EYES: Record<FaceState, { l: Eye; r: Eye; gap: number }> = {
  idle: { l: { w: 3, h: 10, r: 1.5 }, r: { w: 3, h: 10, r: 1.5 }, gap: 11 },
  listening: { l: { w: 3, h: 12, r: 1.5, y: 1 }, r: { w: 3, h: 12, r: 1.5, y: 1 }, gap: 13 },
  thinking: { l: { w: 7, h: 2.4, r: 1.2, y: -2, rot: -18 }, r: { w: 6, h: 6, r: 1.6, y: 1 }, gap: 12 },
  working: { l: { w: 6, h: 6, r: 1.6 }, r: { w: 6, h: 6, r: 1.6 }, gap: 12 },
  answering: { l: { w: 7, h: 4, r: 2, arc: 1 }, r: { w: 7, h: 4, r: 2, arc: 1 }, gap: 12 },
  speaking: { l: { w: 4, h: 8, r: 2 }, r: { w: 4, h: 8, r: 2 }, gap: 11 },
  error: { l: { w: 7, h: 7, r: 1, rot: 45 }, r: { w: 7, h: 7, r: 1, rot: 45 }, gap: 12 },
};

function EyeShape({ e, cx, state, side }: { e: Eye; cx: number; state: FaceState; side: "l" | "r" }) {
  const cy = 14 + (e.y ?? 0);
  if (e.arc) {
    // ‿ smile stroke
    return (
      <motion.path
        d={`M ${cx - e.w / 2} ${cy - 1} Q ${cx} ${cy + 3.5} ${cx + e.w / 2} ${cy - 1}`}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        initial={false}
        animate={{ opacity: 1 }}
      />
    );
  }
  if (state === "error") {
    const s = e.w / 2;
    return (
      <g stroke="currentColor" strokeWidth={2} strokeLinecap="round">
        <line x1={cx - s} y1={cy - s} x2={cx + s} y2={cy + s} />
        <line x1={cx - s} y1={cy + s} x2={cx + s} y2={cy - s} />
      </g>
    );
  }
  const speaking = state === "speaking";
  return (
    <motion.rect
      initial={false}
      animate={
        speaking
          ? { x: cx - e.w / 2, y: [cy - 4, cy - 2, cy - 4], width: e.w, height: [8, 4, 8], rx: e.r }
          : { x: cx - e.w / 2, y: cy - e.h / 2, width: e.w, height: e.h, rx: e.r, rotate: e.rot ?? 0 }
      }
      transition={
        speaking
          ? { duration: 0.5, repeat: Infinity, delay: side === "l" ? 0 : 0.18 }
          : { duration: 0.35, ease: [0.16, 1, 0.3, 1] }
      }
      style={{ transformBox: "fill-box", transformOrigin: "center" }}
      fill="currentColor"
    />
  );
}

/** A tiny dot-matrix screen that mirrors the 3D face, so the twin has a face in every mode. */
export default function FaceBadge({ className }: { className?: string }) {
  const state = useTwin(selectFaceState);
  const cfg = EYES[state];
  const live = useTwin((s) => s.voiceStatus === "live");
  const tint =
    state === "working" ? "from-emerald-400/80 to-yellow-300/70"
    : state === "error" ? "from-rose-400/70 to-orange-300/50"
    : "from-amber-300/80 to-orange-400/70";

  return (
    <div
      role="img"
      aria-label={`Twin status: ${FACE_LABEL[state]}`}
      className={
        "relative grid h-7 w-11 shrink-0 place-items-center overflow-hidden rounded-lg bg-gradient-to-br text-amber-50 " +
        tint +
        " " +
        (className ?? "")
      }
    >
      {/* halftone dots, the orb's signature texture */}
      <span
        aria-hidden
        className="absolute inset-0 opacity-50 [background-image:radial-gradient(rgb(23_21_18/0.55)_0.9px,transparent_1.1px)] [background-size:3px_3px]"
      />
      {live && state === "listening" && (
        <span aria-hidden className="absolute bottom-0.5 right-0.5 grid size-1.5 place-items-center">
          <span className="absolute inset-0 rounded-full bg-amber-50/80 motion-safe:animate-ping [animation-duration:1.8s]" />
          <span className="relative size-1 rounded-full bg-amber-50" />
        </span>
      )}
      <svg viewBox="0 0 44 28" className="relative size-full drop-shadow-[0_0_3px_rgba(255,250,240,0.9)]">
        <EyeShape e={cfg.l} cx={22 - cfg.gap / 2} state={state} side="l" />
        <EyeShape e={cfg.r} cx={22 + cfg.gap / 2} state={state} side="r" />
      </svg>
    </div>
  );
}
