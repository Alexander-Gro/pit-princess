// Wire protocol between the clients (PC + phone) and the signaling server.

export type Role = 'pc' | 'phone';
export type FloorHolder = 'idle' | Role;

export const ROOM_CODE_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** Longest a single transmission may last before the server releases the floor. */
export const MAX_TX_MS = 60_000;

export type SignalData =
  | { kind: 'offer' | 'answer'; sdp: string }
  | { kind: 'ice'; candidate: RTCIceCandidateInit | null };

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
  | { t: 'pair_claim'; code: string };

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
