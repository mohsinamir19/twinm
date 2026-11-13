import { useTwin } from "@/store/twin";
import { handleToolEvent, type ToolEvent } from "./tools";

export type TwinDataMessage =
  | { type: "transcript"; role: "user" | "assistant"; text: string; final: boolean }
  | ({ type: "tool" } & ToolEvent)
  | { type: "error"; message: string };

const uid = () => crypto.randomUUID();

/** Single entry point for everything the agent sends on the "twin" data topic (also used by the mock). */
export function handleTwinMessage(msg: TwinDataMessage) {
  const s = useTwin.getState();
  if (msg.type === "transcript") {
    const text = (msg.text ?? "").trim();
    if (msg.role === "user") {
      if (!msg.final) return s.setVoice({ caption: text });
      s.setVoice({ caption: "" });
      if (text) s.addMessage({ id: uid(), role: "user", content: text, at: Date.now() });
    } else if (msg.final && text) {
      s.addMessage({ id: uid(), role: "assistant", content: text, streaming: false, at: Date.now() });
    }
  } else if (msg.type === "tool") {
    handleToolEvent(msg);
  } else if (msg.type === "error") {
    const message = msg.message || "Something went wrong with the voice session.";
    s.setVoice({ voiceError: message });
    s.addMessage({ id: uid(), role: "assistant", error: true, content: message, at: Date.now() });
  }
}

export function parseTwinMessage(payload: Uint8Array): TwinDataMessage | null {
  try {
    const m = JSON.parse(new TextDecoder().decode(payload));
    return m && typeof m.type === "string" ? (m as TwinDataMessage) : null;
  } catch {
    return null;
  }
}
