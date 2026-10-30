// Receiver-side radio effect: band-limited, compressed and slightly driven voice with a
// static bed and Crew Chief bleeps when the channel opens and closes.
//
// Signal flow:
//   remote voice -> highpass -> lowpass -> auto level -> compressor -> drive (level-compensated) -> voice gain -> gate -> master
//   static noise -> bandpass -> static gain ---------------------------------------------------------^
//   bleeps / busy tone -> bleep gain ----------------------------------------------------------------^
//   master -> limiter -> speakers (or an <audio> element on iOS, see `output`)

export const CC_SOUND_NAMES = [
  'start_bleep',
  'end_bleep',
  'listen_start_sound',
  'listen_end_sound',
] as const;
export type CcSoundName = (typeof CC_SOUND_NAMES)[number];

export interface RadioFxSettings {
  /** Master volume for everything the radio plays, 0..1.5 */
  volume: number;
  /** Voice level, 0..1.5 */
  voice: number;
  /** Bleeps and busy tone level, 0..1.5 */
  bleeps: number;
  /** Static/hiss level while the channel is open, 0..1 */
  staticLevel: number;
  /** Distortion amount, 0..1. Level-compensated, so it changes character, not loudness. */
  drive: number;
  /** Radio bandwidth, 0 = narrow walkie-talkie .. 1 = wide and clear */
  band: number;
  /** Automatic voice leveling, 0 = off .. 1 = bring every talker to the same loudness */
  level: number;
}

export const DEFAULT_FX: RadioFxSettings = {
  volume: 1,
  voice: 0.8,
  bleeps: 0.7,
  staticLevel: 0.25,
  drive: 0.35,
  band: 0.4,
  level: 0.7,
};

/** Allowed range of each setting, for sliders and for validating stored values. */
export const FX_RANGES: Record<keyof RadioFxSettings, [min: number, max: number]> = {
  volume: [0, 1.5],
  voice: [0, 1.5],
  bleeps: [0, 1.5],
  staticLevel: [0, 1],
  drive: [0, 1],
  band: [0, 1],
  level: [0, 1],
};

/** How long the channel stays open after the far side releases, so the voice tail isn't clipped. */
export const RX_TAIL_MS = 180;

const STATIC_PEAK = 0.06;

// Auto level: measured on the filtered voice before any gain, as RMS in dBFS.
/** Speech level every talker is brought to */
const LEVEL_TARGET_DB = -20;
/** Below this it's a pause or background noise: hold the gain rather than boost it */
const LEVEL_SPEECH_FLOOR_DB = -55;
const LEVEL_MAX_BOOST_DB = 24;
const LEVEL_MAX_CUT_DB = -12;
const LEVEL_FRAME_MS = 50;

export interface RadioFxOptions {
  /**
   * 'destination' plays straight to the AudioContext (desktop, supports setSinkId).
   * 'element' plays through an <audio> element instead. iOS Safari is silent or routes to the
   * earpiece when Web Audio plays to ctx.destination while the microphone is open.
   */
  output?: 'destination' | 'element';
}

export class RadioFx {
  readonly ctx: AudioContext;
  readonly rxAnalyser: AnalyserNode;
  private master: GainNode;
  private voiceIn: GainNode;
  private hp: BiquadFilterNode;
  private lp: BiquadFilterNode;
  private shaper: WaveShaperNode;
  private curveDrive = -1;
  private voiceGain: GainNode;
  private voiceGate: GainNode;
  private levelGain: GainNode;
  private levelDetector: AnalyserNode;
  private levelBuf: Float32Array<ArrayBuffer>;
  /** Smoothed loudness of the talker's speech, and the correction currently applied */
  private speechDb = LEVEL_TARGET_DB;
  private levelDb = 0;
  private staticGain: GainNode;
  private bleepGain: GainNode;
  private outEl: HTMLAudioElement | null = null;
  /** Remote voices (from RemoteAudio), summed into the voice chain */
  private remotes = new Map<string, AudioNode>();
  private sounds = new Map<CcSoundName, AudioBuffer>();
  private settings: RadioFxSettings = { ...DEFAULT_FX };
  private open = false;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: AudioContext, opts: RadioFxOptions = {}) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    // Safety limiter on everything we play: a sudden loud moment can't blast the listener or clip
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.1;
    this.master.connect(limiter);
    if (opts.output === 'element') {
      const dest = ctx.createMediaStreamDestination();
      limiter.connect(dest);
      const el = new Audio();
      el.setAttribute('playsinline', '');
      el.autoplay = true;
      el.srcObject = dest.stream;
      this.outEl = el;
    } else {
      limiter.connect(ctx.destination);
    }

    this.voiceIn = ctx.createGain();
    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.Q.value = 0.9;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.Q.value = 0.9;
    const presence = ctx.createBiquadFilter();
    presence.type = 'peaking';
    presence.frequency.value = 1800;
    presence.gain.value = 3;
    // Compress first so the drive stage sees a steady level regardless of how loud the talker is
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -30;
    comp.knee.value = 6;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.15;
    const makeup = ctx.createGain();
    makeup.gain.value = 2;
    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = '2x';
    this.voiceGain = ctx.createGain();
    this.voiceGate = ctx.createGain();
    this.voiceGate.gain.value = 0;
    this.rxAnalyser = ctx.createAnalyser();
    this.rxAnalyser.fftSize = 512;
    this.levelGain = ctx.createGain();
    this.levelDetector = ctx.createAnalyser();
    this.levelDetector.fftSize = 2048;
    this.levelBuf = new Float32Array(this.levelDetector.fftSize);

    this.voiceIn.connect(this.hp).connect(this.lp);
    this.lp.connect(this.levelDetector);
    this.lp
      .connect(this.levelGain)
      .connect(presence)
      .connect(comp)
      .connect(makeup)
      .connect(this.shaper)
      .connect(this.voiceGain)
      .connect(this.voiceGate);
    this.voiceGate.connect(this.rxAnalyser);
    this.voiceGate.connect(this.master);

    // Static bed: looped noise, band-limited to the radio band
    const noise = ctx.createBufferSource();
    noise.buffer = makeNoise(ctx, 2);
    noise.loop = true;
    const nbp = ctx.createBiquadFilter();
    nbp.type = 'bandpass';
    nbp.frequency.value = 2200;
    nbp.Q.value = 0.6;
    this.staticGain = ctx.createGain();
    this.staticGain.gain.value = 0;
    noise.connect(nbp).connect(this.staticGain).connect(this.master);
    noise.start();

    this.bleepGain = ctx.createGain();
    this.bleepGain.connect(this.master);

    this.applySettings(this.settings);
    setInterval(() => this.updateLevel(), LEVEL_FRAME_MS);
  }

  /** Current auto-level correction in dB (positive = boosting a quiet talker). */
  get levelCorrectionDb(): number {
    return this.levelDb;
  }

  /**
   * Auto level: like a radio operator riding the fader. Tracks how loud the talker's speech is
   * and moves the gain towards the target: down quickly (no blasting), up slowly (no pumping).
   * Pauses and noise don't count, and the gain is kept between transmissions.
   */
  private updateLevel(): void {
    const amount = this.settings.level;
    if (amount === 0) {
      if (this.levelDb !== 0) {
        this.levelDb = 0;
        this.levelGain.gain.setTargetAtTime(1, this.ctx.currentTime, 0.05);
      }
      return;
    }
    if (!this.open) return;
    this.levelDetector.getFloatTimeDomainData(this.levelBuf);
    let sum = 0;
    for (let i = 0; i < this.levelBuf.length; i++) sum += this.levelBuf[i] * this.levelBuf[i];
    const rmsDb = 10 * Math.log10(sum / this.levelBuf.length + 1e-12);
    if (rmsDb < LEVEL_SPEECH_FLOOR_DB) return;
    // Follow speech peaks quickly and its dips slowly, so syllable gaps don't read as "quiet"
    this.speechDb += (rmsDb - this.speechDb) * (rmsDb > this.speechDb ? 0.3 : 0.04);
    const wanted = Math.min(LEVEL_MAX_BOOST_DB, Math.max(LEVEL_MAX_CUT_DB, LEVEL_TARGET_DB - this.speechDb)) * amount;
    this.levelDb += (wanted - this.levelDb) * (wanted < this.levelDb ? 0.35 : 0.08);
    this.levelGain.gain.setTargetAtTime(10 ** (this.levelDb / 20), this.ctx.currentTime, 0.04);
  }

  /**
   * Call from a user gesture (tap/click). Resumes the context and, on iOS, starts the
   * output element. Safe to call repeatedly.
   */
  unlock(): void {
    if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => {});
    if (this.outEl?.paused) void this.outEl.play().catch(() => {});
  }

  applySettings(s: Partial<RadioFxSettings>): void {
    this.settings = clampFx({ ...this.settings, ...s });
    const { volume, voice, bleeps, drive, band } = this.settings;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(volume, t, 0.02);
    this.voiceGain.gain.setTargetAtTime(voice, t, 0.02);
    this.bleepGain.gain.setTargetAtTime(bleeps, t, 0.02);
    if (drive !== this.curveDrive) {
      this.shaper.curve = makeDriveCurve(drive);
      this.curveDrive = drive;
    }
    // Band: narrow 500-2300 Hz up to wide 150-6000 Hz
    this.hp.frequency.setTargetAtTime(500 - band * 350, t, 0.02);
    this.lp.frequency.setTargetAtTime(2300 + band * 3700, t, 0.02);
    if (this.open) this.staticGain.gain.setTargetAtTime(this.staticTarget(), t, 0.02);
  }

  getSettings(): RadioFxSettings {
    return { ...this.settings };
  }

  /** Decode Crew Chief .wav files. Missing names fall back to synthesized bleeps. */
  async loadSounds(files: Partial<Record<CcSoundName, ArrayBuffer>>): Promise<CcSoundName[]> {
    const loaded: CcSoundName[] = [];
    for (const name of CC_SOUND_NAMES) {
      const data = files[name];
      if (!data) continue;
      try {
        // decodeAudioData detaches the buffer, so hand it a copy
        this.sounds.set(name, await this.ctx.decodeAudioData(data.slice(0)));
        loaded.push(name);
      } catch (err) {
        console.warn(`[radio] could not decode ${name}`, err);
      }
    }
    return loaded;
  }

  hasSound(name: CcSoundName): boolean {
    return this.sounds.has(name);
  }

  /** Add a remote voice (a node from RemoteAudio). Several can play at once; the gate opens on floor. */
  addRemote(id: string, node: AudioNode): void {
    this.removeRemote(id);
    node.connect(this.voiceIn);
    this.remotes.set(id, node);
  }

  removeRemote(id: string): void {
    const node = this.remotes.get(id);
    if (!node) return;
    try {
      node.disconnect(this.voiceIn);
    } catch {
      /* already disconnected */
    }
    this.remotes.delete(id);
  }

  /** The far side keyed up. */
  openChannel(): void {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    if (this.open) return;
    this.open = true;
    const t = this.ctx.currentTime;
    this.play('start_bleep');
    this.staticGain.gain.cancelScheduledValues(t);
    this.staticGain.gain.setTargetAtTime(this.staticTarget(), t, 0.015);
    this.voiceGate.gain.cancelScheduledValues(t);
    this.voiceGate.gain.setTargetAtTime(1, t, 0.01);
  }

  /** The far side released. The channel closes after a short tail (longer for relayed audio). */
  closeChannel(immediate = false, tailMs = RX_TAIL_MS): void {
    if (!this.open || this.closeTimer) return;
    const doClose = () => {
      this.closeTimer = null;
      this.open = false;
      const t = this.ctx.currentTime;
      this.voiceGate.gain.cancelScheduledValues(t);
      this.voiceGate.gain.setTargetAtTime(0, t, 0.01);
      this.staticGain.gain.cancelScheduledValues(t);
      this.staticGain.gain.setTargetAtTime(0, t, 0.03);
      this.play('end_bleep');
    };
    if (immediate) doClose();
    else this.closeTimer = setTimeout(doClose, tailMs);
  }

  isOpen(): boolean {
    return this.open;
  }

  /** Play a cue sound locally, with a synthesized fallback when the CC file isn't loaded. */
  play(name: CcSoundName): void {
    const buf = this.sounds.get(name);
    if (buf) {
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.bleepGain);
      src.start();
      return;
    }
    const t = this.ctx.currentTime;
    switch (name) {
      case 'start_bleep':
        this.tone(1250, t, 0.07);
        break;
      case 'end_bleep':
        this.tone(1250, t, 0.05);
        this.tone(900, t + 0.07, 0.07);
        break;
      case 'listen_start_sound':
        this.tone(880, t, 0.05, 0.12);
        break;
      case 'listen_end_sound':
        this.tone(660, t, 0.05, 0.12);
        break;
    }
  }

  /** "Channel busy": three short low beeps. */
  playBusy(): void {
    const t = this.ctx.currentTime;
    for (let i = 0; i < 3; i++) this.tone(420, t + i * 0.13, 0.08, 0.18, 'square');
  }

  private staticTarget(): number {
    return this.settings.staticLevel * STATIC_PEAK;
  }

  private tone(freq: number, at: number, dur: number, level = 0.22, type: OscillatorType = 'sine'): void {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(level, at + 0.005);
    g.gain.setValueAtTime(level, at + dur - 0.01);
    g.gain.linearRampToValueAtTime(0, at + dur);
    osc.connect(g).connect(this.bleepGain);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }
}

/** Fill in missing keys and clamp to FX_RANGES (stored settings may be old or hand-edited). */
export function clampFx(s: Partial<RadioFxSettings>): RadioFxSettings {
  const out = { ...DEFAULT_FX };
  for (const key of Object.keys(FX_RANGES) as (keyof RadioFxSettings)[]) {
    const v = s[key];
    const [min, max] = FX_RANGES[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = Math.min(max, Math.max(min, v));
  }
  return out;
}

function makeNoise(ctx: AudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    let v = Math.random() * 2 - 1;
    // Sparse crackles on top of the hiss
    if (Math.random() < 0.0004) v *= 4;
    d[i] = v * 0.5;
  }
  return buf;
}

/**
 * tanh soft clipper. The WaveShaper maps input -1..1 onto the curve. More drive pushes
 * harder into saturation; dividing by k^0.85 keeps loudness roughly constant, so grit
 * changes the character of the voice, not its volume.
 */
function makeDriveCurve(drive: number): Float32Array<ArrayBuffer> {
  const n = 2048;
  const k = 1 + drive * 9;
  const comp = Math.pow(k, 0.85);
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / comp;
  }
  return curve;
}

/** Peak level 0..1 from an analyser, for the rev-light meters. */
export function readLevel(an: AnalyserNode, buf: Float32Array<ArrayBuffer>): number {
  an.getFloatTimeDomainData(buf);
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs(buf[i]);
    if (v > peak) peak = v;
  }
  return Math.min(1, peak * 1.4);
}
