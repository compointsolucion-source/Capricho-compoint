const jwt = require('jsonwebtoken');
const pool = require('../db');
const { PERMISOS, TODOS } = require('../utils/finanzas');

// Finanzas las usan dos tipos de usuario:
//  - Administrador del panel (rol admin): tiene todos los permisos.
//  - Empleado con permisos (entra al portal con su número y PIN): solo lo que el dueño le activó.
// Los permisos del empleado se leen de la base en cada solicitud, así un permiso
// que se quita deja de funcionar al instante.
async function verificarFinanzas(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Inicia sesión para continuar' });
  let datos;
  try { datos = jwt.verify(token, process.env.JWT_SECRET); } catch (_) {
    return res.status(401).json({ error: 'Tu sesión expiró, vuelve a entrar' });
  }
  try {
    if (datos.tipo === 'admin') {
      if (datos.rol !== 'admin') return res.status(403).json({ error: 'Tu usuario no tiene acceso a finanzas' });
      req.fin = { tipo: 'admin', id: datos.id, nombre: datos.nombre, permisos: { ...TODOS } };
      return next();
    }
    if (datos.tipo === 'empleado') {
      const { rows } = await pool.query('SELECT id, nombre, puesto, permisos FROM empleados WHERE id = $1 AND activo = TRUE', [datos.id]);
      if (!rows[0]) return res.status(401).json({ error: 'Tu usuario ya no está activo' });
      const p = rows[0].permisos || {};
      const permisos = Object.fromEntries(PERMISOS.map((k) => [k, p[k] === true]));
      if (!Object.values(permisos).some(Boolean)) return res.status(403).json({ error: 'No tienes permisos de finanzas. Pídelos al dueño.' });
      req.fin = { tipo: 'empleado', id: rows[0].id, nombre: rows[0].nombre, puesto: rows[0].puesto, permisos };
      return next();
    }
    res.status(401).json({ error: 'Sesión no válida' });
  } catch (e) { next(e); }
}

function requierePermiso(...alguno) {
  return (req, res, next) => {
    if (alguno.some((p) => req.fin.permisos[p])) return next();
    res.status(403).json({ error: 'No tienes permiso para esta sección' });
  };
}

function soloAdmin(req, res, next) {
  if (req.fin.tipo === 'admin') return next();
  res.status(403).json({ error: 'Solo el dueño puede hacer esto' });
}

function quien(req) {
  return req.fin.tipo === 'admin' ? `${req.fin.nombre} (admin)` : `${req.fin.nombre}${req.fin.puesto ? ' · ' + req.fin.puesto : ''}`;
}

module.exports = { verificarFinanzas, requierePermiso, soloAdmin, quien };
