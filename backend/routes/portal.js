const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const { verificarEmpleado } = require('../middleware/auth');
const { guardarDataUrl, TIPOS_JUSTIFICANTE } = require('../utils/archivos');
const { ahora } = require('../utils/tiempo');
const { calcularNomina, semanaDe, config, diaOperacion, PERMISOS } = require('../utils/finanzas');

const router = express.Router();

const limiteLogin = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20, skipSuccessfulRequests: true,
  message: { error: 'Demasiados intentos. Espera 15 minutos.' }
});

// Días de vacaciones según la LFT (reforma "Vacaciones Dignas" 2023)
function diasVacacionesLFT(fechaIngreso) {
  if (!fechaIngreso) return { anios: 0, dias: 0 };
  const hoy = ahora().fecha;
  const [ai, mi, di] = fechaIngreso.split('-').map(Number);
  const [ah, mh, dh] = hoy.split('-').map(Number);
  let anios = ah - ai;
  if (mh < mi || (mh === mi && dh < di)) anios--;
  anios = Math.max(anios, 0);
  let dias = 0;
  if (anios >= 1 && anios <= 5) dias = 10 + anios * 2;
  else if (anios > 5) dias = 20 + 2 * Math.ceil((anios - 5) / 5);
  return { anios, dias };
}

// Días naturales que abarca una solicitud (fecha → fecha_fin)
function diasSolicitud(i) {
  if (!i.fecha_fin) return 1;
  const d = Math.round((new Date(`${i.fecha_fin}T12:00:00Z`) - new Date(`${i.fecha}T12:00:00Z`)) / 86400000) + 1;
  return Math.max(d, 1);
}

router.post('/login', limiteLogin, async (req, res, next) => {
  try {
    const numero = String(req.body.numero_empleado || '').trim();
    const pin = String(req.body.pin || '').trim();
    const { rows } = await pool.query('SELECT id, nombre, pin_hash FROM empleados WHERE numero_empleado = $1 AND activo = TRUE', [numero]);
    const emp = rows[0];
    if (!emp || !emp.pin_hash || !(await bcrypt.compare(pin, emp.pin_hash))) {
      return res.status(401).json({ error: 'Número de empleado o PIN incorrecto.' });
    }
    const token = jwt.sign({ tipo: 'empleado', id: emp.id, nombre: emp.nombre }, process.env.JWT_SECRET, { expiresIn: '2h' });
    res.json({ token, nombre: emp.nombre });
  } catch (e) { next(e); }
});

router.get('/yo', verificarEmpleado, async (req, res, next) => {
  try {
    const id = req.empleado.id;
    const emp = (await pool.query(
      `SELECT e.id, e.nombre, e.puesto, e.departamento, e.sucursal, e.numero_empleado, e.fecha_ingreso, e.foto_url, e.permisos,
              h.nombre AS horario_nombre, h.hora_entrada, h.hora_salida, h.dias_semana
       FROM empleados e LEFT JOIN horarios h ON h.id = e.horario_id WHERE e.id = $1`, [id]
    )).rows[0];
    if (!emp) return res.status(404).json({ error: 'Empleado no encontrado' });
    const anio = ahora().fecha.slice(0, 4);
    const vac = (await pool.query(
      `SELECT fecha, fecha_fin FROM incidencias WHERE empleado_id = $1 AND tipo='vacaciones' AND estado='aprobado'
       AND EXTRACT(YEAR FROM fecha) = $2`, [id, anio]
    )).rows;
    const solicitudes = (await pool.query('SELECT * FROM incidencias WHERE empleado_id = $1 ORDER BY creado_en DESC LIMIT 20', [id])).rows;
    const checadas = (await pool.query(
      'SELECT fecha, hora, tipo, metodo FROM checadas WHERE empleado_id = $1 ORDER BY fecha DESC, hora DESC LIMIT 20', [id]
    )).rows;
    const p = emp.permisos || {};
    emp.permisos = Object.fromEntries(PERMISOS.map((k) => [k, p[k] === true]));
    res.json({
      empleado: emp,
      vacaciones: diasVacacionesLFT(emp.fecha_ingreso),
      dias_usados: vac.reduce((s, i) => s + diasSolicitud(i), 0),
      solicitudes,
      checadas
    });
  } catch (e) { next(e); }
});

router.post('/solicitudes', verificarEmpleado, async (req, res, next) => {
  try {
    const b = req.body;
    const errores = [];
    if (!b.fecha) errores.push('Selecciona una fecha.');
    if (!['vacaciones', 'permiso', 'incapacidad', 'horas_extra'].includes(b.tipo)) errores.push('Tipo de solicitud inválido.');
    if (errores.length) return res.status(400).json({ error: errores.join(' ') });
    const archivoUrl = b.archivo ? await guardarDataUrl(b.archivo, { permitidos: TIPOS_JUSTIFICANTE, maxMb: 6 }) : null;
    await pool.query(
      `INSERT INTO incidencias (empleado_id, fecha, fecha_fin, tipo, comentario, horas, archivo_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [req.empleado.id, b.fecha, b.fecha_fin || null, b.tipo, String(b.comentario || '').trim() || null,
       b.tipo === 'horas_extra' && b.horas ? Number(b.horas) : null, archivoUrl]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Mis pagos: semana en curso (calculada con el checador) + pagos anteriores
router.get('/pagos', verificarEmpleado, async (req, res, next) => {
  try {
    const conf = await config();
    const { lunes } = semanaDe(diaOperacion(conf.hora_corte_dia));
    const actual = (await calcularNomina(lunes, { empleadoId: req.empleado.id })).empleados[0] || null;
    const { rows } = await pool.query(
      'SELECT * FROM nomina_pagos WHERE empleado_id = $1 ORDER BY semana DESC LIMIT 12', [req.empleado.id]);
    res.json({
      semana_actual: actual ? { lunes, ...actual, reglas: { bono_puntualidad: conf.bono_puntualidad } } : null,
      pagos: rows.map((p) => ({ ...p, total: Number(p.total), sueldo: Number(p.sueldo), bono_puntualidad: Number(p.bono_puntualidad),
        bonos_extra: Number(p.bonos_extra), sueldo_diario: Number(p.sueldo_diario) }))
    });
  } catch (e) { next(e); }
});

// "Recibí mi pago": el empleado lo confirma con su PIN (queda como recibo firmado)
router.post('/pagos/:id/recibido', verificarEmpleado, limiteLogin, async (req, res, next) => {
  try {
    const emp = (await pool.query('SELECT pin_hash FROM empleados WHERE id = $1', [req.empleado.id])).rows[0];
    if (!emp || !emp.pin_hash || !(await bcrypt.compare(String(req.body.pin || ''), emp.pin_hash))) {
      return res.status(401).json({ error: 'PIN incorrecto.' });
    }
    const { rows } = await pool.query(
      'UPDATE nomina_pagos SET recibido_en = NOW() WHERE id = $1 AND empleado_id = $2 AND recibido_en IS NULL RETURNING id',
      [req.params.id, req.empleado.id]);
    if (!rows[0]) return res.status(400).json({ error: 'Ese pago ya estaba confirmado.' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
