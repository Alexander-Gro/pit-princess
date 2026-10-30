// RadioLink: signaling socket + WebRTC peers + push-to-talk floor control.
// Used by both the phone PWA and the desktop app; only the role differs.
//
// The PC is the hub: it keeps one RTCPeerConnection per phone. A phone has one, to the PC.
// Every member (the PC and each phone) has an id from the server; the floor is held by an id.

import {
  PC_ID,
  PROTOCOL_VERSION,
  type ClientMsg,
  type FloorHolder,
  type MemberId,
  type MemberInfo,
  type PushSub,
  type Role,
  type ServerMsg,
  type SignalData,
} from './protocol.ts';
import { RX_TAIL_MS, type RadioFx } from './radio.ts';

/** Keep the mic open briefly after PTT release so the last syllable isn't clipped. */
export const TX_TAIL_MS = 150;
/** A phone hearing the other phone gets audio relayed via the PC, which arrives later */
export const RELAYED_RX_TAIL_MS = 450;

export type PeerStatus = 'none' | 'connecting' | 'connected' | 'failed';

export interface PeerState {
  id: MemberId;
  status: PeerStatus;
  rttMs: number | null;
  route: 'direct' | 'relay' | null;
}

export interface LinkState {
  signaling: 'connecting' | 'open' | 'closed';
  /** Our member id in the room (null until welcomed) */
  selfId: MemberId | null;
  /** Everyone in the room, with names set by the PC */
  members: MemberInfo[];
  /** Phone: the PC is in the room. PC: at least one phone is. */
  peerPresent: boolean;
  /** Summary: phone = its link to the PC; PC = the best of its phone links */
  peer: PeerStatus;
  peers: PeerState[];
  floor: FloorHolder;
  /** We hold the floor and the mic is live. */
  tx: boolean;
  /** Someone else holds the floor. */
  rx: boolean;
  /** Who is talking when rx (null otherwise) */
  talker: MemberInfo | null;
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
  /** Phone: stable device id (keeps its seat across reconnects) */
  device?: string;
  fx: RadioFx;
  onChange?: (s: LinkState) => void;
  /** A peer's audio arrived (or went away: null). The app routes it to RadioFx/the mixer. */
  onRemoteStream?: (id: MemberId, stream: MediaStream | null) => void;
  /** PC: the track to send to each phone (the relay mix). Without it the mic track is sent. */
  sendTrackFor?: (id: MemberId) => MediaStreamTrack | null;
  /** JSON messages from a peer's data channel */
  onData?: (msg: unknown, from: MemberId) => void;
  /** Our data channel to a peer is open */
  onDataOpen?: (id: MemberId) => void;
  /** A pairing code the server created for this room (PC only) */
  onPairCode?: (code: string, expiresInMs: number) => void;
  /** We (re)entered the room: the server accepted our host/join */
  onWelcome?: (members: MemberInfo[]) => void;
  /** The room's members or names changed */
  onRoster?: (members: MemberInfo[]) => void;
  /** Result of announce(): push subscriptions the push service reported gone */
  onAnnounced?: (sent: number, gone: string[]) => void;
}

interface Peer {
  id: MemberId;
  /** Call id: offer/answer/ICE for an older attempt are ignored */
  cid: string;
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  pendingIce: RTCIceCandidateInit[];
  status: PeerStatus;
  rttMs: number | null;
  route: 'direct' | 'relay' | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
}

function newCallId(): string {
  const b = new Uint8Array(9);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export class RadioLink {
  private opts: RadioLinkOptions;
  private role: Role;
  private ws: WebSocket | null = null;
  private peers = new Map<MemberId, Peer>();
  private iceServers: RTCIceServer[] = [];
  private micTrack: MediaStreamTrack | null = null;
  private txWanted = false;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private backoff = 1000;
  private stopped = false;
  private state: LinkState = {
    signaling: 'connecting',
    selfId: null,
    members: [],
    peerPresent: false,
    peer: 'none',
    peers: [],
    floor: 'idle',
    tx: false,
    rx: false,
    talker: null,
    pending: false,
    rttMs: null,
    route: null,
    error: null,
  };

  constructor(opts: RadioLinkOptions) {
    this.opts = opts;
    this.role = opts.role;
  }

  getState(): LinkState {
    return { ...this.state, members: [...this.state.members], peers: [...this.state.peers] };
  }

  start(): void {
    this.stopped = false;
    this.connect();
    this.statsTimer = setInterval(() => void this.pollStats(), 2000);
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.reconnectTimer = this.releaseTimer = this.statsTimer = null;
    this.ws?.close();
    this.ws = null;
    for (const id of [...this.peers.keys()]) this.teardownPeer(id);
    this.setMicEnabled(false);
    this.update({
      signaling: 'closed',
      peerPresent: false,
      members: [],
      floor: 'idle',
      tx: false,
      rx: false,
      talker: null,
      pending: false,
    });
  }

  /**
   * Set (or swap) the local microphone track. It is only enabled while we transmit.
   * On the PC with `sendTrackFor`, the mic feeds the relay mix instead of being sent directly.
   */
  setMicTrack(track: MediaStreamTrack | null): void {
    this.micTrack = track;
    if (track) track.enabled = this.state.tx;
    if (!this.opts.sendTrackFor) for (const p of this.peers.values()) this.replaceSendTrack(p, track);
  }

  /** PC: re-apply sendTrackFor() to every phone (e.g. after the mixer was rebuilt). */
  refreshSendTracks(): void {
    for (const p of this.peers.values()) this.replaceSendTrack(p, this.sendTrack(p.id));
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

  /** Kick one phone, or all of them (PC only). */
  kick(id?: MemberId): void {
    this.send({ t: 'kick', id });
  }

  /** Display names by member id, including PC_ID for the PC itself (PC only). */
  setNames(names: Record<MemberId, string>): void {
    if (this.role === 'pc') this.send({ t: 'names', names });
  }

  /** Send to one peer, or (PC, no `to`) to every phone. True if at least one got it. */
  sendData(msg: unknown, to?: MemberId): boolean {
    const json = JSON.stringify(msg);
    let sent = false;
    for (const p of this.peers.values()) {
      if (to && p.id !== to) continue;
      if (p.dc?.readyState !== 'open') continue;
      p.dc.send(json);
      sent = true;
    }
    return sent;
  }

  pttDown(): void {
    if (this.txWanted) return;
    this.txWanted = true;
    const self = this.state.selfId;
    if (this.releaseTimer) {
      // Re-pressed during the tail: we still hold the floor, just keep talking.
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
      if (self && this.state.floor === self) return;
    }
    if (!self || this.state.peer !== 'connected' || this.state.signaling !== 'open') {
      this.txWanted = false;
      this.opts.fx.playBusy();
      return;
    }
    if (this.state.floor === self) {
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
      this.update({ signaling: 'open' });
      const key = this.opts.accessKey || undefined;
      const v = PROTOCOL_VERSION;
      this.send(
        this.role === 'pc'
          ? { t: 'host', v, room: this.opts.room, key }
          : { t: 'join', v, room: this.opts.room, key, device: this.opts.device },
      );
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
      case 'welcome': {
        if (!Array.isArray(msg.members) || typeof msg.you !== 'string') {
          // A server from before multi-phone rooms
          this.stopped = true;
          this.ws?.close();
          this.update({ signaling: 'closed', error: 'Server out of date: redeploy it' });
          break;
        }
        // Only a real welcome resets the backoff; "room full"/"no PC yet" keep backing off
        this.backoff = 1000;
        this.iceServers = msg.iceServers;
        this.update({ selfId: msg.you, error: null });
        this.setMembers(msg.members);
        this.forceFloor(msg.floor);
        // A floor still held under our id (e.g. after a reconnect) with PTT up would stay stuck
        if (msg.floor === msg.you && !this.txWanted) this.send({ t: 'floor_release' });
        this.opts.onWelcome?.(msg.members);
        // The server told our peers peer_left when our old socket dropped, so they've torn down.
        // Always start fresh calls, even if an old connection still looks alive.
        this.dropGonePeers(msg.members);
        if (this.role === 'pc') for (const m of msg.members) if (m.role === 'phone') void this.startCall(m.id);
        break;
      }
      case 'roster':
        this.setMembers(msg.members);
        this.dropGonePeers(msg.members);
        this.opts.onRoster?.(msg.members);
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
        if (this.role === 'pc') void this.startCall(msg.id);
        break;
      case 'peer_left':
        this.teardownPeer(msg.id);
        break;
      case 'signal':
        await this.onSignal(msg.from, msg.cid, msg.data);
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
        for (const id of [...this.peers.keys()]) this.teardownPeer(id);
        this.update({
          signaling: 'closed',
          peerPresent: false,
          members: [],
          error: msg.reason === 'replaced' ? 'Opened somewhere else' : 'Disconnected by the PC',
        });
        break;
      case 'error':
        if (msg.code === 'unauthorized' || msg.code === 'update_required') {
          // Retrying won't help
          this.stopped = true;
          this.ws?.close();
          this.update({
            signaling: 'closed',
            error: msg.code === 'unauthorized' ? 'Wrong or missing access key' : 'App out of date: reload it',
          });
        } else if (msg.code === 'no_host' || msg.code === 'room_full') {
          // Not in yet: keep retrying quietly, and join once the PC is online / a seat frees up
          this.update({ peerPresent: false, members: [], error: msg.code === 'room_full' ? 'room_full' : null });
          this.ws?.close();
        } else this.update({ error: msg.code });
        break;
    }
  }

  /** Peers whose member left while we weren't told (e.g. our socket was down) are dead: drop them. */
  private dropGonePeers(members: MemberInfo[]): void {
    const ids = new Set(members.map((m) => m.id));
    for (const id of [...this.peers.keys()]) if (!ids.has(id)) this.teardownPeer(id);
  }

  private setMembers(members: MemberInfo[]): void {
    const peerPresent = members.some((m) => (this.role === 'pc' ? m.role === 'phone' : m.role === 'pc'));
    this.update({ members, peerPresent, talker: this.talkerFor(this.state.floor, members) });
  }

  private talkerFor(floor: FloorHolder, members = this.state.members): MemberInfo | null {
    if (floor === 'idle' || floor === this.state.selfId) return null;
    return members.find((m) => m.id === floor) ?? { id: floor, role: floor === PC_ID ? 'pc' : 'phone', name: null };
  }

  // ---- floor ----

  private isOther(holder: FloorHolder): boolean {
    return holder !== 'idle' && holder !== this.state.selfId;
  }

  private onFloor(holder: FloorHolder): void {
    const prev = this.state.floor;
    const self = this.state.selfId;
    this.update({
      floor: holder,
      talker: this.talkerFor(holder),
      pending: holder === self ? false : this.state.pending,
    });

    if (holder === self && prev !== self) {
      if (this.txWanted) this.beginTx();
      else this.send({ t: 'floor_release' }); // released before the grant arrived
    } else if (prev === self && holder !== self) {
      // Server took the floor away (timeout, peer reset)
      if (this.releaseTimer) {
        clearTimeout(this.releaseTimer);
        this.releaseTimer = null;
      }
      this.txWanted = false;
      this.endTx();
    }

    if (this.isOther(holder) && !this.isOther(prev)) {
      this.opts.fx.openChannel();
      this.update({ rx: true });
    } else if (this.isOther(prev) && !this.isOther(holder)) {
      // Another phone's voice reaches us through the PC, so it lags the floor message more
      const relayed = this.role === 'phone' && prev !== PC_ID;
      this.opts.fx.closeChannel(false, relayed ? RELAYED_RX_TAIL_MS : RX_TAIL_MS);
      this.update({ rx: false });
    }
  }

  /** Reset floor without the usual cues (e.g. after a reconnect). */
  private forceFloor(holder: FloorHolder): void {
    if (this.releaseTimer) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
    const self = this.state.selfId;
    if (holder !== self) {
      this.txWanted = false;
      this.setMicEnabled(false);
    }
    const other = this.isOther(holder);
    if (other) this.opts.fx.openChannel();
    else this.opts.fx.closeChannel(true);
    this.update({
      floor: holder,
      tx: holder === self && this.state.tx,
      rx: other,
      talker: this.talkerFor(holder),
      pending: false,
    });
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

  private sendTrack(id: MemberId): MediaStreamTrack | null {
    return this.opts.sendTrackFor ? this.opts.sendTrackFor(id) : this.micTrack;
  }

  private replaceSendTrack(p: Peer, track: MediaStreamTrack | null): void {
    const sender = p.pc.getTransceivers().find((t) => t.receiver.track.kind === 'audio')?.sender;
    if (sender) void sender.replaceTrack(track).catch((e) => console.warn('[link] replaceTrack', e));
  }

  private newPeer(id: MemberId, cid: string): Peer {
    this.teardownPeer(id);
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const peer: Peer = { id, cid, pc, dc: null, pendingIce: [], status: 'connecting', rttMs: null, route: null, restartTimer: null };
    this.peers.set(id, peer);
    this.syncPeers();
    const live = () => this.peers.get(id) === peer;

    pc.onicecandidate = (ev) => {
      if (!live()) return;
      this.sendSignal(id, cid, { kind: 'ice', candidate: ev.candidate ? ev.candidate.toJSON() : null });
    };
    pc.ontrack = (ev) => {
      if (!live()) return;
      this.opts.onRemoteStream?.(id, ev.streams[0] ?? new MediaStream([ev.track]));
    };
    pc.ondatachannel = (ev) => {
      if (live()) this.attachChannel(peer, ev.channel);
    };
    pc.onconnectionstatechange = () => {
      if (!live()) return;
      const cs = pc.connectionState;
      if (cs === 'connected') peer.status = 'connected';
      else if (cs === 'failed') {
        peer.status = 'failed';
        peer.rttMs = null;
        peer.route = null;
        // The PC drives the calls, so it retries; a phone waits for a new offer.
        if (this.role === 'pc' && !peer.restartTimer) {
          peer.restartTimer = setTimeout(() => {
            peer.restartTimer = null;
            if (live() && this.state.members.some((m) => m.id === id)) void this.startCall(id);
          }, 1500);
        }
      } else if (cs === 'disconnected') peer.status = 'connecting';
      this.syncPeers();
    };
    return peer;
  }

  private sendSignal(to: MemberId, cid: string, data: SignalData): void {
    // Phones always signal the PC; the server routes by their connection
    this.send(this.role === 'pc' ? { t: 'signal', to, cid, data } : { t: 'signal', cid, data });
  }

  private attachChannel(peer: Peer, dc: RTCDataChannel): void {
    peer.dc = dc;
    // A channel from ondatachannel may already be open (and may or may not still get 'open'),
    // so fire once from whichever comes first.
    let fired = false;
    const opened = () => {
      if (fired || peer.dc !== dc || this.peers.get(peer.id) !== peer) return;
      fired = true;
      this.opts.onDataOpen?.(peer.id);
    };
    dc.onopen = opened;
    if (dc.readyState === 'open') queueMicrotask(opened);
    dc.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      try {
        this.opts.onData?.(JSON.parse(ev.data), peer.id);
      } catch {
        /* ignore malformed */
      }
    };
  }

  private async startCall(id: MemberId): Promise<void> {
    const peer = this.newPeer(id, newCallId());
    const { pc } = peer;
    try {
      const tr = pc.addTransceiver('audio', { direction: 'sendrecv' });
      this.attachChannel(peer, pc.createDataChannel('fx'));
      await tr.sender.replaceTrack(this.sendTrack(id));
      if (this.peers.get(id) !== peer) return;
      const offer = await pc.createOffer();
      if (this.peers.get(id) !== peer) return;
      await pc.setLocalDescription(offer);
      this.sendSignal(id, peer.cid, { kind: 'offer', sdp: offer.sdp ?? '' });
    } catch (e) {
      console.warn('[link] offer failed', e);
    }
  }

  private async onSignal(from: MemberId, cid: string, data: SignalData): Promise<void> {
    try {
      if (data.kind === 'offer') {
        // Only the PC makes offers; a new one replaces any previous call
        if (this.role !== 'phone' || from !== PC_ID) return;
        const peer = this.newPeer(from, cid);
        const { pc } = peer;
        await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
        const tr = pc.getTransceivers().find((t) => t.receiver.track.kind === 'audio');
        if (tr) {
          tr.direction = 'sendrecv';
          await tr.sender.replaceTrack(this.micTrack);
        }
        await this.flushIce(peer);
        const answer = await pc.createAnswer();
        if (this.peers.get(from) !== peer) return;
        await pc.setLocalDescription(answer);
        this.sendSignal(from, cid, { kind: 'answer', sdp: answer.sdp ?? '' });
        return;
      }
      const peer = this.peers.get(from);
      // Signals for an older call attempt (or a peer we've dropped) are stale
      if (!peer || peer.cid !== cid) return;
      if (data.kind === 'answer') {
        if (this.role !== 'pc' || peer.pc.signalingState !== 'have-local-offer') return;
        await peer.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
        await this.flushIce(peer);
      } else if (data.kind === 'ice') {
        if (!data.candidate) return;
        if (!peer.pc.remoteDescription) peer.pendingIce.push(data.candidate);
        else await peer.pc.addIceCandidate(data.candidate);
      }
    } catch (e) {
      console.warn('[link] signal handling failed', e);
    }
  }

  private async flushIce(peer: Peer): Promise<void> {
    const queued = peer.pendingIce;
    peer.pendingIce = [];
    for (const c of queued) {
      try {
        await peer.pc.addIceCandidate(c);
      } catch (e) {
        console.warn('[link] addIceCandidate', e);
      }
    }
  }

  private teardownPeer(id: MemberId): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    if (peer.restartTimer) clearTimeout(peer.restartTimer);
    peer.dc?.close();
    peer.pc.close();
    this.opts.onRemoteStream?.(id, null);
    this.syncPeers();
  }

  /** Publish per-peer state plus the summary fields. */
  private syncPeers(): void {
    const peers: PeerState[] = [...this.peers.values()].map((p) => ({
      id: p.id,
      status: p.status,
      rttMs: p.rttMs,
      route: p.route,
    }));
    const rank: Record<PeerStatus, number> = { connected: 3, connecting: 2, failed: 1, none: 0 };
    const best = peers.reduce<PeerState | null>((b, p) => (!b || rank[p.status] > rank[b.status] ? p : b), null);
    const changed =
      peers.length !== this.state.peers.length ||
      peers.some((p, i) => {
        const o = this.state.peers[i];
        return !o || o.id !== p.id || o.status !== p.status || o.rttMs !== p.rttMs || o.route !== p.route;
      });
    if (changed) this.state = { ...this.state, peers };
    this.update({ peer: best?.status ?? 'none', rttMs: best?.rttMs ?? null, route: best?.route ?? null }, changed);
  }

  private async pollStats(): Promise<void> {
    let any = false;
    for (const peer of this.peers.values()) {
      if (peer.status !== 'connected') continue;
      try {
        const stats = await peer.pc.getStats();
        let pairId: string | undefined;
        stats.forEach((r) => {
          if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
        });
        let pair: any;
        stats.forEach((r) => {
          if (r.type !== 'candidate-pair') return;
          if (pairId ? r.id === pairId : r.nominated && r.state === 'succeeded') pair = r;
        });
        if (!pair) continue;
        const local = stats.get(pair.localCandidateId);
        const remote = stats.get(pair.remoteCandidateId);
        peer.route = local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relay' : 'direct';
        peer.rttMs = typeof pair.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 1000) : null;
        any = true;
      } catch {
        /* stats are best-effort */
      }
    }
    if (any) this.syncPeers();
  }

  private update(patch: Partial<LinkState>, force = false): void {
    let changed = force;
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
