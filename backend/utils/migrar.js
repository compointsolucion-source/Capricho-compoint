const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
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
  await usuarioInicial();
}

// Usuario dueño inicial, solo si todavía no hay ningún usuario.
//  · Sistema creado desde el panel de Compoint (variables ALTA_*): el dueño del negocio con su
//    usuario y contraseña, y el nombre de su empresa.
//  · Instalación manual sin datos de alta: Admin / Compoint2026 (cámbiala al entrar).
async function usuarioInicial() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM administradores');
  if (rows[0].n > 0) return;
  const e = process.env;
  if (e.ALTA_USUARIO && e.ALTA_PASSWORD) {
    const negocio = String(e.ALTA_NEGOCIO || 'Mi negocio').trim().slice(0, 120);
    await pool.query(
      `INSERT INTO administradores (nombre, usuario, password_hash, rol, correo) VALUES ($1, $2, $3, 'admin', $4)`,
      [String(e.ALTA_DUENO || negocio).trim().slice(0, 100), String(e.ALTA_USUARIO).trim().slice(0, 50),
       await bcrypt.hash(String(e.ALTA_PASSWORD), 10), e.ALTA_CORREO ? String(e.ALTA_CORREO).trim().slice(0, 150) : null]);
    await pool.query('UPDATE configuracion SET empresa_nombre = $1 WHERE id = 1', [negocio]);
    console.log(`[alta] Usuario dueño creado para «${negocio}»`);
    return;
  }
  await pool.query(
    `INSERT INTO administradores (nombre, usuario, password_hash, rol)
     VALUES ('Administrador', 'Admin', '$2a$10$jKKUHzO0fM.V6VcQt4qz2.CwjEz4ULQPamU5edV.ImcR54WMxy2U2', 'admin')`);
  console.log('[alta] Usuario inicial: Admin (cambia la contraseña al entrar)');
}

module.exports = { migrar };
