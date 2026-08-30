/* MBL HSE Dashboard — offline support service worker
 *
 * Strategy
 *  - /api/*            : network-only (never serve stale published data)
 *  - navigations/HTML  : network-first, fall back to cache when offline
 *  - same-origin static: stale-while-revalidate
 *  - cross-origin CDN  : runtime cache only after a real successful fetch
 *                        (never precached, so a CDN hiccup cannot break install)
 */
const CACHE = 'mbl-hse-v14';

/* Only local, guaranteed-present files are precached. Precaching opaque
   cross-origin CDN responses used to poison the cache with broken entries. */
const PRECACHE = [
  '/',
  '/index.html',
  '/logo.png',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', function(event){
  event.waitUntil(
    caches.open(CACHE).then(function(cache){
      // Add individually so one missing file cannot abort the whole install
      return Promise.all(PRECACHE.map(function(u){
        return cache.add(new Request(u, { cache: 'reload' })).catch(function(){});
      }));
    }).then(function(){ return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(event){
  event.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){ return k !== CACHE; })
        .map(function(k){ return caches.delete(k); }));
    }).then(function(){ return self.clients.claim(); })
  );
});

// Allow the page to trigger an immediate update
self.addEventListener('message', function(event){
  if(event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function putInCache(req, res){
  if(!res || res.status !== 200 || res.type === 'opaque') return;
  var clone = res.clone();
  caches.open(CACHE).then(function(cache){ cache.put(req, clone); }).catch(function(){});
}

self.addEventListener('fetch', function(event){
  var req = event.request;
  if(req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch(e){ return; }
  if(url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // 1) API — always live. Published data must never come from cache.
  if(url.origin === self.location.origin && url.pathname.indexOf('/api/') === 0){
    event.respondWith(
      fetch(req, { cache: 'no-store' }).catch(function(){
        return new Response(JSON.stringify({ ok: false, error: 'offline' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  var isNavigation = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').indexOf('text/html') !== -1;

  // 2) HTML / navigations — network-first so a new deploy is picked up at once.
  if(isNavigation && url.origin === self.location.origin){
    event.respondWith(
      fetch(req).then(function(res){
        putInCache(req, res);
        return res;
      }).catch(function(){
        return caches.match(req).then(function(c){
          return c || caches.match('/index.html') || caches.match('/');
        });
      })
    );
    return;
  }

  // 3) Everything else — stale-while-revalidate.
  event.respondWith(
    caches.match(req).then(function(cached){
      var network = fetch(req).then(function(res){
        putInCache(req, res);
        return res;
      }).catch(function(){ return cached; });
      return cached || network;
    })
  );
});
