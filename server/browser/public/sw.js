/* Mist Browser service worker: Ultraviolet's, unchanged apart from taking over at once. */
importScripts('uv/uv.bundle.js');
importScripts('uv.config.js');
importScripts(__uv$config.sw);

const uv = new UVServiceWorker();
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  event.respondWith((async () => {
    if (uv.route(event)) return await uv.fetch(event);
    return await fetch(event.request);
  })());
});
