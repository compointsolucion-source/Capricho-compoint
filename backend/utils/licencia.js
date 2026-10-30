const crypto = require('crypto');
const pool = require('../db');
const { ahora } = require('./tiempo');

// Licencia de Compoint Check.
// Los sistemas que Compoint crea para sus clientes traen COMPOINT_LICENCIA_TOKEN: cada hora
// preguntan a compoint.com.mx cómo está su suscripción (paquete, vencimiento, suspendida) y
// la respuesta viene FIRMADA con ese token, así nadie la puede inventar.
// Sin token (instalación propia de Compoint) no hay ningún control: todo funciona siempre.

const TOKEN = process.env.COMPOINT_LICENCIA_TOKEN || '';
const URL_LICENCIA = process.env.COMPOINT_LICENCIA_URL || 'https://www.compoint.com.mx/check/licencia.php';
const CONTACTO = 'Compoint · WhatsApp 33 2590 7090';

const PAQUETES = {
  basico: { nombre: 'Check Básico', modulos: ['checador'], max_empleados: 10, max_terminales: 1 },
  nomina: { nombre: 'Check Nómina', modulos: ['checador', 'nomina'], max_empleados: 25, max_terminales: 3 },
  total: { nombre: 'Check Total', modulos: ['checador', 'nomina', 'finanzas'], max_empleados: null, max_terminales: null }
};

let guardada = null;      // última respuesta firmada y verificada
let cargada = false;
let ultimaConsulta = 0;

async function cargar() {
  if (cargada) return;
  try {
    const { rows } = await pool.query('SELECT licencia FROM configuracion WHERE id = 1');
    guardada = rows[0]?.licencia || null;
  } catch (_) { guardada = null; }
  cargada = true;
}

function firmaValida(r, nonce) {
  if (!r || r.ok !== true || r.n !== nonce || typeof r.firma !== 'string') return false;
  const canonico = [r.control ? '1' : '0', r.suspendida ? '1' : '0', r.paquete || '', r.vence || '',
    r.max_empleados === null || r.max_empleados === undefined ? '' : String(r.max_empleados), r.cliente || '', nonce, r.emitido || ''].join('|');
  const esperada = crypto.createHmac('sha256', TOKEN).update(canonico).digest('hex');
  return r.firma.length === esperada.length && crypto.timingSafeEqual(Buffer.from(r.firma), Buffer.from(esperada));
}

// Pregunta a compoint.com.mx. Si no contesta, se queda con lo último que sabía.
async function consultar() {
  if (!TOKEN) return { ok: true, sin_control: true };
  ultimaConsulta = Date.now();
  const nonce = crypto.randomBytes(16).toString('hex');
  try {
    const resp = await fetch(URL_LICENCIA, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'CompointCheck' },
      body: JSON.stringify({ t: TOKEN, n: nonce }), signal: AbortSignal.timeout(15000)
    });
    const r = await resp.json().catch(() => null);
    if (!firmaValida(r, nonce)) return { ok: false, error: `respuesta no válida (${resp.status})` };
    guardada = {
      control: !!r.control, suspendida: !!r.suspendida, paquete: PAQUETES[r.paquete] ? r.paquete : null,
      vence: /^\d{4}-\d{2}-\d{2}$/.test(r.vence || '') ? r.vence : null,
      max_empleados: Number.isInteger(r.max_empleados) ? r.max_empleados : null,
      cliente: String(r.cliente || ''), verificado: new Date().toISOString()
    };
    await pool.query('UPDATE configuracion SET licencia = $1 WHERE id = 1', [JSON.stringify(guardada)]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function diasEntre(a, b) {
  return Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 86400000);
}

// Estado actual, listo para usarse (no hace llamadas de red).
function estado() {
  const todo = ['checador', 'nomina', 'finanzas'];
  if (!TOKEN) return { control: false, bloqueado: false, aviso: false, modulos: todo, max_empleados: null, max_terminales: null };
  const g = guardada;
  // Todavía no hay respuesta (sistema recién creado): funciona normal mientras llega
  if (!g) return { control: true, pendiente: true, bloqueado: false, aviso: false, modulos: todo, max_empleados: null, max_terminales: null, contacto: CONTACTO };
  if (!g.control) return { control: false, bloqueado: false, aviso: false, modulos: todo, max_empleados: null, max_terminales: null };
  const p = PAQUETES[g.paquete] || null;
  const hoy = ahora().fecha;
  const dias = g.vence ? diasEntre(hoy, g.vence) : null;
  const vencida = dias !== null && dias < 0;
  const bloqueado = g.suspendida || vencida;
  return {
    control: true, bloqueado, motivo: g.suspendida ? 'suspendida' : vencida ? 'vencida' : null,
    aviso: !bloqueado && dias !== null && dias <= 7, dias, vence: g.vence,
    paquete: g.paquete, paquete_nombre: p ? p.nombre : null,
    modulos: p ? p.modulos : todo,
    max_empleados: g.max_empleados !== null ? g.max_empleados : (p ? p.max_empleados : null),
    max_terminales: p ? p.max_terminales : null,
    contacto: CONTACTO
  };
}

async function iniciar() {
  await cargar();
  if (!TOKEN) return;
  setTimeout(() => consultar().then((r) => { if (!r.ok) console.log('[licencia] sin respuesta:', r.error); }), 5000);
  setInterval(() => consultar().catch(() => {}), 60 * 60 * 1000);
}

// "Ya pagué": vuelve a preguntar (como máximo cada 20 segundos)
async function revisarAhora() {
  if (!TOKEN) return { ok: true };
  if (Date.now() - ultimaConsulta < 20 * 1000) return { ok: true, espera: true };
  return consultar();
}

// Datos para dar de alta códigos de terminal en compoint.com.mx (solo sistemas de clientes)
function central() {
  if (!TOKEN) return null;
  return { token: TOKEN, url: URL_LICENCIA.replace(/licencia\.php(\?.*)?$/, 'terminal.php') };
}

module.exports = { iniciar, estado, revisarAhora, cargar, central, PAQUETES, _consultar: consultar };
