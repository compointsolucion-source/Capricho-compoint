const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { verificarToken, requiereAdmin } = require('../middleware/auth');
const { enviarCorreo } = require('../utils/correo');

const router = express.Router();
const TEMAS = ['oscuro-neon', 'oscuro-azul', 'claro-corporativo', 'claro-moderno'];

// Pública: tema y nombre (para pintar el login y la pantalla del celular)
router.get('/publica', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT empresa_nombre, tema FROM configuracion WHERE id = 1');
    res.json(rows[0] || { empresa_nombre: 'Compoint', tema: 'oscuro-neon' });
  } catch (e) { next(e); }
});

router.use(verificarToken, requiereAdmin);

router.get('/', async (req, res, next) => {
  try {
    const [general, smtp, usuarios, empleados] = await Promise.all([
      pool.query('SELECT * FROM configuracion WHERE id = 1'),
      pool.query('SELECT id, proveedor, host, puerto, usuario, correo_remitente, nombre_remitente, (contrasena IS NOT NULL AND contrasena <> \'\') AS tiene_contrasena FROM configuracion_smtp WHERE id = 1'),
      pool.query(
        `SELECT a.id, a.nombre, a.usuario, a.rol, a.activo, a.empleado_id, e.nombre AS empleado_nombre
         FROM administradores a LEFT JOIN empleados e ON e.id = a.empleado_id ORDER BY a.nombre`
      ),
      pool.query('SELECT id, nombre FROM empleados WHERE activo = TRUE ORDER BY nombre')
    ]);
    res.json({ general: general.rows[0], smtp: smtp.rows[0], usuarios: usuarios.rows, empleados: empleados.rows, temas: TEMAS });
  } catch (e) { next(e); }
});

router.put('/general', async (req, res, next) => {
  try {
    const b = req.body;
    const tema = TEMAS.includes(b.tema) ? b.tema : 'oscuro-neon';
    const segundos = Math.min(Math.max(Number(b.qr_vigencia_segundos) || 25, 10), 300);
    const DIAS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
    const diasOp = (Array.isArray(b.dias_operacion) ? b.dias_operacion : String(b.dias_operacion || 'X,J,V,S,D').split(','))
      .filter((d) => DIAS.includes(d));
    const num = (v, def, min, max) => { const n = Number(v); return isFinite(n) && v !== '' && v !== null && v !== undefined ? Math.min(Math.max(n, min), max) : def; };
    const correo = String(b.aviso_corte_correo || '').trim();
    if (correo && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(correo)) return res.status(400).json({ error: 'El correo para avisos no es válido.' });
    await pool.query(
      `UPDATE configuracion SET empresa_nombre = $1, tema = $2, qr_vigencia_segundos = $3,
         requiere_facial = $4, tolerancia_default_min = $5, dias_operacion = $6, hora_corte_dia = $7,
         comision_tarjeta = $8, bono_puntualidad = $9, bono_semana_perfecta = $10, puntualidad_tolerancia_min = $11,
         bono_pierde_con_falta = $12, aviso_corte_correo = $13, actualizado_en = NOW() WHERE id = 1`,
      [String(b.empresa_nombre || 'Compoint').trim() || 'Compoint', tema, segundos, !!b.requiere_facial,
       Math.max(Number(b.tolerancia_default_min) || 10, 0), (diasOp.length ? DIAS.filter((d) => diasOp.includes(d)) : ['X', 'J', 'V', 'S', 'D']).join(','),
       Math.round(num(b.hora_corte_dia, 6, 0, 12)), num(b.comision_tarjeta, 3.5, 0, 20), num(b.bono_puntualidad, 60, 0, 100000),
       num(b.bono_semana_perfecta, 0, 0, 100000), Math.round(num(b.puntualidad_tolerancia_min, 0, 0, 120)), !!b.bono_pierde_con_falta, correo || null]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.put('/smtp', async (req, res, next) => {
  try {
    const b = req.body;
    const valores = [b.proveedor || 'gmail', String(b.host || '').trim(), Number(b.puerto) || 587,
      String(b.usuario || '').trim() || null, String(b.correo_remitente || '').trim() || null,
      String(b.nombre_remitente || '').trim() || null];
    if (b.contrasena) {
      valores.push(b.contrasena);
      await pool.query('UPDATE configuracion_smtp SET proveedor=$1, host=$2, puerto=$3, usuario=$4, correo_remitente=$5, nombre_remitente=$6, contrasena=$7 WHERE id=1', valores);
    } else {
      await pool.query('UPDATE configuracion_smtp SET proveedor=$1, host=$2, puerto=$3, usuario=$4, correo_remitente=$5, nombre_remitente=$6 WHERE id=1', valores);
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/smtp/probar', async (req, res, next) => {
  try {
    if (!req.body.correo) return res.status(400).json({ error: 'Escribe a qué correo mandar la prueba.' });
    const r = await enviarCorreo(req.body.correo, 'Correo de prueba — Capricho-compoint', 'Si ves esto, tu configuración de correo funciona correctamente.');
    if (r === true) return res.json({ ok: true });
    res.status(400).json({ error: r });
  } catch (e) { next(e); }
});

router.post('/usuarios', async (req, res, next) => {
  try {
    const b = req.body;
    const nombre = String(b.nombre || '').trim();
    const usuario = String(b.usuario || '').trim();
    const rol = b.rol === 'supervisor' ? 'supervisor' : 'admin';
    const empleadoId = rol === 'supervisor' && b.empleado_id ? Number(b.empleado_id) : null;
    const errores = [];
    if (!nombre || !usuario) errores.push('Nombre y usuario son obligatorios.');
    if (String(b.password || '').length < 6) errores.push('La contraseña debe tener al menos 6 caracteres.');
    if (rol === 'supervisor' && !empleadoId) errores.push('Un supervisor debe estar vinculado a un empleado (para saber de quién es jefe).');
    if (!errores.length) {
      const existe = await pool.query('SELECT id FROM administradores WHERE LOWER(usuario) = LOWER($1)', [usuario]);
      if (existe.rows[0]) errores.push('Ese nombre de usuario ya existe.');
    }
    if (errores.length) return res.status(400).json({ error: errores.join(' ') });
    await pool.query(
      'INSERT INTO administradores (nombre, usuario, password_hash, rol, empleado_id) VALUES ($1,$2,$3,$4,$5)',
      [nombre, usuario, await bcrypt.hash(b.password, 10), rol, empleadoId]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.patch('/usuarios/:id/toggle', async (req, res, next) => {
  try {
    if (Number(req.params.id) === Number(req.usuario.id)) return res.status(400).json({ error: 'No puedes desactivarte a ti mismo.' });
    await pool.query('UPDATE administradores SET activo = NOT activo WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/usuarios/:id/password', async (req, res, next) => {
  try {
    if (String(req.body.password || '').length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });
    await pool.query(
      'UPDATE administradores SET password_hash = $1, intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = $2',
      [await bcrypt.hash(req.body.password, 10), req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
