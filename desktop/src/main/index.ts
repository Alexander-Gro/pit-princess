import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Joysticks, matchesBinding } from './joystick';
import { loadSettings, saveSettings } from './settings';
import { loadCrewChief, resolveFxFolder } from './crewchief';
import { MAX_PUSH_SUBS, NOISE_MODES, ROOM_CODE_RE, clampFx, cleanName, isDeviceId, isPushSub } from '@pit/shared';
import { MAX_DEVICE_NAMES, type Settings } from '../common/types';

// Dev/test aid: run with a throwaway settings folder
if (process.env.PIT_USER_DATA) app.setPath('userData', process.env.PIT_USER_DATA);

// The radio must play without a click in the window, and keep running while the sim has focus.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

let win: BrowserWindow | null = null;
const joysticks = new Joysticks();
let binding = false;
/** The physical button currently keying the mic, as `path#button`; null when PTT is up. */
let pttKey: string | null = null;

function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function releasePtt(): void {
  if (pttKey === null) return;
  pttKey = null;
  send('ptt', false);
}

function pressPtt(key: string): void {
  if (pttKey !== null) return;
  pttKey = key;
  send('ptt', true);
}

/** Save without letting a locked file (antivirus, indexer) throw out of an event handler. */
function trySave(patch: Partial<Settings>): void {
  try {
    saveSettings(patch);
  } catch (e) {
    console.warn('[settings] save failed', e);
  }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1040,
    height: 880,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#0b0b0d',
    // Packaged: copied next to the app by electron-builder (extraResources); dev: desktop/build
    icon: app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(__dirname, '../../build/icon.png'),
    title: 'Pit Princess',
    autoHideMenuBar: true,
    // Packaged builds take the icon from the exe; in dev, point Electron at it directly
    ...(app.isPackaged ? {} : { icon: join(__dirname, '../../build/icon.png') }),
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.once('ready-to-show', () => win?.show());
  // Dev aid: PIT_SCREENSHOT=out.png saves a capture of the window a few seconds after load
  const shot = process.env.PIT_SCREENSHOT;
  if (shot) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const img = await win?.webContents.capturePage();
        if (img) writeFileSync(shot, img.toPNG());
      }, Number(process.env.PIT_SCREENSHOT_DELAY ?? 4000));
    });
  }
  // External links (e.g. the phone URL) open in the default browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  // After a renderer reload, start from a clean PTT/bind state
  win.webContents.on('did-finish-load', () => {
    binding = false;
    pttKey = null;
  });
  win.on('closed', () => {
    win = null;
  });

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
}

function registerIpc(): void {
  ipcMain.handle('settings:get', () => loadSettings());
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
    const clean = sanitizePatch(patch);
    // Unbinding while the button is held must not leave the mic keyed
    if (clean.ptt === null) releasePtt();
    return saveSettings(clean);
  });
  ipcMain.handle('cc:load', () => loadCrewChief(loadSettings().ccFolder));
  ipcMain.handle('cc:browse', async () => {
    const opts = { title: 'Select the Crew Chief "Sounds" folder', properties: ['openDirectory' as const] };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled || !res.filePaths[0]) return null;
    const picked = res.filePaths[0];
    if (!resolveFxFolder(picked)) {
      await dialog.showMessageBox({
        type: 'warning',
        message: 'That folder does not contain Crew Chief radio sounds (fx\\start_bleep.wav).',
      });
      return null;
    }
    trySave({ ccFolder: picked });
    return loadCrewChief(picked);
  });
  ipcMain.handle('joy:list', () => joysticks.list());
  ipcMain.handle('bind:start', () => {
    binding = true;
    releasePtt();
  });
  ipcMain.handle('bind:cancel', () => {
    binding = false;
  });
}

/** Only accept known keys of the right type from the renderer. */
function sanitizePatch(patch: Partial<Settings>): Partial<Settings> {
  const out: Partial<Settings> = {};
  if (typeof patch.serverUrl === 'string' && /^https?:\/\/[^\s]+$/.test(patch.serverUrl)) {
    out.serverUrl = patch.serverUrl.replace(/\/+$/, '');
  }
  if (typeof patch.accessKey === 'string' && patch.accessKey.length <= 256) out.accessKey = patch.accessKey;
  if (typeof patch.room === 'string' && ROOM_CODE_RE.test(patch.room)) out.room = patch.room;
  if (typeof patch.inputDeviceId === 'string') out.inputDeviceId = patch.inputDeviceId;
  if (typeof patch.outputDeviceId === 'string') out.outputDeviceId = patch.outputDeviceId;
  if (patch.ptt === null) out.ptt = null;
  if (patch.fx && typeof patch.fx === 'object') {
    out.fx = clampFx({ ...loadSettings().fx, ...patch.fx });
  }
  if (patch.ccFolder === null) out.ccFolder = null;
  if (typeof patch.micGain === 'number' && Number.isFinite(patch.micGain)) {
    out.micGain = Math.max(0, Math.min(2, patch.micGain));
  }
  if (typeof patch.feedbackSuppression === 'boolean') out.feedbackSuppression = patch.feedbackSuppression;
  if (
    Array.isArray(patch.pushSubs) &&
    patch.pushSubs.length <= MAX_PUSH_SUBS &&
    patch.pushSubs.every((e) => e && (e.device === null || isDeviceId(e.device)) && isPushSub(e.sub))
  ) {
    out.pushSubs = patch.pushSubs.map((e) => ({ device: e.device, sub: e.sub }));
  }
  if (patch.pcName !== undefined) {
    const name = cleanName(patch.pcName);
    if (name) out.pcName = name;
  }
  if (patch.deviceNames && typeof patch.deviceNames === 'object' && !Array.isArray(patch.deviceNames)) {
    const entries = Object.entries(patch.deviceNames)
      .filter(([id, n]) => isDeviceId(id) && cleanName(n))
      .slice(-MAX_DEVICE_NAMES);
    out.deviceNames = Object.fromEntries(entries.map(([id, n]) => [id, cleanName(n)!]));
  }
  if (typeof patch.relayPhones === 'boolean') out.relayPhones = patch.relayPhones;
  if (typeof patch.noise === 'string' && NOISE_MODES.includes(patch.noise)) out.noise = patch.noise;
  return out;
}

function startJoysticks(): void {
  joysticks.on('error', (msg) => {
    console.warn('[joystick]', msg);
    send('joy:error', msg);
  });
  joysticks.on('devices', (list) => send('joy:devices', list));
  // A device unplugged mid-transmission must not leave the mic open
  joysticks.on('closed', (info) => {
    if (pttKey?.startsWith(`${info.path}#`)) releasePtt();
  });
  joysticks.on('button', (ev, down) => {
    const key = `${ev.path}#${ev.button}`;
    if (!down) {
      // Release on the exact button that keyed the mic, whatever the binding is now
      if (key === pttKey) releasePtt();
      return;
    }
    if (binding) {
      binding = false;
      const ptt = { path: ev.path, guid: ev.guid, name: ev.name, button: ev.button };
      trySave({ ptt });
      send('bind:captured', ptt);
      return;
    }
    const b = loadSettings().ptt;
    if (!b) return;
    const paths = new Set(joysticks.list().map((d) => d.path));
    if (!matchesBinding(b, ev, paths)) return;
    // Matched via guid+name fallback (device moved ports): lock onto this exact device
    if (ev.path !== b.path) trySave({ ptt: { ...b, path: ev.path } });
    pressPtt(key);
  });
  joysticks.start();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    registerIpc();
    createWindow();
    startJoysticks();
  });

  app.on('window-all-closed', () => {
    joysticks.stop();
    app.quit();
  });
}
