// RadioLink: signaling socket + WebRTC peers + push-to-talk floor control.
// Used by both the phone PWA and the desktop app; only the role differs.
//
// Full mesh: every member keeps one RTCPeerConnection to every other member (at most 3 links:
// PC <-> each phone and phone <-> phone), so the phones keep talking when the PC is off and
// nothing has to switch when it comes or goes. Every member has an id from the server; the floor
// is held by an id. Offers: the PC always offers; between phones, the lower member id does.

import {
  PC_ID,
  PROTOCOL_VERSION,
  type ClientMsg,
  type FloorHolder,
  type MemberId,
  type MemberInfo,
  type PushEntry,
  type PushSub,
  type Role,
  type ServerMsg,
  type SignalData,
} from './protocol.ts';
import { RX_TAIL_MS, type RadioFx } from './radio.ts';

/** Keep the mic open briefly after PTT release so the last syllable isn't clipped. */
export const TX_TAIL_MS = 150;

/** Keep-alive: we send hb this often; no word from the server for HB_DEAD_MS means the socket is dead */
const HB_INTERVAL_MS = 5_000;
const HB_DEAD_MS = 12_000;
/** A member that vanished from the roster keeps its working link this long, in case it's a blip */
const GONE_GRACE_MS = 4_000;
/** A link that isn't up this long after starting is restarted */
const CONNECT_WATCHDOG_MS = 15_000;
/** The server answers a talk press almost instantly; silence this long means the socket is dead */
const FLOOR_ANSWER_MS = 2_500;
/** An ICE link stuck in 'disconnected' this long is restarted rather than waiting for 'failed' */
const DISCONNECTED_RESTART_MS = 5_000;

/** Triple-press to ping: each press shorter than this... */
export const PING_PRESS_MS = 400;
/** ...and all three within this window */
export const PING_WINDOW_MS = 1500;

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
  /** Anyone else is in the room */
  peerPresent: boolean;
  /** PC's setting: phones hear each other while the PC is in the room */
  phonesHear: boolean;
  /** Summary: the best of our links (connected if we can talk to anyone) */
  peer: PeerStatus;
  /** Every other member has a working link (otherwise someone can't hear us) */
  allConnected: boolean;
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

export interface PingResult {
  sent: number;
  gone: string[];
  limited: boolean;
  unavailable: boolean;
  /** Refused by the push service (not just expired) */
  failed: number;
  waitMs: number;
}

/** Short status text for a ping result */
export function pingText(r: PingResult): string {
  if (r.unavailable) return 'Alerts not set up';
  if (r.limited) return `Wait ${Math.max(1, Math.ceil(r.waitMs / 1000))} s`;
  if (r.sent) return r.failed ? `Pinged ${r.sent}, ${r.failed} failed` : `Pinged ${r.sent}`;
  if (r.failed) return 'Alert failed';
  return 'Nobody to ping';
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
  /** Phone: the name it was last given, shown until the PC names it */
  name?: string;
  /** Phone: its id in the notification directory */
  pushId?: string;
  fx: RadioFx;
  onChange?: (s: LinkState) => void;
  /** A peer's audio arrived (or went away: null). The app routes it to RadioFx/the mixer. */
  onRemoteStream?: (id: MemberId, stream: MediaStream | null) => void;
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
  /** Result of a ping (triple-press or ping()) */
  onPinged?: (r: PingResult) => void;
  /** Who to ping: subscriptions of phones that aren't in the room (from the app's directory) */
  pingTargets?: () => PushSub[];
  /** Another member's copy of the notification directory (relayed by the server) */
  onDir?: (entries: PushEntry[], from: MemberId) => void;
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
  /** Restart if still 'disconnected' when this fires */
  disconnectTimer: ReturnType<typeof setTimeout> | null;
  /** Its member left the roster; drop the link when this fires unless it comes back */
  goneTimer: ReturnType<typeof setTimeout> | null;
  /** Restarts the link if it hasn't connected in time */
  watchdog: ReturnType<typeof setTimeout> | null;
  /** The remote app instance this link was made with */
  inst: string | undefined;
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
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private lastFromServer = 0;
  private away = false;
  private backoff = 1000;
  private stopped = false;
  /** Triple-press detection */
  private pressStart = 0;
  private taps: number[] = [];
  private state: LinkState = {
    signaling: 'connecting',
    selfId: null,
    members: [],
    peerPresent: false,
    phonesHear: true,
    peer: 'none',
    allConnected: false,
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

  /** This app instance; a new launch gets a new one so others drop their old links to us */
  private inst = newCallId();

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
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.reconnectTimer = this.releaseTimer = this.statsTimer = this.hbTimer = null;
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

  /** Set (or swap) the local microphone track, sent to every peer. Only enabled while we transmit. */
  setMicTrack(track: MediaStreamTrack | null): void {
    this.micTrack = track;
    if (track) track.enabled = this.state.tx;
    for (const p of this.peers.values()) this.replaceSendTrack(p, track);
  }

  /** "Get on the radio": push-notify the room's phones that aren't connected. False if offline. */
  ping(): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN || !this.state.selfId) return false;
    this.send({ t: 'ping', subs: this.opts.pingTargets?.() ?? [] });
    return true;
  }

  /**
   * The network may have changed (came back online, app back on screen): reconnect right away
   * instead of waiting out the backoff, or check that the socket is still alive.
   */
  nudge(dead = false): void {
    if (this.stopped) return;
    // Nothing from the server for a while (e.g. we were suspended): the socket is likely dead
    const stale =
      this.ws?.readyState === WebSocket.OPEN && (dead || Date.now() - this.lastFromServer > HB_INTERVAL_MS * 1.5);
    if (stale) {
      const ws = this.ws!;
      ws.close();
      ws.onclose?.(new CloseEvent('close'));
    }
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.backoff = 1000;
      this.connect();
    } else this.send({ t: 'hb' });
  }

  /** Our app is in the background (away) or on screen again; pings treat away phones as gone. */
  setAway(away: boolean): void {
    if (this.away === away) return;
    this.away = away;
    this.send({ t: 'presence', away });
  }

  /** Share our copy of the notification directory with the room. */
  shareDir(entries: PushEntry[]): void {
    this.send({ t: 'dir', entries });
  }

  /** PC: whether phones hear each other while the PC is here. */
  setPhonesHear(on: boolean): void {
    if (this.role === 'pc') this.send({ t: 'room_settings', phonesHear: on });
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

  /** Display names by member id, including PC_ID for the PC itself; null clears a name (PC only). */
  setNames(names: Record<MemberId, string | null>): void {
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

  /** `synthetic`: re-keying by the app (not a human press), never counted towards a ping. */
  pttDown(synthetic = false): void {
    if (!synthetic && !this.pressStart) this.pressStart = Date.now();
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
      // Nobody to talk to: a soft tick rather than "busy" (the presses may be a ping)
      if (this.state.signaling === 'open' && !this.state.peerPresent) this.opts.fx.playTick();
      else this.opts.fx.playBusy();
      return;
    }
    if (this.state.floor === self) {
      this.beginTx();
      return;
    }
    this.update({ pending: true });
    this.send({ t: 'floor_request' });
    // No answer at all to a talk press means the socket is likely dead (it can die without
    // closing): reconnect now instead of waiting for the keep-alive to notice
    const askedAt = Date.now();
    setTimeout(() => {
      if (this.state.pending && this.lastFromServer < askedAt) this.nudge(true);
    }, FLOOR_ANSWER_MS);
  }

  /** `immediate` skips the tail, e.g. when the page is being hidden and timers may not run. */
  pttUp(immediate = false): void {
    this.countPress();
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
      this.lastFromServer = Date.now();
      if (this.hbTimer) clearInterval(this.hbTimer);
      // A socket can die silently (network switch, sleeping laptop): notice within HB_DEAD_MS
      this.hbTimer = setInterval(() => {
        if (this.ws !== ws) return;
        if (Date.now() - this.lastFromServer > HB_DEAD_MS) {
          this.backoff = 1000;
          ws.close();
          ws.onclose?.(new CloseEvent('close'));
          return;
        }
        this.send({ t: 'hb' });
      }, HB_INTERVAL_MS);
      const key = this.opts.accessKey || undefined;
      const v = PROTOCOL_VERSION;
      this.send(
        this.role === 'pc'
          ? { t: 'host', v, room: this.opts.room, key, inst: this.inst }
          : {
              t: 'join',
              v,
              room: this.opts.room,
              key,
              device: this.opts.device,
              name: this.opts.name,
              push: this.opts.pushId,
              inst: this.inst,
            },
      );
    };
    ws.onmessage = (ev) => {
      this.lastFromServer = Date.now();
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
      if (this.hbTimer) clearInterval(this.hbTimer);
      this.hbTimer = null;
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
        this.update({ selfId: msg.you, error: null, phonesHear: msg.phonesHear !== false });
        this.setMembers(msg.members);
        this.forceFloor(msg.floor);
        // A floor still held under our id (e.g. after a reconnect) with PTT up would stay stuck
        if (msg.floor === msg.you && !this.txWanted) this.send({ t: 'floor_release' });
        this.opts.onWelcome?.(msg.members);
        // Links to members that are still here (same ids) can keep running; others are stale
        const here = new Set(msg.members.map((m) => m.id));
        for (const id of [...this.peers.keys()]) if (!here.has(id)) this.teardownPeer(id);
        if (this.away) this.send({ t: 'presence', away: true });
        this.reconcile();
        break;
      }
      case 'roster':
        this.update({ phonesHear: msg.phonesHear !== false });
        this.setMembers(msg.members);
        this.reconcile();
        this.opts.onRoster?.(msg.members);
        break;
      case 'pinged':
        this.opts.onPinged?.({
          sent: msg.sent,
          gone: msg.gone,
          limited: msg.limited,
          unavailable: msg.unavailable === true,
          failed: msg.failed ?? 0,
          waitMs: msg.waitMs ?? 0,
        });
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
        // Peers follow the roster (see reconcile)
        break;
      case 'peer_left':
        // The roster that follows handles it (with a grace period for short blips)
        break;
      case 'hb':
        break;
      case 'dir':
        this.opts.onDir?.(msg.entries, msg.from);
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
          error:
            msg.reason === 'replaced'
              ? 'Opened somewhere else'
              : msg.reason === 'room_closed'
                ? 'Room closed by the PC'
                : 'Disconnected by the PC',
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
        } else if (msg.code === 'no_host' || msg.code === 'room_full' || msg.code === 'server_full') {
          // Not in yet: keep retrying quietly, and join once a seat (or a room slot) frees up
          this.update({ peerPresent: false, members: [], error: msg.code === 'room_full' ? 'room_full' : null });
          this.ws?.close();
        } else console.warn('[link] server error', msg.code); // e.g. a refused message; not a link failure
        break;
    }
  }

  /** We offer to `id` (PC always; between phones, the lower member id), otherwise we answer. */
  private weOffer(id: MemberId): boolean {
    const self = this.state.selfId;
    if (!self) return false;
    if (self === PC_ID) return true;
    if (id === PC_ID) return false;
    return self < id;
  }

  /**
   * Make our connections match the room: one to every other member. Drop links to members who
   * left (even if we were never told, e.g. our socket was down), and call the ones we offer to.
   */
  private reconcile(): void {
    const self = this.state.selfId;
    if (!self) return;
    const members = new Map(this.state.members.filter((m) => m.id !== self).map((m) => [m.id, m]));
    const others = new Set(members.keys());
    for (const [id, peer] of [...this.peers]) {
      const m = members.get(id);
      if (m && m.inst && peer.inst && m.inst !== peer.inst) {
        // Same member, new app launch: the old link is dead even if it still looks up
        this.teardownPeer(id);
      } else if (m) {
        // It's back (a blip): keep the link
        if (peer.goneTimer) clearTimeout(peer.goneTimer);
        peer.goneTimer = null;
        peer.inst ??= m.inst;
        // A link that failed and isn't already being retried: try again
        if (peer.status === 'failed' && !peer.restartTimer && this.weOffer(id)) void this.startCall(id);
      } else if (peer.status === 'connected') {
        // Its socket to the server dropped, but our direct link may be fine: give it a moment
        peer.goneTimer ??= setTimeout(() => {
          peer.goneTimer = null;
          if (this.peers.get(id) === peer && !this.state.members.some((m) => m.id === id)) this.teardownPeer(id);
        }, GONE_GRACE_MS);
      } else this.teardownPeer(id);
    }
    for (const id of others) if (!this.peers.has(id) && this.weOffer(id)) void this.startCall(id);
  }

  /** Count a human press that just ended; the third quick one in a row pings. */
  private countPress(): void {
    if (!this.pressStart) return;
    const now = Date.now();
    const short = now - this.pressStart < PING_PRESS_MS;
    this.pressStart = 0;
    if (!short) {
      this.taps = [];
      return;
    }
    this.taps = [...this.taps.filter((t) => now - t < PING_WINDOW_MS), now];
    if (this.taps.length < 3) return;
    this.taps = [];
    if (this.ping()) this.opts.fx.playPingSent();
    else this.opts.fx.playBusy();
  }

  private setMembers(members: MemberInfo[]): void {
    const self = this.state.selfId;
    const peerPresent = members.some((m) => m.id !== self);
    this.update({
      members,
      peerPresent,
      talker: this.talkerFor(this.state.floor, members),
      allConnected: this.allLinksUp(members),
    });
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
      this.opts.fx.closeChannel(false, RX_TAIL_MS);
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

  private replaceSendTrack(p: Peer, track: MediaStreamTrack | null): void {
    const sender = p.pc.getTransceivers().find((t) => t.receiver.track.kind === 'audio')?.sender;
    if (sender) void sender.replaceTrack(track).catch((e) => console.warn('[link] replaceTrack', e));
  }

  private newPeer(id: MemberId, cid: string): Peer {
    this.teardownPeer(id);
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const peer: Peer = {
      id,
      cid,
      pc,
      dc: null,
      pendingIce: [],
      status: 'connecting',
      rttMs: null,
      route: null,
      restartTimer: null,
      disconnectTimer: null,
      goneTimer: null,
      watchdog: null,
      inst: this.state.members.find((m) => m.id === id)?.inst,
    };
    this.peers.set(id, peer);
    this.syncPeers();
    const live = () => this.peers.get(id) === peer;
    // Never sit in "connecting" forever (lost offer/answer, no route): start over
    peer.watchdog = setTimeout(() => {
      peer.watchdog = null;
      if (!live() || peer.status === 'connected' || !this.state.members.some((m) => m.id === id)) return;
      if (this.weOffer(id)) void this.startCall(id);
      else this.sendSignal(id, peer.cid, { kind: 'restart' });
    }, CONNECT_WATCHDOG_MS);

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
      // The offering side starts a new call; the answering side asks it to.
      const restart = (delay: number) => {
        if (peer.restartTimer) return;
        peer.restartTimer = setTimeout(() => {
          peer.restartTimer = null;
          if (!live() || !this.state.members.some((m) => m.id === id)) return;
          if (this.weOffer(id)) void this.startCall(id);
          else this.sendSignal(id, peer.cid, { kind: 'restart' });
        }, delay);
      };
      if (cs !== 'disconnected' && peer.disconnectTimer) {
        clearTimeout(peer.disconnectTimer);
        peer.disconnectTimer = null;
      }
      if (cs === 'connected') peer.status = 'connected';
      else if (cs === 'failed') {
        peer.status = 'failed';
        peer.rttMs = null;
        peer.route = null;
        restart(1500);
      } else if (cs === 'disconnected') {
        peer.status = 'connecting';
        // Browsers can sit in 'disconnected' for a long time before 'failed'; don't wait for it
        peer.disconnectTimer ??= setTimeout(() => {
          peer.disconnectTimer = null;
          if (live() && pc.connectionState === 'disconnected') restart(0);
        }, DISCONNECTED_RESTART_MS);
      }
      this.syncPeers();
    };
    return peer;
  }

  private sendSignal(to: MemberId, cid: string, data: SignalData): void {
    this.send({ t: 'signal', to, cid, data });
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
      await tr.sender.replaceTrack(this.micTrack);
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
        // Only accept offers from members we answer to; a new one replaces any previous call
        if (this.weOffer(from) || !this.state.members.some((m) => m.id === from)) return;
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
      if (data.kind === 'restart') {
        // The answering side lost its connection: start a new call (if it's still ours to make)
        const cur = this.peers.get(from);
        if (this.weOffer(from) && (!cur || cur.cid === cid) && this.state.members.some((m) => m.id === from)) {
          void this.startCall(from);
        }
        return;
      }
      const peer = this.peers.get(from);
      // Signals for an older call attempt (or a peer we've dropped) are stale
      if (!peer || peer.cid !== cid) return;
      if (data.kind === 'answer') {
        if (!this.weOffer(from) || peer.pc.signalingState !== 'have-local-offer') return;
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
    if (peer.disconnectTimer) clearTimeout(peer.disconnectTimer);
    if (peer.goneTimer) clearTimeout(peer.goneTimer);
    if (peer.watchdog) clearTimeout(peer.watchdog);
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
    this.update(
      { peer: best?.status ?? 'none', rttMs: best?.rttMs ?? null, route: best?.route ?? null, allConnected: this.allLinksUp() },
      changed,
    );
  }

  /** Every other member in the room has a connected link from us. */
  private allLinksUp(members = this.state.members): boolean {
    const others = members.filter((m) => m.id !== this.state.selfId);
    return others.length > 0 && others.every((m) => this.peers.get(m.id)?.status === 'connected');
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
