// Debugging "the ping doesn't reach the other phone": directory propagation and presence in the
// scenarios that matter, with real phone PWAs (each in its OWN browser context = its own
// localStorage, push id and device id), the real server and real WebRTC.
//
// Headless Chromium has no push service, so PushManager/Notification are stubbed (as in
// push-mic.spec.ts) and /api/info gets a fake VAPID key so the Alerts chip shows. Each phone's
// subscription has its own endpoint. Everything after "tap the chip" is the real code path.
//
// What we check is the `subs` list in the phone's {t:'ping'} message: who it would notify.
//
// Tests marked test.fail() describe what we WANT and fail on the current code. When a fix lands
// Playwright reports them as "unexpectedly passed": drop the test.fail() line then. (v4: the
// background/presence and failed-WebRTC-link ones did; the directory now goes via the server.)
import { expect, test, type Browser } from '@playwright/test';
import { SERVER, logConsole, newRoom, sentOf, type Phone } from './mesh-helpers.ts';

const FAKE_VAPID = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
const KEYS = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };
const dirKey = (room: string) => `pit-princess-dir:${room}`;
type Sub = { endpoint: string; keys: typeof KEYS };

/** Init script: granted notifications and a fake PushManager whose endpoints are unique per subscribe() */
function pushStub(opts: { name: string; keys: typeof KEYS; blockIce: boolean }) {
  const w = window as unknown as Record<string, unknown>;
  Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'granted' });
  Notification.requestPermission = async () => 'granted';
  let n = 0;
  let current: unknown = null;
  const make = () => {
    const endpoint = `https://fcm.googleapis.com/fcm/send/e2e-${opts.name}-${++n}`;
    return {
      endpoint,
      options: null,
      toJSON: () => ({ endpoint, expirationTime: null, keys: opts.keys }),
      unsubscribe: async () => ((current = null), true),
    };
  };
  PushManager.prototype.getSubscription = async function () {
    return current as PushSubscription | null;
  };
  PushManager.prototype.subscribe = async function () {
    current = make();
    w.__endpoint = (current as { endpoint: string }).endpoint;
    return current as PushSubscription;
  };
  if (opts.blockIce) {
    // A WebRTC link that never connects (e.g. two phones on CGNAT mobile data with no TURN):
    // no remote candidates are ever used, so ICE fails and the data channel never opens.
    RTCPeerConnection.prototype.addIceCandidate = async function () {};
  }
}

async function openPushPhone(browser: Browser, name: string, room: string, blockIce = false, storage: Record<string, string> = {}): Promise<Phone> {
  const context = await browser.newContext({ permissions: ['microphone'] });
  const page = await context.newPage();
  logConsole(name, page);
  await page.addInitScript(pushStub, { name, keys: KEYS, blockIce });
  await page.addInitScript((kv) => {
    for (const [k, v] of Object.entries(kv)) if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
  }, storage);
  await page.route('**/api/info', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), vapidPublicKey: FAKE_VAPID } });
  });
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

/** Tap the Alerts chip; resolves to this phone's subscription as it is published */
async function turnOnAlerts(p: Phone): Promise<Sub> {
  const chip = p.page.locator('#notify');
  await expect(chip).toHaveText('Turn on alerts', { timeout: 10_000 });
  await chip.click();
  await expect(chip).toHaveText('Alerts on');
  const endpoint = (await p.page.evaluate(() => (window as unknown as { __endpoint: string }).__endpoint))!;
  return { endpoint, keys: KEYS };
}

const dirOf = (p: Phone, room: string) =>
  p.page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '[]') as { owner: string; sub: Sub | null; ts: number }[], dirKey(room));

/** Triple-tap (v4: there is no Ping chip any more) and return the subs of the ping message it sent */
async function pingSubs(p: Phone): Promise<Sub[]> {
  const before = sentOf(p, 'ping').length;
  // Let earlier taps age out of the 1.5 s triple-tap window
  await p.page.waitForTimeout(1600);
  for (let i = 0; i < 3; i++) {
    await p.page.keyboard.press('Space');
    await p.page.waitForTimeout(100);
  }
  await expect.poll(() => sentOf(p, 'ping').length).toBe(before + 1);
  const subs = sentOf(p, 'ping').at(-1)!.subs as Sub[];
  console.log(`[push-debug] ${p.name} ping subs: ${JSON.stringify(subs.map((s) => s.endpoint))}`);
  return subs;
}

/** Make the page look hidden, as iOS does when the app is backgrounded or the screen locks */
const goBackground = (p: Phone) =>
  p.page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  });

test.describe('ping targets: directory propagation and presence', () => {
  test('baseline: B subscribes while alone, A joins while B is still there, B quits -> A pings B', async ({ browser }) => {
    test.setTimeout(90_000);
    const room = newRoom();
    const b = await openPushPhone(browser, 'phoneB', room);
    let a: Phone | null = null;
    try {
      await expect(b.link).toHaveText('ALONE', { timeout: 20_000 });
      const subB = await turnOnAlerts(b);
      a = await openPushPhone(browser, 'phoneA', room);
      await expect(a.link).toHaveText('PC OFF', { timeout: 20_000 });
      // Our own entry spreads through the server (v4: dir relay; it was the data channel)
      await expect.poll(async () => (await dirOf(a!, room)).map((e) => e.sub?.endpoint), { timeout: 10_000 }).toContain(subB.endpoint);
      // While B is here it's not a target
      expect(await pingSubs(a)).toEqual([]);
      await b.context.close();
      await expect(a.link).toHaveText('ALONE', { timeout: 10_000 });
      expect(await pingSubs(a)).toEqual([subB]);
    } finally {
      await a?.context.close();
      await b.context.close().catch(() => {});
    }
  });

  test('v4: B subscribed but was never online at the same time as anyone: A gets its entry from the server cache and pings it', async ({ browser }) => {
    test.setTimeout(60_000);
    const room = newRoom();
    const b = await openPushPhone(browser, 'phoneB', room);
    await expect(b.link).toHaveText('ALONE', { timeout: 20_000 });
    const subB = await turnOnAlerts(b);
    // B's entry reached the server (its dir message carries the new endpoint)
    await expect.poll(() => sentOf(b, 'dir').some((m) => JSON.stringify(m).includes(subB.endpoint)), { timeout: 10_000 }).toBe(true);
    await b.context.close();
    const a = await openPushPhone(browser, 'phoneA', room);
    try {
      await expect(a.link).toHaveText('ALONE', { timeout: 20_000 });
      await expect.poll(async () => (await dirOf(a, room)).map((e) => e.sub?.endpoint), { timeout: 10_000 }).toContain(subB.endpoint);
      expect(await pingSubs(a)).toEqual([subB]);
      await expect(a.page.locator('#ping-msg')).toHaveText('Alerts not set up'); // (e2e server has no VAPID)
    } finally {
      await a.context.close();
    }
  });

  test('B goes to the background (hidden) while connected: A should ping it', async ({ browser }) => {
    // v4: the app sends presence {away} on visibilitychange and pingTargets() skips only non-away members
    test.setTimeout(90_000);
    const room = newRoom();
    const a = await openPushPhone(browser, 'phoneA', room);
    const b = await openPushPhone(browser, 'phoneB', room);
    try {
      await expect(b.link).toHaveText('PC OFF', { timeout: 20_000 });
      const subB = await turnOnAlerts(b);
      await expect.poll(async () => (await dirOf(a, room)).map((e) => e.sub?.endpoint), { timeout: 10_000 }).toContain(subB.endpoint);
      await goBackground(b);
      await expect.poll(() => sentOf(b, 'presence').at(-1)).toEqual({ t: 'presence', away: true });
      await a.page.waitForTimeout(500);
      expect(await pingSubs(a)).toEqual([subB]);
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });

  test('the phone<->phone WebRTC link fails: B subscribes with A in the room, B quits, A should still ping B', async ({ browser }) => {
    // v4: the directory goes through the server, so a dead WebRTC link no longer stops it
    test.setTimeout(90_000);
    const room = newRoom();
    const a = await openPushPhone(browser, 'phoneA', room, true);
    const b = await openPushPhone(browser, 'phoneB', room, true);
    try {
      // Both in the room per the server, but the media/data link can't connect
      await expect(a.link).not.toHaveText('ALONE', { timeout: 20_000 });
      const subB = await turnOnAlerts(b);
      await a.page.waitForTimeout(5000);
      console.log(`[push-debug] link tiles with ICE blocked: A=${await a.link.textContent()} B=${await b.link.textContent()}`);
      console.log(`[push-debug] A's directory: ${JSON.stringify(await dirOf(a, room))}`);
      await b.context.close();
      await expect(a.link).toHaveText('ALONE', { timeout: 10_000 });
      expect(await pingSubs(a)).toEqual([subB]);
    } finally {
      await a.context.close();
      await b.context.close().catch(() => {});
    }
  });

  test('a tombstone for B (its endpoint was reported gone) makes B renew and re-publish when it comes back', async ({ browser }) => {
    test.setTimeout(90_000);
    const room = newRoom();
    const b = await openPushPhone(browser, 'phoneB', room);
    let a: Phone | null = null;
    try {
      await expect(b.link).toHaveText('ALONE', { timeout: 20_000 });
      const first = await turnOnAlerts(b);
      const owner = (await b.page.evaluate(() => localStorage.getItem('pit-princess-push-id')))!;
      // A has a newer "off" marker for B (as after a ping got 410 from the push service)
      const tomb = [{ owner, sub: null, ts: Date.now() + 1000 }];
      a = await openPushPhone(browser, 'phoneA', room, false, { [dirKey(room)]: JSON.stringify(tomb) });
      await expect(a.link).toHaveText('PC OFF', { timeout: 20_000 });
      // B merges the tombstone, renews (new endpoint) and the new entry wins everywhere
      await expect
        .poll(async () => (await dirOf(a!, room)).find((e) => e.owner === owner)?.sub?.endpoint ?? null, { timeout: 15_000 })
        .not.toBeNull();
      const now = (await dirOf(a, room)).find((e) => e.owner === owner)!.sub!.endpoint;
      console.log(`[push-debug] B renewed: ${first.endpoint} -> ${now}`);
      expect(now).not.toBe(first.endpoint);
      await b.context.close();
      await expect(a.link).toHaveText('ALONE', { timeout: 10_000 });
      expect((await pingSubs(a)).map((s) => s.endpoint)).toEqual([now]);
    } finally {
      await a?.context.close();
      await b.context.close().catch(() => {});
    }
  });
});
