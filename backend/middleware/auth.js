const jwt = require('jsonwebtoken');

function leerToken(req) {
  const header = req.headers['authorization'] || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

// Usuarios del panel (RH / supervisores)
function verificarToken(req, res, next) {
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

module.exports = { verificarToken, requiereAdmin, verificarEmpleado };
