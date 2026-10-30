// PC-side relay: builds what each phone hears.
//
// For every phone B there's one output track that mixes
//   - the PC's own mic (the link mutes that track unless the PC transmits), and
//   - every other phone A's received audio, through a gate that is only open while A holds
//     the floor (plus a short tail, because audio arrives after the floor message).
// Phones never connect to each other; the PC is the hub. The relay is raw audio: each phone
// applies its own radio effect, exactly as it does for the PC's voice.

/** Keep a phone's relay open this long after it releases the floor, so its last words get through */
export const RELAY_TAIL_MS = 300;

interface Output {
  dest: MediaStreamAudioDestinationNode;
}

interface Relay {
  gate: GainNode;
  /** Our own record of the gate (gain.value lags the schedule and can't be trusted for this) */
  open: boolean;
  closeTimer: ReturnType<typeof setTimeout> | null;
}

export class PcMixer {
  private ctx: AudioContext;
  private pcBus: GainNode;
  private pcSource: MediaStreamAudioSourceNode | null = null;
  private outputs = new Map<string, Output>();
  private relays = new Map<string, Relay>();
  private floor = 'idle';
  private relayEnabled = true;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.pcBus = ctx.createGain();
  }

  /** The PC's outgoing mic track (TxProcessor output). Call again whenever the mic is reopened. */
  setPcTrack(track: MediaStreamTrack | null): void {
    this.pcSource?.disconnect();
    this.pcSource = null;
    if (!track) return;
    this.pcSource = this.ctx.createMediaStreamSource(new MediaStream([track]));
    this.pcSource.connect(this.pcBus);
  }

  /** The track to send to phone `id`. Created on first use. */
  outputFor(id: string): MediaStreamTrack {
    let out = this.outputs.get(id);
    if (!out) {
      const dest = this.ctx.createMediaStreamDestination();
      dest.channelCount = 1;
      dest.channelCountMode = 'explicit';
      this.pcBus.connect(dest);
      // Everyone else's relay goes into this phone's mix, but never its own voice
      for (const [rid, r] of this.relays) if (rid !== id) r.gate.connect(dest);
      out = { dest };
      this.outputs.set(id, out);
    }
    return out.dest.stream.getAudioTracks()[0];
  }

  /** A phone's received audio (from RemoteAudio). */
  addRemote(id: string, node: AudioNode): void {
    this.removeRemote(id);
    const gate = this.ctx.createGain();
    gate.gain.value = 0;
    node.connect(gate);
    for (const [oid, out] of this.outputs) if (oid !== id) gate.connect(out.dest);
    this.relays.set(id, { gate, open: false, closeTimer: null });
    this.applyGates();
  }

  removeRemote(id: string): void {
    const r = this.relays.get(id);
    if (!r) return;
    if (r.closeTimer) clearTimeout(r.closeTimer);
    r.gate.disconnect();
    this.relays.delete(id);
  }

  /** The phone left: drop its output and its relay. */
  removePhone(id: string): void {
    this.removeRemote(id);
    const out = this.outputs.get(id);
    if (!out) return;
    this.pcBus.disconnect(out.dest);
    for (const r of this.relays.values()) {
      try {
        r.gate.disconnect(out.dest);
      } catch {
        /* wasn't connected */
      }
    }
    out.dest.stream.getTracks().forEach((t) => t.stop());
    this.outputs.delete(id);
  }

  /** Who holds the floor: only that phone's relay is open. */
  setFloor(holder: string): void {
    this.floor = holder;
    this.applyGates();
  }

  /** Turn phone-to-phone relaying on/off (off avoids howling when both phones share a room). */
  setRelayEnabled(on: boolean): void {
    this.relayEnabled = on;
    this.applyGates();
  }

  private applyGates(): void {
    const t = this.ctx.currentTime;
    for (const [id, r] of this.relays) {
      const open = this.relayEnabled && this.floor === id;
      if (open) {
        if (r.closeTimer) {
          clearTimeout(r.closeTimer);
          r.closeTimer = null;
        }
        r.open = true;
        r.gate.gain.setTargetAtTime(1, t, 0.01);
      } else if (r.open) {
        // Turning the relay off is immediate; a floor release keeps a short tail
        if (r.closeTimer && this.relayEnabled) continue;
        if (r.closeTimer) clearTimeout(r.closeTimer);
        const close = () => {
          r.closeTimer = null;
          if (this.relayEnabled && this.floor === id) return;
          r.open = false;
          r.gate.gain.setTargetAtTime(0, this.ctx.currentTime, 0.01);
        };
        if (this.relayEnabled) r.closeTimer = setTimeout(close, RELAY_TAIL_MS);
        else close();
      }
    }
  }
}
