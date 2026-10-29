import { app } from 'electron';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_FX } from '@pit/shared';
import type { Settings } from '../common/types';

const DEFAULTS: Settings = {
  serverUrl: process.env.PIT_SERVER_URL ?? 'http://localhost:8787',
  accessKey: '',
  room: null,
  inputDeviceId: 'default',
  outputDeviceId: 'default',
  ptt: null,
  fx: { ...DEFAULT_FX },
  micGain: 1,
  feedbackSuppression: true,
  noise: 'strong',
  ccFolder: null,
};

let cache: Settings | null = null;

function file(): string {
  return join(app.getPath('userData'), 'settings.json');
}

export function loadSettings(): Settings {
  if (cache) return cache;
  let stored: Partial<Settings> = {};
  try {
    if (existsSync(file())) stored = JSON.parse(readFileSync(file(), 'utf8'));
  } catch (e) {
    console.warn('[settings] unreadable, using defaults', e);
  }
  cache = { ...DEFAULTS, ...stored, fx: { ...DEFAULTS.fx, ...(stored.fx ?? {}) } };
  return cache;
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next: Settings = { ...loadSettings(), ...patch };
  if (patch.fx) next.fx = { ...loadSettings().fx, ...patch.fx };
  cache = next;
  // Write-then-rename so a crash mid-write can't corrupt the file
  const tmp = `${file()}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, file());
  return next;
}
