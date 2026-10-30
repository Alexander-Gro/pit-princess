// Resilience: how the 3-way mesh (PC harness + two phones, each phone in its own browser
// context) survives the things that happen on a real track day: a phone losing network, the PC
// going offline, the server restarting (Render free tier), the app being closed/reopened or
// backgrounded, a socket that silently dies on a WiFi <-> cellular switch, and two phones with no
// direct route (carrier NAT, no TURN).
//
// For each, the test measures the time from the network coming back until audio flows in every
// direction of the mesh (each member keys up and every other member's inbound-rtp byte rate must
// clear a threshold calibrated on the healthy mesh), and records what each UI claimed meanwhile.
// Lines tagged [resilience] are the numbers.
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { newRoom, press, release, SERVER, WS } from './mesh-helpers.ts';
import {
  calibrate,
  rate,
  fmt,
  links,
  measureRecovery,
  openPcAt,
  openPhoneAt,
  pcNode,
  phoneNode,
  probe,
  Proxy,
  reopenPhone,
  ServerProc,
  sleep,
  Timeline,
  uiOf,
  waitMesh,
  LAUNCH_ARGS,
  type Node,
  type PhoneAt,
} from './resilience-helpers.ts';

/** How long after the network returns we call it "recovered fast enough" */
const TARGET_MS = 10_000;
const SERVER_PORT = Number(process.env.E2E_SERVER_PORT);
const OWN_SERVER_PORT = SERVER_PORT + 2;
const PROXY_PORT = SERVER_PORT + 3;

interface Mesh {
  room: string;
  a: PhoneAt;
  b: PhoneAt;
  pc: Page;
  A: Node;
  B: Node;
  PC: Node;
  nodes: Node[];
  threshold: number;
}

async function mesh(
  browser: Browser,
  context: BrowserContext,
  o: { aBase?: string; ws?: string; base?: string; aBrowser?: Browser } = {},
): Promise<Mesh> {
  const room = newRoom();
  const base = o.base ?? SERVER;
  const pc = await openPcAt(context, o.ws ?? WS, room);
  const a = await openPhoneAt(o.aBrowser ?? browser, 'phoneA', o.aBase ?? base, room);
  const b = await openPhoneAt(browser, 'phoneB', base, room);
  const [A, B, PC] = [phoneNode(a), phoneNode(b), pcNode(pc)];
  const nodes = [A, B, PC];
  await waitMesh(nodes);
  const threshold = await calibrate(nodes);
  return { room, a, b, pc, A, B, PC, nodes, threshold };
}

const totals = (nodes: Node[]) => Promise.all(nodes.map(async (n) => (await links(n)).total));
const newCalls = (before: number[], after: number[], nodes: Node[]) =>
  nodes.map((n, i) => `${n.name}+${after[i] - before[i]}`).join(' ');

function report(name: string, rec: { ready: number | null; audio: number | null; rounds: number; lastFail: string }, extra = '') {
  console.log(
    `[resilience] ${name}: links+UI ready ${fmt(rec.ready)}, audio all directions ${fmt(rec.audio)}` +
      ` (${rec.rounds} rounds${rec.audio === null ? `, last: ${rec.lastFail}` : ''})${extra ? `; ${extra}` : ''}`,
  );
}

function expectRecovered(rec: { audio: number | null }, within = TARGET_MS) {
  expect.soft(rec.audio, 'audio never came back in every direction').not.toBeNull();
  if (rec.audio !== null) expect.soft(rec.audio, `recovery took ${fmt(rec.audio)}`).toBeLessThan(within);
}

// Offline emulation stalls the whole browser's network service (other contexts' WebSocket frames
// and ICE checks too), so the member that goes offline runs in a browser process of its own.
// There it also loses its UDP, like a phone that really lost signal.
for (const offMs of [10_000, 40_000]) {
  test(`phone loses network for ${offMs / 1000} s (setOffline) and gets it back`, async ({ browser, playwright, context }) => {
    test.setTimeout(200_000);
    const own = await playwright.chromium.launch({ args: LAUNCH_ARGS });
    const m = await mesh(browser, context, { aBrowser: own });
    try {
      const before = await totals(m.nodes);
      const tl = new Timeline(m.nodes).start();
      await m.a.context.setOffline(true);
      await sleep(offMs - 1000);
      const uiDuring = await uiOf(m.A);
      await sleep(offMs - (Date.now() - tl.t0));
      await m.a.context.setOffline(false);
      const t0 = Date.now();
      const rec = await measureRecovery(t0, m.nodes, m.threshold, 75_000, m.A);
      tl.stop();
      tl.print(`phone offline ${offMs / 1000}s`);
      report(
        `phone offline ${offMs / 1000}s`,
        rec,
        `at the end of the outage A showed "${uiDuring}" (claimed linked for ${tl.overclaimed(m.A, 2)}s with links down); new calls ${newCalls(before, await totals(m.nodes), m.nodes)}`,
      );
      expectRecovered(rec);
    } finally {
      await own.close();
      await m.b.context.close();
    }
  });
}

test('PC loses network for 40 s (setOffline) and gets it back', async ({ browser, playwright }) => {
  test.setTimeout(200_000);
  const own = await playwright.chromium.launch({ args: LAUNCH_ARGS });
  const pcContext = await own.newContext({ permissions: ['microphone'] });
  const m = await mesh(browser, pcContext);
  try {
    const before = await totals(m.nodes);
    const tl = new Timeline(m.nodes).start();
    await pcContext.setOffline(true);
    await sleep(39_000);
    const pcUi = await uiOf(m.PC);
    await sleep(40_000 - (Date.now() - tl.t0));
    await pcContext.setOffline(false);
    const t0 = Date.now();
    const rec = await measureRecovery(t0, m.nodes, m.threshold, 75_000, m.PC);
    tl.stop();
    tl.print('pc offline');
    report(
      'PC offline 40s',
      rec,
      `at the end of the outage the PC showed "${pcUi}"; new calls ${newCalls(before, await totals(m.nodes), m.nodes)}`,
    );
    expectRecovered(rec);
  } finally {
    await m.a.context.close();
    await m.b.context.close();
    await own.close();
  }
});

for (const downMs of [5_000, 30_000]) {
  test(`server killed mid-session, back after ${downMs / 1000} s (Render restart / cold start)`, async ({ browser, context }) => {
    test.setTimeout(180_000);
    const server = new ServerProc(OWN_SERVER_PORT);
    await server.start();
    const m = await mesh(browser, context, { base: server.http, ws: server.ws });
    try {
      const before = await totals(m.nodes);
      const tl = new Timeline(m.nodes).start();
      await server.kill();
      await sleep(Math.min(3000, downMs - 1000));
      const linksDuring = await Promise.all(m.nodes.map(async (n) => (await links(n)).connected));
      const talkDuring = await probe(m.A, [m.B], m.threshold);
      await sleep(downMs - (Date.now() - tl.t0));
      await server.start();
      const t0 = Date.now();
      const rec = await measureRecovery(t0, m.nodes, m.threshold, 75_000);
      tl.stop();
      tl.print(`server down ${downMs / 1000}s`);
      report(
        `server down ${downMs / 1000}s`,
        rec,
        `during outage links still connected ${linksDuring.join('/')} but A->B talk ${talkDuring.ok ? 'worked' : `blocked (${talkDuring.why})`}; new calls after restart ${newCalls(before, await totals(m.nodes), m.nodes)}`,
      );
      expectRecovered(rec);
    } finally {
      await m.a.context.close();
      await m.b.context.close();
      await server.kill();
    }
  });
}

test('phone app closed and reopened', async ({ browser, context }) => {
  test.setTimeout(150_000);
  const m = await mesh(browser, context);
  try {
    const tl = new Timeline(m.nodes).start();
    const tClose = Date.now();
    await m.a.page.close();
    // How long until the others see A gone
    await expect.poll(async () => (await uiOf(m.PC)).endsWith(' 1/1'), { timeout: 40_000 }).toBe(true);
    const noticed = Date.now() - tClose;
    await sleep(Math.max(0, 3000 - noticed));
    await reopenPhone(m.a);
    const t0 = Date.now();
    const rec = await measureRecovery(t0, m.nodes, m.threshold, 60_000, m.A);
    tl.stop();
    tl.print('reopen');
    report('phone closed + reopened', rec, `PC saw A leave after ${fmt(noticed)}`);
    expectRecovered(rec);
  } finally {
    await m.a.context.close();
    await m.b.context.close();
  }
});

test('phone navigates away for 5 s and comes back', async ({ browser, context }) => {
  test.setTimeout(150_000);
  const m = await mesh(browser, context);
  try {
    const tl = new Timeline(m.nodes).start();
    await m.a.page.goto('about:blank');
    await sleep(5000);
    await m.a.page.goto(`${m.a.base}/#room=${m.room}`);
    await m.a.page.locator('#ptt').click();
    const t0 = Date.now();
    const rec = await measureRecovery(t0, m.nodes, m.threshold, 60_000, m.A);
    tl.stop();
    tl.print('navigate');
    report('phone navigated away 5s', rec);
    expectRecovered(rec);
  } finally {
    await m.a.context.close();
    await m.b.context.close();
  }
});

test('phone hidden for 15 s (visibilitychange), then visible again', async ({ browser, context }) => {
  test.setTimeout(150_000);
  const m = await mesh(browser, context);
  try {
    const before = await totals(m.nodes);
    const tl = new Timeline(m.nodes).start();
    await m.a.page.evaluate(() => (window as unknown as { __setHidden: (h: boolean) => void }).__setHidden(true));
    await sleep(5000);
    // Chromium keeps running a hidden page, so this checks only the app's own reaction to hiding
    const during = await probe(m.B, [m.A], m.threshold);
    await sleep(15_000 - (Date.now() - tl.t0));
    await m.a.page.evaluate(() => (window as unknown as { __setHidden: (h: boolean) => void }).__setHidden(false));
    const t0 = Date.now();
    const rec = await measureRecovery(t0, m.nodes, m.threshold, 60_000, m.A);
    tl.stop();
    tl.print('hidden');
    report('phone hidden 15s', rec, `B->A while hidden ${during.ok ? 'flowing' : `dead (${during.why})`}; new calls ${newCalls(before, await totals(m.nodes), m.nodes)}`);
    expectRecovered(rec, 3000);
  } finally {
    await m.a.context.close();
    await m.b.context.close();
  }
});

// Headless Chromium accepts the CDP freeze but keeps running the page's timers, so this is "hidden
// + silent socket" rather than a true iOS suspension; the test logs how many 1 s ticks ran.
test('iOS-like suspension: phone page frozen 40 s with its socket gone silent', async ({ browser, context }) => {
  test.setTimeout(200_000);
  const proxy = new Proxy(PROXY_PORT, SERVER_PORT);
  await proxy.listen();
  const m = await mesh(browser, context, { aBase: proxy.http });
  try {
    const tl = new Timeline(m.nodes).start();
    const cdp = await m.a.context.newCDPSession(m.a.page);
    await m.a.page.evaluate(() => (window as unknown as { __setHidden: (h: boolean) => void }).__setHidden(true));
    await m.a.page.evaluate(() => {
      const w = window as unknown as { __ticks: number };
      w.__ticks = 0;
      setInterval(() => w.__ticks++, 1000);
    });
    let frozen = true;
    try {
      await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
    } catch (e) {
      frozen = false;
      console.log(`[resilience] could not freeze the page (${String(e).split('\n')[0]}); JS keeps running`);
    }
    // A suspended iOS app answers nothing, not even the server's WebSocket pings
    const silenced = proxy.silenceExisting();
    await sleep(40_000);
    if (frozen) await cdp.send('Page.setWebLifecycleState', { state: 'active' });
    const ticks = await m.a.page.evaluate(() => (window as unknown as { __ticks: number }).__ticks);
    await m.a.page.evaluate(() => (window as unknown as { __setHidden: (h: boolean) => void }).__setHidden(false));
    const t0 = Date.now();
    const rec = await measureRecovery(t0, m.nodes, m.threshold, 70_000, m.A);
    tl.stop();
    tl.print('suspend');
    report('phone suspended 40s', rec, `CDP freeze ${frozen ? 'accepted' : 'refused'}, page timers ticked ${ticks}x in 40s (${ticks > 5 ? 'NOT really frozen' : 'frozen'}), silenced ${silenced} sockets`);
    expectRecovered(rec, 30_000);
  } finally {
    await m.a.context.close();
    await m.b.context.close();
    await proxy.close();
  }
});

test('WiFi <-> cellular switch: the phone socket silently dies (half-open), the page keeps running', async ({ browser, context }) => {
  test.setTimeout(200_000);
  const proxy = new Proxy(PROXY_PORT, SERVER_PORT);
  await proxy.listen();
  const m = await mesh(browser, context, { aBase: proxy.http });
  try {
    const tl = new Timeline(m.nodes).start();
    const t0 = Date.now();
    const silenced = proxy.silenceExisting(); // new connections still work: the new network is up
    // When does the server notice? (the PC loses A from its roster)
    const pcSawGone = expect
      .poll(async () => (await uiOf(m.PC)).endsWith(' 1/1'), { timeout: 60_000, intervals: [250] })
      .toBe(true)
      .then(() => Date.now() - t0)
      .catch(() => null);
    const rec = await measureRecovery(t0, m.nodes, m.threshold, 80_000, m.A);
    tl.stop();
    tl.print('half-open');
    report(
      'socket silently dead',
      rec,
      `silenced ${silenced} sockets; PC dropped A after ${fmt(await pcSawGone)}; A's UI claimed linked while a link was down for ${tl.overclaimed(m.A, 2)}s`,
    );
    expectRecovered(rec, 35_000);
  } finally {
    await m.a.context.close();
    await m.b.context.close();
    await proxy.close();
  }
});

test('PC harness stop, 5 s, start', async ({ browser, context }) => {
  test.setTimeout(150_000);
  const m = await mesh(browser, context);
  try {
    const before = await totals(m.nodes);
    const tl = new Timeline(m.nodes).start();
    await m.pc.evaluate(() => window.pit.stop());
    // The phones drop their PC link and keep the one between them (whatever the tile calls that)
    for (const n of [m.A, m.B]) await expect.poll(async () => (await links(n)).connected, { timeout: 20_000 }).toBe(1);
    const pcOffUi = await uiOf(m.A);
    const phonesWhilePcOff = await probe(m.A, [m.B], m.threshold);
    await sleep(5000 - (Date.now() - tl.t0));
    await m.pc.evaluate(() => window.pit.start());
    const t0 = Date.now();
    const rec = await measureRecovery(t0, m.nodes, m.threshold, 60_000, m.PC);
    tl.stop();
    tl.print('pc restart');
    report(
      'PC stop/start',
      rec,
      `PC off: A showed "${pcOffUi}", phone<->phone ${phonesWhilePcOff.ok ? 'ok' : phonesWhilePcOff.why}; new calls ${newCalls(before, await totals(m.nodes), m.nodes)}`,
    );
    expectRecovered(rec);
  } finally {
    await m.a.context.close();
    await m.b.context.close();
  }
});

test('no direct route between the phones (carrier NAT, no TURN): what the UI says', async ({ browser, context }) => {
  test.setTimeout(150_000);
  const room = newRoom();
  const pc = await openPcAt(context, WS, room);
  const a = await openPhoneAt(browser, 'phoneA', SERVER, room, undefined, { noPhoneRoute: true });
  const b = await openPhoneAt(browser, 'phoneB', SERVER, room, undefined, { noPhoneRoute: true });
  const [A, B, PC] = [phoneNode(a), phoneNode(b), pcNode(pc)];
  try {
    // The PC reaches both phones fine
    await expect.poll(async () => (await uiOf(PC)).startsWith('open/connected') && (await uiOf(PC)).endsWith(' 2/2'), { timeout: 25_000 }).toBe(true);
    const threshold = await calibrate([PC, A]);
    const tl = new Timeline([A, B, PC]).start();
    await sleep(45_000);
    // A keys up: B's screen says A is talking, but does any audio arrive?
    await press(a);
    await sleep(800);
    const bUi = await uiOf(B);
    const bRate = await rate(B, 1000);
    const pcRate = await rate(PC, 1000);
    await release(a);
    const aToB = { ok: bRate >= threshold, why: bRate >= threshold ? '' : 'B silent', rates: [bRate, pcRate] };
    const bShowedRx = bUi.includes('RX');
    tl.stop();
    tl.print('no route');
    const pcsA = await a.page.evaluate(() => (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.map((c) => c.connectionState));
    console.log(
      `[resilience] no phone<->phone route: A's links ${pcsA.join(',')}; A->B audio ${aToB.ok ? 'ok' : aToB.why}` +
        ` (rates ${aToB.rates.join(',')}); A showed linked with a dead link for ${tl.overclaimed(A, 2)}s, B for ${tl.overclaimed(B, 2)}s of 45s; B RX cue ${bShowedRx}`,
    );
    // A dead mesh link must not read as "CONNECTED"
    expect.soft(tl.overclaimed(A, 2), 'phone A UI claimed a full mesh while A<->B was down').toBe(0);
    expect.soft(tl.overclaimed(B, 2), 'phone B UI claimed a full mesh while A<->B was down').toBe(0);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});
