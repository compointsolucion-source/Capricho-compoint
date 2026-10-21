const { Pool, types } = require('pg');

// Las fechas (DATE) llegan como texto "AAAA-MM-DD" para evitar corrimientos
// de zona horaria; los NUMERIC llegan como número.
types.setTypeParser(1082, (v) => v);
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));

const url = process.env.DATABASE_URL || '';
const esLocal = /@(localhost|127\.0\.0\.1)(:|\/)/.test(url);
const usarSsl = process.env.DB_SSL ? process.env.DB_SSL === 'true' : !esLocal;

const pool = new Pool({
  connectionString: url,
  ssl: usarSsl ? { rejectUnauthorized: false } : false,
  max: 8
});

module.exports = pool;
