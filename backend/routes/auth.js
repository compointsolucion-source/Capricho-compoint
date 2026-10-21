const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const { verificarToken } = require('../middleware/auth');

const router = express.Router();

const limiteLogin = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Espera 15 minutos e intenta de nuevo.' }
});

const MAX_INTENTOS = 5;
const MINUTOS_BLOQUEO = 15;

router.post('/login', limiteLogin, async (req, res, next) => {
  try {
    const usuario = String(req.body.usuario || '').trim();
    const password = String(req.body.password || '');
    if (!usuario || !password) return res.status(400).json({ error: 'Ingresa usuario y contraseña.' });

    const { rows } = await pool.query(
      'SELECT * FROM administradores WHERE LOWER(usuario) = LOWER($1) AND activo = TRUE',
      [usuario]
    );
    const admin = rows[0];
    if (!admin) return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });

    if (admin.bloqueado_hasta && new Date(admin.bloqueado_hasta) > new Date()) {
      return res.status(423).json({ error: `Usuario bloqueado por intentos fallidos. Intenta en ${MINUTOS_BLOQUEO} minutos.` });
    }

    const ok = await bcrypt.compare(password, admin.password_hash);
    if (!ok) {
      const intentos = admin.intentos_fallidos + 1;
      if (intentos >= MAX_INTENTOS) {
        await pool.query(
          `UPDATE administradores SET intentos_fallidos = 0,
             bloqueado_hasta = NOW() + make_interval(mins => $1) WHERE id = $2`,
          [MINUTOS_BLOQUEO, admin.id]
        );
      } else {
        await pool.query('UPDATE administradores SET intentos_fallidos = $1 WHERE id = $2', [intentos, admin.id]);
      }
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
    }

    await pool.query('UPDATE administradores SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = $1', [admin.id]);

    const datos = { tipo: 'admin', id: admin.id, nombre: admin.nombre, usuario: admin.usuario, rol: admin.rol, empleado_id: admin.empleado_id };
    const token = jwt.sign(datos, process.env.JWT_SECRET, { expiresIn: '3d' });
    res.json({ token, usuario: datos });
  } catch (e) { next(e); }
});

router.get('/yo', verificarToken, (req, res) => res.json({ usuario: req.usuario }));

router.post('/cambiar-password', verificarToken, async (req, res, next) => {
  try {
    const { actual = '', nueva = '', confirmar = '' } = req.body;
    const errores = [];
    const { rows } = await pool.query('SELECT password_hash FROM administradores WHERE id = $1', [req.usuario.id]);
    if (!rows[0] || !(await bcrypt.compare(actual, rows[0].password_hash))) errores.push('Tu contraseña actual no es correcta.');
    if (nueva.length < 6) errores.push('La nueva contraseña debe tener al menos 6 caracteres.');
    if (nueva !== confirmar) errores.push('La confirmación no coincide con la nueva contraseña.');
    if (errores.length) return res.status(400).json({ error: errores.join(' ') });
    await pool.query('UPDATE administradores SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(nueva, 10), req.usuario.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
