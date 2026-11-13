"use client";

import { useCallback } from "react";
import { fetchWorkspace, sendChat, type TwinAction } from "@/lib/api";
import { TOOL_TO_NODE, type ToolId } from "@/lib/nodes";
import { useTwin } from "@/store/twin";

const uid = () => crypto.randomUUID();

/** Resolve when the phase leaves `from`, or after a safety timeout. */
export function waitWhile(from: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (useTwin.getState().phase !== from) return resolve();
    const timer = setTimeout(done, timeoutMs);
    const unsub = useTwin.subscribe((s) => {
      if (s.phase !== from) done();
    });
    function done() {
      clearTimeout(timer);
      unsub();
      resolve();
    }
  });
}

/** Resolve once the canvas particle reaches the core (or after a safety timeout). */
export function waitForThinking(timeoutMs = 3000): Promise<void> {
  return new Promise((resolve) => {
    if (useTwin.getState().phase !== "inbound") return resolve();
    const timer = setTimeout(done, timeoutMs);
    const unsub = useTwin.subscribe((s) => {
      if (s.phase !== "inbound") done();
    });
    function done() {
      clearTimeout(timer);
      unsub();
      resolve();
    }
  });
}

function targetsFor(actions: TwinAction[]): ToolId[] {
  const ids = actions
    .map((a) => TOOL_TO_NODE[a.tool])
    .filter((id): id is ToolId => Boolean(id));
  const unique = Array.from(new Set(ids));
  // A plain answer still consults the twin's memory.
  if (!unique.length) return ["memory"];
  // The backend pushes a phone notification after every action it takes.
  return unique.includes("notify") ? unique : [...unique, "notify"];
}

export interface SendOptions {
  /** Reply will be spoken: ask the backend for spoken style and skip the slow typing effect. */
  voice?: boolean;
  /** Called the moment the reply text arrives (before the tool animation finishes). */
  onReply?: (text: string) => void;
}

/** The one send path for typed and spoken messages. Resolves with the reply text, or null if nothing was sent / it failed. */
export async function sendMessage(text: string, opts: SendOptions = {}): Promise<string | null> {
  const s = useTwin.getState();
  if (s.busy || !text.trim()) return null;

  s.addMessage({ id: uid(), role: "user", content: text, at: Date.now() });
  s.setBusy(true);
  const animate = s.mode === "owner"; // the canvas only exists in Run My Day
  s.startRun(animate);

  try {
    const reply = await sendChat({ message: text, sessionId: s.sessionId, mode: s.mode, voice: opts.voice });
    if (!useTwin.getState().sessionId) useTwin.getState().setSessionId(reply.session_id);
    opts.onReply?.(reply.response);

    if (animate) {
      await waitForThinking();
      useTwin.getState().fireOutbound(targetsFor(reply.actions));
      // Hold the reply until the result has travelled back to the agent.
      await waitWhile("outbound", 9000);
      await waitWhile("returning", 5000);
    }
    useTwin.getState().finishRun();
    useTwin.getState().addMessage({
      id: uid(),
      role: "assistant",
      content: reply.response,
      streaming: !opts.voice,
      at: Date.now(),
    });
    // Keep the node pop-ups current after the twin changed something.
    if (s.mode === "owner" && reply.actions.length) {
      fetchWorkspace(reply.session_id)
        .then((w) => useTwin.getState().setWorkspace(w))
        .catch(() => {});
    }
    return reply.response;
  } catch (e) {
    useTwin.getState().finishRun();
    useTwin.getState().addMessage({
      id: uid(),
      role: "assistant",
      error: true,
      at: Date.now(),
      content: `I couldn't reach my tools. ${e instanceof Error ? e.message : "Unknown error"}. Check your connection and send it again.`,
    });
    return null;
  } finally {
    useTwin.getState().setBusy(false);
  }
}

export function useChat() {
  return useCallback((text: string) => sendMessage(text), []);
}
