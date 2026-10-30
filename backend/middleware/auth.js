const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../db');

function leerToken(req) {
  const header = req.headers['authorization'] || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

// Usuarios del panel (RH / supervisores)
function verificarToken(req, res, next) {
  if (req.terminal) return next(); // ya validada por permitirTerminal en esta misma ruta
  const token = leerToken(req);
  if (!token) return res.status(401).json({ error: 'Inicia sesión para continuar' });
  jwt.verify(token, process.env.JWT_SECRET, (err, datos) => {
    if (err || datos.tipo !== 'admin') return res.status(401).json({ error: 'Tu sesión expiró, vuelve a entrar' });
    req.usuario = datos;
    next();
  });
}

function requiereAdmin(req, res, next) {
  if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'Solo un administrador puede hacer esto' });
  next();
}

// Empleados en el portal de autoservicio
function verificarEmpleado(req, res, next) {
  const token = leerToken(req);
  if (!token) return res.status(401).json({ error: 'Inicia sesión en el portal' });
  jwt.verify(token, process.env.JWT_SECRET, (err, datos) => {
    if (err || datos.tipo !== 'empleado') return res.status(401).json({ error: 'Tu sesión expiró, vuelve a entrar' });
    req.empleado = datos;
    next();
  });
}

// Terminales del negocio (pantalla QR o tableta checador). Su llave empieza con "T." y solo
// sirve en las rutas que la permiten de forma explícita, con los roles indicados.
const hashTerminal = (t) => crypto.createHash('sha256').update(t).digest('hex');
async function terminalDeToken(token) {
  if (!token || !/^T\.[a-f0-9]{48}$/.test(token)) return null;
  const { rows } = await pool.query('SELECT id, nombre, rol FROM terminales WHERE token_hash = $1', [hashTerminal(token)]);
  if (rows[0]) pool.query('UPDATE terminales SET ultimo_contacto = NOW() WHERE id = $1 AND (ultimo_contacto IS NULL OR ultimo_contacto < NOW() - INTERVAL \'20 seconds\')', [rows[0].id]).catch(() => {});
  return rows[0] || null;
}
function permitirTerminal(roles = ['qr', 'checador']) {
  return async (req, res, next) => {
    const token = leerToken(req);
    if (!token || !token.startsWith('T.')) return next();
    try {
      const t = await terminalDeToken(token);
      if (!t) return res.status(401).json({ error: 'Este equipo fue desconectado. Pide un código nuevo al administrador.', terminal_desconectada: true });
      if (!roles.includes(t.rol)) return res.status(403).json({ error: 'Esta terminal no tiene permiso para esto.' });
      req.terminal = t;
      req.usuario = { tipo: 'terminal', rol: 'terminal', id: null, nombre: `Terminal ${t.nombre}` };
      next();
    } catch (e) { next(e); }
  };
}

module.exports = { verificarToken, requiereAdmin, verificarEmpleado, permitirTerminal, terminalDeToken, hashTerminal };
