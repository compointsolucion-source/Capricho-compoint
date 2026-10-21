// Service worker: permite instalar Capricho como app en Windows/Android.
// Los datos NO se guardan: todo se consulta en línea para que la información siempre sea la real.
// Solo se guardan en el equipo los archivos pesados que nunca cambian (reconocimiento
// facial), para que la cámara abra al instante a partir de la segunda vez.
const CACHE_FIJOS = 'capricho-fijos-v1';
const FIJOS = /\/(modelos\/[^/]+|js\/vendor\/(face-api\.min|jsQR|qrcode-generator)\.js)$/;
const SIN_RED = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Sin conexión</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0c0a;color:#f4f7f5;font-family:Segoe UI,Arial,sans-serif;text-align:center;padding:24px}a{display:inline-block;margin-top:16px;padding:12px 20px;background:#5df76a;color:#06210c;font-weight:700;border-radius:8px;text-decoration:none}p{color:#9aa79f}</style></head>
<body><div><h2>Sin conexión</h2><p>Revisa tu internet e intenta de nuevo.</p><a href="javascript:location.reload()">Reintentar</a></div></body></html>`;
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE_FIJOS) await caches.delete(k);
  await self.clients.claim();
})()));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'GET' && url.origin === location.origin && FIJOS.test(url.pathname)) {
    e.respondWith(caches.open(CACHE_FIJOS).then(async (c) => {
      const guardado = await c.match(e.request);
      if (guardado) return guardado;
      const r = await fetch(e.request);
      if (r.ok) c.put(e.request, r.clone()).catch(() => {});
      return r;
    }));
    return;
  }
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => new Response(SIN_RED, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
});
