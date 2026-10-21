const express = require('express');
const pool = require('../db');
const { verificarToken, requiereAdmin } = require('../middleware/auth');
const { ahora } = require('../utils/tiempo');

const router = express.Router();
router.use(verificarToken, requiereAdmin);

const texto = (c) => `${c.fecha} ${String(c.hora).slice(0, 8)} (${c.tipo})`;

async function auditar(cliente, checadaId, empleadoId, adminId, accion, anterior, nuevo) {
  await cliente.query(
    `INSERT INTO auditoria_checadas (checada_id, empleado_id, admin_id, accion, valor_anterior, valor_nuevo)
     VALUES ($1,$2,$3,$4,$5,$6)`, [checadaId, empleadoId, adminId, accion, anterior, nuevo]
  );
}

router.get('/', async (req, res, next) => {
  try {
    const fecha = req.query.fecha || ahora().fecha;
    const { rows } = await pool.query(
      `SELECT c.*, e.nombre FROM checadas c JOIN empleados e ON e.id = c.empleado_id
       WHERE c.fecha = $1 ORDER BY c.hora DESC, c.id DESC`, [fecha]
    );
    res.json({ fecha, checadas: rows });
  } catch (e) { next(e); }
});

function validar(b) {
  if (!b.fecha || !b.hora || !['entrada', 'salida'].includes(b.tipo)) return 'Completa fecha, hora y tipo.';
  return null;
}

router.post('/', async (req, res, next) => {
  const cliente = await pool.connect();
  try {
    const error = validar(req.body) || (!req.body.empleado_id ? 'Selecciona un empleado.' : null);
    if (error) return res.status(400).json({ error });
    const { empleado_id, fecha, hora, tipo } = req.body;
    await cliente.query('BEGIN');
    const { rows } = await cliente.query(
      `INSERT INTO checadas (empleado_id, fecha, hora, tipo, metodo) VALUES ($1,$2,$3,$4,'manual') RETURNING *`,
      [empleado_id, fecha, hora, tipo]
    );
    await auditar(cliente, rows[0].id, empleado_id, req.usuario.id, 'creada', null, texto(rows[0]));
    await cliente.query('COMMIT');
    res.json({ ok: true });
  } catch (e) { await cliente.query('ROLLBACK').catch(() => {}); next(e); } finally { cliente.release(); }
});

router.put('/:id', async (req, res, next) => {
  const cliente = await pool.connect();
  try {
    const error = validar(req.body);
    if (error) return res.status(400).json({ error });
    await cliente.query('BEGIN');
    const orig = (await cliente.query('SELECT * FROM checadas WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!orig) { await cliente.query('ROLLBACK'); return res.status(404).json({ error: 'Checada no encontrada' }); }
    const { rows } = await cliente.query(
      'UPDATE checadas SET fecha=$1, hora=$2, tipo=$3 WHERE id=$4 RETURNING *',
      [req.body.fecha, req.body.hora, req.body.tipo, req.params.id]
    );
    await auditar(cliente, orig.id, orig.empleado_id, req.usuario.id, 'editada', texto(orig), texto(rows[0]));
    await cliente.query('COMMIT');
    res.json({ ok: true });
  } catch (e) { await cliente.query('ROLLBACK').catch(() => {}); next(e); } finally { cliente.release(); }
});

router.delete('/:id', async (req, res, next) => {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const orig = (await cliente.query('DELETE FROM checadas WHERE id = $1 RETURNING *', [req.params.id])).rows[0];
    if (orig) await auditar(cliente, null, orig.empleado_id, req.usuario.id, 'eliminada', texto(orig), null);
    await cliente.query('COMMIT');
    res.json({ ok: true });
  } catch (e) { await cliente.query('ROLLBACK').catch(() => {}); next(e); } finally { cliente.release(); }
});

router.get('/auditoria', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.*, e.nombre AS empleado_nombre, ad.nombre AS admin_nombre
       FROM auditoria_checadas a
       JOIN empleados e ON e.id = a.empleado_id
       LEFT JOIN administradores ad ON ad.id = a.admin_id
       ORDER BY a.creado_en DESC LIMIT 200`
    );
    res.json(rows);
  } catch (e) { next(e); }
});

module.exports = router;
