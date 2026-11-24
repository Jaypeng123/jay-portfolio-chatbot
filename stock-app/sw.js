// Service Worker：離線快取 App 外殼、顯示通知、處理 Web Push
const CACHE = 'twstock-v1';
const SHELL = ['./', 'index.html', 'styles.css', 'js/app.js', 'js/store.js', 'js/data.js', 'js/calc.js',
  'js/indicators.js', 'js/alerts.js', 'js/importer.js', 'icon.svg', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// App 外殼：網路優先、失敗時用快取；API 資料不快取
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request).then((r) => r || caches.match('index.html')))
  );
});

// 伺服器推播（若日後接上 Web Push 服務）
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch (_) { d = { title: '台股提醒', body: e.data?.text() || '' }; }
  e.waitUntil(self.registration.showNotification(d.title || '台股提醒', { body: d.body, icon: 'icon.svg', data: { code: d.code } }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const code = e.notification.data?.code;
  const target = code && /^\w{4,6}$/.test(code) ? `./#stock/${code}` : './';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { c.focus(); if (code) c.postMessage({ code }); return; }
    return self.clients.openWindow(target);
  }));
});
