// Room + floor logic, independent of the transport so it can be tested directly.

import { timingSafeEqual, createHash, randomInt, randomBytes } from 'node:crypto';
import {
  MAX_PHONES,
  MAX_PUSH_SUBS,
  MAX_TX_MS,
  PAIR_CODE_RE,
  PAIR_CODE_TTL_MS,
  CALL_ID_RE,
  MEMBER_ID_RE,
  PC_ID,
  PROTOCOL_VERSION,
  ROOM_CODE_RE,
  cleanName,
  isDeviceId,
  isPushSub,
  type ClientMsg,
  type FloorHolder,
  type MemberId,
  type MemberInfo,
  type PushSub,
  type Role,
  type ServerMsg,
} from '@pit/shared';

export interface Conn {
  send(msg: ServerMsg): void;
  close(): void;
}

interface Member {
  conn: Conn;
  role: Role;
  /** 'pc', or a random id for this phone connection (phones never learn each other's device id) */
  id: MemberId;
  /** Phones: the device id they joined with; the PC uses it to remember names */
  device: string | null;
  /** Phones: seat number 1..MAX_PHONES, kept while connected */
  slot: number;
  room: Room;
}

interface Room {
  code: string;
  pc: Conn | null;
  /** member id -> connection, at most MAX_PHONES */
  phones: Map<MemberId, Conn>;
  /** Display names set by the PC, by member id (dropped when the member leaves) */
  names: Record<MemberId, string>;
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

export class RoomHub {
  readonly rooms = new Map<string, Room>();
  private members = new Map<Conn, Member>();
  /** Connections currently waiting on ICE servers before entering a room */
  private entering = new Map<Conn, { role: Role; code: string; device: string | null }>();
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
      if (msg.v !== PROTOCOL_VERSION) {
        // An app from before multi-phone rooms; it would half-work, so ask for a reload instead
        conn.send({ t: 'error', code: 'update_required' });
        conn.close();
        return;
      }
      if (!this.keyOk(msg.key)) {
        conn.send({ t: 'error', code: 'unauthorized' });
        conn.close();
        return;
      }
      const device = msg.t === 'join' && isDeviceId(msg.device) ? msg.device : null;
      await this.enter(conn, msg.t === 'host' ? 'pc' : 'phone', msg.room, device);
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
        // Phones only ever talk to the PC; the PC says which phone
        const target = m.role === 'phone' ? room.pc : msg.to ? room.phones.get(msg.to) : undefined;
        target?.send({ t: 'signal', from: m.id, cid: msg.cid, data: msg.data });
        break;
      }
      case 'floor_request': {
        if (room.floor === m.id) {
          conn.send({ t: 'floor', holder: m.id });
        } else if (room.floor !== 'idle' || (m.role === 'phone' ? !room.pc : room.phones.size === 0)) {
          conn.send({ t: 'busy' });
        } else {
          this.setFloor(room, m.id);
        }
        break;
      }
      case 'floor_release': {
        if (room.floor === m.id) this.setFloor(room, 'idle');
        break;
      }
      case 'names': {
        if (m.role !== 'pc') break;
        const present = new Set([PC_ID, ...room.phones.keys()]);
        room.names = Object.fromEntries(Object.entries(msg.names).filter(([id]) => present.has(id)));
        this.broadcastRoster(room);
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
        if (m.role !== 'pc') break;
        const one = msg.id ? room.phones.get(msg.id) : undefined;
        const targets = msg.id ? (one ? [one] : []) : [...room.phones.values()];
        for (const phone of targets) {
          this.removeMember(phone, { t: 'kicked', reason: 'kicked' });
          phone.close();
        }
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
    const target = entry ? this.rooms.get(entry.room) : undefined;
    if (entry && target?.pc && target.phones.size >= MAX_PHONES) {
      // Valid code, no free seat: keep the code for after a phone is kicked
      conn.send({ t: 'error', code: 'room_full' });
      return;
    }
    if (!entry || !target?.pc) {
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

  private async enter(conn: Conn, role: Role, code: string, device: string | null): Promise<void> {
    if (!ROOM_CODE_RE.test(code)) {
      conn.send({ t: 'error', code: 'bad_room' });
      return;
    }
    // A second host/join while the first waits for ICE just updates the target; the latest wins.
    const waiting = this.entering.has(conn);
    this.entering.set(conn, { role, code, device });
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
    ({ role, code, device } = target);

    const prev = this.members.get(conn);
    if (prev) {
      if (prev.room.code === code && prev.role === role && prev.device === device) {
        conn.send(this.welcome(prev.room, prev, iceServers));
        return;
      }
      // A host switching to a new code closes its old room (and kicks the phones in it).
      const oldRoom = prev.room;
      this.removeMember(conn, null);
      if (prev.role === 'pc') {
        for (const phone of [...oldRoom.phones.values()]) {
          this.removeMember(phone, { t: 'kicked', reason: 'room_closed' });
          phone.close();
        }
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
      room = { code, pc: null, phones: new Map(), names: {}, floor: 'idle', floorTimer: null };
      this.rooms.set(code, room);
    }

    // Same PC or same phone device reconnecting: the new connection takes over. The old one is
    // removed normally (floor released, PC told peer_left) and the new one gets a fresh member id.
    const existing =
      role === 'pc'
        ? room.pc
        : device
          ? [...room.phones.values()].find((c) => this.members.get(c)?.device === device)
          : undefined;
    let slot = 0;
    if (existing && existing !== conn) {
      slot = this.members.get(existing)?.slot ?? 0;
      this.removeMember(existing, { t: 'kicked', reason: 'replaced' }, true);
      existing.close();
    } else if (role === 'phone' && room.phones.size >= MAX_PHONES) {
      conn.send({ t: 'error', code: 'room_full' });
      return;
    }

    const id = role === 'pc' ? PC_ID : this.newMemberId();
    if (role === 'phone' && !slot) {
      const used = new Set([...room.phones.values()].map((c) => this.members.get(c)?.slot));
      slot = 1;
      while (used.has(slot)) slot++;
    }
    if (role === 'pc') room.pc = conn;
    else room.phones.set(id, conn);
    const member: Member = { conn, role, id, device: role === 'phone' ? device : null, slot, room };
    this.members.set(conn, member);

    conn.send(this.welcome(room, member, iceServers));
    // WebRTC runs PC <-> each phone, so only those pairs hear about each other's arrival
    if (role === 'pc') for (const phone of room.phones.values()) phone.send({ t: 'peer_joined', id: PC_ID });
    else room.pc?.send({ t: 'peer_joined', id });
    this.broadcastRoster(room);
  }

  private welcome(room: Room, m: Member, iceServers: RTCIceServer[]): ServerMsg {
    return { t: 'welcome', role: m.role, you: m.id, iceServers, floor: room.floor, members: this.roster(room, m.role === 'pc') };
  }

  /** `forPc` adds phones' device ids, which only the PC needs (to remember names) */
  private roster(room: Room, forPc: boolean): MemberInfo[] {
    const list: MemberInfo[] = [];
    if (room.pc) list.push({ id: PC_ID, role: 'pc', name: room.names[PC_ID] ?? null });
    for (const [id, c] of room.phones) {
      const m = this.members.get(c);
      const info: MemberInfo = { id, role: 'phone', name: room.names[id] ?? null, slot: m?.slot };
      if (forPc && m?.device) info.device = m.device;
      list.push(info);
    }
    return list;
  }

  private broadcastRoster(room: Room): void {
    room.pc?.send({ t: 'roster', members: this.roster(room, true) });
    const forPhones: ServerMsg = { t: 'roster', members: this.roster(room, false) };
    for (const c of room.phones.values()) c.send(forPhones);
  }

  private newMemberId(): MemberId {
    return `m${randomBytes(9).toString('base64url')}`;
  }

  private conns(room: Room): Conn[] {
    return [...(room.pc ? [room.pc] : []), ...room.phones.values()];
  }

  /**
   * Remove a connection from its room. `farewell` is sent to the removed connection.
   * `replacing` keeps the room alive because a new connection takes the slot right away.
   */
  private removeMember(conn: Conn, farewell: ServerMsg | null, replacing = false): void {
    const m = this.members.get(conn);
    if (!m) return;
    this.members.delete(conn);
    const room = m.room;
    if (farewell) conn.send(farewell);
    // Vacate the slot first so the floor broadcast doesn't reach the departing connection
    if (m.role === 'pc') room.pc = null;
    else room.phones.delete(m.id);
    delete room.names[m.id];
    // A phone's transmission needs the PC to hear and relay it, so the PC leaving ends it too
    if (room.floor === m.id || (m.role === 'pc' && room.floor !== 'idle')) this.setFloor(room, 'idle');
    if (m.role === 'pc') for (const phone of room.phones.values()) phone.send({ t: 'peer_left', id: PC_ID });
    else room.pc?.send({ t: 'peer_left', id: m.id });
    this.broadcastRoster(room);
    if (!room.pc && room.phones.size === 0 && !replacing) this.deleteRoom(room);
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
    for (const c of this.conns(room)) c.send(msg);
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
      if (m.v !== undefined && typeof m.v !== 'number') return null;
      if (m.t === 'join') {
        if (m.device !== undefined && typeof m.device !== 'string') return null;
        return { t: 'join', v: m.v as number | undefined, room: m.room, key: m.key as string | undefined, device: m.device as string | undefined };
      }
      return { t: 'host', v: m.v as number | undefined, room: m.room, key: m.key as string | undefined };
    case 'signal': {
      const d = m.data as Record<string, unknown> | undefined;
      if (!d || typeof d !== 'object') return null;
      if (m.to !== undefined && (typeof m.to !== 'string' || !MEMBER_ID_RE.test(m.to))) return null;
      if (typeof m.cid !== 'string' || !CALL_ID_RE.test(m.cid)) return null;
      const to = m.to as string | undefined;
      const cid = m.cid;
      if ((d.kind === 'offer' || d.kind === 'answer') && typeof d.sdp === 'string') {
        return { t: 'signal', to, cid, data: { kind: d.kind, sdp: d.sdp } };
      }
      if (d.kind === 'ice' && (d.candidate === null || typeof d.candidate === 'object')) {
        return { t: 'signal', to, cid, data: { kind: 'ice', candidate: d.candidate as RTCIceCandidateInit | null } };
      }
      return null;
    }
    case 'kick':
      if (m.id !== undefined && (typeof m.id !== 'string' || !MEMBER_ID_RE.test(m.id))) return null;
      return { t: 'kick', id: m.id as string | undefined };
    case 'names': {
      if (typeof m.names !== 'object' || m.names === null || Array.isArray(m.names)) return null;
      const entries = Object.entries(m.names as Record<string, unknown>);
      if (entries.length > 1 + MAX_PHONES * 10) return null;
      const names: Record<MemberId, string> = {};
      for (const [id, v] of entries) {
        const name = cleanName(v);
        if (!MEMBER_ID_RE.test(id) || !name) return null;
        names[id] = name;
      }
      return { t: 'names', names };
    }
    case 'floor_request':
    case 'floor_release':
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
