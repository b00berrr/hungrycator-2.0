// =====================================================================
//  sw.js: „pracownik w tle” odbiera powiadomienia,
//  nawet gdy aplikacja jest zamknięta.
// =====================================================================
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Przyszło powiadomienie
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Hungrycator', {
      body: data.body || '',
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      tag: data.tag,
      data: { url: data.url || '#/' },
    })
  );
});

// Ktoś stuknął w powiadomienie: otwórz aplikację na właściwym ekranie
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const hash = (event.notification.data && event.notification.data.url) || '#/';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('focus' in client) {
        client.postMessage({ type: 'open', hash });
        return client.focus();
      }
    }
    return self.clients.openWindow(new URL(hash, self.registration.scope).href);
  })());
});
