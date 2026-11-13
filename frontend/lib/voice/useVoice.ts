"use client";

import { useEffect } from "react";
import { VoiceError, fetchSpeech, fetchSttToken } from "@/lib/api";
import { sendMessage } from "@/lib/useChat";
import { useTwin, type AgentState } from "@/store/twin";
import { voiceLevels } from "./levels";
import { LevelMeter, zeroLevels } from "./meter";
import { startMock, voiceMockEnabled } from "./mock";
import { resetToolQueue } from "./tools";

/**
 * Voice session controller (module singleton). No extra server:
 *   mic -> MediaRecorder -> Deepgram STT WebSocket (short-lived token from /voice/stt-token)
 *   final utterance -> the normal chat pipeline (sendMessage, voice: true)
 *   reply -> /voice/speak per sentence -> one AudioContext, gapless scheduled playback.
 * State lives in the zustand store: voiceStatus off -> connecting -> live | error, agentState,
 * userSpeaking, caption, voiceError, micMuted. Live audio levels go to `voiceLevels`.
 * Use headphones for best results: speaker echo can look like barge-in.
 */

const STT_URL =
  "wss://api.deepgram.com/v1/listen?model=nova-3&language=en&smart_format=true&punctuate=true" +
  "&interim_results=true&endpointing=300&utterance_end_ms=1000&vad_events=true";
const KEEPALIVE_MS = 8000;
const TTS_CONCURRENCY = 3;
const BARGE_WORDS = 2;
const BARGE_LEVEL = 0.25;
const BARGE_LEVEL_MS = 400;
const MAX_RECONNECTS = 3;

let meter: LevelMeter | null = null;
let micStream: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let ws: WebSocket | null = null;
let keepAlive: ReturnType<typeof setInterval> | undefined;
let levelPoll: ReturnType<typeof setInterval> | undefined;
let stopMock: (() => void) | null = null;
let session = 0; // bumped on every start/stop so stale async work can bail out
let wired = false;
let cleanups: (() => void)[] = [];

// per-session turn state
let buf = ""; // final transcript pieces of the current utterance
let interim = "";
let pending = ""; // utterance finished while the twin was still thinking
let state: AgentState = "off";
let playId = 0; // bumped to cancel playback
let playAbort: AbortController | null = null;
let sources: AudioBufferSourceNode[] = [];
let loudSince = 0;

const set = (p: Parameters<ReturnType<typeof useTwin.getState>["setVoice"]>[0]) => useTwin.getState().setVoice(p);
const join = (a: string, b: string) => [a, b].filter(Boolean).join(" ");
const words = (t: string) => t.split(/\s+/).filter(Boolean).length;

function setState(a: AgentState) {
  state = a;
  set({ agentState: a });
  useTwin.getState().setSpeaking(a === "speaking");
}

function friendly(e: unknown): string {
  if (e instanceof VoiceError) return e.message;
  const name = e instanceof Error ? e.name : "";
  const msg = e instanceof Error ? e.message : "";
  if (name === "NotAllowedError" || name === "SecurityError" || /permission|denied/i.test(msg)) {
    return "Microphone access is blocked. Allow the microphone in your browser's site settings, then tap the mic again.";
  }
  if (name === "NotFoundError" || /no .*device|requested device not found/i.test(msg)) {
    return "I can't find a microphone. Plug one in and tap the mic again.";
  }
  return "I couldn't start the voice session. Check your connection and try again.";
}

/** Zustand subscription: leaving Run My Day or switching modes ends the session. */
function wire() {
  if (wired) return;
  wired = true;
  useTwin.subscribe((s, prev) => {
    if (s.mode !== prev.mode && s.voiceStatus !== "off") stopVoice();
  });
}

// ---------------------------------------------------------------- playback

function stopPlayback() {
  playId++;
  playAbort?.abort();
  playAbort = null;
  for (const src of sources) {
    src.onended = null;
    try {
      src.stop();
    } catch {
      /* not started */
    }
    src.disconnect();
  }
  sources = [];
}

function sentencesOf(text: string): string[] {
  const clean = text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_#`>~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const raw = clean.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [];
  const out: string[] = [];
  let carry = "";
  for (const r of raw) {
    carry = join(carry, r.trim());
    if (carry.length >= 25) {
      out.push(carry);
      carry = "";
    }
  }
  if (carry) {
    if (out.length && carry.length < 25) out[out.length - 1] = join(out[out.length - 1], carry);
    else out.push(carry);
  }
  // The backend caps each request at 600 characters.
  return out.flatMap((s) => (s.length <= 580 ? [s] : (s.match(/.{1,580}(\s|$)/g) ?? [s]).map((p) => p.trim())));
}

async function speak(text: string, my: number) {
  const ctx = meter?.context();
  const bus = meter?.agentBus();
  const parts = sentencesOf(text);
  if (!ctx || !bus || !parts.length) return finishTurn(my);
  void ctx.resume().catch(() => {});
  stopPlayback();
  const id = playId;
  const abort = new AbortController();
  playAbort = abort;
  const alive = () => id === playId && my === session;

  // Fetch + decode every sentence in parallel (3 at a time); schedule strictly in order.
  const jobs = parts.map(() => {
    let resolve!: (b: AudioBuffer | null) => void;
    const p = new Promise<AudioBuffer | null>((r) => (resolve = r));
    return { p, resolve };
  });
  let next = 0;
  const worker = async () => {
    while (alive() && next < parts.length) {
      const i = next++;
      try {
        const data = await fetchSpeech(parts[i], abort.signal);
        jobs[i].resolve(alive() ? await ctx.decodeAudioData(data) : null);
      } catch {
        jobs[i].resolve(null);
      }
    }
  };
  for (let w = 0; w < Math.min(TTS_CONCURRENCY, parts.length); w++) void worker();

  let when = 0;
  let last: AudioBufferSourceNode | null = null;
  for (const job of jobs) {
    const buffer = await job.p;
    if (!alive()) return;
    if (!buffer) continue;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(bus);
    when = Math.max(ctx.currentTime + 0.03, when);
    src.start(when);
    when += buffer.duration;
    sources.push(src);
    last = src;
    if (state !== "speaking") {
      buf = interim = "";
      set({ caption: "" });
      setState("speaking");
    }
  }
  if (!last) {
    set({ voiceError: "I couldn't speak that reply. Check the voice settings; the text is in the chat." });
    return finishTurn(my);
  }
  last.onended = () => {
    if (alive()) finishTurn(my);
  };
}

function finishTurn(my: number) {
  if (my !== session) return;
  stopPlayback();
  setState("listening");
  if (pending) {
    const t = pending;
    pending = "";
    void sendUtterance(t);
  }
}

async function sendUtterance(text: string) {
  const my = session;
  buf = interim = "";
  set({ caption: "" });
  setState("thinking");
  const reply = await sendMessage(text, { voice: true, onReply: (t) => void speak(t, my) });
  if (my !== session) return;
  if (reply === null && state === "thinking") finishTurn(my); // failed or busy: nothing will be spoken
}

function bargeIn() {
  stopPlayback();
  setState("listening");
}

// ---------------------------------------------------------------- speech to text

function flush() {
  const text = join(buf, interim).trim();
  buf = interim = "";
  set({ caption: "" });
  if (!text || useTwin.getState().micMuted) return;
  if (state === "listening") void sendUtterance(text);
  else if (state === "thinking") pending = join(pending, text);
}

function onSttMessage(raw: string) {
  let m: { type?: string; is_final?: boolean; speech_final?: boolean; channel?: { alternatives?: { transcript?: string }[] } };
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  if (m.type === "UtteranceEnd") return flush();
  if (m.type !== "Results") return;
  const text = (m.channel?.alternatives?.[0]?.transcript ?? "").trim();
  if (!text || useTwin.getState().micMuted) return;
  if (m.is_final) {
    buf = join(buf, text);
    interim = "";
  } else {
    interim = text;
  }
  const heard = join(buf, interim);
  if (state === "speaking") {
    // Ignore the twin's own voice unless this clearly is the user cutting in.
    if (words(heard) < BARGE_WORDS) {
      buf = interim = "";
      return;
    }
    bargeIn();
  }
  if (state === "listening") set({ caption: heard });
  if (m.speech_final) flush();
}

function openOnce(token: string, scheme: "bearer" | "token"): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(STT_URL, [scheme, token]);
    let opened = false;
    sock.onopen = () => {
      opened = true;
      resolve(sock);
    };
    const fail = () => {
      if (!opened) reject(new VoiceError("I couldn't connect to the speech service. Try again in a moment.", 0));
    };
    sock.onerror = fail;
    sock.onclose = fail;
  });
}

/** Deepgram's browser auth for temporary JWTs is the "bearer" subprotocol; fall back to "token" if refused. */
async function openSocket(token: string): Promise<WebSocket> {
  try {
    return await openOnce(token, "bearer");
  } catch {
    return openOnce(token, "token");
  }
}

/** (Re)start the recorder: every new socket needs a fresh webm header, so a new recorder each time. */
function startRecorder(sock: WebSocket) {
  if (!micStream) return;
  try {
    if (recorder && recorder.state !== "inactive") recorder.stop();
  } catch {
    /* already stopped */
  }
  const rec = new MediaRecorder(micStream, { mimeType: "audio/webm;codecs=opus" });
  rec.ondataavailable = (ev) => {
    if (ev.data.size && sock.readyState === WebSocket.OPEN && !useTwin.getState().micMuted) sock.send(ev.data);
  };
  rec.start(250);
  recorder = rec;
}

async function connectStt(my: number): Promise<void> {
  const { token } = await fetchSttToken();
  if (my !== session) return;
  const sock = await openSocket(token);
  if (my !== session) return sock.close();
  ws = sock;
  sock.onmessage = (ev) => {
    if (typeof ev.data === "string") onSttMessage(ev.data);
  };
  sock.onclose = () => {
    if (my === session && ws === sock) void reconnect(my);
  };
  clearInterval(keepAlive);
  keepAlive = setInterval(() => {
    if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: "KeepAlive" }));
  }, KEEPALIVE_MS);
  startRecorder(sock);
}

async function reconnect(my: number) {
  for (let i = 0; i < MAX_RECONNECTS; i++) {
    if (my !== session) return;
    try {
      await connectStt(my);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  if (my !== session) return;
  session++;
  teardown();
  resetToolQueue();
  set({
    voiceStatus: "error",
    agentState: "off",
    userSpeaking: false,
    caption: "",
    micMuted: false,
    voiceError: "The voice connection dropped. Tap the mic to reconnect.",
  });
}

// ---------------------------------------------------------------- lifecycle

function teardown() {
  for (const c of cleanups) c();
  cleanups = [];
  stopMock?.();
  stopMock = null;
  stopPlayback();
  clearInterval(keepAlive);
  clearInterval(levelPoll);
  keepAlive = levelPoll = undefined;
  try {
    if (recorder && recorder.state !== "inactive") recorder.stop();
  } catch {
    /* already stopped */
  }
  recorder = null;
  if (ws) {
    const sock = ws;
    ws = null;
    sock.onclose = null;
    sock.onmessage = null;
    try {
      if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: "CloseStream" }));
      sock.close();
    } catch {
      /* already closed */
    }
  }
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
  meter?.dispose();
  meter = null;
  buf = interim = pending = "";
  state = "off";
  loudSince = 0;
  useTwin.getState().setSpeaking(false);
  zeroLevels();
}

export async function startVoice() {
  const st = useTwin.getState();
  if (st.voiceStatus === "connecting" || st.voiceStatus === "live") return;
  wire();
  const my = ++session;
  teardown();
  set({
    voiceStatus: "connecting",
    voiceError: "",
    agentState: "initializing",
    caption: "",
    userSpeaking: false,
    micMuted: false,
  });

  if (voiceMockEnabled()) {
    stopMock = startMock();
    return;
  }

  try {
    // Create and resume the AudioContext synchronously inside the click handler (autoplay policy).
    const m = new LevelMeter((speaking) => {
      if (state !== "speaking" && useTwin.getState().userSpeaking !== speaking) set({ userSpeaking: speaking });
    });
    meter = m;
    m.context();
    m.resume();
    m.agentBus();

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (my !== session) return stream.getTracks().forEach((t) => t.stop());
    micStream = stream;
    m.setMic(stream);

    await connectStt(my);
    if (my !== session) return;

    // Sustained loud mic while the twin talks counts as barge-in even before words are recognised.
    levelPoll = setInterval(() => {
      if (state !== "speaking" || useTwin.getState().micMuted || voiceLevels.mic < BARGE_LEVEL) {
        loudSince = 0;
        return;
      }
      loudSince ||= performance.now();
      if (performance.now() - loudSince > BARGE_LEVEL_MS) {
        loudSince = 0;
        bargeIn();
      }
    }, 50);

    const onVisible = () => {
      if (!document.hidden) m.resume();
    };
    document.addEventListener("visibilitychange", onVisible);
    cleanups.push(() => document.removeEventListener("visibilitychange", onVisible));

    m.start();
    set({ voiceStatus: "live" });
    setState("listening");
  } catch (e) {
    if (my !== session) return;
    session++;
    teardown();
    resetToolQueue();
    set({
      voiceStatus: "off",
      agentState: "off",
      userSpeaking: false,
      caption: "",
      micMuted: false,
      voiceError: friendly(e),
    });
  }
}

export function stopVoice() {
  session++;
  teardown();
  resetToolQueue();
  set({ voiceStatus: "off", agentState: "off", userSpeaking: false, caption: "", micMuted: false, voiceError: "" });
}

export function toggleVoice() {
  const s = useTwin.getState().voiceStatus;
  if (s === "off" || s === "error") void startVoice();
  else stopVoice();
}

/** Disable the mic track without leaving the session (nothing is sent to Deepgram while muted). */
export function toggleMute() {
  const s = useTwin.getState();
  if (s.voiceStatus !== "live") return;
  const muted = !s.micMuted;
  if (meter) meter.muted = muted;
  micStream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
  set({ micMuted: muted, ...(muted ? { userSpeaking: false, caption: "" } : {}) });
  if (muted) buf = interim = "";
}

export function useVoice() {
  const status = useTwin((s) => s.voiceStatus);
  const agentState = useTwin((s) => s.agentState);
  const userSpeaking = useTwin((s) => s.userSpeaking);
  const caption = useTwin((s) => s.caption);
  const error = useTwin((s) => s.voiceError);
  const muted = useTwin((s) => s.micMuted);
  return {
    status,
    agentState,
    userSpeaking,
    caption,
    error,
    muted,
    live: status === "live",
    start: startVoice,
    stop: stopVoice,
    toggle: toggleVoice,
    toggleMute,
  };
}

/** Mount once near the root: ends the voice session when the app unmounts. */
export function useVoiceLifecycle() {
  useEffect(() => () => stopVoice(), []);
}
