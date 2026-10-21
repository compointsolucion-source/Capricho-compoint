const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const { enviarCorreo } = require('../utils/correo');
const { buscarEmpleadoPorPin } = require('../utils/pin');
const { auditarFin } = require('../utils/finanzas');

// "Olvidé mi contraseña" (panel) y "Olvidé mi PIN" (portal del empleado).
// Rutas públicas: se protegen con límite de intentos, enlaces de un solo uso
// que duran 30 minutos y respuestas que no revelan si una cuenta existe.
const router = express.Router();

// Límites por IP (todos los empleados suelen compartir el mismo Wi-Fi, así que son holgados;
// la seguridad real está en los enlaces de 64 caracteres y en el código de 12)
const limitar = (max, skipSuccessfulRequests = false) => rateLimit({
  windowMs: 15 * 60 * 1000, max, skipSuccessfulRequests, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiados intentos. Espera 15 minutos e intenta de nuevo.' }
});
const limiteSolicitar = limitar(10);
const limiteToken = limitar(30);
const limiteCodigo = limitar(8, true);

const MINUTOS = 30;
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const correoValido = (c) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c);
const normalizarCodigo = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const RESPUESTA = {
  admin: 'Si el usuario o correo coincide con una cuenta que tiene correo registrado, te enviamos un enlace para crear una contraseña nueva. Revisa tu bandeja y la carpeta de spam. El enlace vence en 30 minutos.',
  empleado: 'Si el número de empleado tiene un correo registrado, te enviamos un enlace para crear un PIN nuevo. Revisa tu bandeja y la carpeta de spam. El enlace vence en 30 minutos.'
};

function baseFrontend(req) {
  if (process.env.FRONTEND_URL) return process.env.FRONTEND_URL.replace(/\/$/, '');
  const o = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : '');
  return o.replace(/\/$/, '');
}

async function smtpListo() {
  const { rows } = await pool.query('SELECT host, usuario, contrasena FROM configuracion_smtp WHERE id = 1');
  const c = rows[0];
  return !!(c && c.host && c.usuario && c.contrasena);
}

function correoHtml({ empresa, nombre, enlace, que }) {
  return `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:520px;margin:auto;border:1px solid #e3e8e5;border-radius:12px;overflow:hidden">
    <div style="background:#0a0c0a;color:#5df76a;padding:18px 22px;font-weight:700;font-size:16px">${empresa} · Capricho Compoint</div>
    <div style="padding:22px;color:#16201a;font-size:14px;line-height:1.55">
      <p>Hola ${nombre}:</p>
      <p>Recibimos una solicitud para crear ${que} nuevo. Toca el botón (vence en ${MINUTOS} minutos y solo sirve una vez):</p>
      <p style="text-align:center;margin:26px 0"><a href="${enlace}" style="background:#5df76a;color:#06210c;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px;display:inline-block">Crear ${que} nuevo</a></p>
      <p style="font-size:12px;color:#5c6862">Si el botón no abre, copia este enlace en tu navegador:<br>${enlace}</p>
      <p style="font-size:12px;color:#5c6862">Si tú no lo pediste, ignora este correo: tu ${que} actual sigue funcionando.</p>
    </div></div>`;
}

// Paso 1: pedir el enlace por correo
router.post('/solicitar', limiteSolicitar, async (req, res, next) => {
  try {
    const tipo = req.body.tipo === 'empleado' ? 'empleado' : 'admin';
    const dato = String(req.body.dato || '').trim();
    if (!dato) return res.status(400).json({ error: tipo === 'admin' ? 'Escribe tu usuario o tu correo.' : 'Escribe tu número de empleado.' });
    if (!(await smtpListo())) {
      return res.status(400).json({ error: tipo === 'admin'
        ? 'El envío de correos todavía no está configurado en el sistema. Usa tu código de recuperación o pide a otro administrador que te ponga una contraseña nueva.'
        : 'El envío de correos todavía no está configurado. Pide a tu encargado que te asigne un PIN nuevo.' });
    }
    const cuenta = tipo === 'admin'
      ? (await pool.query('SELECT id, nombre, correo FROM administradores WHERE activo AND (LOWER(usuario) = LOWER($1) OR LOWER(correo) = LOWER($1)) LIMIT 1', [dato])).rows[0]
      : (await pool.query('SELECT id, nombre, correo FROM empleados WHERE activo AND numero_empleado = $1 LIMIT 1', [dato])).rows[0];
    if (cuenta && cuenta.correo && correoValido(cuenta.correo)) {
      const base = baseFrontend(req);
      const token = crypto.randomBytes(32).toString('hex');
      await pool.query('UPDATE recuperaciones SET usado_en = NOW() WHERE tipo = $1 AND cuenta_id = $2 AND usado_en IS NULL', [tipo, cuenta.id]);
      await pool.query(
        `INSERT INTO recuperaciones (tipo, cuenta_id, token_hash, expira_en, ip) VALUES ($1, $2, $3, NOW() + make_interval(mins => $4), $5)`,
        [tipo, cuenta.id, sha(token), MINUTOS, String(req.ip || '').slice(0, 60)]);
      await pool.query("DELETE FROM recuperaciones WHERE expira_en < NOW() - INTERVAL '7 days'");
      const empresa = (await pool.query('SELECT empresa_nombre FROM configuracion WHERE id = 1')).rows[0]?.empresa_nombre || 'Compoint';
      const que = tipo === 'admin' ? 'una contraseña' : 'un PIN';
      const r = await enviarCorreo(cuenta.correo, tipo === 'admin' ? 'Recupera tu contraseña' : 'Recupera tu PIN',
        correoHtml({ empresa, nombre: String(cuenta.nombre).split(' ')[0], enlace: `${base}/recuperar.html?t=${token}`, que }));
      if (r !== true) {
        console.error('[recuperar] no se pudo enviar el correo:', r);
        return res.status(502).json({ error: 'No se pudo enviar el correo en este momento. Intenta más tarde o pide ayuda al administrador.' });
      }
    }
    res.json({ ok: true, mensaje: RESPUESTA[tipo] });
  } catch (e) { next(e); }
});

async function buscarToken(token) {
  if (!/^[a-f0-9]{64}$/.test(String(token || ''))) return null;
  const { rows } = await pool.query('SELECT * FROM recuperaciones WHERE token_hash = $1 AND usado_en IS NULL AND expira_en > NOW()', [sha(token)]);
  return rows[0] || null;
}

// Paso 2: ¿el enlace sigue vigente?
router.get('/token/:token', async (req, res, next) => {
  try {
    const r = await buscarToken(req.params.token);
    if (!r) return res.status(410).json({ error: 'Este enlace ya venció o ya se usó. Pide uno nuevo.' });
    const tabla = r.tipo === 'admin' ? 'administradores' : 'empleados';
    const c = (await pool.query(`SELECT nombre FROM ${tabla} WHERE id = $1 AND activo`, [r.cuenta_id])).rows[0];
    if (!c) return res.status(410).json({ error: 'La cuenta ya no está activa.' });
    res.json({ ok: true, tipo: r.tipo, nombre: String(c.nombre).split(' ')[0] });
  } catch (e) { next(e); }
});

// Paso 3: guardar la contraseña / el PIN nuevo
router.post('/token/:token', limiteToken, async (req, res, next) => {
  try {
    const r = await buscarToken(req.params.token);
    if (!r) return res.status(410).json({ error: 'Este enlace ya venció o ya se usó. Pide uno nuevo.' });
    const nueva = String(req.body.nueva || ''), confirmar = String(req.body.confirmar || '');
    if (nueva !== confirmar) return res.status(400).json({ error: 'La confirmación no coincide.' });
    if (r.tipo === 'admin') {
      if (nueva.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });
      const a = (await pool.query(
        'UPDATE administradores SET password_hash = $1, intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = $2 AND activo RETURNING nombre, usuario',
        [await bcrypt.hash(nueva, 10), r.cuenta_id])).rows[0];
      if (!a) return res.status(410).json({ error: 'La cuenta ya no está activa.' });
      await auditarFin(null, { modulo: 'usuarios', registroId: r.cuenta_id, accion: 'recuperada', descripcion: `${a.nombre} (${a.usuario}) creó una contraseña nueva con el enlace de su correo`, usuario: a.nombre });
    } else {
      if (!/^\d{4}$/.test(nueva)) return res.status(400).json({ error: 'El PIN debe ser de 4 números.' });
      if (await buscarEmpleadoPorPin(nueva, r.cuenta_id)) return res.status(400).json({ error: 'Ese PIN ya lo usa otra persona. Elige otro.' });
      const e = (await pool.query('UPDATE empleados SET pin_hash = $1 WHERE id = $2 AND activo RETURNING nombre', [await bcrypt.hash(nueva, 10), r.cuenta_id])).rows[0];
      if (!e) return res.status(410).json({ error: 'La cuenta ya no está activa.' });
      await auditarFin(null, { modulo: 'empleados', registroId: r.cuenta_id, accion: 'recuperada', descripcion: `${e.nombre} creó un PIN nuevo con el enlace de su correo`, usuario: e.nombre });
    }
    await pool.query('UPDATE recuperaciones SET usado_en = NOW() WHERE id = $1', [r.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Sin correo: con el código de recuperación que el usuario guardó
router.post('/codigo', limiteCodigo, async (req, res, next) => {
  try {
    const usuario = String(req.body.usuario || '').trim();
    const codigo = normalizarCodigo(req.body.codigo);
    const nueva = String(req.body.nueva || ''), confirmar = String(req.body.confirmar || '');
    if (!usuario || codigo.length !== 12) return res.status(400).json({ error: 'Escribe tu usuario y tu código de recuperación completo (12 letras y números).' });
    if (nueva.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });
    if (nueva !== confirmar) return res.status(400).json({ error: 'La confirmación no coincide.' });
    const a = (await pool.query('SELECT id, nombre, usuario, codigo_recuperacion_hash FROM administradores WHERE activo AND LOWER(usuario) = LOWER($1)', [usuario])).rows[0];
    if (!a || !a.codigo_recuperacion_hash || !(await bcrypt.compare(codigo, a.codigo_recuperacion_hash))) {
      return res.status(401).json({ error: 'El usuario o el código de recuperación no son correctos.' });
    }
    // El código se usa una sola vez: después hay que generar otro en Configuración
    await pool.query(
      `UPDATE administradores SET password_hash = $1, intentos_fallidos = 0, bloqueado_hasta = NULL,
         codigo_recuperacion_hash = NULL, codigo_recuperacion_en = NULL WHERE id = $2`,
      [await bcrypt.hash(nueva, 10), a.id]);
    await auditarFin(null, { modulo: 'usuarios', registroId: a.id, accion: 'recuperada', descripcion: `${a.nombre} (${a.usuario}) creó una contraseña nueva con su código de recuperación`, usuario: a.nombre });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.normalizarCodigo = normalizarCodigo;
