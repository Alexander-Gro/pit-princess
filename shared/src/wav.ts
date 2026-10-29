// Helpers for sending the Crew Chief sound files to the phone over the data channel.

import { CC_SOUND_NAMES, type CcSoundName } from './radio.ts';

/** Data channel message carrying one sound file. Files are ~10-20 KB, well under the SCTP message limit. */
export interface FxFileMsg {
  t: 'fx';
  name: CcSoundName;
  b64: string;
}

export const MAX_FX_FILE_BYTES = 40_000;

export function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(bin);
}

export function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function isFxFileMsg(msg: unknown): msg is FxFileMsg {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return (
    m.t === 'fx' &&
    typeof m.name === 'string' &&
    (CC_SOUND_NAMES as readonly string[]).includes(m.name) &&
    typeof m.b64 === 'string' &&
    m.b64.length <= Math.ceil(MAX_FX_FILE_BYTES / 3) * 4
  );
}
