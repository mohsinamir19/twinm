"use client";

import { useEffect, useRef, type RefObject } from "react";

/**
 * requestAnimationFrame loop that only runs while `ref` is on screen and the document is
 * visible. `frame` receives dt in seconds (clamped to 100ms) and may change every render.
 */
export function useVisibleLoop(
  ref: RefObject<Element | null>,
  frame: (dt: number) => void,
  opts: { fpsCap?: number; enabled?: boolean } = {},
) {
  const frameRef = useRef(frame);
  const { fpsCap, enabled = true } = opts;

  useEffect(() => {
    frameRef.current = frame;
  });

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    let onScreen = true;
    let raf = 0;
    let last = 0;
    const minDt = fpsCap ? 1000 / fpsCap : 0;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (!last) last = now;
      const elapsed = now - last;
      if (elapsed < minDt) return;
      last = now;
      frameRef.current(Math.min(elapsed / 1000, 0.1));
    };
    const sync = () => {
      const run = onScreen && !document.hidden;
      if (run && !raf) {
        last = 0;
        raf = requestAnimationFrame(tick);
      } else if (!run && raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };

    const io = new IntersectionObserver((entries) => {
      onScreen = entries[entries.length - 1]?.isIntersecting ?? true;
      sync();
    });
    io.observe(el);
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", sync);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [ref, fpsCap, enabled]);
}
