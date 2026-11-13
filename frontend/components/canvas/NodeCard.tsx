"use client";

import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { ToolId, ToolNodeDef } from "@/lib/nodes";
import { useTwin } from "@/store/twin";

export const CARD_W = 280;
/** Cache-buster so regenerated icons are never served stale. */
export const iconUrl = (def: ToolNodeDef) => `${def.icon}?v=2`;

interface Props {
  def: ToolNodeDef;
  open: boolean;
  /** 1 = card sits to the right of the node, -1 = to the left. */
  side: 1 | -1;
  onClose: () => void;
}

type Row = Record<string, unknown>;

/* ---------- defensive helpers: field names are unknown ---------- */

function pick(obj: unknown, keys: string[]): string | undefined {
  if (!obj || typeof obj !== "object") return typeof obj === "string" && obj ? obj : undefined;
  const o = obj as Row;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

function fmtTime(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  try {
    return d.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
  } catch {
    return v;
  }
}

const list = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);

const isDone = (o: Row) =>
  o.done === true || o.completed === true || ["done", "completed", "complete"].includes(String(o.status ?? "").toLowerCase());

const TITLE = ["title", "text", "name", "content", "summary", "description"];
const TIME = ["ts", "timestamp", "created_at", "time", "at", "start", "start_time", "when", "date"];
const MOCK_FACTS = ["Prefers mornings for deep work", "Timezone: Asia/Karachi", "Keeps Fridays free of meetings"];

interface Item {
  primary: string;
  secondary?: string;
  /** Right-aligned, tabular (times). */
  time?: string;
  done?: boolean;
  link?: string;
}

interface Content {
  items: Item[];
  empty: string;
  heading?: string;
}

function useContent(id: ToolId): Content {
  const ws = useTwin((s) => s.workspace);
  switch (id) {
    case "schedule":
      return {
        empty: "Nothing on the calendar yet.",
        items: list(ws?.events).map((e) => ({
          primary: pick(e, TITLE) ?? "Untitled event",
          time: fmtTime(pick(e, ["start", "start_time", "time", "when", "date"])),
        })),
      };
    case "tasks":
      return {
        empty: "No tasks yet.",
        items: list(ws?.tasks).map((e) => ({ primary: pick(e, TITLE) ?? "Untitled task", done: isDone(e) })),
      };
    case "notes":
      return {
        empty: "No notes yet.",
        items: list(ws?.notes).map((e) => {
          const url = pick(e, ["notion_url"]);
          return {
            primary: pick(e, ["text", "content", "title", "summary", "name"]) ?? "Empty note",
            link: url && /^https?:\/\//i.test(url) ? url : undefined,
          };
        }),
      };
    case "notify": {
      const sent = list(ws?.audit)
        .filter((e) => [e.tool, e.tool_name, e.action].some((v) => v === "notify_owner"))
        .slice(-5)
        .reverse();
      return {
        empty: "No notifications sent yet.",
        items: sent.map((e) => ({
          primary: pick(e, ["summary", "message", "text", "detail", "title"]) ?? "Notification sent",
          time: fmtTime(pick(e, TIME)),
        })),
      };
    }
    case "email":
      return { empty: "Not connected yet. Gmail isn't wired to your twin.", items: [] };
    default: {
      const audit = list(ws?.audit).slice(-5).reverse();
      if (audit.length) {
        return {
          heading: "Recent activity",
          empty: "",
          items: audit.map((e) => ({
            primary: pick(e, ["summary", "action", "event", "message", "tool", "name", "text"]) ?? "Activity",
            time: fmtTime(pick(e, TIME)),
          })),
        };
      }
      return { heading: "What I remember", empty: "", items: MOCK_FACTS.map((primary) => ({ primary })) };
    }
  }
}

function Check({ done }: { done: boolean }) {
  return (
    <svg aria-hidden width="16" height="16" viewBox="0 0 16 16" fill="none" className="mt-px shrink-0">
      <circle
        cx="8"
        cy="8"
        r="6.25"
        stroke={done ? "#34D399" : "rgba(242,237,228,0.38)"}
        strokeWidth="1.25"
        fill={done ? "rgba(52,211,153,0.16)" : "none"}
      />
      {done && <path d="M5.2 8.3l2 2 3.7-4" stroke="#6ee7b7" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}

function Body({ id }: { id: ToolId }) {
  const { items, empty, heading } = useContent(id);
  return (
    <div className="px-4 pb-3 pt-2.5">
      {heading && items.length > 0 && (
        <p className="mb-0.5 text-[10.5px] font-medium uppercase tracking-[0.08em] text-amber-200/70">{heading}</p>
      )}
      {items.length === 0 ? (
        <p className="py-1 text-[13px] leading-snug text-stone-300">{empty}</p>
      ) : (
        <ul className="divide-y divide-white/[0.07]">
          {items.map((it, i) => (
            <li key={i} className="flex items-start gap-2.5 py-2 text-[13px] leading-snug">
              {id === "tasks" && <Check done={!!it.done} />}
              <span className="min-w-0 flex-1">
                <span className={`block break-words ${it.done ? "text-stone-400 line-through decoration-stone-500" : "text-stone-100"}`}>
                  {it.done ? <span className="sr-only">Done: </span> : null}
                  {it.primary}
                </span>
                {it.secondary && <span className="block text-xs text-stone-400">{it.secondary}</span>}
                {it.link && (
                  <a
                    href={it.link}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="mt-0.5 inline-block text-[11px] text-stone-400 underline decoration-white/20 underline-offset-2 outline-none transition-colors hover:text-amber-300 focus-visible:text-amber-300"
                  >
                    Synced to Notion
                  </a>
                )}
              </span>
              {it.time && <span className="shrink-0 pt-px text-xs tabular-nums text-stone-400">{it.time}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Glass pop-up anchored beside a node. The 3D canvas is decorative; this is the accessible part. */
export function NodeCard({ def, open, side, onClose }: Props) {
  const closeBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) closeBtn.current?.focus({ preventScroll: true });
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="card"
          data-twin-card
          role="dialog"
          aria-label={`${def.label} details`}
          initial={{ opacity: 0, scale: 0.96, x: side * 10 }}
          animate={{ opacity: 1, scale: 1, x: 0 }}
          exit={{ opacity: 0, scale: 0.97, x: side * 6 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          style={{ width: CARD_W, pointerEvents: "auto", transformOrigin: side > 0 ? "left center" : "right center" }}
          className="max-h-80 overflow-y-auto rounded-[14px] border border-white/10 bg-stone-900/80 text-left text-stone-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.09),0_18px_40px_-14px_rgba(10,8,5,0.7)] backdrop-blur-md [scrollbar-color:rgba(214,200,180,0.35)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-stone-400/30 [&::-webkit-scrollbar]:w-1.5"
        >
          <div className="flex items-center gap-2.5 border-b border-white/[0.07] px-4 py-3">
            <span
              aria-hidden
              className="size-[22px] shrink-0 rounded-md bg-white/90 bg-contain bg-center bg-no-repeat p-0.5"
              style={{ backgroundImage: `url(${iconUrl(def)})`, backgroundOrigin: "content-box" }}
            />
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-[13px] font-semibold leading-tight text-stone-100">{def.label}</h3>
              <p className="truncate text-[11px] leading-tight text-stone-400">{def.caption}</p>
            </div>
            <button
              ref={closeBtn}
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="grid size-7 shrink-0 place-items-center rounded-full text-stone-300 outline-none transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-amber-400"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <Body id={def.id} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
