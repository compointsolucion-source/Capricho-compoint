const express = require('express');
const pool = require('../db');
const { verificarToken, requiereAdmin } = require('../middleware/auth');

// Revisión del rostro de las checadas. La comparación la hacen las pantallas del
// panel (pantalla QR, dashboard, checadas, empleados) en segundo plano, así el
// celular del empleado no tiene que descargar ni procesar nada pesado.
const router = express.Router();
router.use(verificarToken);

const esDescriptor = (d) => Array.isArray(d) && d.length === 128 && d.every((x) => typeof x === 'number' && isFinite(x) && Math.abs(x) < 10);
const distancia = (a, b) => Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0));

async function umbral() {
  const { rows } = await pool.query('SELECT umbral_facial FROM configuracion WHERE id = 1');
  return Number(rows[0]?.umbral_facial) || 0.6;
}

// Trabajo pendiente para el verificador: fotos de expediente sin procesar y selfies por comparar
router.get('/cola', async (req, res, next) => {
  try {
    const referencias = (await pool.query(
      `SELECT id AS empleado_id, foto_url FROM empleados
       WHERE activo AND foto_url IS NOT NULL AND descriptor_foto IS DISTINCT FROM foto_url ORDER BY id LIMIT 10`)).rows;
    const pendientes = (await pool.query(
      `SELECT c.id, c.empleado_id, c.foto_url FROM checadas c JOIN empleados e ON e.id = c.empleado_id
       WHERE c.revision = 'pendiente' AND c.foto_url IS NOT NULL
         AND e.foto_url IS NOT NULL AND e.descriptor_foto = e.foto_url AND e.descriptor_facial IS NOT NULL
       ORDER BY c.id LIMIT 10`)).rows;
    res.json({ referencias, pendientes });
  } catch (e) { next(e); }
});

// Rasgos de la foto del expediente (descriptor = null si la foto no muestra un rostro)
router.post('/referencia', async (req, res, next) => {
  try {
    const { empleado_id, foto_url, descriptor } = req.body;
    if (descriptor !== null && !esDescriptor(descriptor)) return res.status(400).json({ error: 'Datos de rostro inválidos.' });
    const r = await pool.query(
      'UPDATE empleados SET descriptor_facial = $1, descriptor_foto = $2 WHERE id = $3 AND foto_url = $2 RETURNING id',
      [descriptor ? JSON.stringify(descriptor) : null, foto_url, empleado_id]);
    if (r.rows[0] && !descriptor) {
      await pool.query(
        `UPDATE checadas SET revision = 'revisar', revision_motivo = 'La foto del expediente no muestra bien el rostro'
         WHERE empleado_id = $1 AND revision = 'pendiente'`, [empleado_id]);
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Resultado de una selfie: el servidor compara con el expediente y decide
router.post('/resultado/:id', async (req, res, next) => {
  try {
    const { descriptor } = req.body;
    if (descriptor !== null && !esDescriptor(descriptor)) return res.status(400).json({ error: 'Datos de rostro inválidos.' });
    const c = (await pool.query(
      `SELECT c.id, e.descriptor_facial FROM checadas c JOIN empleados e ON e.id = c.empleado_id
       WHERE c.id = $1 AND c.revision = 'pendiente'`, [req.params.id])).rows[0];
    if (!c) return res.json({ ok: true, omitida: true });
    if (!descriptor) {
      await pool.query("UPDATE checadas SET revision = 'revisar', revision_motivo = 'No se ve un rostro en la foto de la checada' WHERE id = $1", [c.id]);
      return res.json({ ok: true, revision: 'revisar' });
    }
    if (!esDescriptor(c.descriptor_facial)) return res.json({ ok: true, omitida: true });
    const d = distancia(descriptor, c.descriptor_facial);
    const coincide = d < await umbral();
    await pool.query(
      `UPDATE checadas SET revision = $1, verificado_facial = $2, distancia_facial = $3, revision_motivo = $4 WHERE id = $5`,
      [coincide ? 'ok' : 'revisar', coincide, Math.round(d * 1000) / 1000, coincide ? null : 'El rostro no coincide con la foto del expediente', c.id]);
    res.json({ ok: true, revision: coincide ? 'ok' : 'revisar' });
  } catch (e) { next(e); }
});

// Contador para avisos (dashboard / menú)
router.get('/conteo', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE revision = 'revisar')::int AS revisar,
              COUNT(*) FILTER (WHERE revision = 'pendiente')::int AS pendientes
       FROM checadas WHERE revision IN ('revisar', 'pendiente')`);
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// Lista de checadas por revisar (administrador)
router.get('/', requiereAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.fecha, c.hora, c.tipo, c.foto_url, c.revision_motivo, c.distancia_facial, c.creado_en,
              e.id AS empleado_id, e.nombre, e.puesto, e.foto_url AS foto_ref
       FROM checadas c JOIN empleados e ON e.id = c.empleado_id
       WHERE c.revision = 'revisar' ORDER BY c.fecha DESC, c.hora DESC LIMIT 100`);
    res.json({ umbral: await umbral(), checadas: rows });
  } catch (e) { next(e); }
});

// "Sí es él": se confirma la checada (queda en auditoría)
router.post('/:id/aprobar', requiereAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE checadas SET revision = 'aprobada', revisado_por = $1, revisado_en = NOW()
       WHERE id = $2 AND revision = 'revisar' RETURNING id, empleado_id, fecha, hora, tipo`, [req.usuario.nombre || req.usuario.usuario || 'admin', req.params.id]);
    const c = rows[0];
    if (!c) return res.status(404).json({ error: 'Esa checada ya no está por revisar.' });
    await pool.query(
      `INSERT INTO auditoria_checadas (checada_id, empleado_id, admin_id, accion, valor_anterior, valor_nuevo)
       VALUES ($1,$2,$3,'aprobada',$4,$5)`,
      [c.id, c.empleado_id, req.usuario.id, `${c.fecha} ${String(c.hora).slice(0, 8)} (${c.tipo}) por revisar`, 'Rostro confirmado por el administrador']);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
