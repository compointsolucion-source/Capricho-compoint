const express = require('express');
const pool = require('../db');
const { verificarToken, requiereAdmin } = require('../middleware/auth');
const { ahora, aMinutos } = require('../utils/tiempo');
const { enviarCorreo } = require('../utils/correo');

const router = express.Router();
router.use(verificarToken);

// Empleados que debían entrar hoy, ya pasó su tolerancia y no han checado
async function ausentesHoy() {
  const { fecha, hora, diaCodigo } = ahora();
  const festivo = (await pool.query('SELECT descripcion FROM dias_festivos WHERE fecha = $1', [fecha])).rows[0];
  if (festivo) return { festivo: festivo.descripcion, ausentes: [] };
  const { rows } = await pool.query(
    `SELECT e.id, e.nombre, e.departamento, h.hora_entrada, h.tolerancia_minutos, h.dias_semana
     FROM empleados e JOIN horarios h ON h.id = e.horario_id
     WHERE e.activo = TRUE AND h.hora_entrada IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM checadas c WHERE c.empleado_id = e.id AND c.fecha = $1 AND c.tipo = 'entrada')
       AND NOT EXISTS (SELECT 1 FROM incidencias i WHERE i.empleado_id = e.id AND i.estado = 'aprobado'
            AND i.tipo IN ('vacaciones','permiso','incapacidad') AND i.fecha <= $1 AND COALESCE(i.fecha_fin, i.fecha) >= $1)
     ORDER BY e.nombre`, [fecha]
  );
  const ahoraMin = aMinutos(hora);
  const ausentes = rows.filter((e) =>
    e.dias_semana.split(',').includes(diaCodigo) &&
    ahoraMin - aMinutos(e.hora_entrada) > e.tolerancia_minutos
  );
  return { festivo: null, ausentes };
}

router.get('/', async (req, res, next) => {
  try {
    const { fecha } = ahora();
    const [tot, pres, ret, ult, aus] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS n FROM empleados WHERE activo = TRUE'),
      pool.query("SELECT COUNT(DISTINCT empleado_id)::int AS n FROM checadas WHERE fecha = $1 AND tipo = 'entrada'", [fecha]),
      pool.query('SELECT COUNT(DISTINCT empleado_id)::int AS n FROM vista_retardos WHERE fecha = $1 AND es_retardo', [fecha]),
      pool.query(
        `SELECT c.hora, c.tipo, c.metodo, c.verificado_facial, e.nombre, e.puesto FROM checadas c
         JOIN empleados e ON e.id = c.empleado_id WHERE c.fecha = $1 ORDER BY c.hora DESC, c.id DESC LIMIT 15`, [fecha]
      ),
      ausentesHoy()
    ]);
    res.json({
      fecha,
      total_empleados: tot.rows[0].n,
      presentes: pres.rows[0].n,
      retardos: ret.rows[0].n,
      ausentes: aus.ausentes.length,
      festivo: aus.festivo,
      checadas: ult.rows
    });
  } catch (e) { next(e); }
});

router.get('/alertas', requiereAdmin, async (req, res, next) => {
  try {
    const aus = await ausentesHoy();
    const extra = (await pool.query(
      `SELECT i.*, e.nombre AS empleado_nombre FROM incidencias i JOIN empleados e ON e.id = i.empleado_id
       WHERE i.tipo = 'horas_extra' AND i.estado = 'pendiente' ORDER BY i.fecha DESC`
    )).rows;
    res.json({ festivo: aus.festivo, ausentes: aus.ausentes, horas_extra: extra });
  } catch (e) { next(e); }
});

const escapar = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

router.post('/alertas/correo', requiereAdmin, async (req, res, next) => {
  try {
    const { destinatario, asunto, cuerpo } = req.body;
    if (!destinatario || !asunto) return res.status(400).json({ error: 'Indica destinatario y asunto.' });
    const r = await enviarCorreo(destinatario, asunto, escapar(cuerpo || '').replace(/\n/g, '<br>'));
    if (r === true) return res.json({ ok: true });
    res.status(400).json({ error: `No se pudo enviar: ${r}` });
  } catch (e) { next(e); }
});

module.exports = router;
