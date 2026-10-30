// "Notify me when the PC is online": Web Push for the phone.
//
// The phone subscribes once (iOS only allows this in a home-screen app, from a tap) and hands
// the subscription to the PC over the data channel. The PC keeps it and, when it comes online,
// asks the server to send the notification. The server stores nothing.

import type { PhoneToPcMsg, PushSub, RadioLink } from '@pit/shared';

let vapidKey: string | null = null;
let registration: ServiceWorkerRegistration | null = null;
let chip: HTMLButtonElement | null = null;
let getLink: () => RadioLink | null = () => null;

// Register the service worker early so it's active by the time the user taps the chip
const ready: Promise<void> = (async () => {
  if (!('serviceWorker' in navigator)) return;
  try {
    registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    const info = (await (await fetch('/api/info', { cache: 'no-store' })).json()) as { vapidPublicKey?: string | null };
    vapidKey = info.vapidPublicKey ?? null;
  } catch (e) {
    console.warn('[push] unavailable', e);
  }
})();

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function supported(): boolean {
  return !!registration && !!vapidKey && 'PushManager' in window && 'Notification' in window;
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toPushSub(sub: PushSubscription): PushSub | null {
  const j = sub.toJSON();
  if (!j.endpoint || !j.keys?.p256dh || !j.keys?.auth) return null;
  return { endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth } };
}

function send(msg: PhoneToPcMsg): boolean {
  return getLink()?.sendData(msg) ?? false;
}

async function currentSub(): Promise<PushSubscription | null> {
  return registration ? registration.pushManager.getSubscription() : null;
}

/** False when the subscription was made with an older server key (keys were regenerated). */
function keyMatches(sub: PushSubscription): boolean {
  const k = sub.options?.applicationServerKey;
  if (!k || !vapidKey) return true;
  const a = new Uint8Array(k);
  const b = b64urlToBytes(vapidKey);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Our subscription if it still works with this server; a stale one is dropped (and the PC told). */
async function usableSub(): Promise<PushSubscription | null> {
  const sub = await currentSub().catch(() => null);
  if (!sub || keyMatches(sub)) return sub;
  send({ t: 'push_unsub', endpoint: sub.endpoint });
  await sub.unsubscribe().catch(() => {});
  return null;
}

async function render(): Promise<void> {
  if (!chip) return;
  await ready;
  // iOS only offers Web Push to apps added to the home screen
  if (!supported() || (isIos() && !isStandalone())) {
    chip.hidden = true;
    return;
  }
  chip.hidden = false;
  if (Notification.permission === 'denied') chip.textContent = 'Notifications blocked in Settings';
  else chip.textContent = (await usableSub()) ? 'PC alerts: on ✓' : 'Notify me when PC is online';
}

/** Send our existing subscription (if any) to the PC. Safe to call on every connection. */
export async function sendSubscriptionToPc(link: RadioLink | null): Promise<void> {
  await ready;
  const sub = await usableSub();
  const ps = sub && toPushSub(sub);
  if (ps && Notification.permission === 'granted') link?.sendData({ t: 'push_sub', sub: ps } satisfies PhoneToPcMsg);
  void render();
}

/** Called synchronously from the tap. */
function toggle(): Promise<void> {
  if (!chip || !registration || !vapidKey) return Promise.resolve();
  if (Notification.permission === 'default') {
    // Ask before any other await: iOS only shows the prompt while the tap still counts as a gesture
    return Notification.requestPermission().then((perm) => (perm === 'granted' ? subscribe() : render()));
  }
  if (Notification.permission === 'denied') return render();
  return (async () => {
    const existing = await usableSub();
    if (!existing) return subscribe();
    if (!confirm('Stop notifications when the PC comes online?')) return;
    send({ t: 'push_unsub', endpoint: existing.endpoint });
    await existing.unsubscribe().catch(() => {});
    await render();
  })();
}

async function subscribe(): Promise<void> {
  if (!chip || !registration || !vapidKey) return;
  await usableSub(); // clears a subscription made with an old key, which would block a new one
  const sub = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: b64urlToBytes(vapidKey),
  });
  const ps = toPushSub(sub);
  if (ps && !send({ t: 'push_sub', sub: ps })) {
    chip.textContent = 'Saved. Connect to the PC once to finish';
    return;
  }
  await render();
}

export function initPush(linkGetter: () => RadioLink | null, el: HTMLButtonElement): void {
  getLink = linkGetter;
  chip = el;
  el.addEventListener('click', () => {
    void toggle().catch((e) => {
      el.textContent = 'Could not turn on notifications';
      console.warn('[push] subscribe failed', e);
    });
  });
  void render();
}
