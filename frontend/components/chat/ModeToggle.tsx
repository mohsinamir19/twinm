"use client";

import clsx from "clsx";
import { useTwin } from "@/store/twin";
import type { Mode } from "@/lib/api";

const MODES: { id: Mode; label: string }[] = [
  { id: "visitor", label: "AI Twin" },
  { id: "owner", label: "Chief of Staff" },
];

export default function ModeToggle({ className }: { className?: string }) {
  const mode = useTwin((s) => s.mode);
  const busy = useTwin((s) => s.busy);
  const setMode = useTwin((s) => s.setMode);

  return (
    <div role="tablist" aria-label="Mode" className={clsx("flex gap-5", className)}>
      {MODES.map((m) => {
        const on = mode === m.id;
        return (
          <button
            key={m.id}
            role="tab"
            aria-selected={on}
            disabled={busy}
            onClick={() => !on && setMode(m.id)}
            className={clsx(
              "relative py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed",
              on ? "text-stone-50" : "text-stone-400 hover:text-stone-200",
            )}
          >
            {m.label}
            <span
              className={clsx(
                "absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-amber-400 transition-opacity duration-300",
                on ? "opacity-100" : "opacity-0",
              )}
            />
          </button>
        );
      })}
    </div>
  );
}
