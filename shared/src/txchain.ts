// Transmit-side mic processing: level control, adaptive feedback (howl) suppression and a
// safety limiter. Used by the PC, whose mic can hear the phone's speaker when both are in
// the same room: PC mic -> phone speaker -> PC mic is an acoustic loop that echo
// cancellation can't break, because the PC didn't play that sound itself.
//
// Howl detection: feedback is a single frequency that stays put and towers over the rest of
// the spectrum. Speech pitch moves around constantly. When a narrow peak sits in the same
// place for a few frames, a deep, very narrow notch is parked on it.

/** 'strong' = RNNoise AI model, 'standard' = the browser's built-in suppression */
export type NoiseMode = 'off' | 'standard' | 'strong';
export const NOISE_MODES: NoiseMode[] = ['strong', 'standard', 'off'];

/** getUserMedia audio constraints for a noise mode. RNNoise replaces, not stacks on, the browser's. */
export function micConstraints(deviceId: string, noise: NoiseMode, autoGain = false): MediaTrackConstraints {
  return {
    deviceId: deviceId === 'default' ? undefined : { exact: deviceId },
    echoCancellation: true,
    noiseSuppression: noise === 'standard',
    // Off on the PC: auto gain raises the mic whenever it's quiet, which makes room feedback start sooner
    autoGainControl: autoGain,
  };
}

/** Creates the noise-suppression node (see noise.ts) */
export type NoiseNodeFactory = () => AudioNode & { destroy?(): void };

export interface TxOptions {
  noiseNode?: NoiseNodeFactory | null;
}

export interface TxSettings {
  /** Mic level, 0..2 */
  micGain: number;
  feedbackSuppression: boolean;
}

export const DEFAULT_TX: TxSettings = { micGain: 1, feedbackSuppression: true };

const NOTCHES = 8;
const NOTCH_DEPTH_DB = -30;
const NOTCH_Q = 30;
/** A notch nobody re-triggers is lifted after this long */
const NOTCH_HOLD_MS = 45_000;
const FRAME_MS = 40;
/** Consecutive frames a peak must hold still before it counts as feedback (~160 ms) */
const PERSIST_FRAMES = 4;
const MIN_PEAK_DB = -50;
const PEAK_OVER_MEAN_DB = 28;
const PEAK_OVER_NEIGHBOURS_DB = 10;
const F_MIN = 150;
const F_MAX = 8000;

interface Notch {
  filter: BiquadFilterNode;
  freq: number;
  active: boolean;
  lastHit: number;
}

export class TxProcessor {
  readonly analyser: AnalyserNode;
  readonly track: MediaStreamTrack;
  private ctx: AudioContext;
  private source: MediaStreamAudioSourceNode;
  private gain: GainNode;
  private noiseNode: (AudioNode & { destroy?(): void }) | null = null;
  private notches: Notch[] = [];
  private detector: AnalyserNode;
  private spectrum: Float32Array<ArrayBuffer>;
  private timer: ReturnType<typeof setInterval>;
  private candidateBin = -1;
  private candidateFrames = 0;
  private active = false;
  private settings: TxSettings = { ...DEFAULT_TX };
  /** Called with the number of active notches whenever it changes */
  onNotches?: (count: number) => void;

  constructor(ctx: AudioContext, mic: MediaStream, opts: TxOptions = {}) {
    this.ctx = ctx;
    this.source = ctx.createMediaStreamSource(mic);
    this.noiseNode = opts.noiseNode?.() ?? null;
    this.gain = ctx.createGain();
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 90;

    let node: AudioNode = hp;
    for (let i = 0; i < NOTCHES; i++) {
      // A peaking filter at 0 dB is transparent; it becomes a notch when activated
      const f = ctx.createBiquadFilter();
      f.type = 'peaking';
      f.Q.value = NOTCH_Q;
      f.gain.value = 0;
      f.frequency.value = 1000;
      node.connect(f);
      node = f;
      this.notches.push({ filter: f, freq: 0, active: false, lastHit: 0 });
    }

    this.detector = ctx.createAnalyser();
    this.detector.fftSize = 4096;
    this.detector.smoothingTimeConstant = 0;
    this.spectrum = new Float32Array(this.detector.frequencyBinCount);

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.1;

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    const dest = ctx.createMediaStreamDestination();

    if (this.noiseNode) this.source.connect(this.noiseNode).connect(this.gain);
    else this.source.connect(this.gain);
    this.gain.connect(hp);
    node.connect(this.detector);
    node.connect(limiter).connect(this.analyser);
    limiter.connect(dest);

    this.track = dest.stream.getAudioTracks()[0];
    this.track.enabled = false;
    this.timer = setInterval(() => this.detect(), FRAME_MS);
  }

  applySettings(s: Partial<TxSettings>): void {
    this.settings = { ...this.settings, ...s };
    this.gain.gain.setTargetAtTime(Math.max(0, Math.min(2, this.settings.micGain)), this.ctx.currentTime, 0.02);
    if (!this.settings.feedbackSuppression) this.clearNotches();
  }

  /** True when the RNNoise model is in the chain */
  get aiNoiseReduction(): boolean {
    return this.noiseNode !== null;
  }

  /** Only listen for feedback while transmitting; other room noise is irrelevant then. */
  setActive(on: boolean): void {
    this.active = on;
    this.candidateFrames = 0;
  }

  activeNotches(): number {
    return this.notches.filter((n) => n.active).length;
  }

  clearNotches(): void {
    for (const n of this.notches) this.release(n);
    this.onNotches?.(0);
  }

  dispose(): void {
    clearInterval(this.timer);
    this.source.disconnect();
    this.noiseNode?.disconnect();
    this.noiseNode?.destroy?.();
    this.track.stop();
  }

  private detect(): void {
    const now = performance.now();
    let changed = false;
    for (const n of this.notches) {
      if (n.active && now - n.lastHit > NOTCH_HOLD_MS) {
        this.release(n);
        changed = true;
      }
    }
    if (changed) this.onNotches?.(this.activeNotches());
    if (!this.active || !this.settings.feedbackSuppression) return;

    this.detector.getFloatFrequencyData(this.spectrum);
    const binHz = this.ctx.sampleRate / this.detector.fftSize;
    const lo = Math.max(3, Math.floor(F_MIN / binHz));
    const hi = Math.min(this.spectrum.length - 4, Math.ceil(F_MAX / binHz));

    let peakBin = -1;
    let peak = -Infinity;
    let sum = 0;
    for (let i = lo; i <= hi; i++) {
      const v = this.spectrum[i];
      sum += v;
      if (v > peak) {
        peak = v;
        peakBin = i;
      }
    }
    const mean = sum / (hi - lo + 1);
    const neighbours = Math.max(this.spectrum[peakBin - 3], this.spectrum[peakBin + 3]);
    const tonal =
      peak > MIN_PEAK_DB && peak - mean > PEAK_OVER_MEAN_DB && peak - neighbours > PEAK_OVER_NEIGHBOURS_DB;

    if (!tonal) {
      this.candidateFrames = 0;
      return;
    }
    if (Math.abs(peakBin - this.candidateBin) <= 1) this.candidateFrames++;
    else {
      this.candidateBin = peakBin;
      this.candidateFrames = 1;
    }
    if (this.candidateFrames < PERSIST_FRAMES) return;
    this.candidateFrames = 0;
    this.placeNotch(peakBin * binHz, now);
  }

  private placeNotch(freq: number, now: number): void {
    // Already notched nearby (within ~1/12 octave)? Deepen and widen it slightly instead.
    const near = this.notches.find((n) => n.active && Math.abs(Math.log2(freq / n.freq)) < 1 / 12);
    if (near) {
      near.lastHit = now;
      const g = Math.max(-45, near.filter.gain.value - 6);
      near.filter.gain.setTargetAtTime(g, this.ctx.currentTime, 0.005);
      near.filter.Q.setTargetAtTime(Math.max(12, near.filter.Q.value * 0.8), this.ctx.currentTime, 0.005);
      return;
    }
    // Free slot, or recycle the one that has been quiet the longest
    const slot =
      this.notches.find((n) => !n.active) ?? this.notches.reduce((a, b) => (a.lastHit < b.lastHit ? a : b));
    slot.active = true;
    slot.freq = freq;
    slot.lastHit = now;
    slot.filter.frequency.setValueAtTime(freq, this.ctx.currentTime);
    slot.filter.Q.setValueAtTime(NOTCH_Q, this.ctx.currentTime);
    slot.filter.gain.setTargetAtTime(NOTCH_DEPTH_DB, this.ctx.currentTime, 0.005);
    this.onNotches?.(this.activeNotches());
  }

  private release(n: Notch): void {
    n.active = false;
    n.filter.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
  }
}
