import { voiceLevels } from "./levels";

interface Channel {
  src: AudioNode;
  an: AnalyserNode;
  freq: Uint8Array<ArrayBuffer>;
  td: Float32Array<ArrayBuffer>;
  stream: MediaStream | null;
  lo: [number, number];
  mid: [number, number];
  hi: [number, number];
}

const SPEAK_THRESHOLD = 0.07;
const HANGOVER_MS = 250;

/** One AudioContext, two analysers (mic + agent), ONE rAF loop writing `voiceLevels`. No per-frame allocation. */
export class LevelMeter {
  private ctx: AudioContext | null = null;
  private mic: Channel | null = null;
  private agent: Channel | null = null;
  private bus: GainNode | null = null;
  private raf = 0;
  private last = 0;
  private lastLoud = 0;
  private speaking = false;
  private disposed = false;
  muted = false;

  constructor(private onSpeaking: (speaking: boolean) => void) {}

  /** The shared AudioContext (created lazily; create it inside a click handler for autoplay). */
  context(): AudioContext | null {
    if (this.disposed) return null;
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      this.ctx = new Ctor();
    }
    return this.ctx;
  }

  private channel(stream: MediaStream): Channel | null {
    const ctx = this.context();
    if (!ctx || !stream.getAudioTracks().length) return null;
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    an.smoothingTimeConstant = 0.6;
    const src = ctx.createMediaStreamSource(stream);
    src.connect(an); // analysis only: never routed to the speakers
    return this.finish(ctx, an, src, stream);
  }

  private finish(ctx: AudioContext, an: AnalyserNode, src: AudioNode, stream: MediaStream | null): Channel {
    const hz = ctx.sampleRate / an.fftSize;
    const r = (a: number, b: number): [number, number] => [Math.max(1, Math.floor(a / hz)), Math.max(2, Math.ceil(b / hz))];
    return {
      src,
      an,
      stream,
      freq: new Uint8Array(an.frequencyBinCount),
      td: new Float32Array(an.fftSize),
      lo: r(80, 300),
      mid: r(300, 2000),
      hi: r(2000, 6000),
    };
  }

  private drop(ch: Channel | null) {
    if (!ch) return;
    try {
      ch.src.disconnect();
      ch.an.disconnect();
    } catch {
      /* already gone */
    }
  }

  setMic(stream: MediaStream | undefined) {
    if (!stream || this.mic?.stream === stream) return;
    this.drop(this.mic);
    this.mic = this.channel(stream);
  }

  /** Playback bus for synthesized speech: connect AudioBufferSourceNodes here; it feeds the speakers and the agent analyser. */
  agentBus(): GainNode | null {
    const ctx = this.context();
    if (!ctx) return null;
    if (!this.bus) {
      const bus = ctx.createGain();
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      an.smoothingTimeConstant = 0.6;
      bus.connect(ctx.destination);
      bus.connect(an);
      this.bus = bus;
      this.agent = this.finish(ctx, an, bus, null);
    }
    return this.bus;
  }

  setAgent(stream: MediaStream | undefined) {
    if (this.agent && (!stream || this.agent.stream === stream)) {
      if (!stream) {
        this.drop(this.agent);
        this.agent = null;
      }
      return;
    }
    this.drop(this.agent);
    this.agent = stream ? this.channel(stream) : null;
  }

  /** Browsers suspend contexts until a gesture or after the tab was hidden. */
  resume() {
    void this.ctx?.resume().catch(() => {});
  }

  start() {
    this.resume();
    if (this.raf || this.disposed) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  private tick = (now: number) => {
    this.raf = requestAnimationFrame(this.tick);
    const dt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;

    const micLevel = this.mic && !this.muted ? this.measure(this.mic, voiceLevels.micBands, voiceLevels.mic, dt) : this.decay(voiceLevels.micBands, dt);
    voiceLevels.mic = micLevel;
    voiceLevels.agent = this.agent ? this.measure(this.agent, voiceLevels.agentBands, voiceLevels.agent, dt) : this.decay(voiceLevels.agentBands, dt);

    if (micLevel > SPEAK_THRESHOLD) this.lastLoud = now;
    const speaking = now - this.lastLoud < HANGOVER_MS && this.lastLoud > 0;
    if (speaking !== this.speaking) {
      this.speaking = speaking;
      this.onSpeaking(speaking);
    }
  };

  private smooth(prev: number, next: number, dt: number) {
    const tau = next > prev ? 0.04 : 0.14;
    return prev + (next - prev) * (1 - Math.exp(-dt / tau));
  }

  private band(freq: Uint8Array, [a, b]: [number, number]) {
    const hi = Math.min(b, freq.length - 1);
    let sum = 0;
    for (let i = a; i <= hi; i++) sum += freq[i];
    return Math.min(1, (sum / (hi - a + 1) / 255) * 1.8);
  }

  private measure(ch: Channel, bands: [number, number, number], prevLevel: number, dt: number) {
    ch.an.getByteFrequencyData(ch.freq);
    ch.an.getFloatTimeDomainData(ch.td);
    let sq = 0;
    for (let i = 0; i < ch.td.length; i++) sq += ch.td[i] * ch.td[i];
    const rms = Math.sqrt(sq / ch.td.length);
    bands[0] = this.smooth(bands[0], this.band(ch.freq, ch.lo), dt);
    bands[1] = this.smooth(bands[1], this.band(ch.freq, ch.mid), dt);
    bands[2] = this.smooth(bands[2], this.band(ch.freq, ch.hi), dt);
    return this.smooth(prevLevel, Math.min(1, rms * 5), dt);
  }

  private decay(bands: [number, number, number], dt: number) {
    for (let i = 0; i < 3; i++) bands[i] = this.smooth(bands[i], 0, dt);
    return Math.max(bands[0], bands[1], bands[2]) < 0.002 ? 0 : (bands[0] + bands[1] + bands[2]) / 3;
  }

  dispose() {
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.drop(this.mic);
    this.drop(this.agent);
    this.mic = this.agent = null;
    this.bus = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    zeroLevels();
    if (this.speaking) this.onSpeaking(false);
  }
}

export function zeroLevels() {
  voiceLevels.mic = 0;
  voiceLevels.agent = 0;
  for (let i = 0; i < 3; i++) {
    voiceLevels.micBands[i] = 0;
    voiceLevels.agentBands[i] = 0;
  }
}
