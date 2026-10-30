// RadioLink: signaling socket + WebRTC peer + push-to-talk floor control.
// Used by both the phone PWA and the desktop app; only the role differs.

import type { ClientMsg, FloorHolder, PushSub, Role, ServerMsg, SignalData } from './protocol.ts';
import type { RadioFx } from './radio.ts';

/** Keep the mic open briefly after PTT release so the last syllable isn't clipped. */
export const TX_TAIL_MS = 150;

export type PeerStatus = 'none' | 'connecting' | 'connected' | 'failed';

export interface LinkState {
  signaling: 'connecting' | 'open' | 'closed';
  peerPresent: boolean;
  peer: PeerStatus;
  floor: FloorHolder;
  /** We hold the floor and the mic is live. */
  tx: boolean;
  /** The far side holds the floor. */
  rx: boolean;
  /** PTT is held but the floor hasn't been granted yet. */
  pending: boolean;
  rttMs: number | null;
  route: 'direct' | 'relay' | null;
  error: string | null;
}

export interface RadioLinkOptions {
  role: Role;
  /** ws:// or wss:// URL of the signaling endpoint */
  wsUrl: string;
  room: string;
  /** Server access key, if the server requires one */
  accessKey?: string;
  fx: RadioFx;
  onChange?: (s: LinkState) => void;
  /** JSON messages from the peer's data channel */
  onData?: (msg: unknown) => void;
  /** Our data channel to the peer is open */
  onDataOpen?: () => void;
  /** A pairing code the server created for this room (PC only) */
  onPairCode?: (code: string, expiresInMs: number) => void;
  /** We (re)entered the room: the server accepted our host/join */
  onWelcome?: (peerPresent: boolean) => void;
  /** Result of announce(): push subscriptions the push service reported gone */
  onAnnounced?: (sent: number, gone: string[]) => void;
}

export class RadioLink {
  private opts: RadioLinkOptions;
  private role: Role;
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private iceServers: RTCIceServer[] = [];
  private pendingIce: RTCIceCandidateInit[] = [];
  private micTrack: MediaStreamTrack | null = null;
  private txWanted = false;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private backoff = 1000;
  private stopped = false;
  private state: LinkState = {
    signaling: 'connecting',
    peerPresent: false,
    peer: 'none',
    floor: 'idle',
    tx: false,
    rx: false,
    pending: false,
    rttMs: null,
    route: null,
    error: null,
  };

  constructor(opts: RadioLinkOptions) {
    this.opts = opts;
    this.role = opts.role;
  }

  get other(): Role {
    return this.role === 'pc' ? 'phone' : 'pc';
  }

  getState(): LinkState {
    return { ...this.state };
  }

  start(): void {
    this.stopped = false;
    this.connect();
    this.statsTimer = setInterval(() => void this.pollStats(), 2000);
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.reconnectTimer = this.restartTimer = this.releaseTimer = this.statsTimer = null;
    this.ws?.close();
    this.ws = null;
    this.teardownPeer();
    this.setMicEnabled(false);
    this.update({ signaling: 'closed', peerPresent: false, floor: 'idle', tx: false, rx: false, pending: false });
  }

  /** Set (or swap) the local microphone track. It is only enabled while we transmit. */
  setMicTrack(track: MediaStreamTrack | null): void {
    this.micTrack = track;
    if (track) track.enabled = this.state.tx;
    const sender = this.audioSender();
    if (sender) void sender.replaceTrack(track).catch((e) => console.warn('[link] replaceTrack', e));
  }

  /** Ask the server for a 6-digit pairing code (PC only). Arrives via onPairCode. */
  createPairCode(): boolean {
    if (this.role !== 'pc' || this.ws?.readyState !== WebSocket.OPEN) return false;
    this.send({ t: 'pair_create' });
    return true;
  }

  /** Tell the server we're online so it can notify these phones (PC only). */
  announce(subs: PushSub[]): boolean {
    if (this.role !== 'pc' || this.ws?.readyState !== WebSocket.OPEN || subs.length === 0) return false;
    this.send({ t: 'announce', subs });
    return true;
  }

  /** Kick the phone from the room (PC only). */
  kick(): void {
    this.send({ t: 'kick' });
  }

  sendData(msg: unknown): boolean {
    if (this.dc?.readyState !== 'open') return false;
    this.dc.send(JSON.stringify(msg));
    return true;
  }

  pttDown(): void {
    if (this.txWanted) return;
    this.txWanted = true;
    if (this.releaseTimer) {
      // Re-pressed during the tail: we still hold the floor, just keep talking.
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
      if (this.state.floor === this.role) return;
    }
    if (this.state.peer !== 'connected' || this.state.signaling !== 'open') {
      this.txWanted = false;
      this.opts.fx.playBusy();
      return;
    }
    if (this.state.floor === this.role) {
      this.beginTx();
      return;
    }
    this.update({ pending: true });
    this.send({ t: 'floor_request' });
  }

  /** `immediate` skips the tail, e.g. when the page is being hidden and timers may not run. */
  pttUp(immediate = false): void {
    if (!this.txWanted) return;
    this.txWanted = false;
    if (this.state.pending) {
      // Don't release here: if the grant is in flight, onFloor sees txWanted=false and
      // releases it. Releasing now could cancel a later re-press's grant.
      this.update({ pending: false });
      return;
    }
    if (!this.state.tx) return;
    const release = () => {
      this.releaseTimer = null;
      this.endTx();
      this.send({ t: 'floor_release' });
    };
    if (immediate) release();
    else this.releaseTimer = setTimeout(release, TX_TAIL_MS);
  }

  // ---- signaling ----

  private connect(): void {
    if (this.stopped) return;
    this.update({ signaling: 'connecting' });
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.wsUrl);
    } catch (e) {
      this.update({ error: `Bad server URL: ${String(e)}` });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 1000;
      this.update({ signaling: 'open', error: null });
      const key = this.opts.accessKey || undefined;
      this.send(this.role === 'pc' ? { t: 'host', room: this.opts.room, key } : { t: 'join', room: this.opts.room, key });
    };
    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      void this.onServerMsg(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      // The server releases the floor when our socket drops; mirror that locally.
      this.forceFloor('idle');
      this.update({ signaling: 'closed' });
      this.scheduleReconnect();
    };
    ws.onerror = () => {};
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, 10_000);
  }

  private send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private async onServerMsg(msg: ServerMsg): Promise<void> {
    switch (msg.t) {
      case 'welcome':
        this.iceServers = msg.iceServers;
        this.update({ peerPresent: msg.peerPresent });
        this.forceFloor(msg.floor);
        this.opts.onWelcome?.(msg.peerPresent);
        // The server told the phone peer_left when our socket dropped, so it has torn down
        // its side. Always start a fresh call even if our old connection still looks alive.
        if (this.role === 'pc' && msg.peerPresent) void this.startCall();
        break;
      case 'ice':
        this.iceServers = msg.iceServers;
        break;
      case 'announced':
        this.opts.onAnnounced?.(msg.sent, msg.gone);
        break;
      case 'pair_code':
        this.opts.onPairCode?.(msg.code, msg.expiresInMs);
        break;
      case 'peer_joined':
        this.update({ peerPresent: true });
        if (this.role === 'pc') void this.startCall();
        break;
      case 'peer_left':
        this.update({ peerPresent: false });
        this.teardownPeer();
        break;
      case 'signal':
        await this.onSignal(msg.data);
        break;
      case 'floor':
        this.onFloor(msg.holder);
        break;
      case 'busy':
        this.txWanted = false;
        this.update({ pending: false });
        this.opts.fx.playBusy();
        break;
      case 'kicked':
        this.stopped = true;
        this.ws?.close();
        this.teardownPeer();
        this.update({
          signaling: 'closed',
          peerPresent: false,
          error: msg.reason === 'replaced' ? 'Opened somewhere else' : 'Disconnected by the PC',
        });
        break;
      case 'error':
        if (msg.code === 'unauthorized') {
          // Retrying with the same key is pointless
          this.stopped = true;
          this.ws?.close();
          this.update({ signaling: 'closed', error: 'Wrong or missing access key' });
        } else if (msg.code === 'no_host') {
          // PC isn't online yet: keep retrying quietly.
          this.update({ peerPresent: false, error: null });
          this.ws?.close();
        } else this.update({ error: msg.code });
        break;
    }
  }

  // ---- floor ----

  private onFloor(holder: FloorHolder): void {
    const prev = this.state.floor;
    this.update({ floor: holder, pending: holder === this.role ? false : this.state.pending });

    if (holder === this.role && prev !== this.role) {
      if (this.txWanted) this.beginTx();
      else this.send({ t: 'floor_release' }); // released before the grant arrived
    } else if (prev === this.role && holder !== this.role) {
      // Server took the floor away (timeout, peer reset)
      if (this.releaseTimer) {
        clearTimeout(this.releaseTimer);
        this.releaseTimer = null;
      }
      this.txWanted = false;
      this.endTx();
    }

    if (holder === this.other && prev !== this.other) {
      this.opts.fx.openChannel();
      this.update({ rx: true });
    } else if (prev === this.other && holder !== this.other) {
      this.opts.fx.closeChannel();
      this.update({ rx: false });
    }
  }

  /** Reset floor without the usual cues (e.g. after a reconnect). */
  private forceFloor(holder: FloorHolder): void {
    if (this.releaseTimer) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
    if (holder !== this.role) {
      this.txWanted = false;
      this.setMicEnabled(false);
    }
    if (holder === this.other) this.opts.fx.openChannel();
    else this.opts.fx.closeChannel(true);
    this.update({ floor: holder, tx: holder === this.role && this.state.tx, rx: holder === this.other, pending: false });
  }

  private beginTx(): void {
    this.setMicEnabled(true);
    this.opts.fx.play('listen_start_sound');
    this.update({ tx: true, pending: false });
  }

  private endTx(): void {
    if (!this.state.tx) return;
    this.setMicEnabled(false);
    this.opts.fx.play('listen_end_sound');
    this.update({ tx: false });
  }

  private setMicEnabled(on: boolean): void {
    if (this.micTrack) this.micTrack.enabled = on;
  }

  // ---- WebRTC ----

  private newPeer(): RTCPeerConnection {
    this.teardownPeer();
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.pc = pc;
    this.update({ peer: 'connecting' });

    pc.onicecandidate = (ev) => {
      if (this.pc !== pc) return;
      this.send({ t: 'signal', data: { kind: 'ice', candidate: ev.candidate ? ev.candidate.toJSON() : null } });
    };
    pc.ontrack = (ev) => {
      if (this.pc !== pc) return;
      this.opts.fx.setRemoteStream(ev.streams[0] ?? new MediaStream([ev.track]));
    };
    pc.ondatachannel = (ev) => {
      if (this.pc !== pc) return;
      this.attachChannel(ev.channel);
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      const cs = pc.connectionState;
      if (cs === 'connected') this.update({ peer: 'connected' });
      else if (cs === 'failed') {
        this.update({ peer: 'failed', rttMs: null, route: null });
        // The PC drives the call, so it retries; the phone waits for a new offer.
        if (this.role === 'pc' && this.state.peerPresent && !this.restartTimer) {
          this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            if (this.state.peerPresent) void this.startCall();
          }, 1500);
        }
      } else if (cs === 'disconnected') this.update({ peer: 'connecting' });
    };
    return pc;
  }

  private attachChannel(dc: RTCDataChannel): void {
    this.dc = dc;
    // A channel from ondatachannel may already be open (and may or may not still get 'open'),
    // so fire once from whichever comes first.
    let fired = false;
    const opened = () => {
      if (fired || this.dc !== dc) return;
      fired = true;
      this.opts.onDataOpen?.();
    };
    dc.onopen = opened;
    if (dc.readyState === 'open') queueMicrotask(opened);
    dc.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      try {
        this.opts.onData?.(JSON.parse(ev.data));
      } catch {
        /* ignore malformed */
      }
    };
  }

  private async startCall(): Promise<void> {
    const pc = this.newPeer();
    try {
      const tr = pc.addTransceiver('audio', { direction: 'sendrecv' });
      this.attachChannel(pc.createDataChannel('fx'));
      await tr.sender.replaceTrack(this.micTrack);
      if (this.pc !== pc) return;
      const offer = await pc.createOffer();
      if (this.pc !== pc) return;
      await pc.setLocalDescription(offer);
      this.send({ t: 'signal', data: { kind: 'offer', sdp: offer.sdp ?? '' } });
    } catch (e) {
      console.warn('[link] offer failed', e);
    }
  }

  private async onSignal(data: SignalData): Promise<void> {
    try {
      if (data.kind === 'offer') {
        if (this.role !== 'phone') return;
        const pc = this.newPeer();
        await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
        const tr = pc.getTransceivers().find((t) => t.receiver.track.kind === 'audio');
        if (tr) {
          tr.direction = 'sendrecv';
          await tr.sender.replaceTrack(this.micTrack);
        }
        await this.flushIce(pc);
        const answer = await pc.createAnswer();
        if (this.pc !== pc) return;
        await pc.setLocalDescription(answer);
        this.send({ t: 'signal', data: { kind: 'answer', sdp: answer.sdp ?? '' } });
      } else if (data.kind === 'answer') {
        const pc = this.pc;
        if (this.role !== 'pc' || !pc || pc.signalingState !== 'have-local-offer') return;
        await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
        await this.flushIce(pc);
      } else if (data.kind === 'ice') {
        const pc = this.pc;
        if (!data.candidate) return;
        if (!pc || !pc.remoteDescription) this.pendingIce.push(data.candidate);
        else await pc.addIceCandidate(data.candidate);
      }
    } catch (e) {
      console.warn('[link] signal handling failed', e);
    }
  }

  private async flushIce(pc: RTCPeerConnection): Promise<void> {
    const queued = this.pendingIce;
    this.pendingIce = [];
    for (const c of queued) {
      try {
        await pc.addIceCandidate(c);
      } catch (e) {
        console.warn('[link] addIceCandidate', e);
      }
    }
  }

  private teardownPeer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.dc?.close();
    this.dc = null;
    this.pc?.close();
    this.pc = null;
    this.pendingIce = [];
    this.opts.fx.setRemoteStream(null);
    this.update({ peer: 'none', rttMs: null, route: null });
  }

  private audioSender(): RTCRtpSender | null {
    return this.pc?.getTransceivers().find((t) => t.receiver.track.kind === 'audio')?.sender ?? null;
  }

  private async pollStats(): Promise<void> {
    const pc = this.pc;
    if (!pc || this.state.peer !== 'connected') return;
    try {
      const stats = await pc.getStats();
      let pairId: string | undefined;
      stats.forEach((r) => {
        if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
      });
      let pair: any;
      stats.forEach((r) => {
        if (r.type !== 'candidate-pair') return;
        if (pairId ? r.id === pairId : r.nominated && r.state === 'succeeded') pair = r;
      });
      if (!pair) return;
      const local = stats.get(pair.localCandidateId);
      const remote = stats.get(pair.remoteCandidateId);
      const relay = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
      const rtt = typeof pair.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 1000) : null;
      this.update({ rttMs: rtt, route: relay ? 'relay' : 'direct' });
    } catch {
      /* stats are best-effort */
    }
  }

  private update(patch: Partial<LinkState>): void {
    let changed = false;
    for (const k in patch) {
      const key = k as keyof LinkState;
      if (this.state[key] !== patch[key]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.state = { ...this.state, ...patch };
    this.opts.onChange?.(this.getState());
  }
}
