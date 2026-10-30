// Room + floor logic, independent of the transport so it can be tested directly.

import { timingSafeEqual, createHash, randomInt } from 'node:crypto';
import { MAX_PUSH_SUBS, MAX_TX_MS, PAIR_CODE_RE, PAIR_CODE_TTL_MS, isPushSub, type PushSub, ROOM_CODE_RE, type ClientMsg, type FloorHolder, type Role, type ServerMsg } from '@pit/shared';

export interface Conn {
  send(msg: ServerMsg): void;
  close(): void;
}

interface Member {
  conn: Conn;
  role: Role;
  room: Room;
}

interface Room {
  code: string;
  pc: Conn | null;
  phone: Conn | null;
  floor: FloorHolder;
  floorTimer: ReturnType<typeof setTimeout> | null;
}

export interface HubOptions {
  getIceServers: () => Promise<RTCIceServer[]>;
  maxTxMs?: number;
  maxRooms?: number;
  /** When set, host/join must carry this key. Keeps a self-hosted server private. */
  accessKey?: string;
  /** Sends Web Push notifications; absent when VAPID keys aren't configured */
  push?: Pusher | null;
  /** Minimum time between "PC online" notifications for one room */
  announceCooldownMs?: number;
}

export interface Pusher {
  /** Returns the endpoints the push service reported as expired/unsubscribed */
  send(subs: PushSub[], payload: object): Promise<{ sent: number; gone: string[] }>;
}

/** Wrong pairing codes allowed per connection, and server-wide per window, before refusing */
const PAIR_TRIES_PER_CONN = 5;
const PAIR_FAILS_PER_WINDOW = 30;
const PAIR_FAIL_WINDOW_MS = 10 * 60_000;

const ANNOUNCES_PER_CONN = 3;
const ANNOUNCES_PER_WINDOW = 30;
const ANNOUNCE_WINDOW_MS = 60_000;

const other = (r: Role): Role => (r === 'pc' ? 'phone' : 'pc');

export class RoomHub {
  readonly rooms = new Map<string, Room>();
  private members = new Map<Conn, Member>();
  /** Connections currently waiting on ICE servers before entering a room */
  private entering = new Map<Conn, { role: Role; code: string }>();
  private opts: Required<HubOptions>;
  /** pairing code -> room code */
  private pairCodes = new Map<string, { room: string; expires: number }>();
  private pairTries = new WeakMap<Conn, number>();
  private pairFails: number[] = [];
  /** room code -> last time we sent "PC online" for it */
  private lastAnnounce = new Map<string, number>();
  private announcesPerConn = new WeakMap<Conn, number>();
  private announceTimes: number[] = [];

  constructor(opts: HubOptions) {
    this.opts = { maxTxMs: MAX_TX_MS, maxRooms: 1000, accessKey: '', push: null, announceCooldownMs: 120_000, ...opts };
  }

  async handle(conn: Conn, raw: unknown): Promise<void> {
    const msg = parseClientMsg(raw);
    if (!msg) {
      conn.send({ t: 'error', code: 'bad_message' });
      return;
    }
    if (msg.t === 'pair_claim') {
      this.claimPairCode(conn, msg.code);
      return;
    }
    if (msg.t === 'host' || msg.t === 'join') {
      if (!this.keyOk(msg.key)) {
        conn.send({ t: 'error', code: 'unauthorized' });
        conn.close();
        return;
      }
      await this.enter(conn, msg.t === 'host' ? 'pc' : 'phone', msg.room);
      return;
    }
    const m = this.members.get(conn);
    if (!m) {
      conn.send({ t: 'error', code: 'not_in_room' });
      return;
    }
    const room = m.room;
    switch (msg.t) {
      case 'signal': {
        this.connOf(room, other(m.role))?.send({ t: 'signal', data: msg.data });
        break;
      }
      case 'floor_request': {
        if (room.floor === m.role) {
          conn.send({ t: 'floor', holder: m.role });
        } else if (room.floor !== 'idle' || !this.connOf(room, other(m.role))) {
          conn.send({ t: 'busy' });
        } else {
          this.setFloor(room, m.role);
        }
        break;
      }
      case 'floor_release': {
        if (room.floor === m.role) this.setFloor(room, 'idle');
        break;
      }
      case 'announce': {
        if (m.role !== 'pc') break;
        await this.announce(conn, room, msg.subs);
        break;
      }
      case 'pair_create': {
        if (m.role !== 'pc') break;
        // One live code per room
        for (const [c, p] of this.pairCodes) if (p.room === room.code) this.pairCodes.delete(c);
        let code: string;
        do code = String(randomInt(0, 1_000_000)).padStart(6, '0');
        while (this.pairCodes.has(code));
        this.pairCodes.set(code, { room: room.code, expires: Date.now() + PAIR_CODE_TTL_MS });
        conn.send({ t: 'pair_code', code, expiresInMs: PAIR_CODE_TTL_MS });
        break;
      }
      case 'kick': {
        if (m.role !== 'pc' || !room.phone) break;
        const phone = room.phone;
        this.removeMember(phone, { t: 'kicked', reason: 'kicked' });
        phone.close();
        break;
      }
    }
  }

  /**
   * A phone with no room/key yet trades the 6-digit code shown on the PC for both.
   * Codes are single-use and expire; guesses are limited per connection and server-wide,
   * which keeps brute force (1 in a million per guess) out of reach.
   */
  private claimPairCode(conn: Conn, code: string): void {
    const now = Date.now();
    this.pairFails = this.pairFails.filter((t) => now - t < PAIR_FAIL_WINDOW_MS);
    const tries = this.pairTries.get(conn) ?? 0;
    if (tries >= PAIR_TRIES_PER_CONN || this.pairFails.length >= PAIR_FAILS_PER_WINDOW) {
      conn.send({ t: 'error', code: 'rate_limited' });
      conn.close();
      return;
    }
    for (const [c, p] of this.pairCodes) if (p.expires <= now) this.pairCodes.delete(c);
    const entry = PAIR_CODE_RE.test(code) ? this.pairCodes.get(code) : undefined;
    if (!entry || !this.rooms.get(entry.room)?.pc) {
      this.pairTries.set(conn, tries + 1);
      this.pairFails.push(now);
      conn.send({ t: 'error', code: 'bad_code' });
      return;
    }
    this.pairCodes.delete(code);
    conn.send({ t: 'paired', room: entry.room, key: this.opts.accessKey });
  }

  /** Tell the room's phones the PC is online, unless a phone is already here. */
  private async announce(conn: Conn, room: Room, subs: PushSub[]): Promise<void> {
    const now = Date.now();
    const last = this.lastAnnounce.get(room.code) ?? 0;
    // Limits so one client can't use announce to make the server send lots of requests:
    // a PC announces once per launch, so a few per connection and a modest global rate is plenty.
    this.announceTimes = this.announceTimes.filter((t) => now - t < ANNOUNCE_WINDOW_MS);
    const perConn = this.announcesPerConn.get(conn) ?? 0;
    if (
      !this.opts.push ||
      room.phone ||
      subs.length === 0 ||
      now - last < this.opts.announceCooldownMs ||
      perConn >= ANNOUNCES_PER_CONN ||
      this.announceTimes.length >= ANNOUNCES_PER_WINDOW
    ) {
      conn.send({ t: 'announced', sent: 0, gone: [] });
      return;
    }
    this.announcesPerConn.set(conn, perConn + 1);
    this.announceTimes.push(now);
    // Re-insert so the map stays in least-recently-announced order for eviction
    this.lastAnnounce.delete(room.code);
    this.lastAnnounce.set(room.code, now);
    if (this.lastAnnounce.size > 1000) this.lastAnnounce.delete(this.lastAnnounce.keys().next().value!);
    try {
      const res = await this.opts.push.send(subs, {
        title: 'Pit Princess',
        body: 'The PC is online. Tap to open the radio.',
        tag: 'pc-online',
      });
      conn.send({ t: 'announced', ...res });
    } catch (e) {
      console.warn('[push] announce failed', e instanceof Error ? e.message : e);
      conn.send({ t: 'announced', sent: 0, gone: [] });
    }
  }

  private keyOk(key: string | undefined): boolean {
    const expected = this.opts.accessKey;
    if (!expected) return true;
    if (typeof key !== 'string') return false;
    // Compare fixed-length digests so neither length nor content leaks through timing
    const a = createHash('sha256').update(key).digest();
    const b = createHash('sha256').update(expected).digest();
    return timingSafeEqual(a, b);
  }

  /** Push fresh ICE servers (TURN credentials expire) to everyone in a room. */
  async refreshIce(): Promise<void> {
    if (!this.members.size) return;
    const iceServers = await this.opts.getIceServers();
    for (const m of this.members.values()) m.conn.send({ t: 'ice', iceServers });
  }

  disconnect(conn: Conn): void {
    this.entering.delete(conn);
    this.removeMember(conn, null);
  }

  private async enter(conn: Conn, role: Role, code: string): Promise<void> {
    if (!ROOM_CODE_RE.test(code)) {
      conn.send({ t: 'error', code: 'bad_room' });
      return;
    }
    // A second host/join while the first waits for ICE just updates the target; the latest wins.
    const waiting = this.entering.has(conn);
    this.entering.set(conn, { role, code });
    if (waiting) return;
    let iceServers: RTCIceServer[];
    try {
      iceServers = await this.opts.getIceServers();
    } catch {
      iceServers = [];
    }
    const target = this.entering.get(conn);
    if (!target) return; // disconnected while waiting
    this.entering.delete(conn);
    ({ role, code } = target);

    const prev = this.members.get(conn);
    if (prev) {
      if (prev.room.code === code && prev.role === role) {
        conn.send(this.welcome(prev.room, role, iceServers));
        return;
      }
      // A host switching to a new code closes its old room (and kicks the phone in it).
      const oldRoom = prev.room;
      this.removeMember(conn, null);
      if (role === 'pc' && oldRoom.phone) {
        const phone = oldRoom.phone;
        this.removeMember(phone, { t: 'kicked', reason: 'room_closed' });
        phone.close();
      }
    }

    let room = this.rooms.get(code);
    if (!room) {
      // Only the PC creates rooms, so random joins can't fill the table.
      if (role === 'phone') {
        conn.send({ t: 'error', code: 'no_host' });
        return;
      }
      if (this.rooms.size >= this.opts.maxRooms) {
        conn.send({ t: 'error', code: 'bad_room' });
        return;
      }
      room = { code, pc: null, phone: null, floor: 'idle', floorTimer: null };
      this.rooms.set(code, room);
    }

    const existing = this.connOf(room, role);
    if (existing && existing !== conn) {
      this.removeMember(existing, { t: 'kicked', reason: 'replaced' }, true);
      existing.close();
    }

    if (role === 'pc') room.pc = conn;
    else room.phone = conn;
    this.members.set(conn, { conn, role, room });

    conn.send(this.welcome(room, role, iceServers));
    this.connOf(room, other(role))?.send({ t: 'peer_joined' });
  }

  private welcome(room: Room, role: Role, iceServers: RTCIceServer[]): ServerMsg {
    return { t: 'welcome', role, iceServers, peerPresent: !!this.connOf(room, other(role)), floor: room.floor };
  }

  /**
   * Remove a connection from its room. `farewell` is sent to the removed connection.
   * `replacing` skips the peer_left notice because a new connection takes the slot right away.
   */
  private removeMember(conn: Conn, farewell: ServerMsg | null, replacing = false): void {
    const m = this.members.get(conn);
    if (!m) return;
    this.members.delete(conn);
    const room = m.room;
    if (farewell) conn.send(farewell);
    // Vacate the slot first so the floor broadcast doesn't reach the departing connection
    if (m.role === 'pc') room.pc = null;
    else room.phone = null;
    if (room.floor === m.role) this.setFloor(room, 'idle');
    if (!replacing) this.connOf(room, other(m.role))?.send({ t: 'peer_left' });
    if (!room.pc && !room.phone && !replacing) this.deleteRoom(room);
  }

  private deleteRoom(room: Room): void {
    if (room.floorTimer) clearTimeout(room.floorTimer);
    this.rooms.delete(room.code);
  }

  private setFloor(room: Room, holder: FloorHolder): void {
    if (room.floorTimer) {
      clearTimeout(room.floorTimer);
      room.floorTimer = null;
    }
    room.floor = holder;
    if (holder !== 'idle') {
      room.floorTimer = setTimeout(() => {
        room.floorTimer = null;
        if (room.floor === holder) this.setFloor(room, 'idle');
      }, this.opts.maxTxMs);
    }
    const msg: ServerMsg = { t: 'floor', holder };
    room.pc?.send(msg);
    room.phone?.send(msg);
  }

  private connOf(room: Room, role: Role): Conn | null {
    return role === 'pc' ? room.pc : room.phone;
  }
}

function parseClientMsg(raw: unknown): ClientMsg | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  switch (m.t) {
    case 'host':
    case 'join':
      if (typeof m.room !== 'string') return null;
      if (m.key !== undefined && typeof m.key !== 'string') return null;
      return { t: m.t, room: m.room, key: m.key as string | undefined };
    case 'signal': {
      const d = m.data as Record<string, unknown> | undefined;
      if (!d || typeof d !== 'object') return null;
      if ((d.kind === 'offer' || d.kind === 'answer') && typeof d.sdp === 'string') {
        return { t: 'signal', data: { kind: d.kind, sdp: d.sdp } };
      }
      if (d.kind === 'ice' && (d.candidate === null || typeof d.candidate === 'object')) {
        return { t: 'signal', data: { kind: 'ice', candidate: d.candidate as RTCIceCandidateInit | null } };
      }
      return null;
    }
    case 'floor_request':
    case 'floor_release':
    case 'kick':
    case 'pair_create':
      return { t: m.t };
    case 'announce': {
      if (!Array.isArray(m.subs) || m.subs.length > MAX_PUSH_SUBS || !m.subs.every(isPushSub)) return null;
      return { t: 'announce', subs: m.subs.map((s: PushSub) => ({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } })) };
    }
    case 'pair_claim':
      return typeof m.code === 'string' && m.code.length <= 16 ? { t: 'pair_claim', code: m.code } : null;
    default:
      return null;
  }
}
