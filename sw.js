// Ticket Monitor mobile: the app itself opens at once from the phone (data lives in IndexedDB, not here).
// Stale-while-revalidate: the saved copy is shown immediately, a newer version is fetched in the background
// and is used from the next start.
const CACHE = 'tm-shell-1.31';
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
