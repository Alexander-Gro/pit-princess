// Wire protocol between the clients (PC + phone) and the signaling server.

export type Role = 'pc' | 'phone';
export type FloorHolder = 'idle' | Role;

export const ROOM_CODE_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** Longest a single transmission may last before the server releases the floor. */
export const MAX_TX_MS = 60_000;

export type SignalData =
  | { kind: 'offer' | 'answer'; sdp: string }
  | { kind: 'ice'; candidate: RTCIceCandidateInit | null };

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

/** Data channel messages from the phone to the PC */
export type PhoneToPcMsg = { t: 'push_sub'; sub: PushSub } | { t: 'push_unsub'; endpoint: string };

export function isPhoneToPcMsg(v: unknown): v is PhoneToPcMsg {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  if (m.t === 'push_sub') return isPushSub(m.sub);
  if (m.t === 'push_unsub') return typeof m.endpoint === 'string' && m.endpoint.length <= 1024;
  return false;
}

export type ClientMsg =
  /** `key` is the server's access key, required when the server sets ACCESS_KEY */
  | { t: 'host'; room: string; key?: string }
  | { t: 'join'; room: string; key?: string }
  | { t: 'signal'; data: SignalData }
  | { t: 'floor_request' }
  | { t: 'floor_release' }
  | { t: 'kick' }
  /** PC: create a short pairing code for this room */
  | { t: 'pair_create' }
  /** Phone (no room or key yet): trade a pairing code for the room and key */
  | { t: 'pair_claim'; code: string }
  /** PC: "I'm online" — notify these phones if none of them is connected yet */
  | { t: 'announce'; subs: PushSub[] };

export type ErrorCode = 'bad_room' | 'no_host' | 'not_in_room' | 'bad_message' | 'unauthorized' | 'bad_code' | 'rate_limited';

export type ServerMsg =
  | { t: 'welcome'; role: Role; iceServers: RTCIceServer[]; peerPresent: boolean; floor: FloorHolder }
  | { t: 'peer_joined' }
  | { t: 'peer_left' }
  | { t: 'signal'; data: SignalData }
  | { t: 'floor'; holder: FloorHolder }
  | { t: 'busy' }
  | { t: 'pair_code'; code: string; expiresInMs: number }
  | { t: 'paired'; room: string; key: string }
  /** Result of an announce: subscriptions the push service says are gone (forget them) */
  | { t: 'announced'; sent: number; gone: string[] }
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
