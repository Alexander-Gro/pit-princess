// One owner per remote WebRTC audio stream: a single MediaStreamSource that the radio effect
// and the PC's relay mixer both connect to, so removing it from one can't cut the other.

export class RemoteAudio {
  private ctx: AudioContext;
  private entries = new Map<string, { el: HTMLAudioElement; source: MediaStreamAudioSourceNode }>();

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
  }

  /** Attach (or replace, or with null remove) the stream for a member. Returns its audio node. */
  set(id: string, stream: MediaStream | null): MediaStreamAudioSourceNode | null {
    this.remove(id);
    if (!stream) return null;
    // Chrome only feeds a remote WebRTC stream into Web Audio if a media element is also playing it.
    const el = new Audio();
    el.muted = true;
    el.setAttribute('playsinline', '');
    el.srcObject = stream;
    el.play().catch(() => {});
    const source = this.ctx.createMediaStreamSource(stream);
    this.entries.set(id, { el, source });
    return source;
  }

  remove(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.source.disconnect();
    e.el.srcObject = null;
    this.entries.delete(id);
  }
}
