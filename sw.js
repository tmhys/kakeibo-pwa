/**
 * 以前の版はここでアプリ本体をキャッシュ優先で返していたため、
 * 更新を公開しても端末に届かないことがあった。PWAとしてのオフライン起動は
 * やめたので、この Service Worker は自分自身とキャッシュを消して退場するだけ。
 * （すでに入っている端末に「消す版」を配るためにファイルは残しておく）
 */
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach((c) => c.navigate(c.url));
  })());
});
