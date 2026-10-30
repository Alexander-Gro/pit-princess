// End-to-end for the "PC is online" push plumbing and the open-the-mic-once rule.
// Real phone PWA (phone/dist via the real server) <-> RadioLink 'pc' harness, real WebRTC.
//
// Headless Chromium has no push service, so PushManager is stubbed in the phone page (init script
// below) to hand back a fake subscription. Everything after that is the real code path:
// phone/src/push.ts -> RadioLink.shareDir -> server dir relay (v4; was the data channel) -> harness onDir.
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';

const SERVER = `http://localhost:${process.env.E2E_SERVER_PORT}`;
const HARNESS = `http://127.0.0.1:${process.env.E2E_HARNESS_PORT}`;
const WS = `ws://localhost:${process.env.E2E_SERVER_PORT}/ws`;
// A well-formed P-256 key (the e2e server has no VAPID keys; /api/info is faked where needed)
const FAKE_VAPID = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
const FAKE_SUB = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/e2e-fake-subscription',
  keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' },
};

type PitState = { peer: string; floor: string; tx: boolean; rx: boolean; signaling: string };
const pcState = (pc: Page) => pc.evaluate(() => window.pit.state as unknown as PitState);

function logConsole(name: string, p: Page) {
  p.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[${name} console.${m.type()}] ${m.text()}`);
  });
  p.on('pageerror', (e) => console.log(`[${name} pageerror] ${e}`));
}

/** Runs in the phone page before any app code. */
function phoneInit(opts: { permission: NotificationPermission; subscribed: boolean; sub: typeof FAKE_SUB }) {
  const w = window as unknown as Record<string, unknown>;
  // (a) count getUserMedia calls
  w.__gum = 0;
  const md = navigator.mediaDevices;
  const gum = md.getUserMedia.bind(md);
  md.getUserMedia = (c?: MediaStreamConstraints) => {
    (w.__gum as number)++;
    return gum(c);
  };
  // (b) controllable Notification permission and a fake push subscription
  w.__perm = opts.permission;
  Object.defineProperty(Notification, 'permission', { configurable: true, get: () => w.__perm });
  Notification.requestPermission = async () => {
    w.__perm = 'granted';
    return 'granted';
  };
  let current: unknown = null;
  const make = () => ({
    endpoint: opts.sub.endpoint,
    options: null, // keyMatches() treats an unknown key as matching
    toJSON: () => ({ endpoint: opts.sub.endpoint, expirationTime: null, keys: opts.sub.keys }),
    unsubscribe: async () => {
      current = null;
      w.__unsubscribed = ((w.__unsubscribed as number) ?? 0) + 1;
      return true;
    },
  });
  if (opts.subscribed) current = make();
  PushManager.prototype.getSubscription = async function () {
    return current as PushSubscription | null;
  };
  PushManager.prototype.subscribe = async function () {
    w.__subscribeCalls = ((w.__subscribeCalls as number) ?? 0) + 1;
    current = make();
    return current as PushSubscription;
  };
}

async function openPair(
  context: BrowserContext,
  phoneOpts: { permission: NotificationPermission; subscribed: boolean; fakeVapid?: boolean },
) {
  const room = `e2e_${randomBytes(12).toString('hex')}`;
  const pc = await context.newPage();
  const phone = await context.newPage();
  logConsole('pc', pc);
  logConsole('phone', phone);
  await phone.addInitScript(phoneInit, { ...phoneOpts, sub: FAKE_SUB });
  if (phoneOpts.fakeVapid) {
    // Turns the push chip on (supported() needs a server key); the rest of /api/info is real
    await phone.route('**/api/info', async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...(await res.json()), vapidPublicKey: FAKE_VAPID } });
    });
  }
  await pc.goto(`${HARNESS}/pc.html?ws=${encodeURIComponent(WS)}&room=${room}`);
  await expect.poll(async () => (await pcState(pc))?.signaling).toBe('open');
  await phone.goto(`${SERVER}/#room=${room}`);
  await phone.locator('#ptt').click();
  await expect.poll(async () => (await pcState(pc)).peer, { timeout: 20_000 }).toBe('connected');
  await expect(phone.locator('#ptt-text')).toHaveText('TALK', { timeout: 20_000 });
  return { pc, phone };
}

// v4: dir copies arrive via the server (from the phone's member id, or 'server' for its cache), not
// the data channel. `from` is left out here.
const pcData = (pc: Page) =>
  pc.evaluate(() => window.pit.dirs.map(({ entries, valid }) => ({ msg: { t: 'dir', entries } as unknown, valid })));

test.describe('mic is opened once per launch', () => {
  test('cycling the noise filter three times never calls getUserMedia again, and audio still flows', async ({ context }) => {
    const { pc, phone } = await openPair(context, { permission: 'default', subscribed: false });
    const gum = () => phone.evaluate(() => (window as unknown as { __gum: number }).__gum);
    expect(await gum()).toBe(1);

    const nr = phone.locator('#nr');
    await expect(nr).toBeVisible();
    const first = (await nr.textContent())!;
    console.log(`[mic] initial chip: ${first}`);

    const rxBytes = () => pc.evaluate(() => window.pit.rxBytes());
    const rate = async () => {
      const a = await rxBytes();
      await pc.waitForTimeout(1000);
      return (await rxBytes()) - a;
    };
    const pttText = phone.locator('#ptt-text');

    /** idle and TX inbound byte rates at the PC for the current mode */
    const measure = async () => {
      const idle = await rate();
      // (the #nr click moved the mouse away)
      const box = (await phone.locator('#ptt').boundingBox())!;
      await phone.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await phone.mouse.down();
      await expect(pttText).toHaveText('TX');
      await expect.poll(async () => (await pcState(pc)).rx).toBe(true);
      const tx = await rate();
      await phone.mouse.up();
      await expect.poll(async () => (await pcState(pc)).floor).toBe('idle');
      return { idle, tx };
    };

    const results: Record<string, { idle: number; tx: number }> = { [`0 ${first}`]: await measure() };
    // Strong (AI) -> Standard -> Off -> Strong (AI)
    let step = 0;
    for (const want of ['Standard', 'Off', 'Strong (AI)']) {
      await nr.click();
      await expect(nr).toContainText(`Noise filter: ${want}`);
      // openMic() finishes asynchronously; give it time to (wrongly) reach for getUserMedia
      await phone.waitForTimeout(500);
      expect(await gum(), `after switching to ${want}`).toBe(1);
      const label = (await nr.textContent())!;
      // Chromium keeps the old noiseSuppression on applyConstraints; the chip then says "(reopen app to apply)"
      results[`${++step} ${label}`] = await measure();
    }
    console.log(`[mic] inbound audio bytes/s per mode: ${JSON.stringify(results)}`);

    expect(await gum()).toBe(1);
    // In every mode the fake mic's tone reaches the PC while keyed, and the idle mic stays off the wire
    for (const [label, r] of Object.entries(results)) {
      expect(r.tx, `TX louder than idle in "${label}"`).toBeGreaterThan(r.idle * 1.2);
    }
    const idles = Object.values(results).map((r) => r.idle);
    const txs = Object.values(results).map((r) => r.tx);
    // An un-keyed mic leaking onto the wire would look like TX traffic when idle
    expect(Math.max(...idles)).toBeLessThan(Math.min(...txs));
  });
});

// v3: the phone no longer sends push_sub/push_unsub; it puts its own entry {owner: pushId, sub, ts}
// into the room's directory and shares the whole directory as {t:'dir', entries}.
type DirEntry = { owner: string; sub: typeof FAKE_SUB | null; ts: number };
const dirMsgs = async (pc: Page) =>
  (await pcData(pc)).filter((d) => (d.msg as { t?: string }).t === 'dir') as { msg: { t: 'dir'; entries: DirEntry[] }; valid: boolean }[];
/** The newest entry for `owner` the PC has been sent */
const lastEntry = async (pc: Page, owner: string) =>
  (await dirMsgs(pc)).flatMap((d) => d.msg.entries).filter((e) => e.owner === owner).sort((a, b) => b.ts - a.ts)[0] ?? null;
const pushIdOf = (phone: Page) => phone.evaluate(() => localStorage.getItem('pit-princess-push-id'));

test.describe('push subscription reaches the PC through the server (as the directory)', () => {
  test('an existing subscription is shared on connect as our own dir entry; every message passes isDirMsg', async ({ context }) => {
    const { pc, phone } = await openPair(context, { permission: 'granted', subscribed: true, fakeVapid: true });
    const owner = (await pushIdOf(phone))!;
    expect(owner).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    await expect.poll(async () => (await lastEntry(pc, owner))?.sub ?? null).toEqual(FAKE_SUB);
    await pc.waitForTimeout(1000);
    const msgs = await dirMsgs(pc);
    expect(msgs.every((m) => m.valid)).toBe(true);
    // Our entry stays the same (not re-stamped on every message)
    expect(new Set(msgs.flatMap((m) => m.msg.entries).filter((e) => e.owner === owner).map((e) => e.ts)).size).toBe(1);
    expect(await pc.evaluate(() => window.pit.dataOpenCount)).toBe(1);
    // The roster carries the same push id, so the PC can tell this phone is present
    expect((await pc.evaluate(() => window.pit.state!.members)).find((m) => m.role === 'phone')?.pushId).toBe(owner);
    // ...and it's stored on the phone, keyed by room
    const stored = await phone.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('pit-princess-dir:')));
    expect(stored).toHaveLength(1);
  });

  test('without notification permission no live entry is shared', async ({ context }) => {
    const { pc, phone } = await openPair(context, { permission: 'denied', subscribed: true, fakeVapid: true });
    await expect.poll(async () => (await dirMsgs(pc)).length).toBeGreaterThan(0);
    await pc.waitForTimeout(1500);
    const owner = (await pushIdOf(phone))!;
    expect(await lastEntry(pc, owner)).toBeNull();
    expect((await dirMsgs(pc)).flatMap((d) => d.msg.entries).filter((e) => e.sub)).toEqual([]);
  });

  test('tapping the chip subscribes (live entry); tapping again turns it off (newer tombstone)', async ({ context }) => {
    const { pc, phone } = await openPair(context, { permission: 'default', subscribed: false, fakeVapid: true });
    const owner = (await pushIdOf(phone))!;
    const chip = phone.locator('#notify');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText('Turn on alerts');
    expect(await lastEntry(pc, owner)).toBeNull();

    await chip.click();
    await expect.poll(async () => (await lastEntry(pc, owner))?.sub ?? null).toEqual(FAKE_SUB);
    const on = (await lastEntry(pc, owner))!;
    await expect(chip).toHaveText('Alerts on');
    expect(await phone.evaluate(() => (window as unknown as { __subscribeCalls: number }).__subscribeCalls)).toBe(1);

    phone.once('dialog', (d) => void d.accept());
    await chip.click();
    await expect.poll(async () => { const e = await lastEntry(pc, owner); return e ? e.sub : 'missing'; }).toBeNull();
    expect((await lastEntry(pc, owner))!.ts).toBeGreaterThan(on.ts);
    expect((await dirMsgs(pc)).every((m) => m.valid)).toBe(true);
    await expect(chip).toHaveText('Turn on alerts');
    expect(await phone.evaluate(() => (window as unknown as { __unsubscribed: number }).__unsubscribed)).toBe(1);
  });

  test('the PC pings through the real server: no VAPID keys -> pinged {unavailable}', async ({ context }) => {
    const room = `e2e_${randomBytes(12).toString('hex')}`;
    const pc = await context.newPage();
    logConsole('pc', pc);
    await pc.goto(`${HARNESS}/pc.html?ws=${encodeURIComponent(WS)}&room=${room}`);
    await expect.poll(async () => (await pcState(pc))?.signaling).toBe('open');
    await pc.evaluate((s) => (window.pit.targets = [s]), FAKE_SUB);
    expect(await pc.evaluate(() => window.pit.ping())).toBe(true);
    await expect
      .poll(() => pc.evaluate(() => window.pit.pinged))
      .toEqual([{ sent: 0, gone: [], limited: false, unavailable: true, failed: 0, waitMs: 0 }]);
  });

  test('PC announce round-trips through the real server (no VAPID keys: nothing sent)', async ({ context }) => {
    const room = `e2e_${randomBytes(12).toString('hex')}`;
    const pc = await context.newPage();
    logConsole('pc', pc);
    await pc.goto(`${HARNESS}/pc.html?ws=${encodeURIComponent(WS)}&room=${room}`);
    await expect.poll(async () => (await pcState(pc))?.signaling).toBe('open');
    expect(await pc.evaluate((s) => window.pit.announce([s]), FAKE_SUB)).toBe(true);
    await expect.poll(() => pc.evaluate(() => window.pit.announced)).toEqual([{ sent: 0, gone: [] }]);
  });
});

test.describe('service worker', () => {
  test('sw.js is served as JavaScript with Cache-Control: no-cache, and registers at scope /', async ({ request, page }) => {
    const res = await request.get(`${SERVER}/sw.js`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/^(text|application)\/javascript/);
    expect(res.headers()['cache-control']).toBe('no-cache');
    // Not the SPA fallback
    expect(await res.text()).toContain("addEventListener('push'");

    await page.goto(`${SERVER}/`);
    const reg = await page.evaluate(async () => {
      const r = await navigator.serviceWorker.ready;
      return { scope: r.scope, script: r.active?.scriptURL ?? null };
    });
    expect(reg).toEqual({ scope: `${SERVER}/`, script: `${SERVER}/sw.js` });
  });
});
