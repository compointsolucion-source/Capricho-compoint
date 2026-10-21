const express = require('express');
const pool = require('../db');
const { verificarFinanzas, requierePermiso, soloAdmin, quien } = require('../middleware/finanzas');
const {
  PERMISOS, r2, config, diaOperacion, semanaDe, calcularNomina, calcularSemana, calcularMes, auditarFin
} = require('../utils/finanzas');
const { guardarDataUrl, errorUsuario } = require('../utils/archivos');
const { enviarCorreo } = require('../utils/correo');
const { ahora, sumarDias } = require('../utils/tiempo');

const router = express.Router();
router.use(verificarFinanzas);

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const fechaValida = (f) => typeof f === 'string' && FECHA.test(f) && !isNaN(new Date(`${f}T12:00:00Z`));
const dinero = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  if (!isFinite(n) || n < 0 || n > 99999999) throw errorUsuario('Monto inválido.');
  return r2(n);
};
const TIPO_PERMISO = { dia: 'corte', semanal: 'gastos', proveedor: 'surtida', abastos: 'surtida' };

// ¿Puede capturar/modificar en esa fecha? (empleados: solo el día de operación actual o la semana actual)
async function ventanaPermitida(req, fecha, tipo) {
  if (req.fin.tipo === 'admin' || req.fin.permisos.corregir) return true;
  const conf = await config();
  const hoyOp = diaOperacion(conf.hora_corte_dia);
  if (tipo === 'dia') return fecha === hoyOp;
  return semanaDe(fecha).lunes === semanaDe(hoyOp).lunes;
}

// ---------------- Quién soy / configuración ----------------
router.get('/yo', async (req, res, next) => {
  try {
    const conf = await config();
    const hoy = diaOperacion(conf.hora_corte_dia);
    res.json({
      ...req.fin, dia_operacion: hoy, semana: semanaDe(hoy),
      config: { dias_operacion: conf.dias_operacion, hora_corte_dia: conf.hora_corte_dia, comision_tarjeta: conf.comision_tarjeta,
        bono_puntualidad: conf.bono_puntualidad, bono_semana_perfecta: conf.bono_semana_perfecta, tolerancia: conf.tolerancia,
        pierde_con_falta: conf.pierde_con_falta }
    });
  } catch (e) { next(e); }
});

// ---------------- Catálogo de conceptos ----------------
router.get('/conceptos', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM conceptos_gasto ${req.query.todos === '1' && req.fin.tipo === 'admin' ? '' : 'WHERE activo = TRUE'}
       ORDER BY tipo, orden, nombre`);
    res.json(rows.map((c) => ({ ...c, monto_sugerido: c.monto_sugerido === null ? null : Number(c.monto_sugerido) })));
  } catch (e) { next(e); }
});

function datosConcepto(b) {
  const nombre = String(b.nombre || '').trim();
  if (!nombre) throw errorUsuario('Escribe el nombre del concepto.');
  if (!['dia', 'semanal', 'proveedor', 'abastos'].includes(b.tipo)) throw errorUsuario('Tipo inválido.');
  const tel = String(b.telefono || '').replace(/\D/g, '');
  return [nombre, b.tipo, String(b.grupo || '').trim() || null, String(b.icono || '').trim().slice(0, 8) || null,
    tel || null, String(b.ubicacion || '').trim() || null, dinero(b.monto_sugerido), Number(b.orden) || 0, b.activo !== false];
}

router.post('/conceptos', soloAdmin, async (req, res, next) => {
  try {
    await pool.query(
      `INSERT INTO conceptos_gasto (nombre, tipo, grupo, icono, telefono, ubicacion, monto_sugerido, orden, activo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, datosConcepto(req.body));
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Ya existe un concepto con ese nombre en ese tipo.' });
    next(e);
  }
});

router.put('/conceptos/:id', soloAdmin, async (req, res, next) => {
  try {
    await pool.query(
      `UPDATE conceptos_gasto SET nombre=$1, tipo=$2, grupo=$3, icono=$4, telefono=$5, ubicacion=$6, monto_sugerido=$7, orden=$8, activo=$9
       WHERE id=$10`, [...datosConcepto(req.body), req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Ya existe un concepto con ese nombre en ese tipo.' });
    next(e);
  }
});

// ---------------- Corte del día ----------------
async function leerCorte(fecha) {
  const [c, g] = await Promise.all([
    pool.query('SELECT * FROM cortes WHERE fecha = $1', [fecha]),
    pool.query("SELECT * FROM gastos WHERE fecha = $1 AND tipo = 'dia' ORDER BY id", [fecha])
  ]);
  const corte = c.rows[0] || null;
  const gastos = g.rows.map((x) => ({ ...x, monto: Number(x.monto) }));
  const venta = corte ? Number(corte.venta_total) : 0;
  const tarjeta = corte ? Number(corte.venta_tarjeta) : 0;
  const sumaGastos = r2(gastos.reduce((s, x) => s + x.monto, 0));
  const efectivoFinal = r2(venta - tarjeta - sumaGastos);
  const contado = corte && corte.efectivo_contado !== null ? Number(corte.efectivo_contado) : null;
  return {
    corte: corte ? { ...corte, venta_total: venta, venta_tarjeta: tarjeta, efectivo_contado: contado } : null,
    gastos,
    resumen: {
      venta_total: venta, venta_tarjeta: tarjeta, venta_efectivo: r2(venta - tarjeta), gastos: sumaGastos,
      efectivo_final: efectivoFinal, efectivo_contado: contado, diferencia: contado === null ? null : r2(contado - efectivoFinal)
    }
  };
}

router.get('/corte', requierePermiso('corte', 'ver_semana'), async (req, res, next) => {
  try {
    const conf = await config();
    const hoyOp = diaOperacion(conf.hora_corte_dia);
    const fecha = fechaValida(req.query.fecha) ? req.query.fecha : hoyOp;
    if (fecha !== hoyOp && !req.fin.permisos.ver_semana && !req.fin.permisos.corregir) {
      return res.status(403).json({ error: 'Solo puedes ver el corte del día de hoy.' });
    }
    const datos = await leerCorte(fecha);
    const cerrado = datos.corte?.estado === 'cerrado';
    const enVentana = await ventanaPermitida(req, fecha, 'dia');
    res.json({
      fecha, dia_operacion: hoyOp, ...datos,
      editable: req.fin.permisos.corte && enVentana && (!cerrado || req.fin.permisos.corregir),
      puede_cerrar: req.fin.permisos.corte && enVentana && !cerrado,
      puede_reabrir: cerrado && req.fin.permisos.corregir
    });
  } catch (e) { next(e); }
});

async function exigirCorteEditable(req, fecha) {
  if (!req.fin.permisos.corte) throw Object.assign(new Error('No tienes permiso para capturar el corte.'), { status: 403 });
  if (!(await ventanaPermitida(req, fecha, 'dia'))) throw Object.assign(new Error('Solo puedes capturar el corte del día de hoy.'), { status: 403 });
  const { rows } = await pool.query('SELECT * FROM cortes WHERE fecha = $1', [fecha]);
  if (rows[0]?.estado === 'cerrado' && !req.fin.permisos.corregir) {
    throw Object.assign(new Error('Este corte ya está cerrado. Solo el dueño puede corregirlo.'), { status: 403 });
  }
  return rows[0] || null;
}

router.put('/corte', async (req, res, next) => {
  try {
    const b = req.body;
    if (!fechaValida(b.fecha)) return res.status(400).json({ error: 'Fecha inválida.' });
    const antes = await exigirCorteEditable(req, b.fecha);
    const venta = dinero(b.venta_total) ?? 0;
    const tarjeta = dinero(b.venta_tarjeta) ?? 0;
    if (tarjeta > venta) return res.status(400).json({ error: 'La venta con tarjeta no puede ser mayor que la venta total.' });
    const contado = dinero(b.efectivo_contado);
    let foto = antes?.foto_terminal_url || null;
    if (b.foto_terminal) foto = await guardarDataUrl(b.foto_terminal, { maxMb: 4 });
    const notas = String(b.notas || '').trim().slice(0, 255) || null;
    const { rows } = await pool.query(
      `INSERT INTO cortes (fecha, venta_total, venta_tarjeta, efectivo_contado, foto_terminal_url, notas, capturado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (fecha) DO UPDATE SET venta_total=$2, venta_tarjeta=$3, efectivo_contado=$4, foto_terminal_url=$5,
         notas=$6, capturado_por=COALESCE(cortes.capturado_por, $7), actualizado_en=NOW()
       RETURNING *`, [b.fecha, venta, tarjeta, contado, foto, notas, quien(req)]);
    if (antes?.estado === 'cerrado') {
      await auditarFin(null, { modulo: 'corte', registroId: rows[0].id, accion: 'corregido', usuario: quien(req),
        descripcion: `Corte del ${b.fecha} corregido después de cerrado`,
        antes: { venta_total: antes.venta_total, venta_tarjeta: antes.venta_tarjeta, efectivo_contado: antes.efectivo_contado },
        despues: { venta_total: venta, venta_tarjeta: tarjeta, efectivo_contado: contado } });
    }
    res.json({ ok: true, ...(await leerCorte(b.fecha)) });
  } catch (e) { next(e); }
});

router.post('/corte/cerrar', async (req, res, next) => {
  try {
    const fecha = req.body.fecha;
    if (!fechaValida(fecha)) return res.status(400).json({ error: 'Fecha inválida.' });
    if (!req.fin.permisos.corte) return res.status(403).json({ error: 'No tienes permiso para cerrar el corte.' });
    if (!(await ventanaPermitida(req, fecha, 'dia'))) return res.status(403).json({ error: 'Solo puedes cerrar el corte del día de hoy.' });
    const d = await leerCorte(fecha);
    if (!d.corte) return res.status(400).json({ error: 'Primero captura la venta del día.' });
    if (d.corte.estado === 'cerrado') return res.status(400).json({ error: 'Este corte ya estaba cerrado.' });
    if (d.resumen.venta_total <= 0 && req.body.confirmar_sin_venta !== true) {
      return res.status(400).json({ error: 'La venta total está en $0. Si de verdad no hubo venta, confirma para cerrar.', requiere_confirmacion: true });
    }
    await pool.query(`UPDATE cortes SET estado='cerrado', cerrado_por=$1, cerrado_en=NOW(), actualizado_en=NOW() WHERE fecha=$2`, [quien(req), fecha]);
    const conf = await config();
    if (conf.aviso_corte_correo) {
      const r = d.resumen;
      const f = (n) => `$${Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      const caja = r.diferencia === null ? 'sin arqueo' : r.diferencia === 0 ? 'caja cuadrada' : r.diferencia < 0 ? `faltan ${f(-r.diferencia)}` : `sobran ${f(r.diferencia)}`;
      enviarCorreo(conf.aviso_corte_correo, `Corte cerrado ${fecha} — ${caja}`,
        `<h2>Corte del ${fecha}</h2><p>Cerrado por <b>${quien(req)}</b></p>
         <p>Venta total: <b>${f(r.venta_total)}</b><br>Venta tarjeta: ${f(r.venta_tarjeta)}<br>Gastos del día: ${f(r.gastos)}<br>
         Efectivo final: <b>${f(r.efectivo_final)}</b><br>Contado en caja: ${r.efectivo_contado === null ? '—' : f(r.efectivo_contado)} (${caja})</p>`)
        .catch(() => {});
    }
    res.json({ ok: true, ...(await leerCorte(fecha)) });
  } catch (e) { next(e); }
});

router.post('/corte/reabrir', requierePermiso('corregir'), async (req, res, next) => {
  try {
    const fecha = req.body.fecha;
    const { rows } = await pool.query(`UPDATE cortes SET estado='abierto', actualizado_en=NOW() WHERE fecha=$1 AND estado='cerrado' RETURNING id`, [fecha]);
    if (!rows[0]) return res.status(400).json({ error: 'Ese corte no está cerrado.' });
    await auditarFin(null, { modulo: 'corte', registroId: rows[0].id, accion: 'reabierto', descripcion: `Corte del ${fecha} reabierto`, usuario: quien(req) });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------------- Gastos (del día, semanales, surtida) ----------------
router.post('/gastos', async (req, res, next) => {
  try {
    const b = req.body;
    if (!['dia', 'semanal', 'proveedor', 'abastos'].includes(b.tipo)) return res.status(400).json({ error: 'Tipo de gasto inválido.' });
    if (!req.fin.permisos[TIPO_PERMISO[b.tipo]]) return res.status(403).json({ error: 'No tienes permiso para capturar este tipo de gasto.' });
    if (!fechaValida(b.fecha)) return res.status(400).json({ error: 'Fecha inválida.' });
    if (b.tipo === 'dia') await exigirCorteEditable(req, b.fecha);
    else if (!(await ventanaPermitida(req, b.fecha, b.tipo))) return res.status(403).json({ error: 'Solo puedes capturar gastos de la semana actual.' });
    const monto = dinero(b.monto);
    if (!monto) return res.status(400).json({ error: 'Escribe el monto.' });
    let conceptoId = b.concepto_id ? Number(b.concepto_id) : null;
    let concepto = String(b.concepto || '').trim();
    if (conceptoId) {
      const c = (await pool.query('SELECT nombre, tipo FROM conceptos_gasto WHERE id = $1', [conceptoId])).rows[0];
      if (!c) return res.status(400).json({ error: 'Concepto no encontrado.' });
      if (c.tipo !== b.tipo) return res.status(400).json({ error: 'Ese concepto no corresponde a esta sección.' });
      if (!concepto || concepto === c.nombre) concepto = c.nombre;
    }
    if (!concepto) return res.status(400).json({ error: 'Elige o escribe el concepto.' });
    const { rows } = await pool.query(
      `INSERT INTO gastos (fecha, tipo, concepto_id, concepto, monto, nota, capturado_por) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [b.fecha, b.tipo, conceptoId, concepto.slice(0, 80), monto, String(b.nota || '').trim().slice(0, 160) || null, quien(req)]);
    res.json({ ok: true, gasto: { ...rows[0], monto: Number(rows[0].monto) } });
  } catch (e) { next(e); }
});

router.delete('/gastos/:id', async (req, res, next) => {
  try {
    const g = (await pool.query('SELECT * FROM gastos WHERE id = $1', [req.params.id])).rows[0];
    if (!g) return res.status(404).json({ error: 'Gasto no encontrado.' });
    if (!req.fin.permisos[TIPO_PERMISO[g.tipo]]) return res.status(403).json({ error: 'No tienes permiso para borrar este gasto.' });
    if (g.tipo === 'dia') await exigirCorteEditable(req, g.fecha);
    else if (!(await ventanaPermitida(req, g.fecha, g.tipo))) return res.status(403).json({ error: 'Solo puedes borrar gastos de la semana actual.' });
    await pool.query('DELETE FROM gastos WHERE id = $1', [g.id]);
    await auditarFin(null, { modulo: 'gasto', registroId: g.id, accion: 'eliminado', usuario: quien(req),
      descripcion: `${g.concepto} $${Number(g.monto)} del ${g.fecha} (${g.tipo})`, antes: { ...g, monto: Number(g.monto) } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------------- Hoja semanal ----------------
router.get('/semana', requierePermiso('ver_semana', 'surtida', 'gastos'), async (req, res, next) => {
  try {
    const conf = await config();
    const hoyOp = diaOperacion(conf.hora_corte_dia);
    const fecha = fechaValida(req.query.fecha) ? req.query.fecha : hoyOp;
    const { lunes } = semanaDe(fecha);
    const p = req.fin.permisos;
    if (lunes !== semanaDe(hoyOp).lunes && !p.ver_semana) return res.status(403).json({ error: 'Solo puedes ver la semana actual.' });
    const s = await calcularSemana(lunes, { conNomina: true });
    const anterior = p.ver_utilidad ? (await calcularSemana(sumarDias(lunes, -7), { conNomina: true })).cuenta : null;
    // Lo que cada quien puede ver
    const salida = { lunes: s.lunes, domingo: s.domingo, dia_operacion: hoyOp, permisos: p,
      editable: { gastos: p.gastos && (await ventanaPermitida(req, lunes, 'semanal')), surtida: p.surtida && (await ventanaPermitida(req, lunes, 'proveedor')) } };
    const tiposVisibles = [p.ver_semana && 'dia', (p.ver_semana || p.gastos) && 'semanal', (p.ver_semana || p.surtida) && 'proveedor', (p.ver_semana || p.surtida) && 'abastos'].filter(Boolean);
    salida.gastos = s.gastos.filter((g) => tiposVisibles.includes(g.tipo));
    if (p.ver_semana) { salida.dias = s.dias; salida.grupos = s.grupos; }
    if (p.ver_utilidad) {
      salida.cuenta = s.cuenta;
      salida.anterior = anterior ? { venta_total: anterior.venta_total, utilidad: anterior.utilidad } : null;
      salida.nomina = s.nomina ? { totales: s.nomina.totales, empleados: s.nomina.empleados.map((e) => ({ nombre: e.nombre, puesto: e.puesto, sueldo: e.sueldo, bono_puntualidad: e.bono_puntualidad, bonos_extra: e.bonos_extra, total: e.pago ? e.pago.total : e.total, pagado: !!e.pago, dias_trabajados: e.dias_trabajados })) } : null;
    }
    res.json(salida);
  } catch (e) { next(e); }
});

// ---------------- Mes ----------------
router.get('/mes', requierePermiso('ver_utilidad'), async (req, res, next) => {
  try {
    const hoy = ahora().fecha;
    const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : hoy.slice(0, 7);
    const [a, m] = mes.split('-').map(Number);
    const ant = m === 1 ? `${a - 1}-12` : `${a}-${String(m - 1).padStart(2, '0')}`;
    const [actual, anterior] = await Promise.all([calcularMes(mes), calcularMes(ant)]);
    res.json({ ...actual, anterior: { mes: ant, ...anterior.totales } });
  } catch (e) { next(e); }
});

// ---------------- Nómina y pagos ----------------
router.get('/nomina', requierePermiso('nomina'), async (req, res, next) => {
  try {
    const conf = await config();
    const fecha = fechaValida(req.query.fecha) ? req.query.fecha : diaOperacion(conf.hora_corte_dia);
    const nom = await calcularNomina(semanaDe(fecha).lunes);
    let ganancia = null;
    if (req.fin.permisos.ver_utilidad) ganancia = (await calcularSemana(nom.lunes, { conNomina: true })).cuenta;
    res.json({ ...nom, ganancia });
  } catch (e) { next(e); }
});

async function semanaPagada(semana, empleadoId) {
  const { rows } = await pool.query('SELECT id FROM nomina_pagos WHERE semana = $1 AND empleado_id = $2', [semana, empleadoId]);
  return !!rows[0];
}

router.post('/nomina/bonos', requierePermiso('nomina'), async (req, res, next) => {
  try {
    const b = req.body;
    if (!fechaValida(b.semana)) return res.status(400).json({ error: 'Semana inválida.' });
    const semana = semanaDe(b.semana).lunes;
    const concepto = String(b.concepto || '').trim();
    const monto = Number(String(b.monto || '').replace(/[$,\s]/g, ''));
    if (!concepto) return res.status(400).json({ error: 'Escribe el motivo del bono.' });
    if (!isFinite(monto) || monto === 0 || Math.abs(monto) > 1000000) return res.status(400).json({ error: 'Monto inválido (usa negativo para descuentos).' });
    if (await semanaPagada(semana, b.empleado_id)) return res.status(400).json({ error: 'A este empleado ya se le pagó esa semana. Deshaz el pago para cambiarlo.' });
    await pool.query('INSERT INTO bonos_extra (semana, empleado_id, concepto, monto, creado_por) VALUES ($1,$2,$3,$4,$5)',
      [semana, b.empleado_id, concepto.slice(0, 80), r2(monto), quien(req)]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/nomina/bonos/:id', requierePermiso('nomina'), async (req, res, next) => {
  try {
    const b = (await pool.query('SELECT * FROM bonos_extra WHERE id = $1', [req.params.id])).rows[0];
    if (!b) return res.status(404).json({ error: 'Bono no encontrado.' });
    if (await semanaPagada(b.semana, b.empleado_id)) return res.status(400).json({ error: 'Esa semana ya se pagó. Deshaz el pago para cambiarlo.' });
    await pool.query('DELETE FROM bonos_extra WHERE id = $1', [b.id]);
    await auditarFin(null, { modulo: 'nomina', registroId: b.id, accion: 'bono_eliminado', usuario: quien(req), descripcion: `${b.concepto} $${Number(b.monto)}`, antes: b });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/nomina/pagar', requierePermiso('nomina'), async (req, res, next) => {
  try {
    const b = req.body;
    if (!fechaValida(b.semana)) return res.status(400).json({ error: 'Semana inválida.' });
    const metodo = b.metodo === 'transferencia' ? 'transferencia' : 'efectivo';
    const semana = semanaDe(b.semana).lunes;
    const nom = await calcularNomina(semana, { empleadoId: Number(b.empleado_id) });
    const e = nom.empleados[0];
    if (!e) return res.status(404).json({ error: 'Ese empleado no tiene nómina esta semana.' });
    if (e.pago) return res.status(400).json({ error: 'A este empleado ya se le pagó esta semana.' });
    if (e.total <= 0) return res.status(400).json({ error: 'El total a pagar es $0. Revisa su sueldo por día en Empleados.' });
    await pool.query(
      `INSERT INTO nomina_pagos (semana, empleado_id, dias_trabajados, dias_puntuales, sueldo_diario, sueldo, bono_puntualidad, bonos_extra, total, detalle, metodo, pagado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [semana, e.empleado_id, e.dias_trabajados, e.dias_puntuales, e.sueldo_diario, e.sueldo, e.bono_puntualidad, e.bonos_extra, e.total,
       JSON.stringify({ detalle: e.detalle, extras: e.extras, semana_perfecta: e.semana_perfecta, retardos: e.retardos, faltas: e.faltas }), metodo, quien(req)]);
    res.json({ ok: true, total: e.total });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'A este empleado ya se le pagó esta semana.' });
    next(e);
  }
});

router.delete('/nomina/pagos/:id', requierePermiso('corregir'), async (req, res, next) => {
  try {
    const p = (await pool.query('SELECT * FROM nomina_pagos WHERE id = $1', [req.params.id])).rows[0];
    if (!p) return res.status(404).json({ error: 'Pago no encontrado.' });
    await pool.query('DELETE FROM nomina_pagos WHERE id = $1', [p.id]);
    await auditarFin(null, { modulo: 'nomina', registroId: p.id, accion: 'pago_deshecho', usuario: quien(req),
      descripcion: `Pago de $${Number(p.total)} (semana ${p.semana}) deshecho`, antes: { ...p, detalle: undefined } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------------- Permisos y sueldos (solo dueño) ----------------
router.get('/permisos', soloAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, nombre, puesto, numero_empleado, foto_url, sueldo_diario, permisos, (pin_hash IS NOT NULL) AS tiene_pin
       FROM empleados WHERE activo = TRUE ORDER BY nombre`);
    res.json({ empleados: rows.map((e) => ({ ...e, sueldo_diario: Number(e.sueldo_diario) })), lista: PERMISOS });
  } catch (e) { next(e); }
});

router.put('/permisos/:id', soloAdmin, async (req, res, next) => {
  try {
    const p = req.body.permisos || {};
    const limpios = Object.fromEntries(PERMISOS.map((k) => [k, p[k] === true]));
    const antes = (await pool.query('SELECT nombre, permisos FROM empleados WHERE id = $1', [req.params.id])).rows[0];
    if (!antes) return res.status(404).json({ error: 'Empleado no encontrado.' });
    await pool.query('UPDATE empleados SET permisos = $1 WHERE id = $2', [JSON.stringify(limpios), req.params.id]);
    await auditarFin(null, { modulo: 'permisos', registroId: Number(req.params.id), accion: 'cambiados', usuario: quien(req),
      descripcion: `Permisos de ${antes.nombre}`, antes: antes.permisos, despues: limpios });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------------- Auditoría de finanzas ----------------
router.get('/auditoria', soloAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM auditoria_finanzas ORDER BY creado_en DESC LIMIT 200');
    res.json(rows);
  } catch (e) { next(e); }
});

module.exports = router;
