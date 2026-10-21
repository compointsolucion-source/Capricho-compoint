const pool = require('../db');
const { ahora, diaCodigo, sumarDias, aMinutos } = require('./tiempo');

const PERMISOS = ['corte', 'surtida', 'gastos', 'nomina', 'ver_semana', 'ver_utilidad', 'corregir'];
const TODOS = Object.fromEntries(PERMISOS.map((p) => [p, true]));
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function config() {
  const { rows } = await pool.query('SELECT * FROM configuracion WHERE id = 1');
  const c = rows[0] || {};
  return {
    dias_operacion: (c.dias_operacion || 'X,J,V,S,D').split(',').filter(Boolean),
    hora_corte_dia: c.hora_corte_dia ?? 6,
    comision_tarjeta: Number(c.comision_tarjeta ?? 3.5),
    bono_puntualidad: Number(c.bono_puntualidad ?? 60),
    bono_semana_perfecta: Number(c.bono_semana_perfecta ?? 0),
    tolerancia: c.puntualidad_tolerancia_min ?? 0,
    pierde_con_falta: !!c.bono_pierde_con_falta,
    aviso_corte_correo: c.aviso_corte_correo || null,
    empresa: c.empresa_nombre || 'Compoint'
  };
}

// Día de operación: antes de la hora de corte (ej. 6:00 am) todavía cuenta la noche anterior
function diaOperacion(horaCorte = 6) {
  const { fecha, hora } = ahora();
  return aMinutos(hora) < horaCorte * 60 ? sumarDias(fecha, -1) : fecha;
}

// Semana de lunes a domingo que contiene la fecha
function semanaDe(fecha) {
  const dia = (new Date(`${fecha}T12:00:00Z`).getUTCDay() + 6) % 7;
  const lunes = sumarDias(fecha, -dia);
  return { lunes, domingo: sumarDias(lunes, 6) };
}

function diasDeSemana(lunes) {
  return Array.from({ length: 7 }, (_, i) => sumarDias(lunes, i));
}

// ¿Llegó a tiempo? (hora de entrada del horario + tolerancia del bono)
function evaluarEntrada(horaChecada, horaEntrada, tolerancia) {
  if (!horaEntrada) return { evaluable: false, a_tiempo: null, min_tarde: null };
  let dif = aMinutos(horaChecada) - aMinutos(horaEntrada);
  // Turnos de noche: si checó poco antes de medianoche para entrar después (o al revés)
  if (dif > 12 * 60) dif -= 24 * 60;
  if (dif < -12 * 60) dif += 24 * 60;
  const tarde = Math.max(0, Math.round(dif));
  return { evaluable: true, a_tiempo: dif <= tolerancia, min_tarde: tarde };
}

// ---------------- Nómina de la semana (desde el checador) ----------------
async function calcularNomina(lunes, { empleadoId = null } = {}) {
  const conf = await config();
  const domingo = sumarDias(lunes, 6);
  const hoy = ahora().fecha;
  const dias = diasDeSemana(lunes);
  const filtroEmp = empleadoId ? 'AND e.id = $3' : '';
  const params = empleadoId ? [lunes, domingo, empleadoId] : [lunes, domingo];

  const emps = (await pool.query(
    `SELECT e.id, e.nombre, e.puesto, e.departamento, e.sueldo_diario, e.activo, e.foto_url,
            COALESCE(e.fecha_ingreso, (e.creado_en AT TIME ZONE 'America/Mexico_City')::date)::text AS alta,
            h.nombre AS turno, h.hora_entrada, h.dias_semana
     FROM empleados e LEFT JOIN horarios h ON h.id = e.horario_id
     WHERE (e.activo OR EXISTS (SELECT 1 FROM checadas c WHERE c.empleado_id = e.id AND c.fecha BETWEEN $1 AND $2)
            OR EXISTS (SELECT 1 FROM nomina_pagos p WHERE p.empleado_id = e.id AND p.semana = $1)) ${filtroEmp}
     ORDER BY e.nombre`, params
  )).rows;
  if (!emps.length) return { lunes, domingo, empleados: [], totales: totalesNomina([]), reglas: conf };

  const ids = emps.map((e) => e.id);
  const [entradas, festivos, justif, bonos, pagos] = await Promise.all([
    // Un día más para alcanzar entradas después de medianoche del domingo
    pool.query(
      `SELECT empleado_id, fecha, hora FROM checadas
       WHERE tipo = 'entrada' AND fecha BETWEEN $1 AND $2 AND empleado_id = ANY($3)`, [lunes, sumarDias(domingo, 1), ids]),
    pool.query('SELECT fecha FROM dias_festivos WHERE fecha BETWEEN $1 AND $2', [lunes, domingo]),
    pool.query(
      `SELECT empleado_id, fecha, COALESCE(fecha_fin, fecha) AS fin FROM incidencias
       WHERE estado = 'aprobado' AND tipo IN ('vacaciones','permiso','incapacidad')
         AND fecha <= $2 AND COALESCE(fecha_fin, fecha) >= $1 AND empleado_id = ANY($3)`, [lunes, domingo, ids]),
    pool.query('SELECT * FROM bonos_extra WHERE semana = $1 AND empleado_id = ANY($2) ORDER BY id', [lunes, ids]),
    pool.query('SELECT * FROM nomina_pagos WHERE semana = $1 AND empleado_id = ANY($2)', [lunes, ids])
  ]);
  const festivo = new Set(festivos.rows.map((f) => f.fecha));
  // Día de operación: una entrada antes de la hora de corte (ej. 00:30) pertenece a la noche anterior.
  // Por día se toma la PRIMERA entrada en orden de la noche (21:00 va antes que 00:30).
  const entradaDe = new Map();
  const corteMin = conf.hora_corte_dia * 60;
  for (const r of entradas.rows) {
    const min = aMinutos(r.hora);
    const fechaOp = min < corteMin ? sumarDias(r.fecha, -1) : r.fecha;
    const orden = min < corteMin ? min + 1440 : min;
    if (fechaOp < lunes || fechaOp > domingo) continue;
    const k = `${r.empleado_id}|${fechaOp}`;
    const previo = entradaDe.get(k);
    if (!previo || orden < previo.orden) entradaDe.set(k, { hora: r.hora, orden });
  }
  const pagoDe = new Map(pagos.rows.map((p) => [p.empleado_id, p]));

  const resultado = [];
  for (const e of emps) {
    const programados = e.dias_semana ? e.dias_semana.split(',') : [];
    const detalle = [];
    let trabajados = 0, puntuales = 0, retardos = 0, faltas = 0;
    for (const f of dias) {
      const hora = entradaDe.get(`${e.id}|${f}`)?.hora;
      const codigo = diaCodigo(f);
      if (hora) {
        trabajados++;
        const ev = evaluarEntrada(hora, e.hora_entrada, conf.tolerancia);
        if (ev.a_tiempo === true) puntuales++;
        if (ev.a_tiempo === false) retardos++;
        detalle.push({ fecha: f, codigo, estado: ev.a_tiempo === false ? 'retardo' : 'a_tiempo', hora, min_tarde: ev.min_tarde, evaluable: ev.evaluable });
      } else if (e.alta && f < e.alta) {
        detalle.push({ fecha: f, codigo, estado: 'descanso' }); // todavía no trabajaba aquí
      } else if (!programados.includes(codigo) || festivo.has(f)) {
        detalle.push({ fecha: f, codigo, estado: festivo.has(f) && programados.includes(codigo) ? 'festivo' : 'descanso' });
      } else if (justif.rows.some((j) => j.empleado_id === e.id && j.fecha <= f && j.fin >= f)) {
        detalle.push({ fecha: f, codigo, estado: 'justificado' });
      } else if (f < hoy) {
        faltas++;
        detalle.push({ fecha: f, codigo, estado: 'falta' });
      } else {
        detalle.push({ fecha: f, codigo, estado: 'pendiente' });
      }
    }
    let bonoP = puntuales * conf.bono_puntualidad;
    if (conf.pierde_con_falta && faltas > 0) bonoP = 0;
    const semanaPerfecta = e.hora_entrada && trabajados > 0 && faltas === 0 && retardos === 0 && conf.bono_semana_perfecta > 0;
    if (semanaPerfecta) bonoP += conf.bono_semana_perfecta;
    const extras = bonos.rows.filter((b) => b.empleado_id === e.id);
    const sumaExtras = extras.reduce((s, b) => s + Number(b.monto), 0);
    const sueldoDiario = Number(e.sueldo_diario) || 0;
    const sueldo = trabajados * sueldoDiario;
    const pago = pagoDe.get(e.id) || null;
    if (!pago && !extras.length && trabajados === 0 && (!e.activo || sueldoDiario === 0)) continue;

    const calculado = {
      dias_trabajados: trabajados, dias_puntuales: puntuales, retardos, faltas,
      sueldo_diario: sueldoDiario, sueldo: r2(sueldo), bono_puntualidad: r2(bonoP),
      semana_perfecta: !!semanaPerfecta, bonos_extra: r2(sumaExtras), total: r2(sueldo + bonoP + sumaExtras)
    };
    resultado.push({
      empleado_id: e.id, nombre: e.nombre, puesto: e.puesto, departamento: e.departamento, turno: e.turno,
      hora_entrada: e.hora_entrada, sin_horario: !e.hora_entrada, sin_sueldo: sueldoDiario === 0,
      detalle, extras: extras.map((b) => ({ id: b.id, concepto: b.concepto, monto: Number(b.monto) })),
      ...calculado,
      // Si ya se pagó, manda lo que se pagó (foto fija); avisa si cambió algo después
      pago: pago ? {
        id: pago.id, total: Number(pago.total), metodo: pago.metodo, pagado_en: pago.pagado_en,
        pagado_por: pago.pagado_por, recibido_en: pago.recibido_en,
        diferencia: r2(calculado.total - Number(pago.total))
      } : null
    });
  }
  return { lunes, domingo, empleados: resultado, totales: totalesNomina(resultado), reglas: conf };
}

function totalesNomina(lista) {
  const t = { sueldo: 0, bono_puntualidad: 0, bonos_extra: 0, total: 0, pagado: 0, pendiente: 0, empleados: lista.length, pagados: 0, dias_trabajados: 0, dias_puntuales: 0 };
  for (const e of lista) {
    t.sueldo += e.sueldo; t.bono_puntualidad += e.bono_puntualidad; t.bonos_extra += e.bonos_extra;
    t.dias_trabajados += e.dias_trabajados; t.dias_puntuales += e.dias_puntuales;
    const total = e.pago ? e.pago.total : e.total;
    t.total += total;
    if (e.pago) { t.pagado += total; t.pagados++; } else t.pendiente += total;
  }
  for (const k of Object.keys(t)) if (typeof t[k] === 'number') t[k] = r2(t[k]);
  return t;
}

// ---------------- Hoja semanal ----------------
async function calcularSemana(lunes, { conNomina = true } = {}) {
  const conf = await config();
  const domingo = sumarDias(lunes, 6);
  const [cortes, gastos, conceptos] = await Promise.all([
    pool.query('SELECT * FROM cortes WHERE fecha BETWEEN $1 AND $2 ORDER BY fecha', [lunes, domingo]),
    pool.query('SELECT * FROM gastos WHERE fecha BETWEEN $1 AND $2 ORDER BY fecha, id', [lunes, domingo]),
    pool.query('SELECT id, grupo FROM conceptos_gasto')
  ]);
  const grupoDe = new Map(conceptos.rows.map((c) => [c.id, c.grupo]));
  const corteDe = new Map(cortes.rows.map((c) => [c.fecha, c]));

  const dias = [];
  for (const f of diasDeSemana(lunes)) {
    const c = corteDe.get(f);
    const opera = conf.dias_operacion.includes(diaCodigo(f));
    if (!opera && !c) continue;
    const gastosDia = gastos.rows.filter((g) => g.tipo === 'dia' && g.fecha === f);
    const sumaGastos = gastosDia.reduce((s, g) => s + Number(g.monto), 0);
    const venta = c ? Number(c.venta_total) : 0;
    const tarjeta = c ? Number(c.venta_tarjeta) : 0;
    const efectivoFinal = venta - tarjeta - sumaGastos;
    dias.push({
      fecha: f, codigo: diaCodigo(f), opera, corte_id: c?.id || null, estado: c ? c.estado : 'sin_corte',
      venta_total: venta, venta_tarjeta: tarjeta, gastos: r2(sumaGastos), efectivo_final: r2(efectivoFinal),
      efectivo_contado: c && c.efectivo_contado !== null ? Number(c.efectivo_contado) : null,
      diferencia_caja: c && c.efectivo_contado !== null ? r2(Number(c.efectivo_contado) - efectivoFinal) : null,
      capturado_por: c?.capturado_por || null,
      destacados: gastosDia.filter((g) => grupoDe.get(g.concepto_id)).map((g) => `${g.concepto} $${Number(g.monto).toLocaleString('es-MX')}`)
    });
  }

  const suma = (tipo) => r2(gastos.rows.filter((g) => g.tipo === tipo).reduce((s, g) => s + Number(g.monto), 0));
  const nomina = conNomina ? await calcularNomina(lunes) : null;
  const ventaTotal = r2(dias.reduce((s, d) => s + d.venta_total, 0));
  const ventaTarjeta = r2(dias.reduce((s, d) => s + d.venta_tarjeta, 0));
  const g = { dia: suma('dia'), semanal: suma('semanal'), proveedor: suma('proveedor'), abastos: suma('abastos') };
  const nominaTotal = nomina ? nomina.totales.total : 0;
  const comision = r2(ventaTarjeta * conf.comision_tarjeta / 100);
  const gastosTotal = r2(g.dia + g.semanal + g.proveedor + g.abastos + nominaTotal);
  const difCaja = dias.filter((d) => d.diferencia_caja !== null);

  // "Gastos semanales" agrupados como en la hoja de papel
  const grupos = {};
  for (const x of gastos.rows.filter((x) => x.tipo === 'dia' || x.tipo === 'semanal')) {
    const nombre = grupoDe.get(x.concepto_id) || (x.tipo === 'dia' ? 'Gastos del día (varios)' : x.concepto);
    grupos[nombre] ||= { nombre, monto: 0, desde_cortes: x.tipo === 'dia' };
    grupos[nombre].monto = r2(grupos[nombre].monto + Number(x.monto));
    if (x.tipo === 'semanal') grupos[nombre].desde_cortes = false;
  }

  return {
    lunes, domingo, dias,
    gastos: gastos.rows.map((x) => ({ ...x, monto: Number(x.monto) })),
    grupos: Object.values(grupos).sort((a, b) => b.monto - a.monto),
    nomina,
    cuenta: {
      venta_total: ventaTotal, venta_tarjeta: ventaTarjeta, venta_efectivo: r2(ventaTotal - ventaTarjeta),
      gastos_dia: g.dia, gastos_semanal: g.semanal, surtida_proveedor: g.proveedor, surtida_abastos: g.abastos,
      nomina: nominaTotal, nomina_pagada: nomina ? nomina.totales.pagado : 0, nomina_pendiente: nomina ? nomina.totales.pendiente : 0,
      gastos_total: gastosTotal, comision_tarjeta: comision, comision_pct: conf.comision_tarjeta,
      efectivo_final: r2(ventaTotal - ventaTarjeta - gastosTotal),
      utilidad: r2(ventaTotal - gastosTotal - comision),
      diferencia_caja: r2(difCaja.reduce((s, d) => s + d.diferencia_caja, 0)),
      dias_con_corte: dias.filter((d) => d.corte_id).length,
      dias_cerrados: dias.filter((d) => d.estado === 'cerrado').length,
      dias_operacion: dias.filter((d) => d.opera).length
    }
  };
}

// ---------------- Mes (cada semana cuenta en el mes en que termina) ----------------
async function calcularMes(mes) {
  const [a, m] = mes.split('-').map(Number);
  const primero = `${mes}-01`;
  const ultimo = new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10);
  let { lunes } = semanaDe(primero);
  if (sumarDias(lunes, 6) < primero) lunes = sumarDias(lunes, 7);
  const semanas = [];
  const hoy = ahora().fecha;
  for (; sumarDias(lunes, 6) <= ultimo; lunes = sumarDias(lunes, 7)) {
    if (lunes > hoy) break;
    semanas.push(await calcularSemana(lunes));
  }
  const tot = { venta_total: 0, venta_tarjeta: 0, gastos_total: 0, comision_tarjeta: 0, utilidad: 0, nomina: 0, diferencia_caja: 0 };
  const categorias = {};
  const porDia = {};
  const sumarCat = (k, v) => { if (v) categorias[k] = r2((categorias[k] || 0) + v); };
  for (const s of semanas) {
    for (const k of Object.keys(tot)) tot[k] = r2(tot[k] + s.cuenta[k]);
    for (const gr of s.grupos) sumarCat(gr.nombre, gr.monto);
    sumarCat('Nómina y bonos', s.cuenta.nomina);
    sumarCat('Surtida proveedores', s.cuenta.surtida_proveedor);
    sumarCat('Surtida abastos', s.cuenta.surtida_abastos);
    sumarCat('Comisión terminal', s.cuenta.comision_tarjeta);
    for (const d of s.dias) porDia[d.codigo] = r2((porDia[d.codigo] || 0) + d.venta_total);
  }
  return {
    mes,
    semanas: semanas.map((s) => ({ lunes: s.lunes, domingo: s.domingo, ...s.cuenta })),
    totales: tot,
    categorias: Object.entries(categorias).map(([nombre, monto]) => ({ nombre, monto })).sort((x, y) => y.monto - x.monto),
    por_dia: ['L', 'M', 'X', 'J', 'V', 'S', 'D'].filter((d) => porDia[d] !== undefined).map((d) => ({ dia: d, venta: porDia[d] }))
  };
}

// Puntualidad que se le muestra al empleado al checar su entrada
async function puntualidadAlChecar(empleadoId, fecha, hora) {
  const conf = await config();
  const { rows } = await pool.query(
    `SELECT h.hora_entrada FROM empleados e LEFT JOIN horarios h ON h.id = e.horario_id WHERE e.id = $1`, [empleadoId]);
  const horaEntrada = rows[0]?.hora_entrada || null;
  // Solo la PRIMERA entrada del día cuenta para el bono (regresar de comer no cuenta)
  // ¿Ya tenía una entrada antes en la misma noche (día de operación)?
  const corteHora = `${String(conf.hora_corte_dia).padStart(2, '0')}:00:00`;
  const despuesDeMedianoche = aMinutos(hora) < conf.hora_corte_dia * 60;
  const previa = await pool.query(
    despuesDeMedianoche
      ? `SELECT 1 FROM checadas WHERE empleado_id = $1 AND tipo = 'entrada' AND
           ((fecha = $2 AND hora < $3) OR (fecha = ($2::date - 1) AND hora >= $4)) LIMIT 1`
      : `SELECT 1 FROM checadas WHERE empleado_id = $1 AND tipo = 'entrada' AND fecha = $2 AND hora < $3 AND hora >= $4 LIMIT 1`,
    [empleadoId, fecha, hora, corteHora]);
  if (previa.rows[0]) return { evaluable: false, repetida: true };
  const fechaOp = despuesDeMedianoche ? sumarDias(fecha, -1) : fecha;
  const ev = evaluarEntrada(hora, horaEntrada, conf.tolerancia);
  if (!ev.evaluable || !conf.bono_puntualidad) return { evaluable: ev.evaluable, a_tiempo: ev.a_tiempo, min_tarde: ev.min_tarde, hora_entrada: horaEntrada };
  const { lunes } = semanaDe(fechaOp);
  const nom = await calcularNomina(lunes, { empleadoId });
  const e = nom.empleados[0];
  return {
    evaluable: true, a_tiempo: ev.a_tiempo, min_tarde: ev.min_tarde, hora_entrada: horaEntrada,
    bono_hoy: ev.a_tiempo ? conf.bono_puntualidad : 0,
    bono_semana: e ? e.bono_puntualidad : 0,
    racha: e ? e.detalle.filter((d) => d.estado !== 'descanso').map((d) => ({ codigo: d.codigo, estado: d.estado })) : []
  };
}

async function auditarFin(cliente, { modulo, registroId = null, accion, descripcion, antes = null, despues = null, usuario }) {
  await (cliente || pool).query(
    `INSERT INTO auditoria_finanzas (modulo, registro_id, accion, descripcion, antes, despues, usuario)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [modulo, registroId, accion, descripcion, antes ? JSON.stringify(antes) : null, despues ? JSON.stringify(despues) : null, usuario]
  );
}

module.exports = {
  PERMISOS, TODOS, r2, config, diaOperacion, semanaDe, diasDeSemana, evaluarEntrada,
  calcularNomina, calcularSemana, calcularMes, puntualidadAlChecar, auditarFin
};
