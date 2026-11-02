const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const { verificarToken, requiereAdmin, permitirTerminal, hashTerminal } = require('../middleware/auth');
const licencia = require('../utils/licencia');
const { buscarEmpleadoPorPin } = require('../utils/pin');
const { registrarChecada } = require('../utils/registro');
const { guardarDataUrl } = require('../utils/archivos');
const { puntualidadAlChecar } = require('../utils/finanzas');

// Terminales del negocio: una computadora o tableta que muestra el QR de la entrada (rol "qr"),
// una tableta donde el personal checa con su PIN y una selfie (rol "checador"), o un equipo
// que abre el panel normal (rol "admin"). Se conectan con un código de 6 números que da el
// administrador: así nadie escribe direcciones ni deja la contraseña del administrador en el equipo.
const { avisoCorto, guardarPermiso } = require('../utils/aviso');
const router = express.Router();

const ROLES = { qr: 'Pantalla QR', checador: 'Tableta checador', admin: 'Panel del administrador' };
const MINUTOS_CODIGO = 10;
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

const limiteCodigo = rateLimit({
  windowMs: 10 * 60 * 1000, max: 15, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: 'Demasiados intentos. Espera unos minutos y vuelve a intentar.' }
});
const limitePin = rateLimit({
  windowMs: 10 * 60 * 1000, max: 25, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: 'Demasiados intentos. Espera unos minutos.' }
});

function limite() {
  const e = licencia.estado();
  return { max: e.max_terminales ?? null, paquete: e.paquete_nombre || null };
}

// Da de alta el código en compoint.com.mx para que la app encuentre este sistema solo con el código.
// Sin token (instalación propia) no hay registro central: se usa la dirección del sistema.
async function registrarEnCompoint(codigo) {
  const c = licencia.central();
  if (!c) return { ok: false, sin_central: true };
  try {
    const r = await fetch(c.url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'CompointCheck' },
      body: JSON.stringify({ accion: 'registrar', t: c.token, codigo, minutos: MINUTOS_CODIGO }),
      signal: AbortSignal.timeout(8000)
    });
    const j = await r.json().catch(() => null);
    return j && j.ok ? { ok: true } : { ok: false, ocupado: !!(j && j.ocupado) };
  } catch (_) { return { ok: false }; }
}

// Código nuevo de 6 números para conectar (o volver a conectar) una terminal
async function nuevoCodigo(terminalId) {
  let codigo, central = { ok: false };
  for (let i = 0; i < 6; i++) {
    codigo = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const usado = (await pool.query('SELECT 1 FROM terminales WHERE codigo_hash = $1 AND codigo_vence > NOW()', [sha(codigo)])).rows[0];
    if (usado) continue;
    central = await registrarEnCompoint(codigo);
    if (central.ocupado) continue; // otro negocio tiene ese mismo código en este momento
    break;
  }
  const { rows } = await pool.query(
    `UPDATE terminales SET codigo_hash = $1, codigo_vence = NOW() + make_interval(mins => $2) WHERE id = $3 RETURNING codigo_vence`,
    [sha(codigo), MINUTOS_CODIGO, terminalId]);
  return { codigo, vence: rows[0].codigo_vence, central: !!central.ok, minutos: MINUTOS_CODIGO };
}

// ---------- La terminal ----------

// Conectar el equipo con el código (lo llama la pantalla terminal.html)
router.post('/vincular', limiteCodigo, async (req, res, next) => {
  try {
    const codigo = String(req.body.codigo || '').replace(/\D/g, '');
    if (!/^\d{6}$/.test(codigo)) return res.status(400).json({ ok: false, error: 'Escribe los 6 números del código.' });
    const t = (await pool.query('SELECT id, nombre, rol FROM terminales WHERE codigo_hash = $1 AND codigo_vence > NOW()', [sha(codigo)])).rows[0];
    if (!t) return res.status(404).json({ ok: false, error: 'Ese código no existe o ya venció. Pide uno nuevo al administrador (dura 10 minutos).' });
    const token = 'T.' + crypto.randomBytes(24).toString('hex');
    await pool.query(
      `UPDATE terminales SET token_hash = $1, codigo_hash = NULL, codigo_vence = NULL, vinculada_en = NOW(), ultimo_contacto = NOW(), descripcion = $2 WHERE id = $3`,
      [hashTerminal(token), String(req.headers['user-agent'] || '').replace(/\s+/g, ' ').slice(0, 200), t.id]);
    res.json({ ok: true, token, rol: t.rol, nombre: t.nombre });
  } catch (e) { next(e); }
});

// Datos de la terminal para pintar su pantalla
router.get('/yo', permitirTerminal(['qr', 'checador', 'admin']), async (req, res, next) => {
  try {
    if (!req.terminal) return res.status(401).json({ error: 'Este equipo no está conectado.', terminal_desconectada: true });
    const [t, c] = await Promise.all([
      pool.query('SELECT id, nombre, rol, (pin_salida_hash IS NOT NULL) AS tiene_pin FROM terminales WHERE id = $1', [req.terminal.id]),
      pool.query('SELECT empresa_nombre, logo_url, requiere_facial FROM configuracion WHERE id = 1')
    ]);
    const e = licencia.estado();
    res.json({ ...t.rows[0], rol_nombre: ROLES[t.rows[0].rol], empresa_nombre: c.rows[0]?.empresa_nombre || '', logo_url: c.rows[0]?.logo_url || null,
      selfie: !!c.rows[0]?.requiere_facial, pausa: !!e.bloqueado });
  } catch (e) { next(e); }
});

// Cerrar el modo kiosco: pide el PIN de salida de esta terminal
router.post('/salir', limitePin, permitirTerminal(['qr', 'checador', 'admin']), async (req, res, next) => {
  try {
    if (!req.terminal) return res.status(401).json({ ok: false, error: 'Este equipo no está conectado.' });
    const { rows } = await pool.query('SELECT pin_salida_hash FROM terminales WHERE id = $1', [req.terminal.id]);
    const hash = rows[0]?.pin_salida_hash;
    if (hash && !(await bcrypt.compare(String(req.body.pin || ''), hash))) return res.status(401).json({ ok: false, error: 'PIN incorrecto.' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Tableta checador: el empleado escribe su PIN y la tableta toma su selfie
router.post('/checar', limitePin, permitirTerminal(['checador']), async (req, res, next) => {
  try {
    if (!req.terminal) return res.status(401).json({ ok: false, error: 'Este equipo no está conectado.' });
    const pin = String(req.body.pin || '');
    if (!/^\d{4}$/.test(pin)) return res.status(400).json({ ok: false, error: 'Escribe los 4 números de tu PIN.' });
    const emp = await buscarEmpleadoPorPin(pin);
    if (!emp) return res.status(401).json({ ok: false, error: 'PIN incorrecto.' });
    const conf = (await pool.query('SELECT requiere_facial FROM configuracion WHERE id = 1')).rows[0] || {};
    // Sin permiso del empleado no se guarda su foto: la primera vez la tableta le muestra el aviso
    const permiso = emp.consentimiento_fotos || null;
    if (conf.requiere_facial && !permiso) return res.json({ ok: false, necesita_permiso: true, nombre: emp.nombre, aviso: await avisoCorto() });
    const foto = req.body.foto;
    const fotoValida = permiso !== 'rechazo' && typeof foto === 'string' && /^data:image\/jpeg;base64,/.test(foto) && foto.length > 8000;
    if (conf.requiere_facial && permiso === 'acepto' && !fotoValida) return res.status(400).json({ ok: false, error: 'No se pudo tomar tu foto. Mira a la cámara e intenta otra vez.' });
    let fotoUrl = null;
    if (fotoValida) { try { fotoUrl = await guardarDataUrl(foto, { maxMb: 2 }); } catch (e) { if (conf.requiere_facial) throw e; } }
    const r = await registrarChecada({
      empleadoId: emp.id, metodo: 'tableta', ip: req.ip, fotoUrl, verificadoFacial: false,
      revision: fotoUrl ? 'pendiente' : null, terminalId: req.terminal.id
    });
    if (fotoUrl && !emp.foto_url) {
      await pool.query("UPDATE checadas SET revision = 'revisar', revision_motivo = 'Sin foto en el expediente para comparar' WHERE id = $1", [r.id]);
    }
    let puntualidad = null;
    if (r.tipo === 'entrada') { try { puntualidad = await puntualidadAlChecar(emp.id, r.fecha, r.hora); } catch (_) { puntualidad = null; } }
    res.json({ ok: true, empleado: emp.nombre, tipo: r.tipo, hora: r.hora, foto_url: emp.foto_url || fotoUrl, puntualidad });
  } catch (e) {
    if (e.status === 409) return res.status(409).json({ ok: false, error: e.message });
    next(e);
  }
});

// Tableta checador: el empleado acepta o no el aviso de fotos (escribe su PIN otra vez)
router.post('/permiso', limitePin, permitirTerminal(['checador']), async (req, res, next) => {
  try {
    if (!req.terminal) return res.status(401).json({ ok: false, error: 'Este equipo no está conectado.' });
    const emp = await buscarEmpleadoPorPin(String(req.body.pin || ''));
    if (!emp) return res.status(401).json({ ok: false, error: 'PIN incorrecto.' });
    await guardarPermiso(emp.id, req.body.acepta === true, 'tableta');
    res.json({ ok: true, permiso: req.body.acepta === true ? 'acepto' : 'rechazo' });
  } catch (e) { next(e); }
});

// Saludo en pantalla: checadas nuevas desde la última que se mostró
router.get('/recientes', permitirTerminal(['qr', 'checador']), verificarToken, async (req, res, next) => {
  try {
    const desde = parseInt(req.query.desde, 10);
    if (!Number.isInteger(desde)) {
      const { rows } = await pool.query('SELECT COALESCE(MAX(id), 0)::int AS id FROM checadas');
      return res.json({ ultimo_id: rows[0].id, lista: [] });
    }
    const { rows } = await pool.query(
      `SELECT c.id, e.nombre, c.tipo, c.hora, COALESCE(e.foto_url, c.foto_url) AS foto_url
       FROM checadas c JOIN empleados e ON e.id = c.empleado_id
       WHERE c.id > $1 AND c.creado_en > NOW() - INTERVAL '2 minutes' ORDER BY c.id LIMIT 5`, [desde]);
    const ultimo = rows.length ? rows[rows.length - 1].id : desde;
    res.json({ ultimo_id: ultimo, lista: rows });
  } catch (e) { next(e); }
});

// ---------- El administrador ----------

router.get('/', verificarToken, requiereAdmin, async (req, res, next) => {
  try {
    const [t, c] = await Promise.all([
      pool.query(
        `SELECT id, nombre, rol, descripcion, vinculada_en, ultimo_contacto, (pin_salida_hash IS NOT NULL) AS tiene_pin,
                (token_hash IS NOT NULL) AS conectada, (ultimo_contacto > NOW() - INTERVAL '2 minutes') AS en_linea,
                (codigo_vence > NOW()) AS codigo_vigente, codigo_vence, creado_en
         FROM terminales ORDER BY id`),
      pool.query('SELECT logo_url FROM configuracion WHERE id = 1')
    ]);
    const l = limite();
    res.json({ terminales: t.rows.map((x) => ({ ...x, rol_nombre: ROLES[x.rol] })), limite: l.max, paquete_nombre: l.paquete,
      logo_url: c.rows[0]?.logo_url || null, central: !!licencia.central(), roles: ROLES });
  } catch (e) { next(e); }
});

function validar(body, nueva) {
  const nombre = String(body.nombre || '').trim().slice(0, 80);
  if (!nombre) return { error: 'Ponle un nombre, por ejemplo "Entrada principal".' };
  if (!ROLES[body.rol]) return { error: 'Elige para qué es la terminal.' };
  const pin = String(body.pin_salida ?? '').trim();
  if (pin && !/^\d{4}$/.test(pin)) return { error: 'El PIN de salida debe ser de 4 números.' };
  if (nueva && body.rol !== 'admin' && !pin) return { error: 'Pon un PIN de salida de 4 números: con él se cierra la pantalla completa.' };
  return { nombre, rol: body.rol, pin };
}

router.post('/', verificarToken, requiereAdmin, async (req, res, next) => {
  try {
    const v = validar(req.body, true);
    if (v.error) return res.status(400).json({ error: v.error });
    const l = limite();
    if (l.max !== null) {
      const n = (await pool.query('SELECT COUNT(*)::int AS n FROM terminales')).rows[0].n;
      if (n >= l.max) {
        return res.status(403).json({ error: `Tu paquete (${l.paquete}) permite ${l.max === 1 ? '1 terminal' : `hasta ${l.max} terminales`}. Para agregar más: ${licencia.estado().contacto}.` });
      }
    }
    const pinHash = v.pin ? await bcrypt.hash(v.pin, 10) : null;
    const { rows } = await pool.query('INSERT INTO terminales (nombre, rol, pin_salida_hash) VALUES ($1, $2, $3) RETURNING id', [v.nombre, v.rol, pinHash]);
    res.json({ id: rows[0].id, ...(await nuevoCodigo(rows[0].id)) });
  } catch (e) { next(e); }
});

// Logo del negocio para las pantallas (null lo quita)
router.put('/logo', verificarToken, requiereAdmin, async (req, res, next) => {
  try {
    const url = req.body.logo ? await guardarDataUrl(req.body.logo, { maxMb: 1 }) : null;
    await pool.query('UPDATE configuracion SET logo_url = $1 WHERE id = 1', [url]);
    res.json({ ok: true, logo_url: url });
  } catch (e) { next(e); }
});

router.put('/:id', verificarToken, requiereAdmin, async (req, res, next) => {
  try {
    const v = validar(req.body, false);
    if (v.error) return res.status(400).json({ error: v.error });
    const params = [v.nombre, v.rol, req.params.id];
    let extra = '';
    if (v.pin) { params.push(await bcrypt.hash(v.pin, 10)); extra = ', pin_salida_hash = $4'; }
    const { rowCount } = await pool.query(`UPDATE terminales SET nombre = $1, rol = $2${extra} WHERE id = $3`, params);
    if (!rowCount) return res.status(404).json({ error: 'No existe esa terminal.' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Código nuevo: para conectar otra vez el equipo (o cambiarlo por otro)
router.post('/:id/codigo', verificarToken, requiereAdmin, async (req, res, next) => {
  try {
    const t = (await pool.query('SELECT id FROM terminales WHERE id = $1', [req.params.id])).rows[0];
    if (!t) return res.status(404).json({ error: 'No existe esa terminal.' });
    res.json(await nuevoCodigo(t.id));
  } catch (e) { next(e); }
});

// Quitar: el equipo se desconecta al instante
router.delete('/:id', verificarToken, requiereAdmin, async (req, res, next) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM terminales WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'No existe esa terminal.' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
