// Pit Princess service worker: shows "PC is online" push notifications and opens the app on tap.
// Deliberately no offline caching: the app needs the server to do anything useful.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Pit Princess', {
      body: data.body || 'The PC is online.',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      // Replace an older "PC online" notification instead of stacking them
      tag: data.tag || 'pc-online',
      renotify: true,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const w of wins) {
        if ('focus' in w) return w.focus();
      }
      return self.clients.openWindow('/');
    })(),
  );
});
