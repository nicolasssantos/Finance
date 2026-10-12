/* Service worker: o app abre sem internet. Páginas e scripts do próprio app vão primeiro à rede (para pegar versões novas)
   e caem no cache se estiver offline; bibliotecas em /vendor/ ficam no cache. Chamadas ao Firebase e fontes não passam por aqui. */
var V='fin-v1';
var SHELL=['./','index.html','config.js','backend.js','manifest.webmanifest','icon.svg','vendor/xlsx.full.min.js'];

self.addEventListener('install',function(e){
  e.waitUntil(caches.open(V).then(function(c){return c.addAll(SHELL)}).then(function(){return self.skipWaiting()}));
});
self.addEventListener('activate',function(e){
  e.waitUntil(caches.keys().then(function(ks){return Promise.all(ks.filter(function(k){return k!==V}).map(function(k){return caches.delete(k)}))}).then(function(){return self.clients.claim()}));
});
self.addEventListener('fetch',function(e){
  var r=e.request,u=new URL(r.url);
  if(r.method!=='GET'||u.origin!==location.origin)return;
  var store=function(res){if(res&&res.ok){var cp=res.clone();caches.open(V).then(function(c){c.put(r,cp)})}return res};
  if(u.pathname.indexOf('/vendor/')>=0){
    e.respondWith(caches.match(r).then(function(m){return m||fetch(r).then(store)}));
    return;
  }
  e.respondWith(fetch(r).then(store).catch(function(){
    return caches.match(r,{ignoreSearch:true}).then(function(m){return m||caches.match('index.html')});
  }));
});
