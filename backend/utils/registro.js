const pool = require('../db');
const { ahora, sumarDias } = require('./tiempo');

// Registra una checada (QR, tableta o huella). Si no se indica el tipo, alterna
// según la última checada del día: entrada → salida → entrada...
// Evita dobles checadas accidentales en menos de 60 segundos.
//
// Todo pasa con el empleado "apartado" (candado en la base): si llegan dos checadas
// del mismo empleado al mismo tiempo (doble toque, celular y tableta), la segunda
// espera a la primera y ya la ve, así nunca se guarda doble.
//
// Turno nocturno: la primera checada de la mañana, si la última de ayer fue una
// entrada hace menos de 16 horas, es su SALIDA (no una entrada nueva).
async function registrarChecada({ empleadoId, metodo, tipo = null, ip = null, fotoUrl = null, verificadoFacial = false, revision = null, dispositivoId = null, terminalId = null }) {
  const { fecha, hora } = ahora();
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    await cliente.query('SELECT pg_advisory_xact_lock(7351, $1::int)', [empleadoId]);
    const ultimaDe = async (f) => (await cliente.query(
      `SELECT tipo, hora, creado_en FROM checadas WHERE empleado_id = $1 AND fecha = $2
       ORDER BY hora DESC, id DESC LIMIT 1`, [empleadoId, f])).rows[0];
    let ultima = await ultimaDe(fecha);
    if (!ultima) {
      const t = (await cliente.query(
        `SELECT h.tipo_turno FROM empleados e LEFT JOIN horarios h ON h.id = e.horario_id WHERE e.id = $1`, [empleadoId])).rows[0];
      if (t && t.tipo_turno === 'nocturno') {
        const ayer = await ultimaDe(sumarDias(fecha, -1));
        if (ayer && ayer.tipo === 'entrada' && Date.now() - new Date(ayer.creado_en).getTime() < 16 * 3600 * 1000) ultima = ayer;
      }
    }
    if (ultima && Date.now() - new Date(ultima.creado_en).getTime() < 60 * 1000) {
      const e = new Error(`Ya registraste tu ${ultima.tipo} hace unos segundos.`);
      e.status = 409;
      throw e;
    }
    const tipoFinal = tipo || (ultima && ultima.tipo === 'entrada' ? 'salida' : 'entrada');
    const ins = await cliente.query(
      `INSERT INTO checadas (empleado_id, fecha, hora, tipo, metodo, ip_dispositivo, foto_url, verificado_facial, revision, dispositivo_id, terminal_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [empleadoId, fecha, hora, tipoFinal, metodo, ip, fotoUrl, !!verificadoFacial, revision, dispositivoId, terminalId]
    );
    await cliente.query('COMMIT');
    return { id: ins.rows[0].id, tipo: tipoFinal, fecha, hora };
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cliente.release();
  }
}

module.exports = { registrarChecada };
