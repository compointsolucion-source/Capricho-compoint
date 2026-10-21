const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { verificarToken, requiereAdmin } = require('../middleware/auth');
const { guardarDataUrl } = require('../utils/archivos');
const { buscarEmpleadoPorPin } = require('../utils/pin');

const router = express.Router();
router.use(verificarToken);

const COLUMNAS = `e.id, e.nombre, e.puesto, e.departamento, e.sucursal, e.foto_url, e.numero_empleado,
  e.huella_id, e.horario_id, e.jefe_directo_id, e.fecha_ingreso, e.activo, e.creado_en,
  (e.pin_hash IS NOT NULL) AS tiene_pin`;

// Lista completa (admin) — o solo su equipo directo (supervisor)
router.get('/', async (req, res, next) => {
  try {
    const params = [];
    let filtro = '';
    if (req.usuario.rol !== 'admin') {
      filtro = 'WHERE e.jefe_directo_id = $1';
      params.push(req.usuario.empleado_id || 0);
    }
    const { rows } = await pool.query(
      `SELECT ${COLUMNAS}, h.nombre AS horario_nombre FROM empleados e
       LEFT JOIN horarios h ON h.id = e.horario_id ${filtro}
       ORDER BY e.activo DESC, e.nombre ASC`, params
    );
    res.json(rows);
  } catch (e) { next(e); }
});

router.get('/:id', requiereAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT ${COLUMNAS} FROM empleados e WHERE e.id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Empleado no encontrado' });
    res.json(rows[0]);
  } catch (e) { next(e); }
});

async function validar(body, id = null) {
  const errores = [];
  const nombre = String(body.nombre || '').trim();
  const pin = String(body.pin || '').trim();
  if (!nombre) errores.push('El nombre es obligatorio.');
  if (pin && !/^\d{4}$/.test(pin)) errores.push('El PIN debe ser exactamente 4 dígitos.');
  if (pin && /^\d{4}$/.test(pin) && await buscarEmpleadoPorPin(pin, id)) {
    errores.push('Ese PIN ya lo usa otro empleado. Elige uno diferente.');
  }
  const numero = String(body.numero_empleado || '').trim();
  if (numero) {
    const { rows } = await pool.query('SELECT id FROM empleados WHERE numero_empleado = $1 AND ($2::int IS NULL OR id <> $2)', [numero, id]);
    if (rows[0]) errores.push('Ese número de empleado ya existe.');
  }
  const huella = String(body.huella_id || '').trim();
  if (huella) {
    const { rows } = await pool.query('SELECT id FROM empleados WHERE huella_id = $1 AND ($2::int IS NULL OR id <> $2)', [huella, id]);
    if (rows[0]) errores.push('Ese ID de huella ya está asignado a otro empleado.');
  }
  return {
    errores,
    datos: {
      nombre,
      puesto: String(body.puesto || '').trim() || null,
      departamento: String(body.departamento || '').trim() || null,
      sucursal: String(body.sucursal || '').trim() || null,
      numero_empleado: numero || null,
      huella_id: huella || null,
      horario_id: body.horario_id ? Number(body.horario_id) : null,
      fecha_ingreso: body.fecha_ingreso || null,
      activo: body.activo !== false,
      pin
    }
  };
}

router.post('/', requiereAdmin, async (req, res, next) => {
  try {
    const { errores, datos } = await validar(req.body);
    if (errores.length) return res.status(400).json({ error: errores.join(' ') });
    const fotoUrl = req.body.foto ? await guardarDataUrl(req.body.foto) : null;
    const pinHash = datos.pin ? await bcrypt.hash(datos.pin, 10) : null;
    const { rows } = await pool.query(
      `INSERT INTO empleados (nombre, puesto, departamento, sucursal, numero_empleado, huella_id, horario_id, fecha_ingreso, activo, pin_hash, foto_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [datos.nombre, datos.puesto, datos.departamento, datos.sucursal, datos.numero_empleado, datos.huella_id,
       datos.horario_id, datos.fecha_ingreso, datos.activo, pinHash, fotoUrl]
    );
    res.json({ ok: true, id: rows[0].id });
  } catch (e) { next(e); }
});

router.put('/:id', requiereAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { errores, datos } = await validar(req.body, id);
    if (errores.length) return res.status(400).json({ error: errores.join(' ') });
    const sets = ['nombre=$1', 'puesto=$2', 'departamento=$3', 'sucursal=$4', 'numero_empleado=$5', 'huella_id=$6', 'horario_id=$7', 'fecha_ingreso=$8', 'activo=$9'];
    const valores = [datos.nombre, datos.puesto, datos.departamento, datos.sucursal, datos.numero_empleado, datos.huella_id, datos.horario_id, datos.fecha_ingreso, datos.activo];
    if (datos.pin) { valores.push(await bcrypt.hash(datos.pin, 10)); sets.push(`pin_hash=$${valores.length}`); }
    if (req.body.foto) { valores.push(await guardarDataUrl(req.body.foto)); sets.push(`foto_url=$${valores.length}`); }
    if (req.body.quitar_pin) sets.push('pin_hash=NULL');
    valores.push(id);
    await pool.query(`UPDATE empleados SET ${sets.join(', ')} WHERE id=$${valores.length}`, valores);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.patch('/:id/toggle', requiereAdmin, async (req, res, next) => {
  try {
    await pool.query('UPDATE empleados SET activo = NOT activo WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Organigrama: asignar jefe directo (evita ciclos)
router.put('/:id/jefe', requiereAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const jefeId = req.body.jefe_directo_id ? Number(req.body.jefe_directo_id) : null;
    if (jefeId === id) return res.status(400).json({ error: 'Nadie puede ser su propio jefe.' });
    if (jefeId) {
      // Subir por la cadena del nuevo jefe: si aparece este empleado, sería un ciclo
      let actual = jefeId;
      for (let i = 0; i < 100 && actual; i++) {
        if (actual === id) return res.status(400).json({ error: 'Eso crearía un ciclo: ese jefe ya depende de este empleado.' });
        const { rows } = await pool.query('SELECT jefe_directo_id FROM empleados WHERE id = $1', [actual]);
        actual = rows[0]?.jefe_directo_id || null;
      }
    }
    await pool.query('UPDATE empleados SET jefe_directo_id = $1 WHERE id = $2', [jefeId, id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
