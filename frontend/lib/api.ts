export const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

// The owner passphrase is typed by the owner at runtime and kept only for this browser tab.
// It is never baked into the build (a NEXT_PUBLIC_ variable would be readable by every visitor).
const TOKEN_KEY = "twin-owner-token";
export function getOwnerToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}
export function setOwnerToken(token: string) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode: the passphrase is simply asked again */
  }
}

export type Mode = "visitor" | "owner";

export interface TwinAction {
  tool: string;
  status?: string;
  args?: unknown;
  result?: unknown;
  rule?: string;
}

export interface ChatReply {
  response: string;
  session_id: string;
  actions: TwinAction[];
}

export async function sendChat(body: {
  message: string;
  sessionId?: string;
  mode: Mode;
  voice?: boolean;
}): Promise<ChatReply> {
  const owner = body.mode === "owner";
  let timezone: string | undefined;
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    timezone = undefined;
  }
  const payload = JSON.stringify({
    message: body.message,
    session_id: body.sessionId || undefined,
    voice: body.voice || undefined,
    timezone,
  });
  // The route decides the mode on the server: /chat = public AI Twin, /owner/chat = Chief of Staff.
  const post = () => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const t = getOwnerToken();
    if (owner && t) headers["x-owner-token"] = t;
    return fetch(`${API}${owner ? "/owner/chat" : "/chat"}`, { method: "POST", headers, body: payload });
  };
  let res = await post();
  // Only if the server was started with an OWNER_TOKEN do we ask for it (once per tab).
  if (owner && res.status === 401) {
    const t = typeof window !== "undefined" ? window.prompt("This server needs the owner token") : null;
    if (!t) throw new Error("Owner token required");
    setOwnerToken(t.trim());
    res = await post();
    if (res.status === 401) {
      setOwnerToken("");
      throw new Error("Wrong owner token");
    }
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(typeof err.detail === "string" ? err.detail : `Request failed (${res.status})`);
  }
  const data = await res.json();
  return { response: data.response, session_id: data.session_id, actions: data.actions ?? [] };
}

export async function fetchWorkspace(sessionId: string) {
  const res = await fetch(`${API}/workspace/${sessionId}`, {
    headers: { "x-owner-token": getOwnerToken() },
  });
  if (!res.ok) throw new Error(`Workspace unavailable (${res.status})`);
  const d = await res.json();
  return {
    events: d.events ?? [],
    tasks: d.tasks ?? [],
    notes: d.notes ?? [],
    audit: d.audit ?? [],
  };
}

export class VoiceError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function voicePost(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new VoiceError("I couldn't reach the voice service. Check your connection and try again.", 0);
  }
  if (res.status === 503) {
    throw new VoiceError("Voice isn't set up on this server yet (missing DEEPGRAM_API_KEY). You can keep typing in the meantime.", 503);
  }
  if (!res.ok) throw new VoiceError(`Voice is unavailable right now (${res.status}).`, res.status);
  return res;
}

/** Short-lived Deepgram token for the browser STT WebSocket. */
export async function fetchSttToken(): Promise<{ token: string; expires_in: number }> {
  return (await voicePost("/voice/stt-token", undefined)).json();
}

/** Synthesize one sentence; resolves with encoded audio (mp3/wav) ready for decodeAudioData. */
export async function fetchSpeech(text: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  return (await voicePost("/voice/speak", { text }, signal)).arrayBuffer();
}
