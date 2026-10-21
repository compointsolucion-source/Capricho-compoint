const express = require('express');
const pool = require('../db');
const { verificarToken, requiereAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(verificarToken);

const DIAS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT h.*, (SELECT COUNT(*)::int FROM empleados e WHERE e.horario_id = h.id AND e.activo) AS empleados
       FROM horarios h ORDER BY h.activo DESC, h.nombre ASC`
    );
    res.json(rows);
  } catch (e) { next(e); }
});

function validar(b) {
  const errores = [];
  const nombre = String(b.nombre || '').trim();
  const tipo = ['fijo', 'nocturno', 'flexible'].includes(b.tipo_turno) ? b.tipo_turno : 'fijo';
  const dias = (Array.isArray(b.dias) ? b.dias : []).filter((d) => DIAS.includes(d));
  let entrada = b.hora_entrada || null;
  let salida = b.hora_salida || null;
  let horas = b.horas_requeridas !== '' && b.horas_requeridas != null ? Number(b.horas_requeridas) : null;
  if (!nombre) errores.push('El nombre del turno es obligatorio.');
  if (!dias.length) errores.push('Selecciona al menos un día.');
  if (tipo === 'flexible') {
    if (!horas) errores.push('Indica las horas requeridas por día para un turno flexible.');
    entrada = null; salida = null;
  } else {
    if (!entrada || !salida) errores.push('Hora de entrada y salida son obligatorias para turnos fijos o nocturnos.');
    horas = null;
  }
  return {
    errores,
    valores: [nombre, tipo, entrada, salida, Number(b.tolerancia_minutos ?? 10) || 0,
      Number(b.tolerancia_salida_minutos ?? 10) || 0, horas, DIAS.filter((d) => dias.includes(d)).join(','), b.activo !== false]
  };
}

router.post('/', requiereAdmin, async (req, res, next) => {
  try {
    const { errores, valores } = validar(req.body);
    if (errores.length) return res.status(400).json({ error: errores.join(' ') });
    await pool.query(
      `INSERT INTO horarios (nombre, tipo_turno, hora_entrada, hora_salida, tolerancia_minutos, tolerancia_salida_minutos, horas_requeridas, dias_semana, activo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, valores
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.put('/:id', requiereAdmin, async (req, res, next) => {
  try {
    const { errores, valores } = validar(req.body);
    if (errores.length) return res.status(400).json({ error: errores.join(' ') });
    await pool.query(
      `UPDATE horarios SET nombre=$1, tipo_turno=$2, hora_entrada=$3, hora_salida=$4, tolerancia_minutos=$5,
       tolerancia_salida_minutos=$6, horas_requeridas=$7, dias_semana=$8, activo=$9 WHERE id=$10`,
      [...valores, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.patch('/:id/toggle', requiereAdmin, async (req, res, next) => {
  try {
    await pool.query('UPDATE horarios SET activo = NOT activo WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
