// Helpers for resilience.spec.ts: a signaling server the test can kill and restart, a TCP proxy
// that can make a phone's existing connections go silent (a half-open socket, as after a
// WiFi <-> cellular switch or an iOS suspension), audio probes over inbound-rtp byte rates, and a
// sampler that records what each UI claims over time next to the ground truth.
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESS, logConsole, press, release, type Phone, type PitState } from './mesh-helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Same flags as playwright.config.ts, for members that get their own browser process */
export const LAUNCH_ARGS = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
];

// ---------------------------------------------------------------- server we can kill

export class ServerProc {
  private child: ChildProcess | null = null;
  constructor(readonly port: number) {}
  get http() {
    return `http://localhost:${this.port}`;
  }
  get ws() {
    return `ws://localhost:${this.port}/ws`;
  }
  async start(): Promise<void> {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: resolve(here, '../../server'),
      env: { ...process.env, PORT: String(this.port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr?.on('data', (d) => process.stdout.write(`[server:${this.port} err] ${d}`));
    child.stdout?.resume();
    this.child = child;
    const until = Date.now() + 30_000;
    while (Date.now() < until) {
      try {
        if ((await fetch(`${this.http}/healthz`)).ok) return;
      } catch {
        /* not up yet */
      }
      await sleep(100);
    }
    throw new Error('server did not start');
  }
  /** Hard kill, like a crashed/recycled instance */
  async kill(): Promise<void> {
    const c = this.child;
    this.child = null;
    if (!c || c.exitCode !== null) return;
    const exited = new Promise((r) => c.once('exit', r));
    c.kill('SIGKILL');
    await exited;
  }
}

// ---------------------------------------------------------------- TCP proxy

interface Pair {
  client: net.Socket;
  upstream: net.Socket;
  dead: boolean;
}

/**
 * Forwards a port to the server. `silenceExisting()` makes every open connection a black hole:
 * nothing is forwarded either way and neither side is told (a half-open TCP connection). New
 * connections still go through, like the phone after it got its new network.
 */
export class Proxy {
  private server: net.Server;
  private pairs = new Set<Pair>();
  constructor(
    readonly port: number,
    readonly target: number,
  ) {
    this.server = net.createServer((client) => {
      const upstream = net.connect(this.target, '127.0.0.1');
      const pair: Pair = { client, upstream, dead: false };
      this.pairs.add(pair);
      client.on('data', (d) => {
        if (!pair.dead) upstream.write(d);
      });
      upstream.on('data', (d) => {
        if (!pair.dead) client.write(d);
      });
      const end = () => {
        this.pairs.delete(pair);
        if (!pair.dead) {
          client.destroy();
          upstream.destroy();
        }
      };
      // A silenced pair is never closed towards the client (that's the point)
      upstream.on('close', end);
      client.on('close', () => {
        this.pairs.delete(pair);
        upstream.destroy();
      });
      client.on('error', () => {});
      upstream.on('error', () => {});
    });
  }
  get http() {
    return `http://localhost:${this.port}`;
  }
  listen(): Promise<void> {
    return new Promise((r) => this.server.listen(this.port, '127.0.0.1', () => r()));
  }
  silenceExisting(): number {
    let n = 0;
    for (const p of this.pairs) if (!p.dead) (p.dead = true), n++;
    return n;
  }
  async close(): Promise<void> {
    for (const p of this.pairs) {
      p.client.destroy();
      p.upstream.destroy();
    }
    await new Promise((r) => this.server.close(r));
  }
}

// ---------------------------------------------------------------- opening members

/** Remember every RTCPeerConnection (so the test can read stats and count calls) */
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

/**
 * Test-controlled page visibility (window.__setHidden) and an optional "no direct route between
 * the phones" switch (window.__noPhoneRoute): ICE candidates and SDP sent to another phone get an
 * unreachable address, as with two phones behind carrier-grade NAT and no TURN relay.
 */
function testHooks() {
  const w = window as unknown as { __setHidden: (h: boolean) => void; __noPhoneRoute: boolean };
  w.__noPhoneRoute = false;
  w.__setHidden = (h: boolean) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event(h ? 'blur' : 'focus'));
  };
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (w.__noPhoneRoute && typeof data === 'string') {
      try {
        const m = JSON.parse(data);
        if (m.t === 'signal' && m.to !== 'pc' && m.data) {
          const c = m.data.candidate;
          if (m.data.kind === 'ice' && c && typeof c.candidate === 'string' && c.candidate) {
            const parts = c.candidate.split(' ');
            parts[4] = '192.0.2.1'; // TEST-NET-1: nobody answers there
            c.candidate = parts.join(' ');
          }
          if (typeof m.data.sdp === 'string') {
            m.data.sdp = m.data.sdp
              .split('\r\n')
              .filter((l: string) => !l.startsWith('a=candidate'))
              .join('\r\n');
          }
          data = JSON.stringify(m);
        }
      } catch {
        /* not ours */
      }
    }
    return send.call(this, data);
  };
}

export interface PhoneAt extends Phone {
  base: string;
  room: string;
}

/** Load the phone app from `base` in `context` (new context if omitted) and tap to connect. */
export async function openPhoneAt(
  browser: Browser,
  name: string,
  base: string,
  room: string,
  context?: BrowserContext,
  hooks: { noPhoneRoute?: boolean } = {},
): Promise<PhoneAt> {
  context ??= await browser.newContext({ permissions: ['microphone'] });
  const page = await context.newPage();
  logConsole(name, page);
  await page.addInitScript(recordPeerConnections);
  await page.addInitScript(testHooks);
  if (hooks.noPhoneRoute) await page.addInitScript(() => ((window as unknown as { __noPhoneRoute: boolean }).__noPhoneRoute = true));
  const frames: string[] = [];
  const sent: string[] = [];
  page.on('websocket', (ws) => {
    ws.on('framereceived', (f) => frames.push(String(f.payload)));
    ws.on('framesent', (f) => sent.push(String(f.payload)));
  });
  await page.goto(`${base}/#room=${room}`);
  await page.locator('#ptt').click();
  return {
    name,
    base,
    room,
    context,
    page,
    text: page.locator('#ptt-text'),
    sub: page.locator('#ptt-sub'),
    link: page.locator('#v-link'),
    frames,
    sent,
  };
}

/** Same phone (same context, so same device id and seat) in a fresh page */
export async function reopenPhone(p: PhoneAt): Promise<void> {
  const page = await p.context.newPage();
  logConsole(p.name, page);
  await page.addInitScript(recordPeerConnections);
  await page.addInitScript(testHooks);
  page.on('websocket', (ws) => {
    ws.on('framereceived', (f) => p.frames.push(String(f.payload)));
    ws.on('framesent', (f) => p.sent.push(String(f.payload)));
  });
  await page.goto(`${p.base}/#room=${p.room}`);
  await page.locator('#ptt').click();
  p.page = page;
  p.text = page.locator('#ptt-text');
  p.sub = page.locator('#ptt-sub');
  p.link = page.locator('#v-link');
}

export async function openPcAt(context: BrowserContext, ws: string, room: string): Promise<Page> {
  const pc = await context.newPage();
  logConsole('pc', pc);
  await pc.addInitScript(recordPeerConnections);
  await pc.goto(`${HARNESS}/pc.html?ws=${encodeURIComponent(ws)}&room=${room}`);
  await expect.poll(() => pc.evaluate(() => window.pit.error ?? window.pit.ready)).toBe(true);
  await expect.poll(() => pc.evaluate(() => window.pit.state?.signaling)).toBe('open');
  return pc;
}

// ---------------------------------------------------------------- nodes, rates, probes

export type Node = { kind: 'phone'; name: string; p: PhoneAt } | { kind: 'pc'; name: string; page: Page };
export const phoneNode = (p: PhoneAt): Node => ({ kind: 'phone', name: p.name, p });
export const pcNode = (page: Page): Node => ({ kind: 'pc', name: 'pc', page });
const pageOf = (n: Node) => (n.kind === 'pc' ? n.page : n.p.page);

/** Inbound audio bytes per live RTCPeerConnection, keyed by its index (stable across samples) */
async function inbound(n: Node): Promise<Record<string, number>> {
  return pageOf(n).evaluate(async () => {
    const pcs = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs;
    const out: Record<string, number> = {};
    for (let i = 0; i < pcs.length; i++) {
      if (pcs[i].connectionState === 'closed') continue;
      let b = 0;
      (await pcs[i].getStats()).forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio') b = r.bytesReceived ?? 0;
      });
      out[i] = b;
    }
    return out;
  });
}

/** Loudest inbound link of a node, bytes/s over `ms` */
export async function rate(n: Node, ms = 1000): Promise<number> {
  try {
    const a = await inbound(n);
    await sleep(ms);
    const b = await inbound(n);
    return Math.max(0, ...Object.keys(b).map((k) => Math.round((((b[k] ?? 0) - (a[k] ?? b[k])) * 1000) / ms)));
  } catch {
    return 0; // page gone or navigating
  }
}

/** Live RTCPeerConnections in 'connected' state, and how many were ever made */
export async function links(n: Node): Promise<{ connected: number; total: number }> {
  try {
    return await pageOf(n).evaluate(() => {
      const pcs = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs;
      return { connected: pcs.filter((c) => c.connectionState === 'connected').length, total: pcs.length };
    });
  } catch {
    return { connected: 0, total: 0 };
  }
}

/** What the node's UI says right now */
export async function uiOf(n: Node): Promise<string> {
  try {
    if (n.kind === 'pc') {
      const s = (await n.page.evaluate(() => window.pit.state)) as unknown as PitState | null;
      if (!s) return 'none';
      const ok = s.peers.filter((p) => p.status === 'connected').length;
      return `${s.signaling}/${s.peer} ${ok}/${s.members.length - 1}`;
    }
    return await n.p.page.evaluate(
      () => `${document.getElementById('v-link')?.textContent}|${document.getElementById('ptt-text')?.textContent}`,
    );
  } catch {
    return 'gone';
  }
}

async function startTalk(n: Node): Promise<boolean> {
  const until = Date.now() + 1500;
  if (n.kind === 'pc') {
    await n.page.evaluate(() => window.pit.down());
    while (Date.now() < until) {
      if (await n.page.evaluate(() => window.pit.state?.tx)) return true;
      await sleep(50);
    }
    return false;
  }
  await press(n.p);
  while (Date.now() < until) {
    // v4 shows "TX" while keying up too (amber); only the red tile means the floor was granted
    const granted = await n.p.page.evaluate(() => {
      const t = document.getElementById('ptt-text')?.textContent;
      return t === 'TX' && !!document.getElementById('ptt')?.classList.contains('flag-red');
    });
    if (granted) return true;
    await sleep(50);
  }
  return false;
}

async function stopTalk(n: Node): Promise<void> {
  if (n.kind === 'pc') await n.page.evaluate(() => window.pit.up(true));
  else await release(n.p);
  await sleep(350); // tail + floor release
}

/** `talker` keys up; every listener's loudest link must clear `threshold` bytes/s. */
export async function probe(talker: Node, listeners: Node[], threshold: number): Promise<{ ok: boolean; why: string; rates: number[] }> {
  try {
    if (!(await startTalk(talker))) {
      await stopTalk(talker);
      return { ok: false, why: `${talker.name}: no floor`, rates: [] };
    }
    await sleep(400);
    const rates = await Promise.all(listeners.map((l) => rate(l, 1000)));
    await stopTalk(talker);
    const deaf = listeners.filter((_, i) => rates[i] < threshold).map((l) => l.name);
    return { ok: deaf.length === 0, why: deaf.length ? `${talker.name} -> ${deaf.join(',')} silent` : '', rates };
  } catch (e) {
    return { ok: false, why: `${talker.name}: ${String(e).split('\n')[0]}`, rates: [] };
  }
}

/** Everyone talks once, everyone else must hear it (all directions of the mesh). */
export async function audioRound(nodes: Node[], threshold: number, first?: Node): Promise<{ ok: boolean; why: string }> {
  const order = first ? [first, ...nodes.filter((n) => n !== first)] : nodes;
  for (const t of order) {
    const r = await probe(
      t,
      nodes.filter((n) => n !== t),
      threshold,
    );
    if (!r.ok) return r;
  }
  return { ok: true, why: '' };
}

/** Idle vs talking rates on the full mesh, and a threshold halfway between. */
export async function calibrate(nodes: Node[]): Promise<number> {
  const idle = await Promise.all(nodes.map((n) => rate(n, 1500)));
  const talk: number[] = [];
  for (const t of nodes) {
    const r = await probe(
      t,
      nodes.filter((n) => n !== t),
      0,
    );
    expect(r.ok, r.why).toBe(true);
    talk.push(...r.rates);
  }
  const maxIdle = Math.max(...idle);
  const minTalk = Math.min(...talk);
  console.log(`[resilience] calibrate: idle bytes/s ${idle.join(',')}  talking ${talk.join(',')}`);
  expect(minTalk, 'talking must be clearly louder than idle').toBeGreaterThan(maxIdle * 1.15);
  return Math.round((maxIdle + minTalk) / 2);
}

/** Wait until every node has a connected link to every other node. */
export async function waitMesh(nodes: Node[], timeout = 25_000): Promise<void> {
  for (const n of nodes) {
    await expect.poll(async () => (await links(n)).connected, { timeout, message: `${n.name} links` }).toBe(nodes.length - 1);
  }
}

export interface Recovery {
  /** ms from t0 until every node had all its links connected and its UI said so */
  ready: number | null;
  /** ms from t0 until the start of the first audio round where every direction worked */
  audio: number | null;
  rounds: number;
  lastFail: string;
}

/**
 * From t0, wait for transport + UI readiness, then run audio rounds until all directions work.
 * `uiReady` says whether a node's UI shows it fully linked.
 */
export async function measureRecovery(
  t0: number,
  nodes: Node[],
  threshold: number,
  limitMs: number,
  first?: Node,
): Promise<Recovery> {
  const res: Recovery = { ready: null, audio: null, rounds: 0, lastFail: 'never ready' };
  while (Date.now() - t0 < limitMs) {
    if (res.ready === null) {
      const ok = await Promise.all(
        nodes.map(async (n) => (await links(n)).connected === nodes.length - 1 && uiLinked(n, await uiOf(n))),
      );
      if (ok.every(Boolean)) res.ready = Date.now() - t0;
      else {
        await sleep(250);
        continue;
      }
    }
    const start = Date.now() - t0;
    const r = await audioRound(nodes, threshold, first);
    res.rounds++;
    if (r.ok) {
      res.audio = start;
      return res;
    }
    res.lastFail = r.why;
    await sleep(300);
  }
  return res;
}

/** The node's UI claims it is linked (for a phone: CONNECTED, or PC OFF = linked to the other phone; not PARTIAL) */
export function uiLinked(n: Node, ui: string): boolean {
  if (n.kind === 'pc') return ui.startsWith('open/connected');
  const tile = ui.split('|')[0];
  return tile === 'CONNECTED' || tile === 'PC OFF';
}

// ---------------------------------------------------------------- UI timeline

export class Timeline {
  private samples: { t: number; who: string; ui: string; connected: number }[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = new Set<string>();
  constructor(
    private nodes: Node[],
    readonly t0 = Date.now(),
  ) {}
  start(everyMs = 500): this {
    this.timer = setInterval(() => {
      const t = Date.now() - this.t0;
      for (const n of this.nodes) {
        // A frozen page never answers an evaluate: record that instead of stalling
        if (this.busy.has(n.name)) {
          this.samples.push({ t, who: n.name, ui: 'frozen', connected: -1 });
          continue;
        }
        this.busy.add(n.name);
        void Promise.all([uiOf(n), links(n)])
          .then(([ui, l]) => this.samples.push({ t, who: n.name, ui, connected: l.connected }))
          .finally(() => this.busy.delete(n.name));
      }
    }, everyMs);
    return this;
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  /** Compressed: "0.0s CONNECTED|TALK (2) -> 3.5s SERVER…|LINKING (2) -> ..." */
  summary(who: string): string {
    const out: string[] = [];
    let last = '';
    for (const s of this.samples.filter((x) => x.who === who).sort((x, y) => x.t - y.t)) {
      const key = `${s.ui} (${s.connected})`;
      if (key === last) continue;
      last = key;
      out.push(`${(s.t / 1000).toFixed(1)}s ${key}`);
    }
    return out.join(' -> ');
  }
  /** Seconds a node's UI claimed to be linked while fewer than `expected` links were connected */
  overclaimed(n: Node, expected: number): number {
    const xs = this.samples.filter((s) => s.who === n.name).sort((x, y) => x.t - y.t);
    let bad = 0;
    for (let i = 1; i < xs.length; i++) if (uiLinked(n, xs[i].ui) && xs[i].connected < expected) bad += xs[i].t - xs[i - 1].t;
    return Math.round(bad / 100) / 10;
  }
  print(prefix: string): void {
    for (const n of this.nodes) console.log(`[${prefix}] ${n.name} UI: ${this.summary(n.name)}`);
  }
}

export const fmt = (ms: number | null) => (ms === null ? 'NEVER' : `${(ms / 1000).toFixed(1)}s`);
