/* Minimal service worker.
 *
 * Finns främst för att appen ska gå att installera på hemskärmen. Den cachar bara
 * skalet (HTML/CSS/JS/ikoner) — aldrig jobbdata, eftersom den hämtas med
 * användarens token och inte ska ligga kvar i en cache.
 */
'use strict';

const CACHE = 'jobtracker-shell-v8';
const SHELL = [
  '.',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'icon.svg',
  'icon-maskable.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => { /* installationen ska inte falla på en cachemiss */ })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Rör aldrig API-anrop: de är auktoriserade och får inte cachas.
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) {
    return;
  }

  // Nätet först, cache som reserv — så en ny version syns direkt när du är online.
  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(request).then((hit) => hit || caches.match('index.html')))
  );
});
