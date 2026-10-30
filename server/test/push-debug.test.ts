// Debugging "push notifications / ping don't work properly". Everything here uses real code:
// - the REAL web-push library against a local HTTPS push service, with a real receiver key, so the
//   aes128gcm body can be decrypted (RFC 8291) and fed to the REAL phone/public/sw.js in a vm
// - the VAPID JWT web-push builds (Apple's web.push.apple.com rejects some subjects)
// - RoomHub's ping replies (what the phone shows) and its 30 s room cooldown
// - the REAL server process + raw ws clients, to measure how long a phone whose app is suspended
//   (no pongs) or backgrounded-but-alive (pongs) still counts as present, i.e. is NOT pinged.
//
// Tests named "WANTED:" describe the behaviour we want and fail today (it.fails). When a fix lands
// they start "unexpectedly passing": turn them into plain it() then. (v4: the VAPID fallback one did.)
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import type { AddressInfo } from 'node:net';
import selfsigned from 'selfsigned';
import webpush from 'web-push';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, pingText, type MemberInfo, type PushSub, type ServerMsg } from '@pit/shared';
import { createPusher } from '../src/push.ts';
import { RoomHub, type Conn, type Pusher } from '../src/rooms.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SW_SOURCE = readFileSync(join(here, '../../phone/public/sw.js'), 'utf8');

// ---------------------------------------------------------------------------------------------
// Local HTTPS push service that keeps every request body
// ---------------------------------------------------------------------------------------------
let server: Server;
let base = '';
const hits: { path: string; headers: Record<string, string | string[] | undefined>; body: Buffer }[] = [];
const savedTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

beforeAll(async () => {
  const pems = selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { days: 1, keySize: 2048 });
  server = createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      hits.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
      const status = Number((req.url ?? '').split('/')[1]) || 201;
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(status === 403 ? '{"reason":"BadJwtToken"}' : '');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
});

afterAll(async () => {
  if (savedTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = savedTls;
  await new Promise((r) => server.close(r));
});

/** A browser-like subscription whose private key we keep, so we can decrypt what is sent to it */
function receiver(path: string) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const sub: PushSub = {
    endpoint: `${base}${path}`,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
  };
  return { sub, ecdh, auth };
}

/**
 * The hub only accepts real push hosts, so phones send web.push.apple.com endpoints and this
 * Pusher forwards them to the local service (same path), using the REAL createPusher underneath.
 */
function viaLocal(pusher: Pusher): Pusher {
  return {
    send: async (subs, payload) => {
      const local = subs.map((s) => ({ ...s, endpoint: s.endpoint.replace('https://web.push.apple.com', base) }));
      const res = await pusher.send(local, payload);
      return { ...res, gone: res.gone.map((g) => g.replace(base, 'https://web.push.apple.com')) };
    },
  };
}
const asApple = (s: PushSub): PushSub => ({ ...s, endpoint: s.endpoint.replace(base, 'https://web.push.apple.com') });

/** RFC 8188 / RFC 8291 aes128gcm decryption, as the phone's push service + browser do it */
function decryptAes128gcm(body: Buffer, ecdh: ReturnType<typeof createECDH>, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  expect(ciphertext.length).toBeLessThanOrEqual(rs); // a single record
  const uaPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', secret, auth, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([d.update(ciphertext.subarray(0, ciphertext.length - 16)), d.final()]);
  // Last record: content, then the 0x02 delimiter, then zero padding
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  expect(padded[end]).toBe(2);
  return padded.subarray(0, end).toString('utf8');
}

function jwtOf(h: (typeof hits)[number]) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(String(h.headers['authorization']));
  expect(m).not.toBeNull();
  const [, payload] = m![1].split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { aud: string; exp: number; sub: string };
}

/** Run the real sw.js with a fake ServiceWorkerGlobalScope and return its listeners and calls */
function loadSw(windows: { focus: () => Promise<unknown>; url: string }[] = []) {
  const listeners: Record<string, (e: unknown) => void> = {};
  const shown: { title: string; opts: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const self = {
    addEventListener: (t: string, f: (e: unknown) => void) => (listeners[t] = f),
    skipWaiting: () => {},
    registration: { showNotification: async (title: string, opts: Record<string, unknown>) => void shown.push({ title, opts }) },
    clients: {
      claim: async () => {},
      matchAll: async () => windows,
      openWindow: async (url: string) => void opened.push(url),
    },
  };
  runInNewContext(SW_SOURCE, { self });
  return { listeners, shown, opened };
}

/** A PushEvent whose data behaves like PushMessageData for this plaintext */
function pushEvent(plaintext: string | null) {
  const waits: Promise<unknown>[] = [];
  const data = plaintext === null ? null : { json: () => JSON.parse(plaintext), text: () => plaintext };
  return { event: { data, waitUntil: (p: Promise<unknown>) => waits.push(p) }, done: () => Promise.all(waits) };
}

describe('real web-push -> decrypted payload -> real sw.js', () => {
  it('a ping arrives as aes128gcm JSON that sw.js turns into a "wants you on the radio" notification', async () => {
    hits.length = 0;
    const vapid = webpush.generateVAPIDKeys();
    // What Render does: VAPID_SUBJECT unset, publicUrl() = RENDER_EXTERNAL_URL
    const { pusher } = createPusher(
      { VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey },
      'https://pit-princess.onrender.com',
    );
    // Drive it through RoomHub so the payload is exactly what a triple-press produces
    const r = receiver('/201/phoneB');
    const hub = new RoomHub({ getIceServers: async () => [], push: viaLocal(pusher!) });
    const a = new FakeConn();
    await hub.handle(a, { t: 'join', v: PROTOCOL_VERSION, room: ROOM, device: DEV_A, push: PUSH_A });
    const before = Date.now();
    await hub.handle(a, { t: 'ping', subs: [asApple(r.sub)] });
    expect(a.of('pinged')).toEqual([{ t: 'pinged', sent: 1, gone: [], failed: 0, limited: false }]);

    expect(hits).toHaveLength(1);
    const h = hits[0];
    expect(h.headers['content-encoding']).toBe('aes128gcm');
    expect(h.headers['ttl']).toBe('300');
    expect(h.headers['urgency']).toBe('high');
    // No Topic header: two pings don't collapse at the push service
    expect(h.headers['topic']).toBeUndefined();

    const jwt = jwtOf(h);
    expect(jwt.aud).toBe(base);
    // Apple accepts an https subject (verified by hand against web.push.apple.com: 400 BadWebPushToken
    // for a fake token, i.e. the JWT passed) but rejects mailto:...@example.invalid (403 BadJwtToken)
    expect(jwt.sub).toBe('https://pit-princess.onrender.com');
    const ttl = jwt.exp - Math.floor(Date.now() / 1000);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(24 * 3600);

    const plaintext = decryptAes128gcm(h.body, r.ecdh, r.auth);
    const payload = JSON.parse(plaintext) as { title: string; body: string; tag: string };
    expect(payload).toEqual({ title: 'Pit Princess', body: 'Phone 1 wants you on the radio. Tap to join.', tag: expect.stringMatching(/^ping-\d+$/) });
    // v4: a unique tag per ping (ping-<timestamp>), so a second ping is a new alert, not a silent replacement
    const ts = Number(payload.tag.slice('ping-'.length));
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now());

    const sw = loadSw();
    const ev = pushEvent(plaintext);
    sw.listeners.push(ev.event);
    await ev.done();
    expect(sw.shown).toHaveLength(1);
    expect(sw.shown[0].title).toBe('Pit Princess');
    expect(sw.shown[0].opts).toMatchObject({ body: 'Phone 1 wants you on the radio. Tap to join.', tag: payload.tag, renotify: true });
    console.log('[push-debug] notification options:', JSON.stringify(sw.shown[0].opts));
  });

  it('sw.js: no payload / non-JSON payload still shows a notification (iOS revokes subs that push silently)', async () => {
    const sw = loadSw();
    for (const p of [null, 'not json']) {
      const ev = pushEvent(p);
      sw.listeners.push(ev.event);
      await ev.done();
    }
    expect(sw.shown.map((s) => s.opts.body)).toEqual(['Someone is on the radio.', 'not json']);
  });

  it('sw.js notificationclick: focuses an existing window, otherwise opens "/" (the room comes from localStorage)', async () => {
    const focused: string[] = [];
    const withWin = loadSw([{ url: 'https://pit-princess.onrender.com/', focus: async () => void focused.push('w') }]);
    const close = vi.fn();
    let wait: Promise<unknown> = Promise.resolve();
    withWin.listeners.notificationclick({ notification: { close }, waitUntil: (p: Promise<unknown>) => (wait = p) });
    await wait;
    expect(close).toHaveBeenCalled();
    expect(focused).toEqual(['w']);
    expect(withWin.opened).toEqual([]);

    const none = loadSw([]);
    none.listeners.notificationclick({ notification: { close }, waitUntil: (p: Promise<unknown>) => (wait = p) });
    await wait;
    expect(none.opened).toEqual(['/']);
  });

  it('the VAPID fallback subject (no VAPID_SUBJECT, non-https publicUrl) is no longer .invalid, and the server warns', async () => {
    // It was mailto:pit-princess@example.invalid, which web.push.apple.com answers with 403
    // {"reason":"BadJwtToken"} (checked by hand). v4 falls back to mailto:pit-princess@localhost and
    // logs a warning to set VAPID_SUBJECT. Whether Apple accepts @localhost is NOT verified here (no
    // network); the server's own warning says iPhones will refuse, so http deployments still need
    // VAPID_SUBJECT (render.yaml now lists it).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      hits.length = 0;
      const vapid = webpush.generateVAPIDKeys();
      const { pusher } = createPusher({ VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey }, 'http://localhost:8787');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('VAPID_SUBJECT'));
      await pusher!.send([receiver('/201/fallback').sub], { title: 't' });
      const sub = jwtOf(hits[0]).sub;
      console.log('[push-debug] fallback VAPID subject:', sub);
      expect(sub.endsWith('.invalid')).toBe(false);
      expect(sub).toBe('mailto:pit-princess@localhost');
    } finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// RoomHub ping replies: what the pinging phone ends up showing
// ---------------------------------------------------------------------------------------------
const ROOM = 'pushDebugRoom_0123456789';
const DEV_A = 'devAAAAAAAAAAAAAAAAAAA';
const DEV_B = 'devBBBBBBBBBBBBBBBBBBB';
const PUSH_A = 'pushAAAAAAAAAAAAAAAAAA';
const PUSH_B = 'pushBBBBBBBBBBBBBBBBBB';
const APPLE_SUB: PushSub = {
  endpoint: 'https://web.push.apple.com/QFakeTokenForPushDebug',
  keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' },
};

class FakeConn implements Conn {
  msgs: ServerMsg[] = [];
  send(msg: ServerMsg): void {
    this.msgs.push(msg);
  }
  close(): void {}
  of<T extends ServerMsg['t']>(t: T): Extract<ServerMsg, { t: T }>[] {
    return this.msgs.filter((m) => m.t === t) as Extract<ServerMsg, { t: T }>[];
  }
}

/** v4: the phone's #ping-msg text for a pinged reply: the real shared pingText(), fed like RadioLink does */
function phoneText(m: Extract<ServerMsg, { t: 'pinged' }>): string {
  return pingText({
    sent: m.sent,
    gone: m.gone,
    limited: m.limited,
    unavailable: m.unavailable === true,
    failed: m.failed ?? 0,
    waitMs: m.waitMs ?? 0,
  });
}

describe('RoomHub ping replies', () => {
  it('v4: a push the service REJECTS (403 BadJwtToken, 400, 429…) is shown as "Alert failed", not "Nobody to ping"', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const vapid = webpush.generateVAPIDKeys();
      const { pusher } = createPusher({ VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey }, 'https://x.test');
      const hub = new RoomHub({ getIceServers: async () => [], push: viaLocal(pusher!) });
      const a = new FakeConn();
      await hub.handle(a, { t: 'join', v: PROTOCOL_VERSION, room: ROOM, device: DEV_A, push: PUSH_A });
      // The real pusher against the local service answering 403 like Apple does for a bad JWT
      await hub.handle(a, { t: 'ping', subs: [asApple(receiver('/403/apple-says-no').sub)] });
      const rejected = a.of('pinged')[0];
      const b = new FakeConn();
      const hub2 = new RoomHub({ getIceServers: async () => [], push: viaLocal(pusher!) });
      await hub2.handle(b, { t: 'join', v: PROTOCOL_VERSION, room: ROOM, device: DEV_B, push: PUSH_B });
      await hub2.handle(b, { t: 'ping', subs: [] });
      const empty = b.of('pinged')[0];
      console.log('[push-debug] rejected push reply:', JSON.stringify(rejected), '| empty list reply:', JSON.stringify(empty));
      expect(rejected).toEqual({ t: 'pinged', sent: 0, gone: [], failed: 1, limited: false });
      expect(phoneText(rejected)).toBe('Alert failed');
      expect(empty).toEqual({ t: 'pinged', sent: 0, gone: [], limited: false });
      expect(phoneText(empty)).toBe('Nobody to ping');
      expect(warn).toHaveBeenCalledWith('[push] send failed', 403);
    } finally {
      warn.mockRestore();
    }
  });

  it('v4: a failed ping does NOT use up the 30 s room cooldown; a delivered one does, and "limited" says how long', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(1_000_000);
      const calls: PushSub[][] = [];
      let result = { sent: 0, gone: [] as string[], failed: 1 };
      const pusher: Pusher = { send: async (subs) => (calls.push(subs), result) };
      const hub = new RoomHub({ getIceServers: async () => [], push: pusher });
      const a = new FakeConn();
      const b = new FakeConn();
      await hub.handle(a, { t: 'join', v: PROTOCOL_VERSION, room: ROOM, device: DEV_A, push: PUSH_A });
      await hub.handle(b, { t: 'join', v: PROTOCOL_VERSION, room: ROOM, device: DEV_B, push: PUSH_B });
      await hub.handle(a, { t: 'ping', subs: [APPLE_SUB] }); // refused by the push service
      vi.setSystemTime(1_000_000 + 20_000);
      result = { sent: 1, gone: [], failed: 0 };
      await hub.handle(b, { t: 'ping', subs: [APPLE_SUB] }); // allowed straight away, and delivered
      vi.setSystemTime(1_000_000 + 29_000);
      await hub.handle(a, { t: 'ping', subs: [APPLE_SUB] }); // 9 s after B's: 21 s to wait
      expect(calls).toHaveLength(2);
      expect(phoneText(a.of('pinged')[0])).toBe('Alert failed');
      expect(phoneText(b.of('pinged')[0])).toBe('Pinged 1');
      expect(a.of('pinged')[1]).toMatchObject({ limited: true, waitMs: 21_000 });
      expect(phoneText(a.of('pinged')[1])).toBe('Wait 21 s');
      vi.setSystemTime(1_000_000 + 50_000);
      await hub.handle(a, { t: 'ping', subs: [APPLE_SUB] });
      expect(calls).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Presence: the real server process. A phone counts as present (and so is never pinged) until
// its socket closes. iOS suspends a backgrounded/locked web app: it stops answering pings and
// the 15 s heartbeat drops it after 15-30 s. If it is NOT suspended (e.g. still playing audio
// through the <audio> element) it keeps answering and stays present for as long as it likes.
// ---------------------------------------------------------------------------------------------
const serverDir = join(here, '..');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

describe('presence on the real server', () => {
  let proc: ChildProcess;
  let port = 0;
  let output = '';

  beforeAll(async () => {
    port = await freePort();
    const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port) };
    for (const k of ['CF_TURN_KEY_ID', 'CF_TURN_KEY_TOKEN', 'METERED_DOMAIN', 'METERED_API_KEY', 'TURN_URLS', 'DEV_HTTPS', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']) delete env[k];
    proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: serverDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout!.on('data', (d) => (output += d));
    proc.stderr!.on('data', (d) => (output += d));
    const until = Date.now() + 15_000;
    for (;;) {
      if (proc.exitCode !== null) throw new Error(`server exited:\n${output}`);
      try {
        if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break;
      } catch {
        /* not yet */
      }
      if (Date.now() > until) throw new Error(`server did not start:\n${output}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }, 20_000);

  afterAll(async () => {
    if (proc && proc.exitCode === null) {
      const exited = new Promise((r) => proc.once('exit', r));
      proc.kill();
      await exited;
    }
  });

  /** A phone over a raw socket. autoPong=false is an app iOS has suspended (no pongs, socket open). */
  async function member(join: Record<string, unknown>, autoPong: boolean) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { autoPong });
    const rosters: { at: number; pushIds: (string | undefined)[] }[] = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as ServerMsg;
      const members = m.t === 'roster' || m.t === 'welcome' ? (m.members as MemberInfo[]) : null;
      if (members) rosters.push({ at: Date.now(), pushIds: members.map((x) => x.pushId) });
    });
    const closed = new Promise<number>((r) => ws.once('close', () => r(Date.now())));
    await new Promise<void>((r, j) => (ws.once('open', () => r()), ws.once('error', j)));
    ws.send(JSON.stringify({ v: PROTOCOL_VERSION, room: 'presenceRoom_0123456789', ...join }));
    return { ws, rosters, closed };
  }

  it(
    'a suspended phone stays in the roster (excluded from pings) for 15-30 s; a backgrounded-but-alive one stays indefinitely',
    async () => {
      // The PC watches the roster (it pings from the same roster the phones see)
      const a = await member({ t: 'host' }, true);
      const suspended = await member({ t: 'join', device: DEV_B, push: PUSH_B }, false);
      const alive = await member({ t: 'join', device: DEV_A, push: PUSH_A }, true);
      await new Promise((r) => setTimeout(r, 300));
      const t0 = Date.now();
      expect(a.rosters.at(-1)!.pushIds).toEqual([undefined, PUSH_B, PUSH_A]);

      const gone = await Promise.race([
        (async () => {
          for (;;) {
            const last = a.rosters.at(-1)!;
            if (!last.pushIds.includes(PUSH_B)) return last.at;
            await new Promise((r) => setTimeout(r, 50));
          }
        })(),
        new Promise<number>((r) => setTimeout(() => r(-1), 40_000)),
      ]);
      const window = gone < 0 ? Infinity : gone - t0;
      console.log(`[push-debug] suspended phone still "present" (unpingable) for ${(window / 1000).toFixed(1)} s`);
      expect(window).toBeGreaterThan(14_000);
      expect(window).toBeLessThanOrEqual(31_000);
      // The phone that keeps answering pings is still a member: a ping from A would skip it
      expect(a.rosters.at(-1)!.pushIds).toContain(PUSH_A);
      expect(alive.ws.readyState).toBe(WebSocket.OPEN);
      a.ws.close();
      alive.ws.close();
      suspended.ws.terminate();
    },
    60_000,
  );
});
