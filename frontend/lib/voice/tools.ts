import { fetchWorkspace } from "@/lib/api";
import { TOOL_TO_NODE, type ToolId } from "@/lib/nodes";
import { waitForThinking } from "@/lib/useChat";
import { useTwin } from "@/store/twin";

export interface ToolEvent {
  tool: string;
  status: "start" | "done" | "error";
  args?: unknown;
  result?: unknown;
}

/** Tools that change something, so the twin also pings the phone (notify node). */
const ACTION_TOOLS = new Set([
  "add_event",
  "cancel_event",
  "add_task",
  "complete_task",
  "add_note",
  "send_email",
  "draft_email",
]);

const pending = new Set<ToolId>();
let actionRan = false;
let draining = false;
let epoch = 0;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
/** start events seen without a matching done, per tool: a done after a start does not animate twice. */
const inflight: Record<string, number> = {};

function waitForIdle(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (useTwin.getState().phase === "idle") return resolve(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    const unsub = useTwin.subscribe((s) => {
      if (s.phase === "idle") finish(true);
    });
    function finish(ok: boolean) {
      clearTimeout(timer);
      unsub();
      resolve(ok);
    }
  });
}

async function drain() {
  if (draining) return;
  draining = true;
  const my = epoch;
  try {
    while (pending.size && my === epoch) {
      if (!(await waitForIdle(20000))) break;
      if (my !== epoch || !pending.size) break;
      const targets = Array.from(pending);
      if (actionRan && !targets.includes("notify")) targets.push("notify");
      pending.clear();
      actionRan = false;

      const s = useTwin.getState();
      s.startRun(true);
      await waitForThinking();
      if (my !== epoch) break;
      useTwin.getState().fireOutbound(targets);
      // The canvas calls finishRun() itself; this is only a guard against a stuck phase.
      if (!(await waitForIdle(15000)) && my === epoch) useTwin.getState().finishRun();
    }
  } finally {
    draining = false;
    if (my !== epoch) return;
    if (pending.size) void drain();
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    const { sessionId, mode } = useTwin.getState();
    if (mode !== "owner" || !sessionId) return;
    fetchWorkspace(sessionId)
      .then((w) => useTwin.getState().setWorkspace(w))
      .catch(() => {});
  }, 350);
}

/** Drive the canvas director from an agent tool event (Run My Day only). */
export function handleToolEvent(ev: ToolEvent) {
  if (useTwin.getState().mode !== "owner") return;
  const node = TOOL_TO_NODE[ev.tool];
  if (ev.status === "done") scheduleRefresh();
  if (!node) return;

  if (ev.status === "start") {
    inflight[ev.tool] = (inflight[ev.tool] ?? 0) + 1;
  } else {
    const had = (inflight[ev.tool] ?? 0) > 0;
    if (had) inflight[ev.tool] -= 1;
    if (had || ev.status === "error") return;
  }
  pending.add(node);
  if (ACTION_TOOLS.has(ev.tool)) actionRan = true;
  void drain();
}

/** Forget queued animations (voice session ended or the mode changed). */
export function resetToolQueue() {
  epoch++;
  pending.clear();
  actionRan = false;
  for (const k of Object.keys(inflight)) delete inflight[k];
  clearTimeout(refreshTimer);
}
