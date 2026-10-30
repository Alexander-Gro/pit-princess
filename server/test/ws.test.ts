// Integration: boot the real server as a child process and drive it with two ws clients.
import { spawn, type ChildProcess } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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

/**
 * Every socket a test opens. A test that fails part-way would otherwise leave its sockets open, and
 * since they all come from 127.0.0.1 they eat the per-IP cap (20) and make the cap tests fail too.
 */
const sockets = new Set<WebSocket>();
afterEach(async () => {
  const open = [...sockets].filter((ws) => ws.readyState !== WebSocket.CLOSED);
  sockets.clear();
  await Promise.all(
    open.map((ws) => new Promise<void>((r) => (ws.once('close', () => r()), ws.terminate()))),
  );
  if (open.length) await new Promise((r) => setTimeout(r, 100)); // let the server see the closes
});

class Client {
  ws: WebSocket;
  msgs: ServerMsg[] = [];
  private waiters: { pred: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void }[] = [];
  closed: Promise<void>;
  constructor() {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    sockets.add(this.ws);
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
const DEV_A = 'devAAAAAAAAAAAAAAAAAAA';
const DEV_B = 'devBBBBBBBBBBBBBBBBBBB';
const DEV_C = 'devCCCCCCCCCCCCCCCCCCC';

/** Wait until a message matching pred has arrived (buffered or new); it is left in the buffer. */
async function waitFor(c: Client, pred: (m: ServerMsg) => boolean, timeoutMs = 3000): Promise<ServerMsg> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const m = c.msgs.find(pred);
    if (m) return m;
    if (Date.now() > until) throw new Error(`timeout; got ${JSON.stringify(c.msgs)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

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

    pc.send({ t: 'host', v: 4, room: ROOM });
    const w1 = await pc.next('welcome');
    expect(w1).toMatchObject({ role: 'pc', you: 'pc', floor: 'idle', members: [{ id: 'pc', role: 'pc', name: null }] });
    expect(Array.isArray(w1.iceServers) && w1.iceServers.length).toBeTruthy();

    phone.send({ t: 'join', v: 4, room: ROOM, device: DEV_A });
    const w2 = await phone.next('welcome');
    expect(w2).toMatchObject({ role: 'phone', floor: 'idle' });
    const id = w2.you;
    // v4: derived from (room, device) with the server's id secret
    expect(id).toMatch(/^m[A-Za-z0-9_-]{16}$/);
    expect(w2.members).toEqual([
      { id: 'pc', role: 'pc', name: null },
      { id, role: 'phone', name: null, slot: 1 },
    ]);
    expect(await pc.next('peer_joined')).toEqual({ t: 'peer_joined', id });
    await waitFor(pc, (m) => m.t === 'roster' && m.members.some((x) => x.id === id && x.device === DEV_A));

    // signaling relay, with cid passed through and from set by the server (a spoofed from is ignored)
    pc.send({ t: 'signal', to: id, cid: 'cid-0001', data: { kind: 'offer', sdp: 'v=0 fake-offer' } });
    expect(await phone.next('signal')).toEqual({ t: 'signal', from: 'pc', cid: 'cid-0001', data: { kind: 'offer', sdp: 'v=0 fake-offer' } });
    phone.send({ t: 'signal', to: 'pc', from: 'pc', cid: 'cid-0001', data: { kind: 'answer', sdp: 'v=0 fake-answer' } });
    expect(await pc.next('signal')).toEqual({ t: 'signal', from: id, cid: 'cid-0001', data: { kind: 'answer', sdp: 'v=0 fake-answer' } });
    phone.send({ t: 'signal', to: 'pc', cid: 'cid-0001', data: { kind: 'ice', candidate: null } });
    expect(await pc.next('signal')).toEqual({ t: 'signal', from: id, cid: 'cid-0001', data: { kind: 'ice', candidate: null } });

    // floor
    phone.send({ t: 'floor_request' });
    expect(await phone.next('floor')).toEqual({ t: 'floor', holder: id });
    expect(await pc.next('floor')).toEqual({ t: 'floor', holder: id });
    pc.send({ t: 'floor_request' });
    await pc.next('busy');
    pc.send({ t: 'floor_release' }); // ignored: pc is not the holder
    phone.send({ t: 'floor_release' });
    expect(await pc.next('floor')).toEqual({ t: 'floor', holder: 'idle' });
    expect(await phone.next('floor')).toEqual({ t: 'floor', holder: 'idle' });
    expect(pc.msgs.filter((m) => m.t === 'floor')).toEqual([]); // nothing from the ignored release

    // names
    pc.send({ t: 'names', names: { pc: 'Pit wall', [id]: 'Emma' } });
    await waitFor(phone, (m) => m.t === 'roster' && m.members.some((x) => x.id === id && x.name === 'Emma'));

    // PC takes the floor (it is released later when the PC socket drops)
    pc.send({ t: 'floor_request' });
    await pc.next('floor');
    await phone.next('floor');
    // kick: phone gets kicked and its socket is closed by the server
    pc.send({ t: 'kick', id });
    expect(await phone.next('kicked')).toEqual({ t: 'kicked', reason: 'kicked' });
    await phone.closed;
    expect(await pc.next('peer_left')).toEqual({ t: 'peer_left', id });

    // a new phone rejoins; PC still holds the floor
    const phone2 = new Client();
    await phone2.open();
    phone2.send({ t: 'join', v: 4, room: ROOM, device: DEV_B });
    expect(await phone2.next('welcome')).toMatchObject({ floor: 'pc' });
    await pc.next('peer_joined');
    pc.close();
    expect(await phone2.next('floor')).toEqual({ t: 'floor', holder: 'idle' });
    expect(await phone2.next('peer_left')).toEqual({ t: 'peer_left', id: 'pc' });
    phone2.close();
  });

  it('v4: same-device rejoin silently replaces the old socket: same id, floor released, PC sees only peer_joined', async () => {
    const room = 'wsReplaceRoom_0123456789';
    const pc = new Client();
    const a = new Client();
    const b = new Client();
    await Promise.all([pc.open(), a.open(), b.open()]);
    pc.send({ t: 'host', v: 4, room });
    await pc.next('welcome');
    a.send({ t: 'join', v: 4, room, device: DEV_A });
    const oldId = (await a.next('welcome')).you;
    await pc.next('peer_joined');
    a.send({ t: 'floor_request' });
    await pc.next('floor');
    b.send({ t: 'join', v: 4, room, device: DEV_A });
    const newId = (await b.next('welcome')).you;
    expect(newId).toBe(oldId);
    expect(await a.next('kicked')).toEqual({ t: 'kicked', reason: 'replaced' });
    await a.closed;
    expect(await pc.next('floor')).toEqual({ t: 'floor', holder: 'idle' });
    expect(await pc.next('peer_joined')).toEqual({ t: 'peer_joined', id: newId });
    await settle();
    expect(pc.msgs.filter((m) => m.t === 'peer_left')).toEqual([]);
    pc.close();
    b.close();
  });

  it('v4: hb is answered with hb, even before host/join', async () => {
    const c = new Client();
    await c.open();
    c.send({ t: 'hb' });
    expect(await c.next('hb')).toEqual({ t: 'hb' });
    c.send({ t: 'join', v: 4, room: 'wsHbRoom_0123456789', device: DEV_A });
    await c.next('welcome');
    for (let i = 0; i < 3; i++) c.send({ t: 'hb' });
    for (let i = 0; i < 3; i++) expect(await c.next('hb')).toEqual({ t: 'hb' });
    c.close();
    await c.closed;
  });

  it('v4: presence and dir over the real server: away shows in the roster, dir is relayed and cached for a newcomer', async () => {
    const room = 'wsDirRoom_0123456789';
    const a = new Client();
    const b = new Client();
    await Promise.all([a.open(), b.open()]);
    a.send({ t: 'join', v: 4, room, device: DEV_A, push: 'pushAAAAAAAAAAAAAAAAAA', inst: 'inst-aaaa-0001' });
    const wa = await a.next('welcome');
    expect(wa.members).toEqual([{ id: wa.you, role: 'phone', name: null, slot: 1, pushId: 'pushAAAAAAAAAAAAAAAAAA', inst: 'inst-aaaa-0001' }]);
    const entries = [{ owner: 'pushAAAAAAAAAAAAAAAAAA', sub: null, ts: 1 }];
    a.send({ t: 'dir', entries });
    a.send({ t: 'presence', away: true });
    await waitFor(a, (m) => m.t === 'roster' && m.members.some((x) => x.id === wa.you && x.away === true));
    b.send({ t: 'join', v: 4, room, device: DEV_B });
    const wb = await b.next('welcome');
    expect(wb.members.find((m) => m.id === wa.you)).toMatchObject({ away: true });
    expect(await b.next('dir')).toEqual({ t: 'dir', from: 'server', entries });
    b.send({ t: 'dir', entries: [{ owner: 'pushBBBBBBBBBBBBBBBBBB', sub: null, ts: 2 }] });
    expect(await a.next('dir')).toEqual({ t: 'dir', from: wb.you, entries: [{ owner: 'pushBBBBBBBBBBBBBBBBBB', sub: null, ts: 2 }] });
    await settle();
    expect(b.msgs.filter((m) => m.t === 'dir')).toEqual([]); // not echoed to the sender
    a.close();
    b.close();
    await Promise.all([a.closed, b.closed]);
  });

  it('two phones fit, a third gets room_full over a socket that stays open, and gets in when a seat frees', async () => {
    const room = 'wsFullRoom_0123456789';
    const pc = new Client();
    const a = new Client();
    const b = new Client();
    const c = new Client();
    await Promise.all([pc.open(), a.open(), b.open(), c.open()]);
    pc.send({ t: 'host', v: 4, room });
    await pc.next('welcome');
    a.send({ t: 'join', v: 4, room, device: DEV_A });
    const aId = (await a.next('welcome')).you;
    b.send({ t: 'join', v: 4, room, device: DEV_B });
    const bw = await b.next('welcome');
    expect(bw.members.map((m) => m.slot ?? 0)).toEqual([0, 1, 2]);
    c.send({ t: 'join', v: 4, room, device: DEV_C });
    expect(await c.next('error')).toEqual({ t: 'error', code: 'room_full' });
    await settle();
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    // Phones never see device ids
    expect(JSON.stringify([...a.msgs, ...b.msgs, bw])).not.toMatch(/devA|devB|devC/);
    // v3 full mesh: a phone's signal goes to whoever `to` names (here the other phone), tagged with its id
    a.send({ t: 'signal', to: bw.you, cid: 'cid-0002', data: { kind: 'offer', sdp: 'x' } });
    expect(await b.next('signal')).toEqual({ t: 'signal', from: aId, cid: 'cid-0002', data: { kind: 'offer', sdp: 'x' } });
    a.send({ t: 'signal', to: 'pc', cid: 'cid-0003', data: { kind: 'restart' } });
    expect(await pc.next('signal')).toEqual({ t: 'signal', from: aId, cid: 'cid-0003', data: { kind: 'restart' } });
    pc.send({ t: 'kick', id: aId });
    await a.closed;
    c.send({ t: 'join', v: 4, room, device: DEV_C });
    const cw = await c.next('welcome');
    expect(cw.members.find((m) => m.id === cw.you)?.slot).toBe(1);
    expect(pc.msgs.filter((m) => m.t === 'signal')).toEqual([]);
    for (const x of [pc, b, c]) x.close();
  });

  it('host/join without v: update_required, then the server closes the socket', async () => {
    const old = new Client();
    await old.open();
    old.send({ t: 'join', room: ROOM, device: DEV_A });
    expect(await old.next('error')).toEqual({ t: 'error', code: 'update_required' });
    await old.closed;
  });

  it('rejects bad input', async () => {
    const c = new Client();
    await c.open();
    c.send('not json');
    expect(await c.next('error')).toEqual({ t: 'error', code: 'bad_message' });
    c.send({ t: 'join', v: 2, room: ROOM });
    expect(await c.next('error')).toEqual({ t: 'error', code: 'update_required' });
    await c.closed;
    const c2 = new Client();
    await c2.open();
    c2.send({ t: 'join', v: 4, room: 'short' });
    expect(await c2.next('error')).toEqual({ t: 'error', code: 'bad_room' });
    c2.send({ t: 'floor_request' });
    expect(await c2.next('error')).toEqual({ t: 'error', code: 'not_in_room' });
    c2.close();
  });

  it('v3: two phones with no PC: the first creates the room, the second joins, floor and signals flow', async () => {
    const room = 'wsPhonesOnly_0123456789';
    const a = new Client();
    const b = new Client();
    await Promise.all([a.open(), b.open()]);
    a.send({ t: 'join', v: 4, room, device: DEV_A, name: 'Emma', push: 'pushAAAAAAAAAAAAAAAAAA' });
    const wa = await a.next('welcome');
    expect(wa).toMatchObject({ role: 'phone', phonesHear: true, members: [{ role: 'phone', name: 'Emma', slot: 1, pushId: 'pushAAAAAAAAAAAAAAAAAA' }] });
    b.send({ t: 'join', v: 4, room, device: DEV_B });
    const wb = await b.next('welcome');
    expect(wb.members.map((m) => m.id)).toEqual([wa.you, wb.you]);
    await waitFor(a, (m) => m.t === 'roster' && m.members.length === 2);
    b.send({ t: 'floor_request' });
    expect(await a.next('floor')).toEqual({ t: 'floor', holder: wb.you });
    b.send({ t: 'signal', to: wa.you, cid: 'cid-0009', data: { kind: 'answer', sdp: 'y' } });
    expect(await a.next('signal')).toEqual({ t: 'signal', from: wb.you, cid: 'cid-0009', data: { kind: 'answer', sdp: 'y' } });
    a.send({ t: 'ping', subs: [] });
    expect(await a.next('pinged')).toEqual({ t: 'pinged', sent: 0, gone: [], limited: false, unavailable: true });
    a.close();
    b.close();
  });

  it('rejects a bad room code', async () => {
    const c = new Client();
    await c.open();
    c.send({ t: 'join', v: 4, room: 'short' });
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
        sockets.add(ws);
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
