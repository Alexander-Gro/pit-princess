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
  | { t: 'kick' };

export type ErrorCode = 'bad_room' | 'no_host' | 'not_in_room' | 'bad_message' | 'unauthorized';

export type ServerMsg =
  | { t: 'welcome'; role: Role; iceServers: RTCIceServer[]; peerPresent: boolean; floor: FloorHolder }
  | { t: 'peer_joined' }
  | { t: 'peer_left' }
  | { t: 'signal'; data: SignalData }
  | { t: 'floor'; holder: FloorHolder }
  | { t: 'busy' }
  /** Fresh TURN credentials for long sessions */
  | { t: 'ice'; iceServers: RTCIceServer[] }
  | { t: 'kicked'; reason: 'replaced' | 'room_closed' | 'kicked' }
  | { t: 'error'; code: ErrorCode };

export function generateRoomCode(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
