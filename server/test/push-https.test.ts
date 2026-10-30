// createPusher with the REAL web-push library against a local HTTPS "push service".
// Checks that web-push's errors really carry the statusCode createPusher keys on, and that the
// request it makes is a proper encrypted VAPID push.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:https';
import { createECDH, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import selfsigned from 'selfsigned';
import webpush from 'web-push';
import { createPusher } from '../src/push.ts';

let server: Server;
let base = '';
const hits: { path: string; headers: Record<string, unknown>; bytes: number }[] = [];
const savedTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

beforeAll(async () => {
  const pems = selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { days: 1, keySize: 2048 });
  server = createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
    let bytes = 0;
    req.on('data', (c: Buffer) => (bytes += c.length));
    req.on('end', () => {
      hits.push({ path: req.url ?? '', headers: req.headers, bytes });
      const status = Number((req.url ?? '').split('/')[1]) || 201;
      res.writeHead(status).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The local push service uses a self-signed cert; createPusher has no way to pass an agent
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
});

afterAll(async () => {
  if (savedTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = savedTls;
  await new Promise((r) => server.close(r));
});

/** A subscription with real P-256 / auth keys, like a browser makes */
function realSub(path: string) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint: `${base}${path}`,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
  };
}

describe('createPusher + real web-push', () => {
  it('201 is sent, 404/410 are gone, 500 and 429 are failed (v4)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const vapid = webpush.generateVAPIDKeys();
      const { pusher, publicKey } = createPusher(
        { VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey },
        'https://pit.example.test',
      );
      expect(publicKey).toBe(vapid.publicKey);
      const subs = ['/201/a', '/410/b', '/404/c', '/500/d', '/429/e'].map(realSub);
      const res = await pusher!.send(subs, { title: 'Pit Princess', body: 'The PC is online.' });
      expect(res.sent).toBe(1);
      expect([...res.gone].sort()).toEqual([`${base}/404/c`, `${base}/410/b`]);
      expect(res.failed).toBe(2);
      expect(warn.mock.calls.map((c) => c[1]).sort()).toEqual([429, 500]);

      // Every request was a real encrypted VAPID push with our TTL/urgency
      expect(hits).toHaveLength(5);
      for (const h of hits) {
        expect(h.headers['content-encoding']).toBe('aes128gcm');
        expect(h.headers['ttl']).toBe('300');
        expect(h.headers['urgency']).toBe('high');
        expect(String(h.headers['authorization'])).toMatch(/^vapid t=.+, k=.+/);
        expect(h.bytes).toBeGreaterThan(0);
      }
    } finally {
      warn.mockRestore();
    }
  });

  it('a sub with malformed keys is logged, not reported gone (the PC keeps it)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const vapid = webpush.generateVAPIDKeys();
      const { pusher } = createPusher({ VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey }, 'https://x.test');
      const res = await pusher!.send([{ endpoint: `${base}/201/z`, keys: { p256dh: 'short', auth: 'short' } }], {});
      expect(res).toEqual({ sent: 0, gone: [], failed: 1 });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
