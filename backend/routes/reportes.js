const express = require('express');
const pool = require('../db');
const { verificarToken, requiereAdmin } = require('../middleware/auth');
const { ahora, aMinutos, semanaActual } = require('../utils/tiempo');
const { calcularPrenomina } = require('../utils/asistencia');

const router = express.Router();
router.use(verificarToken);

// Reporte de checadas con retardos y salidas anticipadas
router.get('/checadas', async (req, res, next) => {
  try {
    const hoy = ahora().fecha;
    const desde = req.query.desde || `${hoy.slice(0, 8)}01`;
    const hasta = req.query.hasta || hoy;
    const params = [desde, hasta];
    let filtro = '';
    if (req.query.empleado_id) { params.push(req.query.empleado_id); filtro += ` AND e.id = $${params.length}`; }
    if (req.usuario.rol !== 'admin') { params.push(req.usuario.empleado_id || 0); filtro += ` AND e.jefe_directo_id = $${params.length}`; }
    const { rows } = await pool.query(
      `SELECT c.fecha, c.hora, c.tipo, c.metodo, c.verificado_facial, c.foto_url, e.id AS empleado_id, e.nombre, e.puesto, e.departamento,
              h.hora_entrada, h.hora_salida, h.tolerancia_minutos, h.tolerancia_salida_minutos, h.tipo_turno
       FROM checadas c JOIN empleados e ON e.id = c.empleado_id
       LEFT JOIN horarios h ON h.id = e.horario_id
       WHERE c.fecha BETWEEN $1 AND $2 ${filtro}
       ORDER BY c.fecha DESC, c.hora DESC`, params
    );

    let totalRetardos = 0, totalAnticipadas = 0;
    const porDepto = {};
    const resumen = {};
    const registros = rows.map((r) => {
      let minRetardo = null, minAnticipada = null;
      if (r.tipo === 'entrada' && r.hora_entrada && r.tipo_turno !== 'flexible') {
        const d = Math.round(aMinutos(r.hora) - aMinutos(r.hora_entrada));
        if (d > r.tolerancia_minutos) minRetardo = d;
      }
      if (r.tipo === 'salida' && r.hora_salida && r.tipo_turno === 'fijo') {
        const d = Math.round(aMinutos(r.hora_salida) - aMinutos(r.hora));
        if (d > r.tolerancia_salida_minutos) minAnticipada = d;
      }
      const res_ = (resumen[r.nombre] ||= { nombre: r.nombre, checadas: 0, retardos: 0, anticipadas: 0 });
      res_.checadas++;
      if (minRetardo !== null) {
        totalRetardos++; res_.retardos++;
        const dep = r.departamento || 'Sin departamento';
        porDepto[dep] = (porDepto[dep] || 0) + 1;
      }
      if (minAnticipada !== null) { totalAnticipadas++; res_.anticipadas++; }
      return { ...r, min_retardo: minRetardo, min_anticipada: minAnticipada };
    });

    res.json({
      desde, hasta, registros,
      kpis: {
        checadas: registros.length,
        empleados: new Set(registros.map((r) => r.empleado_id)).size,
        retardos: totalRetardos,
        anticipadas: totalAnticipadas
      },
      por_departamento: Object.entries(porDepto).sort((a, b) => b[1] - a[1]).map(([departamento, retardos]) => ({ departamento, retardos })),
      resumen: Object.values(resumen).sort((a, b) => a.nombre.localeCompare(b.nombre))
    });
  } catch (e) { next(e); }
});

router.get('/prenomina', requiereAdmin, async (req, res, next) => {
  try {
    const semana = semanaActual();
    const desde = req.query.desde || semana.desde;
    const hasta = req.query.hasta || semana.hasta;
    if (desde > hasta) return res.status(400).json({ error: 'La fecha inicial debe ser antes de la final.' });
    const resultados = await calcularPrenomina({ desde, hasta, empleadoId: req.query.empleado_id || null });
    const sinHorario = (await pool.query(
      'SELECT COUNT(*)::int AS n FROM empleados WHERE activo = TRUE AND horario_id IS NULL'
    )).rows[0].n;
    res.json({ desde, hasta, resultados, sin_horario: sinHorario });
  } catch (e) { next(e); }
});

module.exports = router;
