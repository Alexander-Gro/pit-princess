// Integration: boot the real server as a child process and drive it with two ws clients.
import { spawn, type ChildProcess } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerMsg } from '@pit/shared';

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..');
let proc: ChildProcess;
let port: number;
let output = '';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

async function waitHealthy(timeoutMs = 15_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (proc.exitCode !== null) throw new Error(`server exited early:\n${output}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not come up:\n${output}`);
}

class Client {
  ws: WebSocket;
  msgs: ServerMsg[] = [];
  private waiters: { pred: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void }[] = [];
  closed: Promise<void>;
  constructor() {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as ServerMsg;
      this.msgs.push(m);
      this.waiters = this.waiters.filter((w) => (w.pred(m) ? (w.resolve(m), false) : true));
    });
    this.closed = new Promise((r) => this.ws.once('close', () => r()));
  }
  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }
  send(m: unknown): void {
    this.ws.send(typeof m === 'string' ? m : JSON.stringify(m));
  }
  /** Wait for the next message (from now on, or already buffered and unconsumed) matching pred. */
  next<T extends ServerMsg['t']>(t: T, timeoutMs = 3000): Promise<Extract<ServerMsg, { t: T }>> {
    const idx = this.msgs.findIndex((m) => m.t === t);
    if (idx >= 0) return Promise.resolve(this.msgs.splice(idx, 1)[0] as Extract<ServerMsg, { t: T }>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${t}; got ${JSON.stringify(this.msgs)}`)), timeoutMs);
      this.waiters.push({
        pred: (m) => m.t === t,
        resolve: (m) => {
          clearTimeout(timer);
          this.msgs.splice(this.msgs.indexOf(m), 1);
          resolve(m as Extract<ServerMsg, { t: T }>);
        },
      });
    });
  }
  close(): void {
    this.ws.close();
  }
}

const settle = () => new Promise((r) => setTimeout(r, 150));

beforeAll(async () => {
  port = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port) };
  for (const k of ['CF_TURN_KEY_ID', 'CF_TURN_KEY_TOKEN', 'METERED_DOMAIN', 'METERED_API_KEY', 'TURN_URLS', 'DEV_HTTPS']) delete env[k];
  proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: serverDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout!.on('data', (d) => (output += d));
  proc.stderr!.on('data', (d) => (output += d));
  await waitHealthy();
}, 20_000);

afterAll(async () => {
  if (proc && proc.exitCode === null) {
    const exited = new Promise((r) => proc.once('exit', r));
    proc.kill();
    await exited;
  }
});

describe('real server over WebSocket', () => {
  const ROOM = 'wsTestRoom_0123456789';

  it('serves healthz, api/info and the phone app shell', async () => {
    expect(await (await fetch(`http://127.0.0.1:${port}/healthz`)).text()).toBe('ok');
    const info = await (await fetch(`http://127.0.0.1:${port}/api/info`)).json();
    // The test server runs without VAPID keys, so push is off
    expect(info).toEqual({ publicUrl: `http://localhost:${port}`, vapidPublicKey: null });
    const page = await fetch(`http://127.0.0.1:${port}/some/deep/link`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('id="ptt"');
  });

  it('host / join / floor / signal / kick flow', async () => {
    const pc = new Client();
    const phone = new Client();
    await Promise.all([pc.open(), phone.open()]);

    pc.send({ t: 'host', room: ROOM });
    const w1 = await pc.next('welcome');
    expect(w1).toMatchObject({ role: 'pc', peerPresent: false, floor: 'idle' });
    expect(Array.isArray(w1.iceServers) && w1.iceServers.length).toBeTruthy();

    phone.send({ t: 'join', room: ROOM });
    expect(await phone.next('welcome')).toMatchObject({ role: 'phone', peerPresent: true, floor: 'idle' });
    await pc.next('peer_joined');

    // signaling relay
    pc.send({ t: 'signal', data: { kind: 'offer', sdp: 'v=0 fake-offer' } });
    expect(await phone.next('signal')).toEqual({ t: 'signal', data: { kind: 'offer', sdp: 'v=0 fake-offer' } });
    phone.send({ t: 'signal', data: { kind: 'answer', sdp: 'v=0 fake-answer' } });
    expect(await pc.next('signal')).toEqual({ t: 'signal', data: { kind: 'answer', sdp: 'v=0 fake-answer' } });
    phone.send({ t: 'signal', data: { kind: 'ice', candidate: null } });
    expect(await pc.next('signal')).toEqual({ t: 'signal', data: { kind: 'ice', candidate: null } });

    // floor
    phone.send({ t: 'floor_request' });
    expect(await phone.next('floor')).toEqual({ t: 'floor', holder: 'phone' });
    expect(await pc.next('floor')).toEqual({ t: 'floor', holder: 'phone' });
    pc.send({ t: 'floor_request' });
    await pc.next('busy');
    pc.send({ t: 'floor_release' }); // ignored: pc is not the holder
    phone.send({ t: 'floor_release' });
    expect(await pc.next('floor')).toEqual({ t: 'floor', holder: 'idle' });
    expect(await phone.next('floor')).toEqual({ t: 'floor', holder: 'idle' });
    expect(pc.msgs).toEqual([]); // nothing from the ignored release

    // PC takes the floor (it is released later when the PC socket drops)
    pc.send({ t: 'floor_request' });
    await pc.next('floor');
    await phone.next('floor');
    // kick: phone gets kicked and its socket is closed by the server
    pc.send({ t: 'kick' });
    expect(await phone.next('kicked')).toEqual({ t: 'kicked', reason: 'kicked' });
    await phone.closed;
    await pc.next('peer_left');

    // a new phone rejoins; PC still holds the floor
    const phone2 = new Client();
    await phone2.open();
    phone2.send({ t: 'join', room: ROOM });
    expect(await phone2.next('welcome')).toMatchObject({ peerPresent: true, floor: 'pc' });
    await pc.next('peer_joined');
    pc.close();
    expect(await phone2.next('floor')).toEqual({ t: 'floor', holder: 'idle' });
    await phone2.next('peer_left');
    phone2.close();
  });

  it('second phone replaces the first over real sockets', async () => {
    const room = 'wsReplaceRoom_0123456789';
    const pc = new Client();
    const a = new Client();
    const b = new Client();
    await Promise.all([pc.open(), a.open(), b.open()]);
    pc.send({ t: 'host', room });
    await pc.next('welcome');
    a.send({ t: 'join', room });
    await a.next('welcome');
    await pc.next('peer_joined');
    b.send({ t: 'join', room });
    await b.next('welcome');
    expect(await a.next('kicked')).toEqual({ t: 'kicked', reason: 'replaced' });
    await a.closed;
    await pc.next('peer_joined');
    await settle();
    expect(pc.msgs.filter((m) => m.t === 'peer_left')).toEqual([]);
    pc.close();
    b.close();
  });

  it('rejects bad input', async () => {
    const c = new Client();
    await c.open();
    c.send('not json');
    expect(await c.next('error')).toEqual({ t: 'error', code: 'bad_message' });
    c.send({ t: 'join', room: 'short' });
    expect(await c.next('error')).toEqual({ t: 'error', code: 'bad_room' });
    c.send({ t: 'floor_request' });
    expect(await c.next('error')).toEqual({ t: 'error', code: 'not_in_room' });
    c.close();
  });

  it('refuses upgrades on paths other than /ws', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/other`);
    const err = await new Promise<unknown>((resolve) => {
      ws.once('error', resolve);
      ws.once('open', () => resolve(null));
    });
    expect(err).toBeTruthy();
  });

  describe('per-IP connection cap (20)', () => {
    const connectStatus = (): Promise<{ ok: true; ws: WebSocket } | { ok: false; status: number | null }> =>
      new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        ws.once('open', () => resolve({ ok: true, ws }));
        ws.once('unexpected-response', (_req, res) => resolve({ ok: false, status: res.statusCode ?? null }));
        ws.once('error', () => resolve({ ok: false, status: null }));
      });

    it('the 21st simultaneous socket gets HTTP 429, and closing frees a slot', async () => {
      await new Promise((r) => setTimeout(r, 300)); // let sockets from earlier tests finish closing
      const open: WebSocket[] = [];
      for (let i = 0; i < 20; i++) {
        const r = await connectStatus();
        expect(r.ok).toBe(true);
        if (r.ok) open.push(r.ws);
      }
      const over = await connectStatus();
      expect(over).toEqual({ ok: false, status: 429 });
      const closed = new Promise((r) => open[0].once('close', r));
      open[0].close();
      await closed;
      await new Promise((r) => setTimeout(r, 100));
      const again = await connectStatus();
      expect(again.ok).toBe(true);
      for (const ws of [...open.slice(1), ...(again.ok ? [again.ws] : [])]) ws.close();
      await new Promise((r) => setTimeout(r, 300));
    });

    it('malformed upgrade requests do not leak cap slots', async () => {
      for (let i = 0; i < 20; i++) {
        await new Promise<void>((resolve) => {
          const s = connect(port, '127.0.0.1', () => {
            s.write(
              [
                'GET /ws HTTP/1.1',
                'Host: x',
                'Upgrade: websocket',
                'Connection: Upgrade',
                'Sec-WebSocket-Version: 13',
                'Sec-WebSocket-Key: bad',
                '',
                '',
              ].join(String.fromCharCode(13, 10)),
            );
          });
          s.on('data', () => {});
          s.on('close', () => resolve());
          s.on('error', () => resolve());
        });
      }
      const r = await connectStatus();
      if (r.ok) r.ws.close();
      expect(r.ok).toBe(true);
    });
  });
});
