const pool = require('../db');
const { ahora } = require('./tiempo');

// Registra una checada (QR o huella). Si no se indica el tipo, alterna
// según la última checada del día: entrada → salida → entrada...
// Evita dobles checadas accidentales en menos de 60 segundos.
async function registrarChecada({ empleadoId, metodo, tipo = null, ip = null, fotoUrl = null, verificadoFacial = false }) {
  const { fecha, hora } = ahora();
  const { rows } = await pool.query(
    `SELECT tipo, hora, creado_en FROM checadas WHERE empleado_id = $1 AND fecha = $2
     ORDER BY hora DESC, id DESC LIMIT 1`, [empleadoId, fecha]
  );
  const ultima = rows[0];
  if (ultima && Date.now() - new Date(ultima.creado_en).getTime() < 60 * 1000) {
    const e = new Error(`Ya registraste tu ${ultima.tipo} hace unos segundos.`);
    e.status = 409;
    throw e;
  }
  const tipoFinal = tipo || (ultima && ultima.tipo === 'entrada' ? 'salida' : 'entrada');
  await pool.query(
    `INSERT INTO checadas (empleado_id, fecha, hora, tipo, metodo, ip_dispositivo, foto_url, verificado_facial)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [empleadoId, fecha, hora, tipoFinal, metodo, ip, fotoUrl, !!verificadoFacial]
  );
  return { tipo: tipoFinal, fecha, hora };
}

module.exports = { registrarChecada };
