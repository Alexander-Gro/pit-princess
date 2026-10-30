// End-to-end for v3: rooms that start from a phone, phone <-> phone with the PC off, the PC
// joining and leaving the mesh, triple-press / chip pings, and the notification directory syncing
// between phones over the data channels. Each phone has its OWN browser context.
import { expect, test } from '@playwright/test';
import {
  connectedPcs,
  newRoom,
  openPc,
  openPhone,
  pcState,
  phoneRate,
  press,
  pushIdOf,
  release,
  sentOf,
  totalPcs,
  WS,
  type Phone,
} from './mesh-helpers.ts';

const FAKE_OWNER = 'fakeOwnerAAAAAAAAAAAAA';
const FAKE_SUB = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/e2e-dir-sync-fake',
  keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' },
};
const dirKey = (room: string) => `pit-princess-dir:${room}`;

/** One quick Space tap (keyboard.press is down+up right away, well under 400 ms) */
const tap = (p: Phone) => p.page.keyboard.press('Space');
async function hold(p: Phone, ms: number) {
  await p.page.keyboard.down('Space');
  await p.page.waitForTimeout(ms);
  await p.page.keyboard.up('Space');
}

test('two phones with no PC talk directly; the PC joins the mesh and leaves again without breaking it', async ({ browser, context }) => {
  test.setTimeout(150_000);
  const room = newRoom();
  const phones: Phone[] = [];
  try {
    // ---- phone A creates the room, B joins: PHONE <-> PHONE ----
    const a = await openPhone(browser, 'phoneA', room);
    phones.push(a);
    await expect(a.link).toHaveText('ALONE', { timeout: 20_000 });
    const b = await openPhone(browser, 'phoneB', room);
    phones.push(b);
    for (const p of [a, b]) {
      await expect(p.link).toHaveText('PHONE ↔ PHONE', { timeout: 20_000 });
      await expect(p.text).toHaveText('HOLD TO TALK');
      expect(await connectedPcs(p)).toBe(1);
    }
    await expect(a.sub).toHaveText('You: Phone 1 · with Phone 2 (PC off)');
    // The room really was made by a phone: no no_host anywhere
    expect([...a.frames, ...b.frames].some((f) => f.includes('no_host'))).toBe(false);

    // ---- A talks: B shows RX and A's audio arrives ----
    await a.page.waitForTimeout(500);
    const idleB = await phoneRate(b);
    await press(a);
    await expect(a.text).toHaveText('TX');
    await expect(b.text).toHaveText('RX');
    await b.page.waitForTimeout(300);
    const txB = await phoneRate(b);
    await release(a);
    await expect(b.text).toHaveText('HOLD TO TALK');
    console.log(`[p2p] no PC: B inbound bytes/s idle=${idleB} while A talks=${txB}`);
    expect(txB).toBeGreaterThan(idleB * 1.2);

    // ---- the PC harness joins: everyone linked to everyone ----
    const abBefore = await totalPcs(a);
    const pc = await openPc(context, room);
    await expect
      .poll(async () => (await pcState(pc)).peers.filter((p) => p.status === 'connected').length, { timeout: 20_000 })
      .toBe(2);
    for (const p of [a, b]) {
      await expect(p.link).toHaveText('CONNECTED', { timeout: 20_000 });
      await expect.poll(() => connectedPcs(p), { timeout: 20_000 }).toBe(2);
    }
    // The phone<->phone link was kept (A made exactly one new connection: the one to the PC)
    expect(await totalPcs(a)).toBe(abBefore + 1);

    // A -> B still flows, with the PC in the room
    const idleB2 = await phoneRate(b);
    await press(a);
    await expect(b.text).toHaveText('RX');
    await expect.poll(async () => (await pcState(pc)).rx).toBe(true);
    await b.page.waitForTimeout(300);
    const txB2 = await phoneRate(b);
    await release(a);
    await expect(b.text).toHaveText('HOLD TO TALK');
    console.log(`[p2p] with PC: B idle=${idleB2} while A talks=${txB2}`);
    expect(txB2).toBeGreaterThan(idleB2 * 1.2);

    // PC -> phones
    const idle = await Promise.all([phoneRate(a), phoneRate(b)]);
    await pc.evaluate(() => window.pit.down());
    for (const p of [a, b]) await expect(p.text).toHaveText('RX');
    await a.page.waitForTimeout(300);
    const tx = await Promise.all([phoneRate(a), phoneRate(b)]);
    await pc.evaluate(() => window.pit.up());
    for (const p of [a, b]) await expect(p.text).toHaveText('HOLD TO TALK');
    console.log(`[p2p] PC talks: A idle=${idle[0]} tx=${tx[0]}; B idle=${idle[1]} tx=${tx[1]}`);
    expect(tx[0]).toBeGreaterThan(idle[0] * 1.2);
    expect(tx[1]).toBeGreaterThan(idle[1] * 1.2);

    // ---- the PC leaves: the phones stay linked (same connection) and audio still flows ----
    const totalBefore = await totalPcs(a);
    await pc.close();
    for (const p of [a, b]) {
      await expect(p.link).toHaveText('PHONE ↔ PHONE', { timeout: 20_000 });
      await expect.poll(() => connectedPcs(p)).toBe(1);
      await expect(p.text).toHaveText('HOLD TO TALK');
    }
    expect(await totalPcs(a)).toBe(totalBefore); // no new call was needed
    const idleB3 = await phoneRate(b);
    await press(a);
    await expect(b.text).toHaveText('RX');
    await b.page.waitForTimeout(300);
    const txB3 = await phoneRate(b);
    await release(a);
    console.log(`[p2p] PC gone: B idle=${idleB3} while A talks=${txB3}`);
    expect(txB3).toBeGreaterThan(idleB3 * 1.2);
  } finally {
    for (const p of phones) await p.context.close();
  }
});

test('a phone holding the floor keeps it when the PC leaves', async ({ browser, context }) => {
  test.setTimeout(90_000);
  const room = newRoom();
  const pc = await openPc(context, room);
  const phones: Phone[] = [];
  try {
    for (const n of ['phoneA', 'phoneB']) phones.push(await openPhone(browser, n, room));
    const [a, b] = phones;
    for (const p of phones) await expect.poll(() => connectedPcs(p), { timeout: 20_000 }).toBe(2);
    await press(a);
    await expect(a.text).toHaveText('TX');
    await expect(b.text).toHaveText('RX');
    await pc.close();
    await expect(b.link).toHaveText('PHONE ↔ PHONE', { timeout: 20_000 });
    // Still talking
    await expect(a.text).toHaveText('TX');
    await expect(b.text).toHaveText('RX');
    await release(a);
    await expect(b.text).toHaveText('HOLD TO TALK');
  } finally {
    for (const p of phones) await p.context.close();
  }
});

test('a lone phone shows ALONE; triple-tap pings, a long press or a slow series does not; the chip pings', async ({ browser }) => {
  test.setTimeout(90_000);
  const room = newRoom();
  const phones: Phone[] = [];
  try {
    const a = await openPhone(browser, 'phoneA', room);
    phones.push(a);
    await expect(a.link).toHaveText('ALONE', { timeout: 20_000 });
    await expect(a.text).toHaveText('WAITING');
    const pingChip = a.page.locator('#ping');
    await expect(pingChip).toBeVisible();
    const pings = () => sentOf(a, 'ping').length;

    // A long press: no ping
    await hold(a, 700);
    // Two quick taps then a long one: still no ping (the long press resets the count)
    await tap(a);
    await tap(a);
    await hold(a, 600);
    // Quick taps spread over more than 1.5 s: no ping
    await tap(a);
    await a.page.waitForTimeout(900);
    await tap(a);
    await a.page.waitForTimeout(900);
    await tap(a);
    await a.page.waitForTimeout(500);
    expect(pings()).toBe(0);
    await a.page.waitForTimeout(1600); // let the last taps age out of the window

    // Three quick taps: a ping over the WebSocket, and the reply shows in the footer
    for (let i = 0; i < 3; i++) {
      await tap(a);
      await a.page.waitForTimeout(80);
    }
    await expect.poll(pings).toBe(1);
    expect(sentOf(a, 'ping')[0]).toEqual({ t: 'ping', subs: [] });
    // The e2e server has no VAPID keys
    await expect(a.page.locator('#ping-msg')).toHaveText('Pinging isn’t set up on the server');
    await expect.poll(() => a.frames.some((f) => f.includes('"t":"pinged"') && f.includes('"unavailable":true'))).toBe(true);
    // The quick presses never reached the floor (nobody to talk to)
    expect(sentOf(a, 'floor_request')).toHaveLength(0);

    // A fourth tap right after does not ping again (the count restarted)
    await tap(a);
    await a.page.waitForTimeout(500);
    expect(pings()).toBe(1);

    // The Ping chip
    await a.page.waitForTimeout(1600);
    await pingChip.click();
    await expect.poll(pings).toBe(2);
  } finally {
    for (const p of phones) await p.context.close();
  }
});

test('triple-tap also pings while connected to the other phone (the blips key up briefly)', async ({ browser }) => {
  test.setTimeout(90_000);
  const room = newRoom();
  const phones: Phone[] = [];
  try {
    for (const n of ['phoneA', 'phoneB']) phones.push(await openPhone(browser, n, room));
    const [a, b] = phones;
    for (const p of phones) await expect(p.link).toHaveText('PHONE ↔ PHONE', { timeout: 20_000 });
    for (let i = 0; i < 3; i++) {
      await tap(a);
      await a.page.waitForTimeout(150);
    }
    await expect.poll(() => sentOf(a, 'ping').length).toBe(1);
    // Nothing for B to ping-wise: it got no ping traffic, and both end idle
    expect(sentOf(b, 'ping')).toHaveLength(0);
    await expect(a.text).toHaveText('HOLD TO TALK');
    await expect(b.text).toHaveText('HOLD TO TALK');
  } finally {
    for (const p of phones) await p.context.close();
  }
});

test('PC harness: triple-press pings with the ping chirp while online; offline it sends nothing and plays busy', async ({ context }) => {
  const room = newRoom();
  const pc = await openPc(context, room);
  const triple = () =>
    pc.evaluate(async () => {
      for (let i = 0; i < 3; i++) {
        window.pit.down();
        await new Promise((r) => setTimeout(r, 50));
        window.pit.up(true);
        await new Promise((r) => setTimeout(r, 80));
      }
    });
  await triple();
  await expect.poll(() => pc.evaluate(() => window.pit.pinged.length)).toBe(1);
  expect(await pc.evaluate(() => window.pit.pingSentCount)).toBe(1);
  // A long PC press does not ping
  await pc.evaluate(async () => {
    window.pit.down();
    await new Promise((r) => setTimeout(r, 600));
    window.pit.up(true);
  });
  await pc.waitForTimeout(500);
  expect(await pc.evaluate(() => window.pit.pinged.length)).toBe(1);
  // Offline
  await pc.evaluate(() => window.pit.stop());
  expect(await pc.evaluate(() => window.pit.ping())).toBe(false);
  const busy0 = await pc.evaluate(() => window.pit.busyCount);
  await triple();
  await pc.waitForTimeout(300);
  expect(await pc.evaluate(() => window.pit.pingSentCount)).toBe(1);
  // 3 presses with no server are busy, and the would-be ping is a 4th busy
  expect((await pc.evaluate(() => window.pit.busyCount)) - busy0).toBe(4);
  expect(await pc.evaluate(() => window.pit.pinged.length)).toBe(1);
});

test('the PC making a New code closes the room: phones show it, forget room/key/directory; Pair again asks first', async ({ browser }) => {
  test.setTimeout(90_000);
  const room = newRoom();
  const phones: Phone[] = [];
  // A bare protocol client stands in for the desktop: host the room, then re-host a new code
  const ws = new WebSocket(WS);
  const got: { t: string }[] = [];
  ws.addEventListener('message', (e) => got.push(JSON.parse(String(e.data))));
  try {
    const entry = { owner: FAKE_OWNER, sub: FAKE_SUB, ts: Date.now() - 60_000 };
    const a = await openPhone(browser, 'phoneA', room, { storage: { [dirKey(room)]: JSON.stringify([entry]) } });
    phones.push(a);
    await expect(a.link).toHaveText('ALONE', { timeout: 20_000 });
    if (ws.readyState !== WebSocket.OPEN) await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    ws.send(JSON.stringify({ t: 'host', v: 3, room }));
    await expect.poll(() => got.some((m) => m.t === 'welcome')).toBe(true);
    ws.send(JSON.stringify({ t: 'host', v: 3, room: newRoom() }));
    await expect(a.text).toHaveText('OFFLINE', { timeout: 10_000 });
    await expect(a.sub).toHaveText('Room closed by the PC');
    const stored = () =>
      a.page.evaluate((k) => [localStorage.getItem('pit-princess-room'), localStorage.getItem(k)], dirKey(room));
    await expect.poll(stored).toEqual([null, null]);
    // It does not reconnect on its own
    await a.page.waitForTimeout(1500);
    expect(a.sent.filter((f) => f.includes('"t":"join"'))).toHaveLength(1);

    // "Pair again": dismissing the confirm keeps the page; accepting goes to the pairing screen
    const repair = a.page.locator('#repair');
    await expect(repair).toBeVisible();
    const dialogs: string[] = [];
    a.page.once('dialog', (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    await repair.click();
    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs[0]).toContain('pair again');
    expect(a.page.url()).toContain('#room=');
    a.page.once('dialog', (d) => void d.accept());
    await repair.click();
    await expect.poll(() => a.page.url()).not.toContain('#room=');
  } finally {
    ws.close();
    for (const p of phones) await p.context.close();
  }
});

test('the notification directory syncs between phones, and pings target absent owners', async ({ browser, context }) => {
  test.setTimeout(90_000);
  const room = newRoom();
  const phones: Phone[] = [];
  try {
    // A starts with a directory entry for a phone that isn't here (as if synced earlier)
    const entry = { owner: FAKE_OWNER, sub: FAKE_SUB, ts: Date.now() - 60_000 };
    const a = await openPhone(browser, 'phoneA', room, { storage: { [dirKey(room)]: JSON.stringify([entry]) } });
    phones.push(a);
    await expect(a.link).toHaveText('ALONE', { timeout: 20_000 });
    const b = await openPhone(browser, 'phoneB', room);
    phones.push(b);
    await expect(b.link).toHaveText('PHONE ↔ PHONE', { timeout: 20_000 });

    // B receives A's copy over the data channel and stores it under the same room key
    const bDir = () => b.page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '[]'), dirKey(room));
    await expect.poll(bDir, { timeout: 10_000 }).toContainEqual(entry);

    // B's ping goes to the absent owner's subscription (and not to A, who is here)
    await b.page.locator('#ping').click();
    await expect.poll(() => sentOf(b, 'ping').length).toBe(1);
    expect(sentOf(b, 'ping')[0]).toEqual({ t: 'ping', subs: [FAKE_SUB] });

    // A PC joining later gets the directory too (valid dir messages from the phones)
    const pc = await openPc(context, room);
    await expect
      .poll(() =>
        pc.evaluate((o) => window.pit.data.some((d) => d.valid && JSON.stringify(d.msg).includes(o)), FAKE_OWNER),
        { timeout: 20_000 },
      )
      .toBe(true);
    expect(await pc.evaluate(() => window.pit.data.every((d) => d.valid))).toBe(true);
    // Each phone's own push id is in the roster, distinct from the absent owner
    const members = (await pcState(pc)).members.filter((m) => m.role === 'phone');
    expect(members.map((m) => m.pushId).sort()).toEqual([await pushIdOf(a), await pushIdOf(b)].sort());
    expect(members.map((m) => m.pushId)).not.toContain(FAKE_OWNER);
  } finally {
    for (const p of phones) await p.context.close();
  }
});
