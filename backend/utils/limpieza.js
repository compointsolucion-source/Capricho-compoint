const pool = require('../db');

// Limpieza diaria de fotos:
//  1) Selfies al checar con más de N días (configuracion.dias_selfies, 90 de entrada; 0 = no borrar):
//     la checada se queda, solo se le quita la foto. Las que siguen pendientes o "por revisar" no se tocan.
//  2) Archivos que ya nadie usa (fotos reemplazadas, selfies quitadas, intentos que no se guardaron),
//     con más de 1 día. Nunca se borra un archivo que use una checada, un empleado (foto o referencia),
//     un justificante, un corte o el logo.
const ID = "substring(u from '([0-9a-fA-F-]{36})$')";

async function limpiarFotos() {
  const c = await pool.connect();
  try {
    // Una sola copia del sistema limpia a la vez
    const { rows: [l] } = await c.query('SELECT pg_try_advisory_lock(7351002) AS ok');
    if (!l.ok) return null;
    try {
      const dias = (await c.query('SELECT dias_selfies FROM configuracion WHERE id = 1')).rows[0]?.dias_selfies ?? 90;
      let selfies = 0;
      if (dias > 0) {
        const r = await c.query(
          `UPDATE checadas SET foto_url = NULL
           WHERE id IN (SELECT id FROM checadas
                        WHERE foto_url IS NOT NULL AND fecha < CURRENT_DATE - $1::int
                          AND (revision IS NULL OR revision NOT IN ('pendiente', 'revisar'))
                        LIMIT 20000)`, [dias]);
        selfies = r.rowCount;
      }
      const r2 = await c.query(
        `WITH usados AS (
           SELECT ${ID} AS id FROM (
             SELECT foto_url AS u FROM checadas WHERE foto_url IS NOT NULL
             UNION SELECT foto_url FROM empleados WHERE foto_url IS NOT NULL
             UNION SELECT descriptor_foto FROM empleados WHERE descriptor_foto IS NOT NULL
             UNION SELECT archivo_url FROM incidencias WHERE archivo_url IS NOT NULL
             UNION SELECT foto_terminal_url FROM cortes WHERE foto_terminal_url IS NOT NULL
             UNION SELECT logo_url FROM configuracion WHERE logo_url IS NOT NULL
           ) t)
         DELETE FROM archivos a
         WHERE a.creado_en < NOW() - INTERVAL '1 day'
           AND NOT EXISTS (SELECT 1 FROM usados WHERE lower(usados.id) = a.id::text)`);
      if (selfies || r2.rowCount) console.log(`[limpieza] selfies viejas quitadas: ${selfies} · archivos borrados: ${r2.rowCount}`);
      return { selfies, archivos: r2.rowCount };
    } finally {
      await c.query('SELECT pg_advisory_unlock(7351002)').catch(() => {});
    }
  } finally {
    c.release();
  }
}

// Corre 3 minutos después de arrancar y luego una vez al día
function iniciar() {
  const correr = () => limpiarFotos().catch((e) => console.error('[limpieza] Error:', e.message));
  setTimeout(correr, 3 * 60 * 1000).unref();
  setInterval(correr, 24 * 60 * 60 * 1000).unref();
}

module.exports = { limpiarFotos, iniciar };
