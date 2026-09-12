const CACHE_NAME = 'framecomment-v1'

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((name) => name !== CACHE_NAME)
            .map((name) => caches.delete(name))
        )
      }),
    ])
  )
})

self.addEventListener('push', (event) => {
  if (!event.data) return

  let payload
  try {
    payload = event.data.json()
  } catch {
    payload = {
      title: 'FrameComment',
      body: event.data.text() || 'You have a new notification',
    }
  }

  // 7.8.1: PNG, never SVG — macOS accepts only raster attachments and drops
  // the whole notification otherwise (see src/app/brand/icon-192.png). No
  // default badge: Android draws the badge as a white silhouette, and a
  // coloured logomark there is a blob.
  const options = {
    body: payload.body || 'You have a new notification',
    icon: payload.icon || '/brand/icon-192.png',
    tag: payload.tag || 'default',
    data: payload.data || {},
    vibrate: [100, 50, 100],
    requireInteraction: false,
    silent: false,
    renotify: true,
    actions: payload.actions || [],
  }
  if (payload.badge) options.badge = payload.badge

  // 7.8.1: tell every open page of this origin that a push ARRIVED, before
  // anything is drawn. Settings → Notifications → Browser listens for this, so
  // its test button can say where the chain breaks: accepted by the push
  // service but never received here (the browser's push channel is blocked),
  // or received here but never shown (the operating system hides it). Without
  // this the two failures look identical: nothing happens.
  const title = payload.title || 'FrameComment'
  const announce = self.clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then((clientList) => {
      for (const client of clientList) {
        client.postMessage({
          type: 'fc:push-received',
          title,
          tag: options.tag,
          receivedAt: Date.now(),
        })
      }
    })
    .catch(() => {})

  // If the full option set is ever refused, still show a plain notification —
  // a silent failure here is exactly what makes push "not work" undiagnosably.
  const show = self.registration
    .showNotification(title, options)
    .catch(() => self.registration.showNotification(title, { body: options.body, tag: options.tag }))

  event.waitUntil(Promise.all([announce, show]))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  const data = event.notification.data || {}
  let url = '/admin'

  if (data.url) {
    url = data.url
  } else {
    switch (data.type) {
      case 'CLIENT_COMMENT':
      case 'CLIENT_UPLOAD':
      case 'SHARE_ACCESS':
        if (data.projectId) {
          url = `/admin/projects/${data.projectId}`
        }
        break
      case 'ADMIN_ACCESS':
      case 'SECURITY_ALERT':
        url = '/admin/security'
        break
      default:
        url = '/admin'
    }
  }

  if (event.action === 'dismiss') return

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes('/admin') && 'focus' in client) {
          client.navigate(url)
          return client.focus()
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(url)
      }
    })
  )
})

self.addEventListener('notificationclose', () => {})

self.addEventListener('message', (event) => {
  if (event.origin && event.origin !== self.location.origin) return
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
})

self.addEventListener('fetch', (event) => {
  if (!event.request.url.startsWith(self.location.origin)) return
  if (event.request.url.includes('/api/')) return

  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  )
})
