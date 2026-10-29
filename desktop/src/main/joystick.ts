// Joystick/wheel input via SDL2. Unlike the browser Gamepad API this keeps
// working while the sim has focus.

import { EventEmitter } from 'node:events';
import type { ButtonEvent, JoystickInfo, PttBinding } from '../common/types';

// Must be set before SDL initialises: deliver joystick events while we're not the focused app.
process.env.SDL_JOYSTICK_ALLOW_BACKGROUND_EVENTS = '1';

type Sdl = typeof import('@kmamal/sdl');
type Instance = ReturnType<Sdl['joystick']['openDevice']>;
type Device = Sdl['joystick']['devices'][number];

export interface JoystickEvents {
  button: [ev: ButtonEvent, down: boolean];
  /** A device went away; any button it was holding is effectively released. */
  closed: [info: JoystickInfo];
  devices: [list: JoystickInfo[]];
  error: [msg: string];
}

/**
 * Note: @kmamal/sdl reconciles devices by index, so after a removal its Device objects
 * can be overwritten with a neighbour's data and `deviceRemove` may name the wrong one.
 * We therefore snapshot each device's identity when opening it and rely only on the
 * instance's own 'close' event, which the library fires for the right instance.
 */
export class Joysticks extends EventEmitter<JoystickEvents> {
  private sdl: Sdl | null = null;
  private opened = new Map<Instance, JoystickInfo>();

  start(): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      this.sdl = require('@kmamal/sdl') as Sdl;
    } catch (e) {
      this.emit('error', `Joystick support unavailable: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const js = this.sdl.joystick;
    js.on('deviceAdd', () => this.openAll());
    js.on('deviceRemove', () => this.openAll());
    this.openAll();
  }

  list(): JoystickInfo[] {
    return [...this.opened.values()].map((i) => ({ ...i }));
  }

  stop(): void {
    for (const instance of this.opened.keys()) if (!instance.closed) instance.close();
    this.opened.clear();
  }

  /** Open any device that isn't open yet (matched by OS path). */
  private openAll(): void {
    if (!this.sdl) return;
    const openPaths = new Set([...this.opened.values()].map((i) => i.path));
    for (const d of this.sdl.joystick.devices) {
      const path = d.path ?? `id:${d.id}`;
      if (!openPaths.has(path)) this.open(d, path);
    }
    this.emit('devices', this.list());
  }

  private open(device: Device, path: string): void {
    let instance: Instance;
    try {
      instance = this.sdl!.joystick.openDevice(device);
    } catch (e) {
      console.warn('[joystick] cannot open', device.name, e);
      return;
    }
    const info: JoystickInfo = { path, guid: device.guid, name: device.name, buttons: instance.buttons.length };
    this.opened.set(instance, info);
    const ev = { path, guid: info.guid, name: info.name };
    instance.on('buttonDown', ({ button }) => this.emit('button', { ...ev, button }, true));
    instance.on('buttonUp', ({ button }) => this.emit('button', { ...ev, button }, false));
    instance.on('close', () => {
      this.opened.delete(instance);
      this.emit('closed', info);
      this.emit('devices', this.list());
    });
  }
}

/**
 * Does a button event match the saved binding? The device path is exact; if the saved path
 * isn't connected (device moved to another USB port) fall back to guid + name.
 */
export function matchesBinding(b: PttBinding, ev: ButtonEvent, connectedPaths: Set<string>): boolean {
  if (ev.button !== b.button) return false;
  if (ev.path === b.path) return true;
  if (connectedPaths.has(b.path)) return false;
  return ev.guid === b.guid && ev.name === b.name;
}
