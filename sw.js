/* =====================================================================
   SAKUMA Manutenção — service worker
   Cache-first nos arquivos do app. Mudar CACHE força a atualização
   sem quebrar o app já aberto: o novo só assume depois que fecha.
   ===================================================================== */

const CACHE = 'sakuma-manutencao-v7';

const ARQUIVOS = [
  './',
  './index.html',
  './manifest.json',
  './css/app.css',
  './js/config.js',
  './js/base.js',
  './js/telas.js',
  './js/os.js',
  './icone.svg',
  './lop-branca.svg',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js'
];

self.addEventListener('install', ev => {
  ev.waitUntil(
    caches.open(CACHE).then(c =>
      // addAll falha inteiro se um arquivo cair; guardo um a um para
      // o app instalar mesmo se o CDN estiver fora naquele instante.
      Promise.all(ARQUIVOS.map(a => c.add(a).catch(e => console.warn('sem cache:', a, e))))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', ev => {
  ev.waitUntil(
    caches.keys()
      .then(nomes => Promise.all(nomes.filter(n => n !== CACHE).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', ev => {
  const url = new URL(ev.request.url);

  // Chamadas ao Supabase nunca vêm do cache: ou vão à rede, ou o app
  // trata como offline e guarda na fila.
  if (url.hostname.endsWith('.supabase.co')) return;
  if (ev.request.method !== 'GET') return;

  ev.respondWith(
    caches.match(ev.request).then(resposta => {
      if (resposta) return resposta;
      return fetch(ev.request).then(r => {
        if (r && r.status === 200 && (url.origin === location.origin || url.hostname === 'cdn.jsdelivr.net')) {
          const copia = r.clone();
          caches.open(CACHE).then(c => c.put(ev.request, copia));
        }
        return r;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
