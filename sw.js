/* ============================================================
   Service Worker — caches the AI model permanently
   ============================================================ */

var CACHE = 'bgremover-v1';
var MODEL_HOSTS = [
  'staticimgly.com',
  'cdn.jsdelivr.net',
  'esm.sh',
  'unpkg.com'
];

self.addEventListener('install', function(e){
  self.skipWaiting();
});

self.addEventListener('activate', function(e){
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function(e){
  var url;
  try { url = new URL(e.request.url); } catch (err) { return; }

  var isModel = MODEL_HOSTS.some(function(h){
    return url.hostname.indexOf(h) > -1;
  });

  if (isModel) {
    // Cache-first: model files download once, then load from disk forever
    e.respondWith(
      caches.open(CACHE).then(function(cache){
        return cache.match(e.request).then(function(cached){
          if (cached) return cached;
          return fetch(e.request).then(function(res){
            if (res && res.ok) cache.put(e.request, res.clone());
            return res;
          });
        });
      })
    );
  } else {
    // Network-first for everything else
    e.respondWith(
      fetch(e.request).catch(function(){
        return caches.match(e.request);
      })
    );
  }
});