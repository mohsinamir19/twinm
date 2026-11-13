"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUpRight } from "lucide-react";
import clsx from "clsx";
import { useTwin } from "@/store/twin";
import StreamedMarkdown from "./StreamedMarkdown";

const TRY = {
  visitor: ["What are you working on right now?", "Give me the short version of your background."],
  owner: ["Block two hours tomorrow morning for deep work.", "Add a task: send the proposal to Sam."],
} as const;

const time = (at?: number) =>
  at ? new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Still up?" : h < 12 ? "Good morning." : h < 18 ? "Good afternoon." : "Good evening.";
}

export default function MessageList({ onPick, full }: { onPick: (text: string) => void; full: boolean }) {
  const messages = useTwin((s) => s.messages);
  const busy = useTwin((s) => s.busy);
  const mode = useTwin((s) => s.mode);
  const patch = useTwin((s) => s.patchMessage);

  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [hello, setHello] = useState("Hello.");
  useEffect(() => {
    const id = requestAnimationFrame(() => setHello(greeting()));
    return () => cancelAnimationFrame(id);
  }, []);

  // Follow new content only while the reader is already near the bottom.
  useEffect(() => {
    const el = scroller.current;
    const content = inner.current;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTo({ top: el.scrollHeight });
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  const lastIsUser = messages[messages.length - 1]?.role === "user";

  return (
    <div
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      className={clsx("scroll-soft min-h-0 flex-1 overflow-y-auto", full ? "py-8" : "px-4 py-4")}
      role="log"
      aria-live="polite"
      aria-label="Conversation"
    >
      <div ref={inner} className="flex flex-col gap-6">
        {messages.length === 0 && (
          <div className={full ? "pt-[10vh]" : "pt-1"}>
            <h2
              className={clsx(
                "font-serif tracking-tight text-stone-50 text-balance",
                full ? "text-5xl leading-[1.05] md:text-6xl" : "text-3xl leading-tight",
              )}
            >
              {mode === "owner" ? (
                <>
                  What needs <em className="text-amber-200">doing</em> today?
                </>
              ) : (
                hello
              )}
            </h2>
            <p className={clsx("mt-3 max-w-[44ch] text-stone-300 text-pretty", full ? "text-base" : "text-sm")}>
              {mode === "owner"
                ? "I handle your calendar, tasks and notes, and ping your phone when it's done."
                : "Ask about my work, background and how I think. I answer from what I know."}
            </p>
            <ul className="mt-8 divide-y divide-white/10 border-y border-white/10">
              {TRY[mode].map((q) => (
                <li key={q}>
                  <button
                    onClick={() => onPick(q)}
                    className="group flex w-full items-center justify-between gap-4 py-3 text-left text-[0.9375rem] text-stone-200 transition-colors hover:text-white"
                  >
                    <span>{q}</span>
                    <ArrowUpRight className="size-4 shrink-0 text-stone-500 transition-[transform,color] group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-amber-300" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <AnimatePresence initial={false}>
          {messages.map((m) => (
            <motion.article
              key={m.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            >
              <header className="mb-1.5 flex items-baseline gap-2 font-mono text-[0.6875rem] tracking-wide text-stone-400">
                <span className={m.role === "user" ? "text-stone-300" : "text-amber-300"}>
                  {m.role === "user" ? "You" : "Twin"}
                </span>
                <time className="tabular-nums">{time(m.at)}</time>
              </header>
              {m.role === "user" ? (
                <p className="max-w-[70ch] whitespace-pre-wrap break-words text-[0.9375rem] leading-relaxed text-stone-300">
                  {m.content}
                </p>
              ) : m.error ? (
                <p className="max-w-[70ch] text-[0.9375rem] leading-relaxed text-rose-200">{m.content}</p>
              ) : (
                <StreamedMarkdown
                  content={m.content}
                  streaming={m.streaming}
                  onDone={() => patch(m.id, { streaming: false })}
                />
              )}
            </motion.article>
          ))}
        </AnimatePresence>

        {busy && lastIsUser && (
          <article role="status" aria-label="Twin is working">
            <header className="mb-2 font-mono text-[0.6875rem] tracking-wide text-amber-300">Twin</header>
            <div className="flex max-w-[34ch] flex-col gap-2" aria-hidden>
              <span className="h-2.5 w-full animate-pulse rounded-full bg-white/10" />
              <span className="h-2.5 w-2/3 animate-pulse rounded-full bg-white/10 [animation-delay:150ms]" />
            </div>
          </article>
        )}
      </div>
    </div>
  );
}
