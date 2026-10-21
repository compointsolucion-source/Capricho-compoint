const bcrypt = require('bcryptjs');
const pool = require('../db');

// El checador por QR identifica al empleado SOLO con su PIN, así que cada
// PIN debe ser único entre los empleados activos.
// soloId: compara únicamente contra ese empleado (celular registrado o sesión ya
// validada) — es mucho más rápido que revisar el PIN de toda la plantilla.
async function buscarEmpleadoPorPin(pin, excluirId = null, soloId = null) {
  const { rows } = soloId
    ? await pool.query('SELECT id, nombre, foto_url, pin_hash FROM empleados WHERE id = $1 AND activo = TRUE AND pin_hash IS NOT NULL', [soloId])
    : await pool.query('SELECT id, nombre, foto_url, pin_hash FROM empleados WHERE activo = TRUE AND pin_hash IS NOT NULL');
  for (const emp of rows) {
    if (excluirId && Number(emp.id) === Number(excluirId)) continue;
    if (await bcrypt.compare(pin, emp.pin_hash)) return emp;
  }
  return null;
}

module.exports = { buscarEmpleadoPorPin };
