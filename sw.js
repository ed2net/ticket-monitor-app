// Ticket Monitor mobile: the app itself opens at once from the phone (data lives in IndexedDB, not here).
// Stale-while-revalidate: the saved copy is shown immediately, a newer version is fetched in the background
// and is used from the next start.
const CACHE = 'tm-shell-1.50';
const SHELL = ['./', 'index.html', 'style.css', 'config.js', 'app.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== self.location.origin || /\/(rest|auth|realtime)\/v1\//.test(u.pathname)) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const hit = await cache.match(e.request);
    const net = fetch(e.request, {cache: 'no-cache'}).then(r => { if (r.ok) cache.put(e.request, r.clone()); return r; });
    if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
    try { return await net; }
    catch { return (await cache.match(e.request, {ignoreSearch: true})) || (await cache.match('index.html')) || Response.error(); }
  }));
});

// 1.48: notifications — a new ticket / a cancelled one / given away (sent by the Edge Function «push»)
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = {title: 'Ticket Monitor', body: e.data ? e.data.text() : ''}; }
  const show = self.registration.showNotification(d.title || 'Ticket Monitor', {
    body: d.body || '', tag: d.tag || 'tm', renotify: true, dir: 'rtl', lang: 'he',
    icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', vibrate: d.kind === 'cancel' ? [300, 150, 300, 150, 300] : [200, 100, 200],
    data: {id: d.id || null, kind: d.kind || ''},
  });
  const tell = self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(cs => cs.forEach(c => c.postMessage({push: true, kind: d.kind, id: d.id})));
  e.waitUntil(Promise.all([show, tell]));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const id = (e.notification.data || {}).id;
  e.waitUntil(self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(cs => {
    const c = cs.find(x => x.url.startsWith(self.registration.scope));
    if (c) { if (id) c.postMessage({open: id}); return c.focus(); }
    return self.clients.openWindow(new URL(id ? './?t=' + id : './', self.registration.scope).href);
  }));
});
