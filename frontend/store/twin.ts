import { create } from "zustand";
import type { Mode } from "@/lib/api";
import type { ToolId } from "@/lib/nodes";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Assistant messages reveal progressively until streaming is false. */
  streaming?: boolean;
  error?: boolean;
  at?: number;
}

/** Where the voice loop is: listening (mic open), thinking (waiting on /chat), speaking (TTS playing). */
export type AgentState = "off" | "initializing" | "idle" | "listening" | "thinking" | "speaking";
export type VoiceStatus = "off" | "connecting" | "live" | "error";

export type FaceState =
  | "idle"
  | "listening"
  | "thinking"
  | "working"
  | "answering"
  | "speaking"
  | "error";

/** Loose shape of GET /workspace/{id}; every list may be empty or hold unknown fields. */
export interface Workspace {
  events: Record<string, unknown>[];
  tasks: Record<string, unknown>[];
  notes: Record<string, unknown>[];
  audit: Record<string, unknown>[];
}

/**
 * idle      nothing running
 * inbound   a light particle travels from the chat to the core
 * thinking  the core is processing (waiting on the backend)
 * outbound  pulses travel from the core to `targets`; each lit tool stays "active" (energy glow)
 * returning pulses travel from the tools back to the core (the result reaches the agent),
 *           then the canvas calls finishRun() and the reply is shown
 */
export type Phase = "idle" | "inbound" | "thinking" | "outbound" | "returning";

export interface TwinState {
  messages: ChatMessage[];
  sessionId: string;
  mode: Mode;
  busy: boolean;

  phase: Phase;
  /** Bumped on every new run so canvas animations can restart. */
  runId: number;
  targets: ToolId[];
  /** Tools currently glowing mint. */
  active: ToolId[];
  selected: ToolId | null;

  /** Live data for the node pop-ups (Run My Day only). */
  workspace: Workspace | null;
  /** Microphone toggle; UI-only until the voice backend lands. */
  listening: boolean;
  /** Reserved for text-to-speech: true while the twin's voice is playing. */
  speaking: boolean;

  /** Live voice session (browser mic -> Deepgram STT -> /chat -> /voice/speak). `listening` above mirrors "mic session is on". */
  voiceStatus: VoiceStatus;
  agentState: AgentState;
  /** True while the user's own voice is detected on the mic. */
  userSpeaking: boolean;
  /** Interim (not yet final) transcript of what the user is saying. */
  caption: string;
  voiceError: string;
  /** The mic track is disabled but the session stays connected. */
  micMuted: boolean;
  setVoice: (
    p: Partial<Pick<TwinState, "voiceStatus" | "agentState" | "userSpeaking" | "caption" | "voiceError" | "micMuted">>,
  ) => void;

  setWorkspace: (w: Workspace | null) => void;
  setListening: (b: boolean) => void;
  setSpeaking: (b: boolean) => void;
  setMode: (m: Mode) => void;
  setSessionId: (id: string) => void;
  setBusy: (b: boolean) => void;
  addMessage: (m: ChatMessage) => void;
  patchMessage: (id: string, p: Partial<ChatMessage>) => void;
  reset: () => void;

  /** `animate` is false when no canvas is mounted (My Twin mode). */
  startRun: (animate?: boolean) => void;
  setPhase: (p: Phase) => void;
  fireOutbound: (targets: ToolId[]) => void;
  /** Called by the canvas when a pulse lands on a node. */
  activate: (id: ToolId) => void;
  finishRun: () => void;
  select: (id: ToolId | null) => void;
}

export const useTwin = create<TwinState>((set) => ({
  messages: [],
  sessionId: "",
  mode: "visitor",
  busy: false,

  phase: "idle",
  runId: 0,
  targets: [],
  active: [],
  selected: null,
  workspace: null,
  listening: false,
  speaking: false,
  voiceStatus: "off",
  agentState: "off",
  userSpeaking: false,
  caption: "",
  voiceError: "",
  micMuted: false,
  // `listening` mirrors "a voice session exists" so older UI keeps working.
  setVoice: (p) => set(p.voiceStatus ? { ...p, listening: p.voiceStatus !== "off" } : p),

  setSpeaking: (speaking) => set({ speaking }),
  setWorkspace: (workspace) => set({ workspace }),
  setListening: (listening) => set({ listening }),
  setMode: (mode) =>
    set({ mode, messages: [], sessionId: "", phase: "idle", active: [], targets: [], selected: null, workspace: null, busy: false }),
  setSessionId: (sessionId) => set({ sessionId }),
  setBusy: (busy) => set({ busy }),
  addMessage: (m) => set((s) => ({ messages: [...s.messages, m] })),
  patchMessage: (id, p) =>
    set((s) => ({ messages: s.messages.map((m) => (m.id === id ? { ...m, ...p } : m)) })),
  reset: () =>
    set({ messages: [], sessionId: "", phase: "idle", active: [], targets: [], selected: null, workspace: null }),

  startRun: (animate = true) =>
    set((s) => ({ phase: animate ? "inbound" : "thinking", runId: s.runId + 1, targets: [], active: [] })),
  setPhase: (phase) => set({ phase }),
  fireOutbound: (targets) => set({ phase: "outbound", targets }),
  activate: (id) => set((s) => (s.active.includes(id) ? s : { active: [...s.active, id] })),
  finishRun: () => set({ phase: "idle", targets: [], active: [] }),
  select: (selected) => set({ selected }),
}));

/**
 * The face's expression, derived from what the app is doing.
 * Priority: mic open > tools running > thinking > replying > speaking > error > idle.
 */
export const selectFaceState = (s: TwinState): FaceState => {
  const last = s.messages[s.messages.length - 1];
  if (s.voiceStatus === "live") {
    if (s.agentState === "speaking") return "speaking";
    if (s.phase === "outbound") return "working";
    if (s.agentState === "thinking" || s.phase !== "idle") return "thinking";
    return "listening"; // the mic is open and nobody is talking: attentive, brighter while the user speaks
  }
  if (s.listening) return "listening";
  if (s.phase === "outbound") return "working";
  if (s.phase === "inbound" || s.phase === "thinking" || s.phase === "returning") return "thinking";
  if (last?.streaming) return "answering";
  if (s.speaking) return "speaking";
  if (last?.error) return "error";
  return "idle";
};
