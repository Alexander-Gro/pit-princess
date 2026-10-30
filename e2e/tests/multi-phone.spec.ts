// End-to-end: two real phone PWAs + the RadioLink 'pc' harness (RemoteAudio + PcMixer, wired like
// the desktop app), over the real server and real WebRTC in Chromium with fake mics.
//
// Each phone runs in its OWN browser context: a shared context shares localStorage, which would
// give both phones the same device id (and the second would just replace the first).
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';

const SERVER = `http://localhost:${process.env.E2E_SERVER_PORT}`;
const HARNESS = `http://127.0.0.1:${process.env.E2E_HARNESS_PORT}`;
const WS = `ws://localhost:${process.env.E2E_SERVER_PORT}/ws`;

type Member = { id: string; role: 'pc' | 'phone'; name: string | null; slot?: number; device?: string };
type PitState = {
  peer: string;
  floor: string;
  tx: boolean;
  rx: boolean;
  signaling: string;
  members: Member[];
  peers: { id: string; status: string }[];
};
const pcState = (pc: Page) => pc.evaluate(() => window.pit.state as unknown as PitState);

function logConsole(name: string, p: Page) {
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

interface Phone {
  name: string;
  context: BrowserContext;
  page: Page;
  text: ReturnType<Page['locator']>;
  sub: ReturnType<Page['locator']>;
  /** server->phone websocket frames (busy has no DOM representation) */
  frames: string[];
}

async function openPhone(browser: Browser, name: string, room: string): Promise<Phone> {
  const context = await browser.newContext({ permissions: ['microphone'] });
  const page = await context.newPage();
  logConsole(name, page);
  await page.addInitScript(recordPeerConnections);
  const frames: string[] = [];
  page.on('websocket', (ws) => ws.on('framereceived', (f) => frames.push(String(f.payload))));
  await page.goto(`${SERVER}/#room=${room}`);
  await page.locator('#ptt').click();
  return { name, context, page, text: page.locator('#ptt-text'), sub: page.locator('#ptt-sub'), frames };
}

/** The phone's current RTCPeerConnection to the PC (the newest one) */
async function phoneInboundBytes(p: Phone): Promise<number> {
  return p.page.evaluate(async () => {
    const pcs = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.filter((c) => c.connectionState !== 'closed');
    const pc = pcs[pcs.length - 1];
    if (!pc) return -1;
    let n = 0;
    (await pc.getStats()).forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'audio') n = r.bytesReceived ?? 0;
    });
    return n;
  });
}

/** Inbound audio bytes per second at a phone, averaged over `ms` (the fake mic beeps, so longer is steadier) */
async function phoneRate(p: Phone, ms = 2000): Promise<number> {
  const a = await phoneInboundBytes(p);
  await p.page.waitForTimeout(ms);
  return Math.round((((await phoneInboundBytes(p)) - a) * 1000) / ms);
}

/** Force the phone's outgoing mic track on or off, bypassing PTT (a "hot mic") */
async function setHotMic(p: Phone, on: boolean): Promise<void> {
  await p.page.evaluate((on) => {
    const pcs = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.filter((c) => c.connectionState !== 'closed');
    const t = pcs[pcs.length - 1]?.getSenders().find((s) => s.track?.kind === 'audio')?.track;
    if (t) t.enabled = on;
  }, on);
}

async function press(p: Phone): Promise<void> {
  const box = (await p.page.locator('#ptt').boundingBox())!;
  await p.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await p.page.mouse.down();
}
const release = (p: Phone) => p.page.mouse.up();

const deviceOf = (p: Phone) => p.page.evaluate(() => localStorage.getItem('pit-princess-device'));

test('two phones and the PC: relay, names, busy, room full', async ({ browser, context }) => {
  test.setTimeout(120_000);
  const room = `e2e_${randomBytes(12).toString('hex')}`;
  const pc = await context.newPage();
  logConsole('pc', pc);
  await pc.goto(`${HARNESS}/pc.html?ws=${encodeURIComponent(WS)}&room=${room}`);
  await expect.poll(() => pc.evaluate(() => window.pit.error ?? window.pit.ready)).toBe(true);
  await expect.poll(async () => (await pcState(pc)).signaling).toBe('open');

  const phones: Phone[] = [];
  try {
    // ---- both connect ----
    const a = await openPhone(browser, 'phoneA', room);
    phones.push(a);
    await expect(a.text).toHaveText('HOLD TO TALK', { timeout: 20_000 });
    const b = await openPhone(browser, 'phoneB', room);
    phones.push(b);
    await expect(b.text).toHaveText('HOLD TO TALK', { timeout: 20_000 });
    await expect
      .poll(async () => (await pcState(pc)).peers.filter((p) => p.status === 'connected').length, { timeout: 20_000 })
      .toBe(2);
    await expect.poll(() => pc.evaluate(() => window.pit.remotes.length)).toBe(2);

    // Separate contexts -> separate device ids
    const [devA, devB] = [await deviceOf(a), await deviceOf(b)];
    expect(devA).toBeTruthy();
    expect(devB).toBeTruthy();
    expect(devA).not.toBe(devB);
    const members = (await pcState(pc)).members;
    const memA = members.find((m) => m.device === devA)!;
    const memB = members.find((m) => m.device === devB)!;
    expect(memA.slot).toBe(1);
    expect(memB.slot).toBe(2);
    // Unnamed phones read "Phone 1/2"
    await expect(a.sub).toHaveText('You: Phone 1 · with Phone 2');
    await expect(b.sub).toHaveText('You: Phone 2 · with Phone 1');
    // Phones never see device ids
    for (const p of [a, b]) {
      const all = p.frames.join('\n');
      expect(all).not.toContain(devA!);
      expect(all).not.toContain(devB!);
    }

    // ---- names set by the PC show on the phones ----
    await pc.evaluate((n) => window.pit.setNames(n), { pc: 'Pit wall', [memA.id]: 'Emma', [memB.id]: 'Lou' });
    await expect(a.sub).toHaveText('You: Emma · with Lou');
    await expect(b.sub).toHaveText('You: Lou · with Emma');

    // ---- the relay is silent when nobody holds the floor ----
    await pc.waitForTimeout(500);
    const idleB = await phoneRate(b);
    // Even with A's mic forced on (a hot mic while not keyed), nothing of A reaches B
    const pcFromA = () => pc.evaluate((id) => window.pit.rxBytes(id), memA.id);
    const pcRateFromA = async () => {
      const x = await pcFromA();
      await pc.waitForTimeout(1000);
      return (await pcFromA()) - x;
    };
    const pcIdleFromA = await pcRateFromA();
    await setHotMic(a, true);
    await pc.waitForTimeout(300);
    const [hotB, pcHotFromA] = await Promise.all([phoneRate(b), pcRateFromA()]);
    await setHotMic(a, false);
    const gainsIdle = await pc.evaluate(() => window.pit.relayGains());
    console.log(
      `[relay] idle: B=${idleB} B(A hot mic, not keyed)=${hotB} | PC from A: idle=${pcIdleFromA} hot=${pcHotFromA} | gates=${JSON.stringify(gainsIdle)}`,
    );
    // The hot mic really was on the wire to the PC...
    expect(pcHotFromA).toBeGreaterThan(pcIdleFromA * 1.2);
    // ...but the relay gate kept it from B
    expect(hotB).toBeLessThan(idleB * 1.15);
    expect(Object.values(gainsIdle).every((g) => g < 0.01)).toBe(true);

    // ---- phone A keys up: PC rx, B shows RX with the talker's name ----
    await press(a);
    await expect(a.text).toHaveText('TX');
    await expect.poll(async () => (await pcState(pc)).rx).toBe(true);
    expect((await pcState(pc)).floor).toBe(memA.id);
    await expect(b.text).toHaveText('RX');
    await expect(b.sub).toHaveText('Emma talking');
    await pc.waitForTimeout(300);
    const txB = await phoneRate(b);
    const gainsTx = await pc.evaluate(() => window.pit.relayGains());
    console.log(`[relay] B inbound bytes/s: idle=${idleB} while A talks=${txB} | gates=${JSON.stringify(gainsTx)}`);
    expect(gainsTx[memA.id]).toBeGreaterThan(0.9);
    expect(gainsTx[memB.id]).toBeLessThan(0.01);
    // Measured locally: idle ~1.75-1.8 kB/s (encoded silence, varies ~3%), relayed tone 2.4-3.8 kB/s.
    // Same 1.2x margin as the single-phone specs.
    expect(txB).toBeGreaterThan(idleB * 1.2);

    // ---- B pressing while A talks: busy, stays RX ----
    const busyBefore = b.frames.filter((f) => f.includes('"t":"busy"')).length;
    await press(b);
    await expect.poll(() => b.frames.filter((f) => f.includes('"t":"busy"')).length).toBe(busyBefore + 1);
    await expect(b.text).toHaveText('RX');
    await expect(a.text).toHaveText('TX');
    expect((await pcState(pc)).floor).toBe(memA.id);
    await release(b);

    // A releases: idle everywhere
    await release(a);
    await expect.poll(async () => (await pcState(pc)).floor).toBe('idle');
    await expect(a.text).toHaveText('HOLD TO TALK');
    await expect(b.text).toHaveText('HOLD TO TALK');
    // The relay gate closes after its tail
    await expect.poll(() => pc.evaluate((id) => window.pit.relayGains()[id], memA.id), { timeout: 3000 }).toBeLessThan(0.01);

    // ---- relay disabled: B's rate during A's TX stays near idle ----
    await pc.evaluate(() => window.pit.setRelay(false));
    const idleB2 = await phoneRate(b);
    await press(a);
    await expect(a.text).toHaveText('TX');
    await expect(b.text).toHaveText('RX');
    await pc.waitForTimeout(300);
    const offB = await phoneRate(b);
    console.log(`[relay] relay OFF: B idle=${idleB2} while A talks=${offB} (relay on was ${txB})`);
    // Note: after real audio has passed, Opus sometimes codes the silence far more cheaply
    // (~150 B/s instead of ~1.8 kB/s), so "idle" is the larger of the two idle readings.
    expect(offB).toBeLessThan(Math.max(idleB, idleB2) * 1.15);
    expect(offB).toBeLessThan(txB);
    await release(a);
    await expect.poll(async () => (await pcState(pc)).floor).toBe('idle');
    await pc.evaluate(() => window.pit.setRelay(true));

    // ---- the PC talks: both phones show RX ----
    await pc.evaluate(() => window.pit.down());
    await expect.poll(async () => (await pcState(pc)).tx).toBe(true);
    for (const p of [a, b]) {
      await expect(p.text).toHaveText('RX');
      await expect(p.sub).toHaveText('Pit wall talking');
    }
    await pc.evaluate(() => window.pit.up());
    for (const p of [a, b]) await expect(p.text).toHaveText('HOLD TO TALK');

    // ---- a third phone: ROOM FULL ----
    const c = await openPhone(browser, 'phoneC', room);
    phones.push(c);
    await expect(c.text).toHaveText('ROOM FULL', { timeout: 20_000 });
    expect(c.frames.some((f) => f.includes('"code":"room_full"'))).toBe(true);
    // ...and the two phones in the room are undisturbed
    expect((await pcState(pc)).members.filter((m) => m.role === 'phone')).toHaveLength(2);
    await expect(a.text).toHaveText('HOLD TO TALK');
    await expect(b.text).toHaveText('HOLD TO TALK');
  } finally {
    for (const p of phones) await p.context.close();
  }
});

test('a third phone gets in once the PC kicks one (it keeps retrying)', async ({ browser, context }) => {
  test.setTimeout(90_000);
  const room = `e2e_${randomBytes(12).toString('hex')}`;
  const pc = await context.newPage();
  logConsole('pc', pc);
  await pc.goto(`${HARNESS}/pc.html?ws=${encodeURIComponent(WS)}&room=${room}`);
  await expect.poll(async () => (await pcState(pc))?.signaling).toBe('open');
  const phones: Phone[] = [];
  try {
    for (const n of ['phoneA', 'phoneB']) {
      const p = await openPhone(browser, n, room);
      phones.push(p);
      await expect(p.text).toHaveText('HOLD TO TALK', { timeout: 20_000 });
    }
    const c = await openPhone(browser, 'phoneC', room);
    phones.push(c);
    await expect(c.text).toHaveText('ROOM FULL', { timeout: 20_000 });
    const devA = await deviceOf(phones[0]);
    const idA = (await pcState(pc)).members.find((m) => m.device === devA)!.id;
    await pc.evaluate((id) => window.pit.kick(id), idA);
    await expect(phones[0].text).toHaveText('OFFLINE');
    // C retries with backoff and takes the free seat (slot 1)
    await expect(c.text).toHaveText('HOLD TO TALK', { timeout: 30_000 });
    await expect(c.sub).toHaveText('You: Phone 1 · with Phone 2');
    await expect(phones[1].sub).toHaveText('You: Phone 2 · with Phone 1');
  } finally {
    for (const p of phones) await p.context.close();
  }
});
