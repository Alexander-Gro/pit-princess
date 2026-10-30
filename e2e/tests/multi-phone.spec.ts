// End-to-end: two real phone PWAs + the RadioLink 'pc' harness, over the real server and real
// WebRTC in Chromium with fake mics. Full mesh: each phone links to the PC AND to the other phone,
// so a phone hears the other phone directly (no PC relay any more).
//
// Each phone runs in its OWN browser context: a shared context shares localStorage, which would
// give both phones the same device id (and the second would just replace the first).
import { expect, test } from '@playwright/test';
import {
  connectedPcs,
  deviceOf,
  newRoom,
  openPc,
  openPhone,
  pcState,
  phoneRate,
  press,
  release,
  type Phone,
} from './mesh-helpers.ts';

test('two phones and the PC: full mesh, names, audio between phones, busy, room full', async ({ browser, context }) => {
  test.setTimeout(120_000);
  const room = newRoom();
  const pc = await openPc(context, room);

  const phones: Phone[] = [];
  try {
    // ---- both connect ----
    const a = await openPhone(browser, 'phoneA', room);
    phones.push(a);
    await expect(a.text).toHaveText('TALK', { timeout: 20_000 });
    const b = await openPhone(browser, 'phoneB', room);
    phones.push(b);
    await expect(b.text).toHaveText('TALK', { timeout: 20_000 });
    await expect
      .poll(async () => (await pcState(pc)).peers.filter((p) => p.status === 'connected').length, { timeout: 20_000 })
      .toBe(2);
    await expect.poll(() => pc.evaluate(() => window.pit.remotes.length)).toBe(2);
    // Mesh: each phone has a live link to the PC and one to the other phone
    for (const p of [a, b]) {
      await expect.poll(() => connectedPcs(p), { timeout: 20_000 }).toBe(2);
      await expect(p.link).toHaveText('CONNECTED');
    }

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
    // Every phone has a push id in the roster
    expect(memA.pushId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(memB.pushId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    // Unnamed phones read "Phone 1/2" (v4: the talk tile shows only our own name)
    await expect(a.sub).toHaveText('Phone 1');
    await expect(b.sub).toHaveText('Phone 2');
    // Phones never see device ids
    for (const p of [a, b]) {
      const all = p.frames.join('\n');
      expect(all).not.toContain(devA!);
      expect(all).not.toContain(devB!);
    }

    // ---- names set by the PC show on the phones ----
    await pc.evaluate((n) => window.pit.setNames(n), { pc: 'Pit wall', [memA.id]: 'Emma', [memB.id]: 'Lou' });
    await expect(a.sub).toHaveText('Emma');
    await expect(b.sub).toHaveText('Lou');

    // ---- phone A keys up: PC rx, B shows RX with the talker's name, and A's audio reaches B ----
    await pc.waitForTimeout(500);
    const idleB = await phoneRate(b);
    await press(a);
    await expect(a.text).toHaveText('TX');
    await expect.poll(async () => (await pcState(pc)).rx).toBe(true);
    expect((await pcState(pc)).floor).toBe(memA.id);
    await expect(b.text).toHaveText('RX');
    await expect(b.sub).toHaveText('Emma');
    await expect(a.sub).toHaveText('Emma');
    await pc.waitForTimeout(300);
    const txB = await phoneRate(b);
    const pcFromA0 = await pc.evaluate((id) => window.pit.rxBytes(id), memA.id);
    await pc.waitForTimeout(1000);
    const pcFromA = (await pc.evaluate((id) => window.pit.rxBytes(id), memA.id)) - pcFromA0;
    console.log(`[mesh] B inbound bytes/s (loudest link): idle=${idleB} while A talks=${txB}; PC from A=${pcFromA}/s`);
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
    await expect(a.text).toHaveText('TALK');
    await expect(b.text).toHaveText('TALK');

    // ---- the PC's "phones hear each other" setting reaches both phones in the roster ----
    await pc.evaluate(() => window.pit.setPhonesHear(false));
    for (const p of [a, b]) {
      await expect.poll(() => p.frames.some((f) => f.includes('"t":"roster"') && f.includes('"phonesHear":false'))).toBe(true);
    }
    await expect.poll(async () => (await pcState(pc)).phonesHear).toBe(false);
    await pc.evaluate(() => window.pit.setPhonesHear(true));
    await expect.poll(async () => (await pcState(pc)).phonesHear).toBe(true);

    // ---- the PC talks: both phones show RX, and its audio reaches both ----
    const idleRates = await Promise.all([phoneRate(a), phoneRate(b)]);
    await pc.evaluate(() => window.pit.down());
    await expect.poll(async () => (await pcState(pc)).tx).toBe(true);
    for (const p of [a, b]) {
      await expect(p.text).toHaveText('RX');
      await expect(p.sub).toHaveText('Pit wall');
    }
    await pc.waitForTimeout(300);
    const txRates = await Promise.all([phoneRate(a), phoneRate(b)]);
    console.log(`[mesh] PC talks: A idle=${idleRates[0]} tx=${txRates[0]}; B idle=${idleRates[1]} tx=${txRates[1]}`);
    expect(txRates[0]).toBeGreaterThan(idleRates[0] * 1.2);
    expect(txRates[1]).toBeGreaterThan(idleRates[1] * 1.2);
    await pc.evaluate(() => window.pit.up());
    for (const p of [a, b]) await expect(p.text).toHaveText('TALK');

    // ---- a third phone: ROOM FULL ----
    const c = await openPhone(browser, 'phoneC', room);
    phones.push(c);
    await expect(c.text).toHaveText('ROOM FULL', { timeout: 20_000 });
    expect(c.frames.some((f) => f.includes('"code":"room_full"'))).toBe(true);
    // ...and the two phones in the room are undisturbed
    expect((await pcState(pc)).members.filter((m) => m.role === 'phone')).toHaveLength(2);
    await expect(a.text).toHaveText('TALK');
    await expect(b.text).toHaveText('TALK');
  } finally {
    for (const p of phones) await p.context.close();
  }
});

test('a third phone gets in once the PC kicks one (it keeps retrying)', async ({ browser, context }) => {
  test.setTimeout(90_000);
  const room = newRoom();
  const pc = await openPc(context, room);
  const phones: Phone[] = [];
  try {
    for (const n of ['phoneA', 'phoneB']) {
      const p = await openPhone(browser, n, room);
      phones.push(p);
      await expect(p.text).toHaveText('TALK', { timeout: 20_000 });
    }
    const c = await openPhone(browser, 'phoneC', room);
    phones.push(c);
    await expect(c.text).toHaveText('ROOM FULL', { timeout: 20_000 });
    const devA = await deviceOf(phones[0]);
    const idA = (await pcState(pc)).members.find((m) => m.device === devA)!.id;
    await pc.evaluate((id) => window.pit.kick(id), idA);
    await expect(phones[0].text).toHaveText('OFFLINE');
    // C retries with backoff and takes the free seat (slot 1)
    await expect(c.text).toHaveText('TALK', { timeout: 30_000 });
    await expect(c.sub).toHaveText('Phone 1');
    await expect(phones[1].sub).toHaveText('Phone 2');
    // ...and C links to B directly too
    await expect.poll(() => connectedPcs(c), { timeout: 20_000 }).toBe(2);
  } finally {
    for (const p of phones) await p.context.close();
  }
});
