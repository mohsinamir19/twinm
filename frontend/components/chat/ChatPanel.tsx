"use client";

import { useRef, useState } from "react";
import { ArrowUp, RotateCcw } from "lucide-react";
import clsx from "clsx";
import { motion } from "framer-motion";
import { selectFaceState, useTwin } from "@/store/twin";
import { HandoffBeam, type BeamPhase } from "@/components/ui/handoff-beam";
import { voiceLevels } from "@/lib/voice/levels";
import { useChat } from "@/lib/useChat";
import FaceBadge, { FACE_LABEL } from "./FaceBadge";
import MessageList from "./MessageList";
import MicButton from "./MicButton";
import ModeToggle from "./ModeToggle";

/** Read every frame by the beam: the agent's bands while it speaks, the mic's otherwise. */
const beamLevel = (): [number, number, number] => {
  const s = useTwin.getState();
  return s.voiceStatus === "live" && s.agentState === "speaking" ? voiceLevels.agentBands : voiceLevels.micBands;
};

export default function ChatPanel({ variant }: { variant: "full" | "dock" }) {
  const full = variant === "full";
  const send = useChat();
  const mode = useTwin((s) => s.mode);
  const busy = useTwin((s) => s.busy);
  const reset = useTwin((s) => s.reset);
  const hasMessages = useTwin((s) => s.messages.length > 0);
  const voiceStatus = useTwin((s) => s.voiceStatus);
  const agentState = useTwin((s) => s.agentState);
  const caption = useTwin((s) => s.caption);
  const voiceError = useTwin((s) => s.voiceError);
  const face = useTwin(selectFaceState);

  const [draft, setDraft] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);

  const beamPhase: BeamPhase =
    voiceStatus === "live"
      ? agentState === "speaking"
        ? "speaking"
        : agentState === "thinking"
          ? "thinking"
          : "listening"
      : busy
        ? "thinking"
        : "idle";

  const submit = (text = draft) => {
    if (!text.trim() || busy) return;
    setDraft("");
    void send(text.trim());
    input.current?.focus();
  };

  const brand = (
    <div className="flex items-center gap-3">
      <FaceBadge />
      <div className="leading-tight">
        <h1 className="text-[0.95rem] font-semibold tracking-tight text-stone-50">Twin</h1>
        <p className="font-mono text-[0.6875rem] text-stone-400" aria-live="polite">
          {FACE_LABEL[face]}
        </p>
      </div>
    </div>
  );

  const resetButton = (
    <button
      onClick={reset}
      disabled={!hasMessages}
      aria-label="Start a new conversation"
      title="New conversation"
      className="grid size-8 place-items-center rounded-lg text-stone-400 transition-colors hover:bg-white/10 hover:text-stone-100 disabled:pointer-events-none disabled:opacity-0"
    >
      <RotateCcw className="size-4" strokeWidth={1.75} />
    </button>
  );

  return (
    <motion.div
      key={variant}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      className={clsx("flex h-full flex-col", !full && "glass overflow-hidden")}
    >
      {full ? (
        <header className="flex items-end justify-between border-b border-white/10 px-5 pb-0 pt-4 md:px-8">
          <div className="pb-3">{brand}</div>
          <ModeToggle />
          <div className="pb-2">{resetButton}</div>
        </header>
      ) : (
        <header className="border-b border-white/10 px-4 pt-4">
          <div className="flex items-center justify-between pb-3">
            {brand}
            {resetButton}
          </div>
          <ModeToggle />
        </header>
      )}

      <div className={clsx("flex min-h-0 flex-1 flex-col", full && "mx-auto w-full max-w-[46rem] px-5 md:px-6")}>
        <MessageList onPick={submit} full={full} />

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className={clsx(full ? "pb-5 pt-2" : "p-3")}
        >
          {caption && (
            <p className="mb-1.5 truncate px-2 text-sm italic text-stone-400" aria-live="polite">
              {caption}
            </p>
          )}
          {voiceError && (
            <p role="alert" className="mb-1.5 px-2 text-[0.8125rem] text-rose-300">
              {voiceError}
            </p>
          )}
          <HandoffBeam
            phase={beamPhase}
            level={beamLevel}
            palette="ember"
            radius={20}
            className="border border-white/12 bg-stone-950/40 transition-colors focus-within:border-amber-300/60"
          >
          <div className="flex items-end gap-1 p-1.5">
            <label htmlFor="chat-input" className="sr-only">
              Message your twin
            </label>
            <textarea
              id="chat-input"
              ref={input}
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              maxLength={4000}
              placeholder={mode === "owner" ? "Tell your twin what to do" : "Ask your twin"}
              className="max-h-36 min-h-9 flex-1 resize-none bg-transparent px-2.5 py-2 text-[0.9375rem] text-stone-50 outline-none placeholder:text-stone-400 [field-sizing:content]"
            />
            <MicButton />
            <button
              type="submit"
              disabled={!draft.trim() || busy}
              aria-label="Send message"
              className="grid size-9 shrink-0 place-items-center rounded-lg bg-amber-400 text-stone-900 transition-[background-color,transform] hover:bg-amber-300 active:scale-95 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-stone-500"
            >
              <ArrowUp className="size-[1.1rem]" strokeWidth={2.25} />
            </button>
          </div>
          </HandoffBeam>
          {full && (
            <p className="mt-2 px-1 font-mono text-[0.6875rem] text-stone-500">
              Enter to send · Shift+Enter for a new line
            </p>
          )}
        </form>
      </div>
    </motion.div>
  );
}
