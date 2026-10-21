// Verificador de rostros en segundo plano.
// Corre en las pantallas del panel (pantalla QR, dashboard, checadas, empleados):
// compara cada selfie de checada con la foto del expediente sin hacer esperar al
// empleado. Lo que no coincide queda "por revisar" para el administrador.
(function () {
  if (window.iniciarVerificador) return;
  const MODELOS = 'modelos';
  let listo = null, trabajando = false;

  function cargarScript(src) {
    return new Promise((ok, mal) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = mal; document.head.appendChild(s); });
  }
  function cargar() {
    if (!listo) {
      listo = (async () => {
        if (!window.faceapi) await cargarScript('js/vendor/face-api.min.js');
        await Promise.all([
          faceapi.nets.tinyFaceDetector.loadFromUri(MODELOS),
          faceapi.nets.faceLandmark68Net.loadFromUri(MODELOS),
          faceapi.nets.faceRecognitionNet.loadFromUri(MODELOS)
        ]);
      })();
      listo.catch(() => { listo = null; });
    }
    return listo;
  }
  // Rasgos del rostro de una foto (null si no hay rostro). Prueba varios tamaños
  // porque las fotos de expediente vienen de cámaras y encuadres muy distintos.
  // Foto con margen alrededor: el detector falla cuando la cara llena toda la imagen
  // (fotos de expediente recortadas muy cerca)
  function conMargen(img) {
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const m = Math.round(Math.max(w, h) * 0.45);
    const c = document.createElement('canvas');
    c.width = w + m * 2; c.height = h + m * 2;
    const g = c.getContext('2d');
    g.fillStyle = '#777'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, m, m, w, h);
    return c;
  }
  async function rasgos(url) {
    const img = await faceapi.fetchImage(urlArchivo(url));
    for (const fuente of [img, conMargen(img)]) {
      for (const inputSize of [416, 608, 320]) {
        const d = await faceapi.detectSingleFace(fuente, new faceapi.TinyFaceDetectorOptions({ inputSize, scoreThreshold: 0.35 }))
          .withFaceLandmarks().withFaceDescriptor();
        if (d) return Array.from(d.descriptor);
      }
    }
    return null;
  }
  async function ciclo() {
    if (trabajando) return;
    trabajando = true;
    try {
      const cola = await api('/revision/cola');
      if (!cola.referencias.length && !cola.pendientes.length) return;
      await cargar();
      for (const r of cola.referencias) {
        let d;
        try { d = await rasgos(r.foto_url); } catch (_) { continue; } // sin red: se reintenta en el siguiente ciclo
        await api('/revision/referencia', { method: 'POST', body: { empleado_id: r.empleado_id, foto_url: r.foto_url, descriptor: d } });
      }
      for (const c of cola.pendientes) {
        let d;
        try { d = await rasgos(c.foto_url); } catch (_) { continue; }
        const res = await api(`/revision/resultado/${c.id}`, { method: 'POST', body: { descriptor: d } });
        document.dispatchEvent(new CustomEvent('revision-actualizada', { detail: { id: c.id, ...res } }));
      }
      // Si quedó más trabajo, seguir enseguida
      if (cola.referencias.length + cola.pendientes.length >= 10) setTimeout(ciclo, 500);
    } catch (_) { /* se reintenta en el siguiente ciclo */ } finally { trabajando = false; }
  }
  window.iniciarVerificador = function (cadaSegundos = 20) {
    setTimeout(ciclo, 2500);
    setInterval(ciclo, cadaSegundos * 1000);
  };
})();
