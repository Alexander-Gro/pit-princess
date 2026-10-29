import { contextBridge, ipcRenderer } from 'electron';
import type { PitApi } from '../common/types';

const api: PitApi = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  loadCrewChief: () => ipcRenderer.invoke('cc:load'),
  browseCrewChief: () => ipcRenderer.invoke('cc:browse'),
  listJoysticks: () => ipcRenderer.invoke('joy:list'),
  startBind: () => ipcRenderer.invoke('bind:start'),
  cancelBind: () => ipcRenderer.invoke('bind:cancel'),
  onPtt: (cb) => void ipcRenderer.on('ptt', (_e, down: boolean) => cb(down)),
  onBindCaptured: (cb) => void ipcRenderer.on('bind:captured', (_e, b) => cb(b)),
  onJoysticks: (cb) => void ipcRenderer.on('joy:devices', (_e, list) => cb(list)),
  onJoystickError: (cb) => void ipcRenderer.on('joy:error', (_e, msg: string) => cb(msg)),
};

contextBridge.exposeInMainWorld('pit', api);
