// Types shared by the Electron main process, preload and renderer.

import type { CcSoundName, NoiseMode, RadioFxSettings } from '@pit/shared';

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
  ccFolder: string | null;
}

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
