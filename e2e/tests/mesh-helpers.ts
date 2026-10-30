// Shared helpers for the full-mesh specs: real phone PWAs (each in its OWN browser context, so
// each has its own localStorage / device id / push id) and the RadioLink 'pc' harness.
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';

export const SERVER = `http://localhost:${process.env.E2E_SERVER_PORT}`;
export const HARNESS = `http://127.0.0.1:${process.env.E2E_HARNESS_PORT}`;
export const WS = `ws://localhost:${process.env.E2E_SERVER_PORT}/ws`;

export type Member = { id: string; role: 'pc' | 'phone'; name: string | null; slot?: number; device?: string; pushId?: string };
export type PitState = {
  peer: string;
  floor: string;
  tx: boolean;
  rx: boolean;
  signaling: string;
  phonesHear: boolean;
  members: Member[];
  peers: { id: string; status: string }[];
};
export const pcState = (pc: Page) => pc.evaluate(() => window.pit.state as unknown as PitState);

export const newRoom = () => `e2e_${randomBytes(12).toString('hex')}`;

export function logConsole(name: string, p: Page) {
  p.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[${name} console.${m.type()}] ${m.text()}`);
  });
  p.on('pageerror', (e) => console.log(`[${name} pageerror] ${e}`));
}

/** Runs in each phone page before app code: remember RTCPeerConnections so the test can read stats. */
function recordPeerConnections() {
  const w = window as unknown as { __pcs: RTCPeerConnection[] };
  w.__pcs = [];
  const Orig = window.RTCPeerConnection;
  const Wrapped = function (this: unknown, ...args: ConstructorParameters<typeof RTCPeerConnection>) {
    const pc = new Orig(...args);
    w.__pcs.push(pc);
    return pc;
  } as unknown as typeof RTCPeerConnection;
  Wrapped.prototype = Orig.prototype;
  Object.setPrototypeOf(Wrapped, Orig);
  window.RTCPeerConnection = Wrapped;
}

export interface Phone {
  name: string;
  context: BrowserContext;
  page: Page;
  text: ReturnType<Page['locator']>;
  sub: ReturnType<Page['locator']>;
  link: ReturnType<Page['locator']>;
  /** server->phone websocket frames */
  frames: string[];
  /** phone->server websocket frames */
  sent: string[];
}

export interface OpenOpts {
  /** localStorage entries to set before the app loads */
  storage?: Record<string, string>;
}

export async function openPhone(browser: Browser, name: string, room: string, opts: OpenOpts = {}): Promise<Phone> {
  const context = await browser.newContext({ permissions: ['microphone'] });
  const page = await context.newPage();
  logConsole(name, page);
  await page.addInitScript(recordPeerConnections);
  if (opts.storage) {
    await page.addInitScript((kv) => {
      for (const [k, v] of Object.entries(kv)) if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
    }, opts.storage);
  }
  const frames: string[] = [];
  const sent: string[] = [];
  page.on('websocket', (ws) => {
    ws.on('framereceived', (f) => frames.push(String(f.payload)));
    ws.on('framesent', (f) => sent.push(String(f.payload)));
  });
  await page.goto(`${SERVER}/#room=${room}`);
  await page.locator('#ptt').click();
  return {
    name,
    context,
    page,
    text: page.locator('#ptt-text'),
    sub: page.locator('#ptt-sub'),
    link: page.locator('#v-link'),
    frames,
    sent,
  };
}

export async function openPc(context: BrowserContext, room: string): Promise<Page> {
  const pc = await context.newPage();
  logConsole('pc', pc);
  await pc.goto(`${HARNESS}/pc.html?ws=${encodeURIComponent(WS)}&room=${room}`);
  await expect.poll(() => pc.evaluate(() => window.pit.error ?? window.pit.ready)).toBe(true);
  await expect.poll(async () => (await pcState(pc)).signaling).toBe('open');
  return pc;
}

/** Inbound audio bytes of every live peer connection of a phone (one per other member) */
export async function phoneInbound(p: Phone): Promise<number[]> {
  return p.page.evaluate(async () => {
    const pcs = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.filter((c) => c.connectionState !== 'closed');
    const out: number[] = [];
    for (const pc of pcs) {
      let n = 0;
      (await pc.getStats()).forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio') n = r.bytesReceived ?? 0;
      });
      out.push(n);
    }
    return out;
  });
}

/**
 * Inbound audio bytes/s at a phone on its loudest link, averaged over `ms`. With the mesh a phone
 * has one connection per other member; whoever talks shows up on one of them, the others carry
 * encoded silence, so the max per link is the clearest signal.
 */
export async function phoneRate(p: Phone, ms = 2000): Promise<number> {
  const a = await phoneInbound(p);
  await p.page.waitForTimeout(ms);
  const b = await phoneInbound(p);
  return Math.max(0, ...b.map((x, i) => Math.round(((x - (a[i] ?? 0)) * 1000) / ms)));
}

/** Live peer connections of a phone that are connected */
export const connectedPcs = (p: Phone) =>
  p.page.evaluate(() => (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.filter((c) => c.connectionState === 'connected').length);
/** Every RTCPeerConnection the phone ever made */
export const totalPcs = (p: Phone) => p.page.evaluate(() => (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.length);

export async function press(p: Phone): Promise<void> {
  const box = (await p.page.locator('#ptt').boundingBox())!;
  await p.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await p.page.mouse.down();
}
export const release = (p: Phone) => p.page.mouse.up();

export const deviceOf = (p: Phone) => p.page.evaluate(() => localStorage.getItem('pit-princess-device'));
export const pushIdOf = (p: Phone) => p.page.evaluate(() => localStorage.getItem('pit-princess-push-id'));

/** Messages of type `t` the phone sent to the server */
export const sentOf = (p: Phone, t: string) =>
  p.sent.map((f) => JSON.parse(f) as { t: string; [k: string]: unknown }).filter((m) => m.t === t);
