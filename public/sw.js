const CACHE = 'photo-keeper-v1';
const SHELL = ['/', '/manifest.json', '/icon-192.png', '/icon-512.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  // 認証・API・写真ファイルはキャッシュしない
  if (e.request.method !== 'GET' || u.pathname.startsWith('/api') || u.pathname.startsWith('/auth') || u.pathname.startsWith('/files')) return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
