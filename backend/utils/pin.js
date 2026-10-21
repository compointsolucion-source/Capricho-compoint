const bcrypt = require('bcryptjs');
const pool = require('../db');

// El checador por QR identifica al empleado SOLO con su PIN, así que cada
// PIN debe ser único entre los empleados activos.
async function buscarEmpleadoPorPin(pin, excluirId = null) {
  const { rows } = await pool.query(
    'SELECT id, nombre, foto_url, pin_hash FROM empleados WHERE activo = TRUE AND pin_hash IS NOT NULL'
  );
  for (const emp of rows) {
    if (excluirId && Number(emp.id) === Number(excluirId)) continue;
    if (await bcrypt.compare(pin, emp.pin_hash)) return emp;
  }
  return null;
}

module.exports = { buscarEmpleadoPorPin };
