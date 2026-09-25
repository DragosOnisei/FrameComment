const CACHE_NAME = 'framecomment-v1'

// 7.16.2: macOS, by user agent — the worker has no other way to know. Every
// browser on a Mac still reports "Macintosh"/"Mac OS X" (Chrome's reduced
// user agent keeps the platform), which is the only fact the rule below
// needs. An iPad in desktop mode also says Macintosh; it ignores
// requireInteraction anyway, so being included costs nothing.
const IS_MAC = /Macintosh|Mac OS X/.test((self.navigator && self.navigator.userAgent) || '')

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
    // 7.8.4: persistent. A banner that slides away after five seconds is
    // missed by anyone not looking at the screen at that moment; a review
    // note deserves to wait until it is read. Chrome on macOS delivers a
    // requireInteraction notification through its "alerts" helper, which
    // stays until clicked or dismissed regardless of the Banners/Alerts
    // style chosen for Chrome. The payload can opt out per notification.
    //
    // 7.16.2: except on a Mac, where that helper is exactly what loses the
    // click. Measured on Dragos's own machine on 2026-09-25 with the Settings
    // test's click step: the alert that stays on screen was clicked and no
    // `notificationclick` ever reached this worker; the same test sent as a
    // banner arrived on the first click (Chromium 370536109 / 375640809 —
    // macOS 15 and later). A notification that stays but cannot be opened is
    // worse than one that slides into Notification Center and can, so on
    // macOS every notification is a banner. The one exception is the
    // Settings test's persistent variant, kept so the day Chrome fixes this
    // can be seen from that page rather than guessed.
    requireInteraction:
      payload.requireInteraction !== false &&
      !(IS_MAC && !(payload.data && payload.data.type === 'TEST')),
    silent: false,
    renotify: true,
    actions: payload.actions || [],
    // Shown by Chrome as the notification's time; the server stamps it.
    timestamp: typeof payload.timestamp === 'number' ? payload.timestamp : Date.now(),
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

/**
 * 7.16.1: where a click on a notification goes.
 *
 * Every push carries `data.url`. The client-comment broadcast used to carry
 * the e-mail link, `/login?returnUrl=<the comment>`, and the login page does
 * not forward a session that is already live — so clicking "New comment on
 * …" on a Mac opened the sign-in form, not the comment. The server now sends
 * the direct link; notifications already sitting in Notification Center still
 * hold the old one, so a same-origin /login link is unwrapped here to its
 * returnUrl (same rule as the login page: a path, not `//host` or `/\host`).
 * Same-origin links are reduced to path + query so they can be handed to the
 * app's router.
 */
function resolveClickUrl(data) {
  let url = '/admin'
  if (data && data.url) {
    url = data.url
  } else {
    switch (data && data.type) {
      case 'CLIENT_COMMENT':
      case 'CLIENT_UPLOAD':
      case 'SHARE_ACCESS':
        if (data.projectId) url = `/admin/projects/${data.projectId}`
        break
      case 'ADMIN_ACCESS':
      case 'SECURITY_ALERT':
        url = '/admin/security'
        break
      default:
        url = '/admin'
    }
  }
  try {
    const u = new URL(url, self.location.origin)
    if (u.origin !== self.location.origin) return u.href
    if (u.pathname === '/login') {
      const ret = u.searchParams.get('returnUrl')
      if (ret && /^\/(?![/\\])/.test(ret)) return ret
    }
    return u.pathname + u.search + u.hash
  } catch {
    return '/admin'
  }
}

/**
 * Ask an open FrameComment tab to go there itself, the way a click on a bell
 * row does: a client-side navigation plus a `comment:focus` event, so the
 * player lands on the comment and pulses it (ServiceWorkerProvider listens).
 * `client.navigate()` would reload the whole app instead, and it throws for a
 * tab this worker does not control. Resolves true only when the page answered
 * that it handled it; a tab with no listener (an old build, a page mid-load)
 * answers nothing and the caller falls back.
 */
function askPageToOpen(client, url, data) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), 800)
    try {
      const channel = new MessageChannel()
      channel.port1.onmessage = (e) => {
        clearTimeout(timer)
        finish(!!(e.data && e.data.ok))
      }
      client.postMessage(
        { type: 'fc:open-url', url, notificationId: (data && data.notificationId) || null },
        [channel.port2],
      )
    } catch {
      clearTimeout(timer)
      finish(false)
    }
  })
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  if (event.action === 'dismiss') return

  const data = event.notification.data || {}
  const url = resolveClickUrl(data)
  const inApp = url.startsWith('/')

  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      // 7.16.2: say that a click ARRIVED, to every open page, before doing
      // anything with it. Chrome on macOS 15 and later often drops clicks on
      // notifications between the system and the browser (Chromium issues
      // 370536109, 375640809) — Chrome comes to the front and this handler
      // never runs. From the outside that looks exactly like a handler that
      // runs and fails, so Settings → Notifications listens for this and its
      // test can say which of the two happened.
      for (const c of all) {
        try {
          c.postMessage({
            type: 'fc:notification-clicked',
            tag: event.notification.tag || null,
            dataType: data.type || null,
            at: Date.now(),
          })
        } catch {
          /* a closing tab — nothing to tell */
        }
      }
      // The test notification exists to be clicked from the Settings page, so
      // its click brings the browser forward and stays put: navigating would
      // take the page that is reporting the result away from under it.
      if (data.type === 'TEST') {
        const own = all.find((c) => {
          try {
            return new URL(c.url).origin === self.location.origin
          } catch {
            return false
          }
        })
        if (own) {
          try {
            await own.focus()
          } catch {
            /* best-effort */
          }
        }
        return
      }
      // The tab the person is looking at first, then any visible one, then an
      // admin page, then anything of ours. The old handler took the first
      // "/admin" tab in whatever order the browser listed them — often a
      // background tab in another window.
      const rank = (c) =>
        c.focused ? 0 : c.visibilityState === 'visible' ? 1 : c.url.includes('/admin') ? 2 : 3
      const ours = inApp
        ? all
            .filter((c) => {
              try {
                return new URL(c.url).origin === self.location.origin
              } catch {
                return false
              }
            })
            .sort((a, b) => rank(a) - rank(b))
        : []
      const target = ours[0]
      if (target) {
        try {
          await target.focus()
        } catch {
          /* focus is best-effort; the navigation below still happens */
        }
        if (await askPageToOpen(target, url, data)) return
        try {
          if ('navigate' in target) {
            const navigated = await target.navigate(url)
            if (navigated) return
          }
        } catch {
          /* not controlled by this worker — open a window instead */
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(url)
    })(),
  )
})

self.addEventListener('notificationclose', () => {})

self.addEventListener('message', (event) => {
  if (event.origin && event.origin !== self.location.origin) return
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
})

// 7.10.1: no `fetch` handler. This worker exists for push notifications;
// the handler that used to sit here routed every same-origin request except
// /api/ through the worker only to `fetch()` it unchanged, with a fallback to
// a cache nothing ever wrote to — so on a network failure it answered with
// `undefined`, which the page sees as a failed request. That is pure overhead
// on every page, chunk and image, and on iOS Safari, which stops workers
// aggressively, a request in flight through one is a way for a load to fail
// that has nothing to do with the server. Requests now go straight to the
// network as they would with no worker at all.
