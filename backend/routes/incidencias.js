const express = require('express');
const pool = require('../db');
const { verificarToken } = require('../middleware/auth');
const { guardarDataUrl, TIPOS_JUSTIFICANTE } = require('../utils/archivos');

const router = express.Router();
router.use(verificarToken);

const TIPOS = ['vacaciones', 'permiso', 'incapacidad', 'horas_extra', 'falta', 'otro'];
const esAdmin = (req) => req.usuario.rol === 'admin';

router.get('/', async (req, res, next) => {
  try {
    const estado = req.query.estado || 'pendiente';
    const cond = [];
    const params = [];
    if (estado !== 'todos') { params.push(estado); cond.push(`i.estado = $${params.length}`); }
    if (!esAdmin(req)) { params.push(req.usuario.empleado_id || 0); cond.push(`e.jefe_directo_id = $${params.length}`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT i.*, e.nombre AS empleado_nombre, ad.nombre AS revisor_nombre
       FROM incidencias i JOIN empleados e ON e.id = i.empleado_id
       LEFT JOIN administradores ad ON ad.id = i.revisado_por
       ${where} ORDER BY i.creado_en DESC LIMIT 300`, params
    );
    const kpis = (await pool.query(
      `SELECT COUNT(*) FILTER (WHERE estado='pendiente')::int AS pendientes,
              COUNT(*) FILTER (WHERE estado='aprobado' AND date_trunc('month', creado_en) = date_trunc('month', NOW()))::int AS aprobadas_mes,
              COUNT(*)::int AS total
       FROM incidencias`
    )).rows[0];
    res.json({ solicitudes: rows, kpis });
  } catch (e) { next(e); }
});

async function puedeVerEmpleado(req, empleadoId) {
  if (esAdmin(req)) return true;
  const { rows } = await pool.query('SELECT jefe_directo_id FROM empleados WHERE id = $1', [empleadoId]);
  return rows[0] && Number(rows[0].jefe_directo_id) === Number(req.usuario.empleado_id);
}

router.post('/', async (req, res, next) => {
  try {
    const b = req.body;
    const errores = [];
    const empleadoId = Number(b.empleado_id);
    if (!empleadoId) errores.push('Selecciona un empleado.');
    if (!b.fecha) errores.push('La fecha es obligatoria.');
    if (!TIPOS.includes(b.tipo)) errores.push('Tipo inválido.');
    if (errores.length) return res.status(400).json({ error: errores.join(' ') });
    if (!(await puedeVerEmpleado(req, empleadoId))) return res.status(403).json({ error: 'Ese empleado no es de tu equipo.' });

    const estado = ['pendiente', 'aprobado', 'rechazado'].includes(b.estado) ? b.estado : 'pendiente';
    const archivoUrl = b.archivo ? await guardarDataUrl(b.archivo, { permitidos: TIPOS_JUSTIFICANTE, maxMb: 6 }) : null;
    const resuelta = estado !== 'pendiente';
    await pool.query(
      `INSERT INTO incidencias (empleado_id, fecha, fecha_fin, tipo, estado, comentario, horas, archivo_url, revisado_por, revisado_en)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [empleadoId, b.fecha, b.fecha_fin || null, b.tipo, estado, String(b.comentario || '').trim() || null,
       b.tipo === 'horas_extra' && b.horas ? Number(b.horas) : null, archivoUrl,
       resuelta ? req.usuario.id : null, resuelta ? new Date() : null]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.patch('/:id/resolver', async (req, res, next) => {
  try {
    const accion = req.body.accion;
    if (!['aprobado', 'rechazado'].includes(accion)) return res.status(400).json({ error: 'Acción inválida' });
    const { rows } = await pool.query('SELECT empleado_id FROM incidencias WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Solicitud no encontrada' });
    if (!(await puedeVerEmpleado(req, rows[0].empleado_id))) {
      return res.status(403).json({ error: 'Solo puedes resolver solicitudes de tu equipo directo.' });
    }
    await pool.query('UPDATE incidencias SET estado=$1, revisado_por=$2, revisado_en=NOW() WHERE id=$3', [accion, req.usuario.id, req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
