// createPusher with web-push mocked: config handling and how send results are classified.
// (push-https.test.ts runs the real web-push library against a local HTTPS push service.)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const wp = vi.hoisted(() => ({
  setVapidDetails: vi.fn(),
  sendNotification: vi.fn(),
}));
vi.mock('web-push', () => ({ default: wp, ...wp }));

import { createPusher } from '../src/push.ts';

const KEYS = { VAPID_PUBLIC_KEY: 'pub-key', VAPID_PRIVATE_KEY: 'priv-key' };
const sub = (n: number) => ({ endpoint: `https://push.example.test/${n}`, keys: { p256dh: `p${n}`, auth: `a${n}` } });
const httpError = (statusCode: number) => Object.assign(new Error(`Received unexpected response code ${statusCode}`), { statusCode });

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  wp.setVapidDetails.mockReset();
  wp.sendNotification.mockReset();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe('createPusher config', () => {
  it('returns null without both VAPID keys', () => {
    expect(createPusher({}, 'https://x.test')).toEqual({ pusher: null, publicKey: null });
    expect(createPusher({ VAPID_PUBLIC_KEY: 'pub' }, 'https://x.test')).toEqual({ pusher: null, publicKey: null });
    expect(createPusher({ VAPID_PRIVATE_KEY: 'priv' }, 'https://x.test')).toEqual({ pusher: null, publicKey: null });
    // whitespace-only counts as missing
    expect(createPusher({ VAPID_PUBLIC_KEY: '  ', VAPID_PRIVATE_KEY: '\n' }, 'https://x.test')).toEqual({ pusher: null, publicKey: null });
    expect(wp.setVapidDetails).not.toHaveBeenCalled();
  });

  it('with keys: returns a pusher and the trimmed public key', () => {
    const r = createPusher({ VAPID_PUBLIC_KEY: ' pub-key \n', VAPID_PRIVATE_KEY: ' priv-key ' }, 'https://pit.example.test');
    expect(r.pusher).not.toBeNull();
    expect(r.publicKey).toBe('pub-key');
    expect(wp.setVapidDetails).toHaveBeenCalledWith('https://pit.example.test', 'pub-key', 'priv-key');
  });

  it('subject: VAPID_SUBJECT wins, then an https public URL, else a mailto placeholder', () => {
    createPusher({ ...KEYS, VAPID_SUBJECT: ' mailto:me@example.test ' }, 'https://pit.example.test');
    expect(wp.setVapidDetails).toHaveBeenLastCalledWith('mailto:me@example.test', 'pub-key', 'priv-key');
    createPusher({ ...KEYS }, 'http://localhost:8787');
    expect(wp.setVapidDetails).toHaveBeenLastCalledWith('mailto:pit-princess@example.invalid', 'pub-key', 'priv-key');
    createPusher({ ...KEYS, VAPID_SUBJECT: '   ' }, 'https://pit.example.test');
    expect(wp.setVapidDetails).toHaveBeenLastCalledWith('https://pit.example.test', 'pub-key', 'priv-key');
  });
});

describe('pusher.send', () => {
  it('sends the JSON payload to each sub with a short TTL and counts successes', async () => {
    wp.sendNotification.mockResolvedValue({ statusCode: 201 });
    const { pusher } = createPusher(KEYS, 'https://x.test');
    const res = await pusher!.send([sub(1), sub(2)], { title: 'T', body: 'B' });
    expect(res).toEqual({ sent: 2, gone: [] });
    expect(wp.sendNotification).toHaveBeenCalledTimes(2);
    const [s, body, opts] = wp.sendNotification.mock.calls[0];
    expect(s).toEqual(sub(1));
    expect(JSON.parse(body)).toEqual({ title: 'T', body: 'B' });
    expect(opts).toMatchObject({ TTL: 300, urgency: 'high' });
  });

  it('404 and 410 go into gone; other HTTP errors and network errors do not', async () => {
    const outcome: Record<string, () => Promise<unknown>> = {
      'https://push.example.test/1': async () => ({ statusCode: 201 }),
      'https://push.example.test/2': async () => Promise.reject(httpError(410)),
      'https://push.example.test/3': async () => Promise.reject(httpError(404)),
      'https://push.example.test/4': async () => Promise.reject(httpError(500)),
      'https://push.example.test/5': async () => Promise.reject(httpError(429)),
    };
    wp.sendNotification.mockImplementation((s: { endpoint: string }) => outcome[s.endpoint]());
    const { pusher } = createPusher(KEYS, 'https://x.test');
    const res = await pusher!.send([1, 2, 3, 4, 5].map(sub), {});
    expect(res.sent).toBe(1);
    expect([...res.gone].sort()).toEqual(['https://push.example.test/2', 'https://push.example.test/3']);
    expect(warn).toHaveBeenCalledTimes(2); // 500 and 429 are logged, not dropped
  });

  it('errors without a status (network, bad keys) are not gone', async () => {
    wp.sendNotification
      .mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
      .mockRejectedValueOnce(new Error('The subscription p256dh value should be 65 bytes long.'))
      .mockRejectedValueOnce('a string');
    const { pusher } = createPusher(KEYS, 'https://x.test');
    expect(await pusher!.send([sub(1), sub(2), sub(3)], {})).toEqual({ sent: 0, gone: [] });
  });

  it('a sync throw from sendNotification is handled like a rejection', async () => {
    wp.sendNotification.mockImplementation(() => {
      throw httpError(410);
    });
    const { pusher } = createPusher(KEYS, 'https://x.test');
    await expect(pusher!.send([sub(1)], {})).resolves.toEqual({ sent: 0, gone: ['https://push.example.test/1'] });
  });

  it('sends in parallel (one slow push service does not serialize the rest)', async () => {
    let inFlight = 0;
    let peak = 0;
    wp.sendNotification.mockImplementation(async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return { statusCode: 201 };
    });
    const { pusher } = createPusher(KEYS, 'https://x.test');
    await pusher!.send([1, 2, 3].map(sub), {});
    expect(peak).toBe(3);
  });

  it('no subs: nothing sent', async () => {
    const { pusher } = createPusher(KEYS, 'https://x.test');
    expect(await pusher!.send([], {})).toEqual({ sent: 0, gone: [] });
    expect(wp.sendNotification).not.toHaveBeenCalled();
  });
});
