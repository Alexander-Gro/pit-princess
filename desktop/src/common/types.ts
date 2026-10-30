// Types shared by the Electron main process, preload and renderer.

import type { CcSoundName, NoiseMode, PushSub, RadioFxSettings } from '@pit/shared';

export interface PttBinding {
  /** OS device path; distinguishes two identical devices */
  path: string;
  guid: string | null;
  name: string | null;
  button: number;
}

export interface Settings {
  serverUrl: string;
  /** Access key for a private server (the server's ACCESS_KEY); empty for open/local servers */
  accessKey: string;
  room: string | null;
  inputDeviceId: string;
  outputDeviceId: string;
  ptt: PttBinding | null;
  fx: RadioFxSettings;
  /** Mic level sent to the phone, 0..2 */
  micGain: number;
  feedbackSuppression: boolean;
  noise: NoiseMode;
  /** Phones to notify when this PC comes online, by the device that subscribed */
  pushSubs: StoredPushSub[];
  /** This PC's name, shown on the phones */
  pcName: string;
  /** Names the PC gave phones, by device id */
  deviceNames: Record<string, string>;
  /** Let phones hear each other (the PC relays). Off avoids howling when both phones share a room. */
  relayPhones: boolean;
  ccFolder: string | null;
}

export interface StoredPushSub {
  /** Device id of the phone that subscribed; null for subscriptions saved before multi-phone */
  device: string | null;
  sub: PushSub;
}

/** At most this many phone names are remembered */
export const MAX_DEVICE_NAMES = 20;

export interface JoystickInfo {
  path: string;
  guid: string | null;
  name: string | null;
  buttons: number;
}

export interface ButtonEvent {
  path: string;
  guid: string | null;
  name: string | null;
  button: number;
}

export interface CrewChiefResult {
  folder: string | null;
  files: Partial<Record<CcSoundName, Uint8Array>>;
  missing: CcSoundName[];
}

export interface PitApi {
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  loadCrewChief(): Promise<CrewChiefResult>;
  browseCrewChief(): Promise<CrewChiefResult | null>;
  listJoysticks(): Promise<JoystickInfo[]>;
  /** Next joystick button press is captured and saved as the PTT binding */
  startBind(): Promise<void>;
  cancelBind(): Promise<void>;
  onPtt(cb: (down: boolean) => void): void;
  onBindCaptured(cb: (b: PttBinding) => void): void;
  onJoysticks(cb: (list: JoystickInfo[]) => void): void;
  onJoystickError(cb: (msg: string) => void): void;
}
