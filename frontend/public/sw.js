// Service worker de Big Benj Charts : reçoit les alertes de prix envoyées par le serveur,
// même quand l'application est fermée, et les affiche en notification.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch (e) {
    payload = {}
  }
  const data = payload.data || {}
  const note = payload.notification || {}
  const title = data.title || note.title || 'Big Benj Charts'
  const body = data.body || note.body || ''
  const tag = data.tag || 'bbc'
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const front = windows.filter((w) => w.focused)
    if (front.length) {
      // Application au premier plan : elle sonne et affiche l'alerte elle-même.
      front.forEach((w) => w.postMessage({ type: 'bbc-alert', title, body, tag }))
      return
    }
    await self.registration.showNotification(title, {
      body,
      tag,
      renotify: true,
      requireInteraction: true,
      icon: '/icon-192.png',
      badge: '/badge-96.png',
      vibrate: [300, 150, 300, 150, 600],
      data: { url: data.url || '/' },
    })
  })())
})

// Un appui sur la notification ouvre l'application (ou la ramène au premier plan).
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    if (windows.length) return windows[0].focus()
    return self.clients.openWindow(url)
  })())
})
