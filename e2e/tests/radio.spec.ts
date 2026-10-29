// End-to-end: real phone PWA (phone/dist served by the real server) <-> RadioLink 'pc' harness,
// over real WebSocket signaling and a real WebRTC connection in Chromium with a fake mic.
import { expect, test, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';

const SERVER = `http://localhost:${process.env.E2E_SERVER_PORT}`;
const HARNESS = `http://127.0.0.1:${process.env.E2E_HARNESS_PORT}`;

type PitState = { peer: string; floor: string; tx: boolean; rx: boolean; pending: boolean; signaling: string };
const pcState = (pc: Page) => pc.evaluate(() => window.pit.state as unknown as PitState);

test('phone and PC connect, key up, get busy, and release', async ({ context }) => {
  const room = `e2e_${randomBytes(12).toString('hex')}`; // 28 chars, matches ROOM_CODE_RE
  const pc = await context.newPage();
  const phone = await context.newPage();
  for (const [name, p] of [['pc', pc], ['phone', phone]] as const) {
    p.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') console.log(`[${name} console.${m.type()}] ${m.text()}`);
    });
    p.on('pageerror', (e) => console.log(`[${name} pageerror] ${e}`));
  }

  // Record server->phone frames so we can see 'busy', which has no DOM representation.
  const phoneFrames: string[] = [];
  phone.on('websocket', (ws) => ws.on('framereceived', (f) => phoneFrames.push(String(f.payload))));

  await pc.goto(`${HARNESS}/pc.html?ws=${encodeURIComponent(`ws://localhost:${process.env.E2E_SERVER_PORT}/ws`)}&room=${room}`);
  await expect.poll(() => pc.evaluate(() => window.pit.error ?? window.pit.ready)).toBe(true);
  await expect.poll(async () => (await pcState(pc)).signaling).toBe('open');

  await phone.goto(`${SERVER}/#room=${room}`);
  const pttText = phone.locator('#ptt-text');
  await expect(pttText).toHaveText('TAP TO CONNECT');
  await phone.locator('#ptt').click();

  // Both sides reach a connected WebRTC peer
  await expect.poll(async () => (await pcState(pc)).peer, { timeout: 20_000 }).toBe('connected');
  await expect(pttText).toHaveText('HOLD TO TALK', { timeout: 20_000 });
  await expect(phone.locator('#v-link')).toHaveText('CONNECTED');
  await expect.poll(() => pc.evaluate(() => window.pit.remoteTrack)).toBe(true);

  // --- PC keys up: phone shows RX ---
  await pc.evaluate(() => window.pit.down());
  await expect.poll(async () => (await pcState(pc)).tx).toBe(true);
  await expect(pttText).toHaveText('RX');

  // Phone presses while the PC holds the floor: server answers busy, phone stays on RX
  const box = (await phone.locator('#ptt').boundingBox())!;
  await phone.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await phone.mouse.down();
  await expect.poll(() => phoneFrames.filter((f) => f.includes('"t":"busy"')).length).toBe(1);
  await expect(pttText).toHaveText('RX');
  await phone.mouse.up();

  // PC releases (after the TX tail): back to idle on both sides
  await pc.evaluate(() => window.pit.up());
  await expect.poll(async () => (await pcState(pc)).floor).toBe('idle');
  expect(await pcState(pc)).toMatchObject({ tx: false, rx: false });
  await expect(pttText).toHaveText('HOLD TO TALK');

  // Phone mic track is disabled while idle, so Opus only sends tiny silence frames.
  // (Headless Chromium has no audio output, so audioLevel/totalAudioEnergy stay 0; compare bytes.)
  const energy = () => pc.evaluate(() => window.pit.rxBytes());
  const idle0 = await energy();
  await pc.waitForTimeout(1000);
  const idleDelta = (await energy()) - idle0;

  // --- Phone keys up: PC gets rx=true ---
  await phone.mouse.down();
  await expect(pttText).toHaveText('TX');
  await expect.poll(async () => (await pcState(pc)).rx).toBe(true);
  expect((await pcState(pc)).floor).toBe('phone');
  // ...and the fake mic's tone actually reaches the PC while transmitting (higher bitrate than encoded silence) (much higher bitrate)
  const tx0 = await energy();
  await pc.waitForTimeout(1000);
  const txDelta = (await energy()) - tx0;
  console.log(`[audio] inbound audio bytes/s: idle=${idleDelta} tx=${txDelta}`);
  // Measured locally: idle ~1.8 kB/s (encoded silence, no DTX), TX ~2.5 kB/s (fake-device tone).
  expect(txDelta).toBeGreaterThan(idleDelta * 1.2);

  // PC presses while the phone holds the floor: busy
  const busyBefore = await pc.evaluate(() => window.pit.busyCount);
  await pc.evaluate(() => window.pit.down());
  await expect.poll(() => pc.evaluate(() => window.pit.busyCount)).toBe(busyBefore + 1);
  expect(await pcState(pc)).toMatchObject({ tx: false, pending: false, rx: true });
  await pc.evaluate(() => window.pit.up());

  // Phone releases: idle again
  await phone.mouse.up();
  await expect(pttText).toHaveText('HOLD TO TALK');
  await expect.poll(async () => (await pcState(pc)).floor).toBe('idle');
  expect(await pcState(pc)).toMatchObject({ rx: false, tx: false, peer: 'connected' });
});

async function connectPair(context: import('@playwright/test').BrowserContext) {
  const room = `e2e_${randomBytes(12).toString('hex')}`;
  const pc = await context.newPage();
  const phone = await context.newPage();
  const harnessUrl = `${HARNESS}/pc.html?ws=${encodeURIComponent(`ws://localhost:${process.env.E2E_SERVER_PORT}/ws`)}&room=${room}`;
  await pc.goto(harnessUrl);
  await expect.poll(async () => (await pcState(pc))?.signaling).toBe('open');
  await phone.goto(`${SERVER}/#room=${room}`);
  await phone.locator('#ptt').click();
  await expect.poll(async () => (await pcState(pc)).peer, { timeout: 20_000 }).toBe('connected');
  const pttText = phone.locator('#ptt-text');
  await expect(pttText).toHaveText('HOLD TO TALK', { timeout: 20_000 });
  return { pc, phone, pttText, harnessUrl };
}

test('a tap released before the grant arrives does not leave the floor stuck', async ({ context }) => {
  const { pc, pttText } = await connectPair(context);
  // pttDown + immediate pttUp in the same task: the request is still pending at release time.
  await pc.evaluate(() => {
    window.pit.down();
    window.pit.up(true);
  });
  await expect.poll(async () => (await pcState(pc)).floor).toBe('idle');
  await expect(pttText).toHaveText('HOLD TO TALK');
  expect(await pcState(pc)).toMatchObject({ tx: false, pending: false });
  // and the floor is really free: the phone can key up
  await pttText.hover();
  const phone = pttText.page();
  await phone.mouse.down();
  await expect(pttText).toHaveText('TX');
  await phone.mouse.up();
  await expect(pttText).toHaveText('HOLD TO TALK');
});

test('pttUp(true) ends TX without the tail', async ({ context }) => {
  const { pc, pttText } = await connectPair(context);
  await pc.evaluate(() => window.pit.down());
  await expect(pttText).toHaveText('RX');
  const t = await pc.evaluate(async () => {
    window.pit.up(true);
    return window.pit.state!.tx;
  });
  expect(t).toBe(false);
  await expect(pttText).toHaveText('HOLD TO TALK');
});

test('PC reload re-establishes the call with the waiting phone', async ({ context }) => {
  const { pc, phone, pttText, harnessUrl } = await connectPair(context);
  await pc.goto('about:blank');
  await expect(pttText).not.toHaveText('HOLD TO TALK', { timeout: 10_000 });
  await pc.goto(harnessUrl);
  await expect.poll(async () => (await pcState(pc))?.peer, { timeout: 20_000 }).toBe('connected');
  await expect(pttText).toHaveText('HOLD TO TALK', { timeout: 20_000 });
  await pc.evaluate(() => window.pit.down());
  await expect(pttText).toHaveText('RX');
  await pc.evaluate(() => window.pit.up());
  await expect(pttText).toHaveText('HOLD TO TALK');
  void phone;
});
