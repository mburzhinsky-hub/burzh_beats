const CACHE='burzh-beats-web-v12';
const CORE=['./','./index.html','./manifest.webmanifest','./icon.svg','./local-player.js?v=3'];

self.addEventListener('install',event=>{
  event.waitUntil(
    caches.open(CACHE)
      .then(cache=>cache.addAll(CORE))
      .then(()=>self.skipWaiting())
  );
});

self.addEventListener('activate',event=>{
  event.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET')return;

  const url=new URL(request.url);
  const isMedia=url.pathname.includes('/media/');
  const isRange=request.headers.has('range');

  // Let Safari handle audio/range requests natively. This is important for
  // seeking, lock-screen playback and background playback on iPhone.
  if(isMedia||isRange)return;

  event.respondWith(
    fetch(request)
      .then(response=>{
        const copy=response.clone();
        caches.open(CACHE).then(cache=>cache.put(request,copy)).catch(()=>{});
        return response;
      })
      .catch(()=>caches.match(request).then(response=>response||caches.match('./index.html')))
  );
});