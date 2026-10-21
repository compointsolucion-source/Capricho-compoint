const pool = require('../db');
const { ahora, diaCodigo, sumarDias, aMinutos, horasEntre, semanaIso } = require('./tiempo');

// Cálculo de pre-nómina (LFT): horas ordinarias, extra dobles (primeras 9
// por semana) y triples (después de 9), horas en domingo (prima dominical),
// retardos y faltas. Los días con vacaciones/permiso/incapacidad aprobados
// no cuentan como falta, y los días futuros no se evalúan.
async function calcularPrenomina({ desde, hasta, empleadoId = null }) {
  const hoy = ahora().fecha;
  const params = [];
  let filtro = 'WHERE e.activo = TRUE';
  if (empleadoId) { params.push(empleadoId); filtro += ` AND e.id = $${params.length}`; }
  const empleados = (await pool.query(
    `SELECT e.id, e.nombre, e.departamento, h.nombre AS turno, h.tipo_turno, h.hora_entrada, h.hora_salida,
            h.tolerancia_minutos, h.horas_requeridas, h.dias_semana
     FROM empleados e JOIN horarios h ON h.id = e.horario_id ${filtro} ORDER BY e.nombre`, params
  )).rows;
  if (!empleados.length) return [];

  const ids = empleados.map((e) => e.id);
  const hastaExt = sumarDias(hasta, 1); // para salidas de turnos nocturnos
  const [festivos, checadas, justificadas] = await Promise.all([
    pool.query('SELECT fecha FROM dias_festivos WHERE fecha BETWEEN $1 AND $2', [desde, hasta]),
    pool.query(
      `SELECT empleado_id, fecha, hora, tipo FROM checadas
       WHERE empleado_id = ANY($1) AND fecha BETWEEN $2 AND $3 ORDER BY fecha, hora`, [ids, desde, hastaExt]
    ),
    pool.query(
      `SELECT empleado_id, fecha, COALESCE(fecha_fin, fecha) AS fin, tipo FROM incidencias
       WHERE empleado_id = ANY($1) AND estado = 'aprobado' AND tipo IN ('vacaciones','permiso','incapacidad')
       AND fecha <= $3 AND COALESCE(fecha_fin, fecha) >= $2`, [ids, desde, hasta]
    )
  ]);
  const festivosSet = new Set(festivos.rows.map((r) => r.fecha));
  const porEmpleado = new Map();
  for (const c of checadas.rows) {
    const k = `${c.empleado_id}|${c.fecha}`;
    if (!porEmpleado.has(k)) porEmpleado.set(k, []);
    porEmpleado.get(k).push(c);
  }
  const estaJustificado = (empId, fecha) =>
    justificadas.rows.some((j) => j.empleado_id === empId && j.fecha <= fecha && j.fin >= fecha);

  const resultados = [];
  for (const emp of empleados) {
    const dias = (emp.dias_semana || '').split(',');
    const nocturno = emp.tipo_turno === 'nocturno';
    const jornada = emp.tipo_turno === 'flexible'
      ? Number(emp.horas_requeridas) || 8
      : (emp.hora_entrada && emp.hora_salida ? horasEntre(emp.hora_entrada, emp.hora_salida, nocturno) : 8);

    let ordinarias = 0, domingo = 0, retardos = 0, faltas = 0, justificados = 0, diasTrabajados = 0;
    const extraPorSemana = {};

    for (let f = desde; f <= hasta; f = sumarDias(f, 1)) {
      if (f > hoy) break;
      if (!dias.includes(diaCodigo(f)) || festivosSet.has(f)) continue;
      const delDia = porEmpleado.get(`${emp.id}|${f}`) || [];
      const entrada = delDia.find((c) => c.tipo === 'entrada');
      if (!entrada) {
        if (estaJustificado(emp.id, f)) justificados++;
        else if (f < hoy || (emp.hora_entrada && aMinutos(ahora().hora) > aMinutos(emp.hora_entrada) + emp.tolerancia_minutos)) faltas++;
        continue;
      }
      diasTrabajados++;
      if (emp.tipo_turno !== 'flexible' && emp.hora_entrada) {
        if (aMinutos(entrada.hora) - aMinutos(emp.hora_entrada) > emp.tolerancia_minutos) retardos++;
      }
      // Salida: la última del mismo día después de la entrada; en turno nocturno,
      // la primera salida de la mañana siguiente si no hubo en el mismo día.
      let salida = [...delDia].reverse().find((c) => c.tipo === 'salida' && c.hora > entrada.hora);
      if (!salida && nocturno) {
        const sig = porEmpleado.get(`${emp.id}|${sumarDias(f, 1)}`) || [];
        salida = sig.find((c) => c.tipo === 'salida' && aMinutos(c.hora) < 12 * 60);
      }
      if (!salida) continue;
      const trabajadas = horasEntre(entrada.hora, salida.hora, nocturno && salida.hora < entrada.hora);
      ordinarias += Math.min(trabajadas, jornada);
      const extra = Math.max(trabajadas - jornada, 0);
      if (extra > 0) {
        const s = semanaIso(f);
        extraPorSemana[s] = (extraPorSemana[s] || 0) + extra;
      }
      if (diaCodigo(f) === 'D') domingo += trabajadas;
    }
    let dobles = 0, triples = 0;
    for (const total of Object.values(extraPorSemana)) {
      dobles += Math.min(total, 9);
      triples += Math.max(total - 9, 0);
    }
    const r2 = (n) => Math.round(n * 100) / 100;
    resultados.push({
      empleado_id: emp.id, nombre: emp.nombre, departamento: emp.departamento, turno: emp.turno,
      dias_trabajados: diasTrabajados,
      horas_ordinarias: r2(ordinarias), horas_dobles: r2(dobles), horas_triples: r2(triples),
      horas_domingo: r2(domingo), retardos, faltas, dias_justificados: justificados
    });
  }
  return resultados;
}

module.exports = { calcularPrenomina };
