"use client";

import dynamic from "next/dynamic";
import { AnimatePresence, motion } from "framer-motion";
import ChatPanel from "@/components/chat/ChatPanel";
import { useTwin } from "@/store/twin";
import { useVoiceLifecycle } from "@/lib/voice/useVoice";

// The WebGL scene is client-only and heavy: keep it out of the initial bundle.
const Scene = dynamic(() => import("@/components/canvas/Scene"), { ssr: false });

const ease = [0.16, 1, 0.3, 1] as const;

export default function CommandCenter() {
  const runMyDay = useTwin((s) => s.mode === "owner");
  useVoiceLifecycle();

  return (
    <main className="relative h-dvh w-full overflow-hidden">
      {/* "Run My Day" only: the 3D canvas is mounted here and nowhere else. */}
      <AnimatePresence>
        {runMyDay && (
          <motion.div
            key="canvas"
            aria-hidden="true"
            initial={{ opacity: 0, filter: "blur(8px)" }}
            animate={{ opacity: 1, filter: "blur(0px)" }}
            exit={{ opacity: 0, transition: { duration: 0.15 } }}
            transition={{ duration: 0.7, ease }}
            className="absolute inset-x-0 top-0 h-[42dvh] md:inset-y-0 md:left-[30%] md:right-0 md:h-auto"
          >
            <Scene />
          </motion.div>
        )}
      </AnimatePresence>

      <section
        aria-label="Chat with your twin"
        className={
          runMyDay
            ? "absolute inset-x-3 bottom-3 top-[40dvh] md:inset-y-4 md:left-4 md:right-auto md:top-4 md:w-[calc(30%-1.5rem)] md:min-w-[22rem]"
            : "absolute inset-0"
        }
      >
        <ChatPanel variant={runMyDay ? "dock" : "full"} />
      </section>
    </main>
  );
}
