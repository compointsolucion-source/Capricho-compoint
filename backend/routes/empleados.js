const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { verificarToken, requiereAdmin } = require('../middleware/auth');
const { guardarDataUrl } = require('../utils/archivos');
const { buscarEmpleadoPorPin } = require('../utils/pin');
const { auditarFin } = require('../utils/finanzas');

const router = express.Router();
router.use(verificarToken);

const COLUMNAS = `e.id, e.nombre, e.puesto, e.departamento, e.sucursal, e.foto_url, e.numero_empleado,
  e.huella_id, e.horario_id, e.jefe_directo_id, e.fecha_ingreso, e.activo, e.creado_en, e.sueldo_diario, e.permisos, e.correo,
  (e.pin_hash IS NOT NULL) AS tiene_pin,
  (e.foto_url IS NOT NULL AND e.descriptor_foto = e.foto_url AND e.descriptor_facial IS NULL) AS foto_sin_rostro,
  (SELECT json_build_object('id', d.id, 'descripcion', d.descripcion, 'creado_en', d.creado_en, 'ultimo_uso', d.ultimo_uso)
     FROM dispositivos d WHERE d.empleado_id = e.id AND d.activo) AS celular`;

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
  const correo = String(body.correo || '').trim();
  if (correo && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(correo)) errores.push('El correo no es válido.');
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
      correo: correo || null,
      sueldo_diario: Math.max(0, Math.round((Number(String(body.sueldo_diario ?? 0).replace(/[$,\s]/g, '')) || 0) * 100) / 100),
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
      `INSERT INTO empleados (nombre, puesto, departamento, sucursal, numero_empleado, huella_id, horario_id, fecha_ingreso, activo, pin_hash, foto_url, sueldo_diario, correo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [datos.nombre, datos.puesto, datos.departamento, datos.sucursal, datos.numero_empleado, datos.huella_id,
       datos.horario_id, datos.fecha_ingreso, datos.activo, pinHash, fotoUrl, datos.sueldo_diario, datos.correo]
    );
    res.json({ ok: true, id: rows[0].id });
  } catch (e) { next(e); }
});

router.put('/:id', requiereAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { errores, datos } = await validar(req.body, id);
    if (errores.length) return res.status(400).json({ error: errores.join(' ') });
    const sets = ['nombre=$1', 'puesto=$2', 'departamento=$3', 'sucursal=$4', 'numero_empleado=$5', 'huella_id=$6', 'horario_id=$7', 'fecha_ingreso=$8', 'activo=$9', 'sueldo_diario=$10', 'correo=$11'];
    const valores = [datos.nombre, datos.puesto, datos.departamento, datos.sucursal, datos.numero_empleado, datos.huella_id, datos.horario_id, datos.fecha_ingreso, datos.activo, datos.sueldo_diario, datos.correo];
    if (datos.pin) { valores.push(await bcrypt.hash(datos.pin, 10)); sets.push(`pin_hash=$${valores.length}`); }
    if (req.body.foto) { valores.push(await guardarDataUrl(req.body.foto)); sets.push(`foto_url=$${valores.length}`); }
    if (req.body.quitar_pin) sets.push('pin_hash=NULL');
    valores.push(id);
    await pool.query(`UPDATE empleados SET ${sets.join(', ')} WHERE id=$${valores.length}`, valores);
    if (req.body.foto) {
      // Foto nueva: las checadas que no se pudieron comparar por la foto anterior se vuelven a revisar
      await pool.query(
        `UPDATE checadas SET revision = 'pendiente', revision_motivo = NULL WHERE empleado_id = $1 AND revision = 'revisar'
         AND revision_motivo IN ('Sin foto en el expediente para comparar', 'La foto del expediente no muestra bien el rostro')`, [id]);
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.patch('/:id/toggle', requiereAdmin, async (req, res, next) => {
  try {
    await pool.query('UPDATE empleados SET activo = NOT activo WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Cuánto historial tiene (para avisar antes de eliminar)
async function historial(id, cliente = pool) {
  const { rows } = await cliente.query(
    `SELECT (SELECT COUNT(*)::int FROM checadas WHERE empleado_id = $1) AS checadas,
            (SELECT COUNT(*)::int FROM nomina_pagos WHERE empleado_id = $1) AS pagos,
            (SELECT COALESCE(SUM(total), 0)::float FROM nomina_pagos WHERE empleado_id = $1) AS pagado,
            (SELECT COUNT(*)::int FROM incidencias WHERE empleado_id = $1) AS incidencias,
            (SELECT COUNT(*)::int FROM bonos_extra WHERE empleado_id = $1) AS bonos`, [id]);
  return rows[0];
}
router.get('/:id/historial', requiereAdmin, async (req, res, next) => {
  try { res.json(await historial(req.params.id)); } catch (e) { next(e); }
});

// Eliminar definitivamente: borra al empleado con TODO su historial (checadas, incidencias,
// bonos y pagos de nómina) y sus fotos. Queda registrado en Auditoría.
router.delete('/:id', requiereAdmin, async (req, res, next) => {
  const cliente = await pool.connect();
  try {
    const id = Number(req.params.id);
    await cliente.query('BEGIN');
    const e = (await cliente.query('SELECT id, nombre, puesto, numero_empleado, foto_url FROM empleados WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!e) { await cliente.query('ROLLBACK'); return res.status(404).json({ error: 'Empleado no encontrado.' }); }
    const h = await historial(id, cliente);
    const urls = (await cliente.query(
      `SELECT foto_url AS u FROM empleados WHERE id = $1 UNION SELECT foto_url FROM checadas WHERE empleado_id = $1
       UNION SELECT archivo_url FROM incidencias WHERE empleado_id = $1`, [id])).rows.map((r) => r.u).filter(Boolean);
    const ids = urls.map((u) => (/\/api\/archivos\/([0-9a-f-]{36})$/.exec(u) || [])[1]).filter(Boolean);
    await cliente.query('UPDATE administradores SET empleado_id = NULL WHERE empleado_id = $1', [id]);
    await cliente.query("DELETE FROM recuperaciones WHERE tipo = 'empleado' AND cuenta_id = $1", [id]);
    await cliente.query('DELETE FROM empleados WHERE id = $1', [id]);
    if (ids.length) await cliente.query('DELETE FROM archivos WHERE id = ANY($1::uuid[])', [ids]);
    await auditarFin(cliente, { modulo: 'empleados', registroId: id, accion: 'eliminado',
      descripcion: `Empleado ${e.nombre} eliminado con su historial (${h.checadas} checadas, ${h.pagos} pagos de nómina, ${h.incidencias} incidencias)`,
      antes: { nombre: e.nombre, puesto: e.puesto, numero_empleado: e.numero_empleado, ...h }, usuario: req.usuario.nombre || req.usuario.usuario });
    await cliente.query('COMMIT');
    res.json({ ok: true });
  } catch (err) { await cliente.query('ROLLBACK').catch(() => {}); next(err); } finally { cliente.release(); }
});

// Liberar el celular registrado (el empleado podrá registrar otro al checar)
router.delete('/:id/dispositivo', requiereAdmin, async (req, res, next) => {
  try {
    await pool.query('UPDATE dispositivos SET activo = FALSE WHERE empleado_id = $1 AND activo', [req.params.id]);
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
