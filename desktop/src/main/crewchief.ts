// Locate and read Crew Chief V4's radio sound effects from the local install.
// The files are only read, never copied or redistributed.

import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { CC_SOUND_NAMES, MAX_FX_FILE_BYTES, type CcSoundName } from '@pit/shared';
import type { CrewChiefResult } from '../common/types';

function candidates(): string[] {
  const local = process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Local');
  return [join(local, 'CrewChiefV4', 'Sounds'), join(local, 'CrewChiefV4', 'sounds')];
}

/** Accept either the Sounds folder or its fx subfolder. Returns the fx folder. */
export function resolveFxFolder(folder: string): string | null {
  for (const dir of [join(folder, 'fx'), folder]) {
    if (existsSync(join(dir, 'start_bleep.wav'))) return dir;
  }
  return null;
}

export function detectCrewChief(): string | null {
  for (const c of candidates()) {
    const fx = resolveFxFolder(c);
    if (fx) return fx;
  }
  return null;
}

export async function loadCrewChief(folder: string | null): Promise<CrewChiefResult> {
  const fx = (folder && resolveFxFolder(folder)) || detectCrewChief();
  const result: CrewChiefResult = { folder: fx, files: {}, missing: [] };
  for (const name of CC_SOUND_NAMES) {
    if (!fx) {
      result.missing.push(name);
      continue;
    }
    const path = join(fx, `${name}.wav`);
    try {
      const st = await stat(path);
      // Keep files small enough to send over the phone's data channel in one message
      if (st.size > MAX_FX_FILE_BYTES) throw new Error('too large');
      result.files[name] = new Uint8Array(await readFile(path));
    } catch {
      result.missing.push(name as CcSoundName);
    }
  }
  return result;
}
