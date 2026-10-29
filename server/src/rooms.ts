// Room + floor logic, independent of the transport so it can be tested directly.

import { timingSafeEqual, createHash } from 'node:crypto';
import { MAX_TX_MS, ROOM_CODE_RE, type ClientMsg, type FloorHolder, type Role, type ServerMsg } from '@pit/shared';

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
}

const other = (r: Role): Role => (r === 'pc' ? 'phone' : 'pc');

export class RoomHub {
  readonly rooms = new Map<string, Room>();
  private members = new Map<Conn, Member>();
  /** Connections currently waiting on ICE servers before entering a room */
  private entering = new Map<Conn, { role: Role; code: string }>();
  private opts: Required<HubOptions>;

  constructor(opts: HubOptions) {
    this.opts = { maxTxMs: MAX_TX_MS, maxRooms: 1000, accessKey: '', ...opts };
  }

  async handle(conn: Conn, raw: unknown): Promise<void> {
    const msg = parseClientMsg(raw);
    if (!msg) {
      conn.send({ t: 'error', code: 'bad_message' });
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
      case 'kick': {
        if (m.role !== 'pc' || !room.phone) break;
        const phone = room.phone;
        this.removeMember(phone, { t: 'kicked', reason: 'kicked' });
        phone.close();
        break;
      }
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
      return { t: m.t };
    default:
      return null;
  }
}
