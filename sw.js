// Ticket Monitor mobile: the app itself opens at once from the phone (data lives in IndexedDB, not here).
// Stale-while-revalidate: the saved copy is shown immediately, a newer version is fetched in the background
// and is used from the next start.
const CACHE = 'tm-shell-1.51';
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

// 1.48: notifications — a new ticket / a cancelled one (sent by the Edge Function «push»)
// 1.51: iPhone gets only the standard options; every push is written down (⚙ shows «התראה אחרונה»)
const APPLE = /iPhone|iPad|iPod|Macintosh/.test(self.navigator.userAgent);
async function diag(rec) {
  try { const c = await caches.open('tm-diag'); await c.put('diag-last-push', new Response(JSON.stringify({at: Date.now(), ...rec}))); } catch {}
}
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = {title: 'Ticket Monitor', body: e.data ? e.data.text() : ''}; }
  const opts = {body: d.body || '', tag: (d.tag || 'tm') + (d.kind ? '-' + d.kind : ''), icon: 'icons/icon-192.png', data: {id: d.id || null, kind: d.kind || ''}};
  if (!APPLE) Object.assign(opts, {renotify: true, dir: 'rtl', lang: 'he', badge: 'icons/icon-192.png',
                                   vibrate: d.kind === 'cancel' ? [300, 150, 300, 150, 300] : [200, 100, 200]});
  const show = self.registration.showNotification(d.title || 'Ticket Monitor', opts)
    .then(() => diag({title: d.title || '', shown: true}))
    .catch(err => diag({title: d.title || '', shown: false, error: String(err && err.message || err)}));
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
