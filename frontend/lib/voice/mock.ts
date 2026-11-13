import { useTwin } from "@/store/twin";
import { handleTwinMessage } from "./events";
import { voiceLevels } from "./levels";
import { zeroLevels } from "./meter";

/**
 * MOCK VOICE DRIVER (development and screenshots, no LiveKit, no mic, no backend).
 *
 * Enable with `NEXT_PUBLIC_VOICE_MOCK=1 npm run dev` or by opening the app with `?voicemock=1`.
 * Tapping the mic then runs this loop forever until stopped:
 *   listening 3s (fake mic level, userSpeaking true in the middle, interim caption, final user line)
 *   -> thinking 1.5s -> tool events add_event + add_task (Run My Day only) -> speaking 4s
 *   (fake agent level + assistant transcript) -> listening again.
 * It writes the same store fields, voiceLevels and tool-event path as the real client.
 */
export function voiceMockEnabled(): boolean {
  if (process.env.NEXT_PUBLIC_VOICE_MOCK === "1") return true;
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).get("voicemock") === "1";
}

const wait = (ms: number, alive: () => boolean) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    const poll = setInterval(() => {
      if (!alive()) {
        clearTimeout(t);
        clearInterval(poll);
        resolve();
      }
    }, 100);
    setTimeout(() => clearInterval(poll), ms + 50);
  });

export function startMock(): () => void {
  let alive = true;
  const ok = () => alive;
  const set = useTwin.getState().setVoice;
  const t0 = performance.now();
  let phase: "listening" | "thinking" | "speaking" = "listening";
  let phaseStart = t0;
  let speaking = false;

  // Fake levels, one rAF loop, no allocations.
  let raf = 0;
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const x = (now - t0) / 1000;
    const syll = Math.pow(0.5 + 0.5 * Math.sin(x * 19.5), 2) * (0.6 + 0.4 * Math.sin(x * 2.3 + 1));
    const into = (now - phaseStart) / 1000;
    const muted = useTwin.getState().micMuted;
    const micOn = phase === "listening" && !muted && into > 0.8 && into < 2.4;
    const micV = micOn ? syll : 0;
    const agentV = phase === "speaking" ? syll : 0;
    const k = (a: number, b: number) => a + (b - a) * 0.35;
    voiceLevels.mic = k(voiceLevels.mic, micV);
    voiceLevels.agent = k(voiceLevels.agent, agentV);
    const mb = voiceLevels.micBands, ab = voiceLevels.agentBands;
    mb[0] = k(mb[0], micV * 0.9); mb[1] = k(mb[1], micV * 0.7); mb[2] = k(mb[2], micV * 0.45);
    ab[0] = k(ab[0], agentV * 0.9); ab[1] = k(ab[1], agentV * 0.7); ab[2] = k(ab[2], agentV * 0.45);
    if (micOn !== speaking) {
      speaking = micOn;
      useTwin.getState().setVoice({ userSpeaking: micOn });
    }
  };
  raf = requestAnimationFrame(frame);

  const go = (p: typeof phase) => {
    phase = p;
    phaseStart = performance.now();
    set({ agentState: p });
  };

  void (async () => {
    set({ agentState: "initializing" });
    await wait(600, ok);
    if (!ok()) return;
    set({ voiceStatus: "live" });
    while (alive) {
      go("listening");
      await wait(1000, ok);
      if (!ok()) break;
      handleTwinMessage({ type: "transcript", role: "user", text: "Add a meeting with", final: false });
      await wait(800, ok);
      if (!ok()) break;
      handleTwinMessage({ type: "transcript", role: "user", text: "Add a meeting with Sam tomorrow at 3 and a task to", final: false });
      await wait(1200, ok);
      if (!ok()) break;
      handleTwinMessage({
        type: "transcript",
        role: "user",
        text: "Add a meeting with Sam tomorrow at 3 and a task to send the proposal.",
        final: true,
      });
      go("thinking");
      await wait(1500, ok);
      if (!ok()) break;
      const tools = [
        { tool: "add_event", args: { title: "Meeting with Sam" } },
        { tool: "add_task", args: { title: "Send the proposal" } },
      ];
      for (const t of tools) handleTwinMessage({ type: "tool", tool: t.tool, status: "start", args: t.args });
      await wait(700, ok);
      for (const t of tools) handleTwinMessage({ type: "tool", tool: t.tool, status: "done", args: t.args, result: { ok: true } });
      go("speaking");
      handleTwinMessage({
        type: "transcript",
        role: "assistant",
        text: "Done. I put the meeting with Sam on your calendar for 3 pm tomorrow and added a task to send the proposal.",
        final: true,
      });
      await wait(4000, ok);
    }
  })();

  return () => {
    alive = false;
    cancelAnimationFrame(raf);
    zeroLevels();
  };
}
