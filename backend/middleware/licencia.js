const { estado } = require('../utils/licencia');

// Aplica la suscripción de Compoint Check a todo /api:
//  · Vencida o suspendida → "solo consulta": se puede ver todo, pero no checar ni capturar.
//  · Paquete → qué módulos se pueden usar (Básico: checador; Nómina: + nómina; Total: todo).
// Iniciar sesión, recuperar la contraseña y la licencia misma siempre funcionan.

const SIEMPRE = [/^\/auth\//, /^\/recuperar\//, /^\/licencia(\/|$)/, /^\/salud$/, /^\/portal\/login$/, /^\/archivos\//,
  /^\/terminales\/(yo|salir)$/]; // la terminal siempre puede ver su estado y cerrarse con su PIN
const CHECADOR = [/^\/qr\//, /^\/huella\//, /^\/terminales\/(checar|permiso)$/];
// Rutas de finanzas que entran en el paquete Nómina (el resto es del paquete Total)
const DE_NOMINA = [/^\/finanzas\/yo$/, /^\/finanzas\/nomina/, /^\/finanzas\/auditoria$/, /^\/portal\/pagos/];
const DE_FINANZAS = [/^\/finanzas\//];

function cumple(lista, ruta) { return lista.some((r) => r.test(ruta)); }

function verificarLicencia(req, res, next) {
  const e = estado();
  if (!e.control) return next();
  const ruta = req.path;
  if (cumple(SIEMPRE, ruta)) return next();

  if (e.bloqueado) {
    const texto = e.motivo === 'suspendida'
      ? 'Tu sistema Compoint Check está suspendido. Puedes consultar tu información, pero no checar ni capturar.'
      : `Tu suscripción de Compoint Check venció el ${e.vence.split('-').reverse().join('/')}. Puedes consultar tu información, pero no checar ni capturar.`;
    const error = `${texto} Para renovar: ${e.contacto}.`;
    if (cumple(CHECADOR, ruta)) return res.status(402).json({ ok: false, licencia: true, error: 'El checador está en pausa: la suscripción de tu negocio no está al corriente. Avisa a tu encargado.' });
    if (req.method !== 'GET') return res.status(402).json({ ok: false, licencia: true, error });
  }

  const m = e.modulos || [];
  if (cumple(DE_NOMINA, ruta) && !m.includes('nomina')) {
    return res.status(403).json({ ok: false, licencia: true, error: `Tu paquete (${e.paquete_nombre}) no incluye nómina. Para agregarla: ${e.contacto}.` });
  }
  if (!cumple(DE_NOMINA, ruta) && cumple(DE_FINANZAS, ruta) && !m.includes('finanzas')) {
    return res.status(403).json({ ok: false, licencia: true, error: `Tu paquete (${e.paquete_nombre}) no incluye finanzas. Para agregarlas: ${e.contacto}.` });
  }
  next();
}

module.exports = { verificarLicencia };
