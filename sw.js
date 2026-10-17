// All paths follow the registration scope, including GitHub Pages subdirectories.
const CACHE_PREFIX = 'zenith-focus-';
const CACHE_NAME = `${CACHE_PREFIX}v5`;
const scopeUrl = new URL(self.registration.scope);
const assetUrl = path => new URL(path, scopeUrl).href;
const ASSETS_TO_CACHE = [
  './', 'index.html', 'manifest.json', 'icon-192.png', 'icon-512.png',
  'assets/rain.wav', 'assets/forest.wav', 'assets/fire.mp3',
  'assets/cafe.mp3', 'assets/complete.mp3'
].map(assetUrl);

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME)
    .then(cache => cache.addAll(ASSETS_TO_CACHE))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(names => Promise.all(names
    .filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
    .map(name => caches.delete(name))))
    .then(() => self.clients.claim()));
});

// Media elements request byte ranges, even when the complete audio is cached.
async function audioRange(request, cached) {
  const range = request.headers.get('range');
  const match = /^bytes=(\d*)-(\d*)$/.exec(range || '');
  if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416 });
  const buffer = await cached.arrayBuffer();
  const size = buffer.byteLength;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  return new Response(buffer.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': cached.headers.get('content-type') || 'audio/mpeg',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes'
    }
  });
}

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== scopeUrl.origin ||
      !url.pathname.startsWith(scopeUrl.pathname)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request.url);
    if (request.headers.has('range') && cached) return audioRange(request, cached);
    // Keep navigation fresh; immutable local assets are available immediately offline.
    if (cached && request.mode !== 'navigate') return cached;
    try {
      const response = await fetch(request);
      if (response.ok && response.status === 200 && !request.headers.has('range')) {
        await cache.put(request, response.clone());
      }
      return response;
    } catch {
      return cached || (request.mode === 'navigate' && await cache.match(assetUrl('index.html'))) ||
        new Response('Çevrimdışı: kaynak kullanılamıyor.', { status: 503 });
    }
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
