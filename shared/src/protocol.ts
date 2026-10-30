// Wire protocol between the clients (PC + phone) and the signaling server.

export type Role = 'pc' | 'phone';
/** A room member: 'pc' for the PC, the phone's device id for a phone */
export type MemberId = string;
export const PC_ID = 'pc';
/** 'idle' or the id of the member who is talking */
export type FloorHolder = 'idle' | MemberId;

/** Phones allowed in a room at once (plus the PC) */
export const MAX_PHONES = 2;
/** Phone device ids: random base64url, kept in the phone's storage */
export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const MAX_NAME_LEN = 24;

/** Protocol version sent in host/join; older clients are told to update */
export const PROTOCOL_VERSION = 4;

/** Member ids: 'pc', or a random id the server gives each phone connection */
export const MEMBER_ID_RE = /^(pc|[A-Za-z0-9_-]{4,64})$/;
/** Call id: ties offer/answer/ICE to one RTCPeerConnection attempt */
export const CALL_ID_RE = /^[A-Za-z0-9_-]{4,32}$/;

export interface MemberInfo {
  id: MemberId;
  role: Role;
  /** Set by the PC; null when it hasn't named this device */
  name: string | null;
  /** Phones: stable seat number 1..MAX_PHONES while connected */
  slot?: number;
  /** Phones: the device id. Only included in the PC's copy of the roster. */
  device?: string;
  /** Phones: opaque id for the "PC online"/ping directory (not the device id) */
  pushId?: string;
  /** The app isn't on screen (backgrounded or locked): treat as gone for pings */
  away?: boolean;
  /** Changes on every app launch: a new value means a new instance, so old links are stale */
  inst?: string;
}

export function isDeviceId(v: unknown): v is string {
  return typeof v === 'string' && DEVICE_ID_RE.test(v) && v !== PC_ID && v !== 'idle';
}

/** Trim and validate a display name; null if unusable. */
export function cleanName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  // No control characters; collapse whitespace
  const s = v
    .replace(/[\t\n\r]/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length >= 1 && s.length <= MAX_NAME_LEN ? s : null;
}

export function generateDeviceId(): string {
  return generateRoomCode();
}

export const ROOM_CODE_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** Longest a single transmission may last before the server releases the floor. */
export const MAX_TX_MS = 60_000;

export type SignalData =
  | { kind: 'offer' | 'answer'; sdp: string }
  | { kind: 'ice'; candidate: RTCIceCandidateInit | null }
  /** The answering side's connection failed: ask the offerer to start a new call */
  | { kind: 'restart' };

/** A phone's Web Push subscription (PushSubscription.toJSON()), kept by the PC app */
export interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** At most this many phones are notified per PC */
export const MAX_PUSH_SUBS = 5;

/**
 * Push services browsers actually use. The server POSTs to subscription endpoints, so only
 * these hosts are accepted; anything else (IP literals, internal hosts) could be used to make
 * the server send requests on someone's behalf.
 */
const PUSH_HOSTS = ['push.apple.com', 'fcm.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com'];

export function isPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

export function isPushSub(v: unknown): v is PushSub {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  const keys = s.keys as Record<string, unknown> | undefined;
  return (
    typeof s.endpoint === 'string' &&
    s.endpoint.length <= 1024 &&
    isPushEndpoint(s.endpoint) &&
    typeof keys === 'object' &&
    keys !== null &&
    typeof keys.p256dh === 'string' &&
    keys.p256dh.length <= 256 &&
    typeof keys.auth === 'string' &&
    keys.auth.length <= 256
  );
}

/**
 * One phone's entry in the room's notification directory. Every device keeps a copy and they
 * sync over the data channels, so whoever is online can ping the others (the server keeps none).
 * `owner` is the phone's push id; `sub: null` means it turned notifications off.
 */
export interface PushEntry {
  owner: string;
  sub: PushSub | null;
  /** Owner's clock when it last changed; the newest entry per owner wins */
  ts: number;
}

export function isPushEntry(v: unknown): v is PushEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    isDeviceId(e.owner) &&
    (e.sub === null || isPushSub(e.sub)) &&
    typeof e.ts === 'number' &&
    Number.isFinite(e.ts) &&
    e.ts > 0
  );
}

/** Data channel message: share the notification directory */
export interface DirMsg {
  t: 'dir';
  entries: PushEntry[];
}

/** Directory size cap (live entries plus "turned off" markers) */
export const MAX_DIR_ENTRIES = 12;

export function isDirMsg(v: unknown): v is DirMsg {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  return m.t === 'dir' && Array.isArray(m.entries) && m.entries.length <= MAX_DIR_ENTRIES && m.entries.every(isPushEntry);
}

export type ClientMsg =
  /** `key` is the server's access key, required when the server sets ACCESS_KEY */
  | { t: 'host'; v?: number; room: string; key?: string; inst?: string }
  /** `device` identifies the phone across reconnects (one slot per device) */
  /** `name`: the name this phone was last given (until the PC names it); `push`: its push id */
  | { t: 'join'; v?: number; room: string; key?: string; device?: string; name?: string; push?: string; inst?: string }
  /** `to` (PC only): the phone it's for. Phones always signal the PC. */
  | { t: 'signal'; to?: MemberId; cid: string; data: SignalData }
  | { t: 'floor_request' }
  | { t: 'floor_release' }
  /** PC: kick one phone, or every phone when `id` is omitted */
  | { t: 'kick'; id?: MemberId }
  /** PC: display names for itself ('pc') and the phones (by member id) */
  | { t: 'names'; names: Record<MemberId, string | null> }
  /** PC: create a short pairing code for this room */
  | { t: 'pair_create' }
  /** Phone (no room or key yet): trade a pairing code for the room and key */
  | { t: 'pair_claim'; code: string }
  /** PC: "I'm online" — notify these phones if none of them is connected yet */
  | { t: 'announce'; subs: PushSub[] }
  /** Any member: "get on the radio" to these (absent) phones */
  | { t: 'ping'; subs: PushSub[] }
  /** PC: room-wide settings */
  | { t: 'room_settings'; phonesHear: boolean }
  /** Keep-alive: the server answers with hb, so a dead connection is noticed quickly */
  | { t: 'hb' }
  /** Our app went to the background (away) or came back */
  | { t: 'presence'; away: boolean }
  /** Share the notification directory with the room (the server relays it, never stores it) */
  | { t: 'dir'; entries: PushEntry[] };

export type ErrorCode = 'bad_room' | 'no_host' | 'not_in_room' | 'bad_message' | 'unauthorized' | 'bad_code' | 'rate_limited' | 'room_full' | 'update_required' | 'server_full';

export type ServerMsg =
  | {
      t: 'welcome';
      role: Role;
      you: MemberId;
      iceServers: RTCIceServer[];
      floor: FloorHolder;
      members: MemberInfo[];
      /** Whether phones should hear each other while the PC is here */
      phonesHear: boolean;
    }
  /** Everyone in the room, sent whenever someone joins, leaves or is renamed */
  | { t: 'roster'; members: MemberInfo[]; phonesHear: boolean }
  /** A peer to set up WebRTC with arrived/left (phones are only told about the PC) */
  | { t: 'peer_joined'; id: MemberId }
  | { t: 'peer_left'; id: MemberId }
  | { t: 'signal'; from: MemberId; cid: string; data: SignalData }
  | { t: 'floor'; holder: FloorHolder }
  | { t: 'busy' }
  | { t: 'pair_code'; code: string; expiresInMs: number }
  | { t: 'paired'; room: string; key: string }
  /** Result of an announce: subscriptions the push service says are gone (forget them) */
  | { t: 'announced'; sent: number; gone: string[]; failed?: number }
  | { t: 'hb' }
  /** Another member's copy of the notification directory */
  | { t: 'dir'; from: MemberId; entries: PushEntry[] }
  /** Result of a ping; `limited` when it was refused for coming too soon */
  | {
      t: 'pinged';
      sent: number;
      gone: string[];
      limited: boolean;
      unavailable?: boolean;
      /** Deliveries the push service refused (not "gone"): e.g. a 403 */
      failed?: number;
      /** When limited: how long until pinging is allowed again */
      waitMs?: number;
    }
  /** Fresh TURN credentials for long sessions */
  | { t: 'ice'; iceServers: RTCIceServer[] }
  | { t: 'kicked'; reason: 'replaced' | 'room_closed' | 'kicked' }
  | { t: 'error'; code: ErrorCode };

/** How long a pairing code shown on the PC stays valid */
export const PAIR_CODE_TTL_MS = 10 * 60_000;
export const PAIR_CODE_RE = /^\d{6}$/;

export function generateRoomCode(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
