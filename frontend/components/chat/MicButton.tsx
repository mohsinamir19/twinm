"use client";

import { useEffect, useRef } from "react";
import { Loader2, Mic, MicOff } from "lucide-react";
import clsx from "clsx";
import { useReducedMotion } from "framer-motion";
import { voiceLevels } from "@/lib/voice/levels";
import { useVoice } from "@/lib/voice/useVoice";

/** Three bars driven by the mic bands through CSS variables: no React render per frame. */
function LevelBars({ active }: { active: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduced = useReducedMotion();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!active || reduced) {
      for (let i = 0; i < 3; i++) el.style.setProperty(`--b${i}`, active ? "0.55" : "0.25");
      return;
    }
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const b = voiceLevels.micBands;
      el.style.setProperty("--b0", String(0.22 + b[0] * 0.78));
      el.style.setProperty("--b1", String(0.22 + b[1] * 0.78));
      el.style.setProperty("--b2", String(0.22 + b[2] * 0.78));
      el.style.setProperty("--ring", String(voiceLevels.mic));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, reduced]);
  return (
    <span ref={ref} aria-hidden className="relative flex h-[1.1rem] items-center gap-[3px]">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-full w-[3px] origin-center rounded-full bg-current"
          style={{ transform: `scaleY(var(--b${i}, 0.3))` }}
        />
      ))}
    </span>
  );
}

/** Start/stop the voice session, plus a mute control while live. */
export default function MicButton() {
  const v = useVoice();
  const connecting = v.status === "connecting";
  const live = v.status === "live";
  const errored = v.status === "error" || (v.status === "off" && !!v.error);
  const label = connecting
    ? "Connecting voice"
    : live
      ? "End voice session"
      : errored
        ? `Voice unavailable: ${v.error}. Tap to retry`
        : "Start voice";

  return (
    <>
      {live && (
        <button
          type="button"
          onClick={v.toggleMute}
          aria-pressed={v.muted}
          aria-label={v.muted ? "Unmute microphone" : "Mute microphone"}
          title={v.muted ? "Unmute" : "Mute"}
          className={clsx(
            "grid size-9 shrink-0 place-items-center rounded-lg transition-colors",
            v.muted ? "bg-rose-400/15 text-rose-300" : "text-stone-400 hover:bg-white/10 hover:text-stone-100",
          )}
        >
          {v.muted ? <MicOff className="size-[1.1rem]" strokeWidth={1.9} /> : <Mic className="size-[1.1rem]" strokeWidth={1.9} />}
        </button>
      )}
      <button
        type="button"
        onClick={v.toggle}
        disabled={connecting}
        aria-pressed={live}
        aria-label={label}
        title={errored ? v.error : label}
        className={clsx(
          "relative grid size-9 shrink-0 place-items-center rounded-lg transition-colors disabled:cursor-wait",
          live && "bg-orange-500/15 text-orange-300",
          connecting && "text-stone-300",
          errored && "text-rose-300 hover:bg-rose-400/10",
          !live && !connecting && !errored && "text-stone-400 hover:bg-white/10 hover:text-stone-100",
        )}
      >
        {connecting ? (
          <Loader2 className="size-[1.1rem] animate-spin" strokeWidth={1.9} />
        ) : live ? (
          <LevelBars active={!v.muted} />
        ) : errored ? (
          <MicOff className="size-[1.1rem]" strokeWidth={1.9} />
        ) : (
          <Mic className="size-[1.1rem]" strokeWidth={1.9} />
        )}
      </button>
    </>
  );
}
