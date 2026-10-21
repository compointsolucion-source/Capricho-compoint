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
  max: 8,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000
});

// Neon cierra las conexiones inactivas cuando la base se "duerme". Sin este aviso,
// esa desconexión tumbaba el servidor completo (y tardaba en volver a levantar).
pool.on('error', (e) => console.error('[db] conexión inactiva cerrada:', e.message));

module.exports = pool;
