const express = require('express');
const pool = require('../db');
const { verificarToken, requiereAdmin } = require('../middleware/auth');
const { ahora } = require('../utils/tiempo');

const router = express.Router();

// Archivos (fotos y justificantes). El id es un UUID imposible de adivinar,
// así la foto de referencia se puede leer desde el celular al checar.
router.get('/archivos/:id', async (req, res, next) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).end();
    const { rows } = await pool.query('SELECT tipo_mime, datos FROM archivos WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).end();
    res.set('Content-Type', rows[0].tipo_mime);
    res.set('Cache-Control', 'private, max-age=86400');
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(rows[0].datos);
  } catch (e) { next(e); }
});

router.use(verificarToken, requiereAdmin);

const TABLAS = ['configuracion', 'configuracion_smtp', 'horarios', 'empleados', 'administradores', 'checadas',
  'qr_tokens', 'dias_festivos', 'incidencias', 'auditoria_checadas', 'archivos',
  'conceptos_gasto', 'cortes', 'gastos', 'bonos_extra', 'nomina_pagos', 'auditoria_finanzas'];

function literal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (Buffer.isBuffer(v)) return `'\\x${v.toString('hex')}'::bytea`;
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

// Respaldo completo en SQL (se descarga a tu computadora). Neon además
// guarda historial propio para restaurar a un punto en el tiempo.
router.get('/respaldo', async (req, res, next) => {
  try {
    const sinFotos = req.query.sin_fotos === '1';
    const { fecha, hora } = ahora();
    let sql = `-- Respaldo Capricho-compoint — ${fecha} ${hora}\n-- Restaurar: pegar en el SQL Editor de Neon sobre una base con el esquema creado.\nBEGIN;\n`;
    const orden = [...TABLAS].reverse();
    sql += `TRUNCATE ${orden.join(', ')} RESTART IDENTITY CASCADE;\n\n`;
    for (const t of TABLAS) {
      if (t === 'qr_tokens' || (sinFotos && t === 'archivos')) continue;
      const { rows } = await pool.query(`SELECT * FROM ${t}`);
      if (!rows.length) continue;
      const cols = Object.keys(rows[0]);
      sql += `-- ${t}\n`;
      // Los jefes directos se asignan al final (un empleado puede apuntar a otro que aún no se insertó)
      const esEmp = t === 'empleados';
      for (const r of rows) {
        sql += `INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map((c) => literal(esEmp && c === 'jefe_directo_id' ? null : r[c])).join(', ')});\n`;
      }
      if (esEmp) {
        for (const r of rows.filter((x) => x.jefe_directo_id)) {
          sql += `UPDATE empleados SET jefe_directo_id = ${r.jefe_directo_id} WHERE id = ${r.id};\n`;
        }
      }
      if (cols.includes('id') && t !== 'archivos' && t !== 'configuracion' && t !== 'configuracion_smtp') {
        sql += `SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT MAX(id) FROM ${t}), 1));\n`;
      }
      sql += '\n';
    }
    sql += 'COMMIT;\n';
    const nombre = `respaldo_capricho_${fecha}_${hora.replace(/:/g, '')}.sql`;
    res.set('Content-Type', 'application/sql; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${nombre}"`);
    res.send(sql);
  } catch (e) { next(e); }
});

router.get('/conteos', async (req, res, next) => {
  try {
    const q = (t) => pool.query(`SELECT COUNT(*)::int AS n FROM ${t}`).then((r) => r.rows[0].n);
    const [empleados, checadas, horarios, incidencias, usuarios, festivos, archivos, cortes, gastos] = await Promise.all(
      ['empleados', 'checadas', 'horarios', 'incidencias', 'administradores', 'dias_festivos', 'archivos', 'cortes', 'gastos'].map(q)
    );
    const tam = (await pool.query('SELECT pg_database_size(current_database())::bigint AS b')).rows[0].b;
    res.json({ empleados, checadas, horarios, incidencias, usuarios, festivos, archivos, cortes, gastos, tamano_bytes: Number(tam) });
  } catch (e) { next(e); }
});

const FRASES = { historial: 'BORRAR HISTORIAL', operativo: 'BORRAR TODO', fabrica: 'REINICIO DE FABRICA' };

router.post('/reinicio', async (req, res, next) => {
  const nivel = req.body.nivel;
  if (!FRASES[nivel]) return res.status(400).json({ error: 'Nivel inválido.' });
  if (String(req.body.frase || '').trim().toUpperCase() !== FRASES[nivel]) {
    return res.status(400).json({ error: 'La frase de confirmación no coincide. No se hizo ningún cambio.' });
  }
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    let mensaje = '';
    if (nivel === 'historial') {
      await c.query('DELETE FROM checadas; DELETE FROM auditoria_checadas; DELETE FROM incidencias; DELETE FROM qr_tokens; DELETE FROM nomina_pagos; DELETE FROM bonos_extra; DELETE FROM gastos; DELETE FROM cortes; DELETE FROM auditoria_finanzas;');
      mensaje = 'Se borró todo el historial (checadas, incidencias, cortes, gastos, nómina pagada y auditorías). Empleados, horarios, proveedores y usuarios se conservaron.';
    } else {
      await c.query('UPDATE administradores SET empleado_id = NULL');
      await c.query('DELETE FROM gastos; DELETE FROM cortes; DELETE FROM auditoria_finanzas; DELETE FROM empleados; DELETE FROM horarios; DELETE FROM dias_festivos; DELETE FROM qr_tokens; DELETE FROM archivos;');
      mensaje = 'Se borraron empleados, horarios, días festivos e historial completo. Los usuarios y la configuración se conservaron.';
      if (nivel === 'fabrica') {
        await c.query('DELETE FROM administradores WHERE id <> $1', [req.usuario.id]);
        await c.query("UPDATE administradores SET rol = 'admin', empleado_id = NULL WHERE id = $1", [req.usuario.id]);
        await c.query("UPDATE configuracion_smtp SET proveedor='gmail', host='smtp.gmail.com', puerto=587, usuario=NULL, contrasena=NULL, correo_remitente=NULL, nombre_remitente=NULL WHERE id=1");
        await c.query("UPDATE configuracion SET empresa_nombre='Compoint', tema='oscuro-neon', qr_vigencia_segundos=25, requiere_facial=FALSE, tolerancia_default_min=10 WHERE id=1");
        mensaje = 'Reinicio de fábrica completo. El sistema quedó como recién instalado. Tu usuario sigue activo para que no te quedes fuera.';
      }
    }
    await c.query('COMMIT');
    res.json({ ok: true, mensaje });
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    next(e);
  } finally { c.release(); }
});

module.exports = router;
