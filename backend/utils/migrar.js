const fs = require('fs');
const path = require('path');
const pool = require('../db');

// Al arrancar, aplica los archivos de sql/ en orden. Todos están escritos
// para poder correrse varias veces sin dañar nada (IF NOT EXISTS / ON CONFLICT),
// así una instalación nueva para otro cliente solo necesita su DATABASE_URL.
async function migrar() {
  const carpeta = path.join(__dirname, '..', 'sql');
  const archivos = fs.readdirSync(carpeta).filter((f) => f.endsWith('.sql')).sort();
  for (const archivo of archivos) {
    const sql = fs.readFileSync(path.join(carpeta, archivo), 'utf8');
    await pool.query(sql);
    console.log(`[migrar] ${archivo} OK`);
  }
}

module.exports = { migrar };
