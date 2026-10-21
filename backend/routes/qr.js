const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const { verificarToken } = require('../middleware/auth');
const { buscarEmpleadoPorPin } = require('../utils/pin');
const { registrarChecada } = require('../utils/registro');
const { guardarDataUrl } = require('../utils/archivos');

const router = express.Router();

// Evita que alguien pruebe los 10,000 PINs posibles. Solo cuentan los
// intentos FALLIDOS: todos los empleados suelen compartir el mismo Wi-Fi
// (misma IP), y las checadas correctas no deben bloquearse entre sí.
const limitePin = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 25,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Demasiados intentos desde este celular. Espera unos minutos.' }
});

async function tokenVigente(token) {
  if (!token || !/^[a-f0-9]{32}$/.test(token)) return false;
  const { rows } = await pool.query('SELECT id FROM qr_tokens WHERE token = $1 AND expira_en > NOW()', [token]);
  return !!rows[0];
}

// Pantalla de la entrada: genera un QR nuevo (requiere sesión iniciada en esa pantalla)
router.post('/token', verificarToken, async (req, res, next) => {
  try {
    const conf = (await pool.query('SELECT qr_vigencia_segundos FROM configuracion WHERE id = 1')).rows[0];
    const segundos = conf?.qr_vigencia_segundos || 25;
    const token = crypto.randomBytes(16).toString('hex');
    // El token vale un poco más que lo que dura en pantalla, para quien lo escaneó al último segundo
    await pool.query(
      'INSERT INTO qr_tokens (token, expira_en) VALUES ($1, NOW() + make_interval(secs => $2))',
      [token, segundos + 60]
    );
    await pool.query("DELETE FROM qr_tokens WHERE expira_en < NOW() - INTERVAL '1 hour'");
    res.json({ token, segundos });
  } catch (e) { next(e); }
});

// Celular: ¿sigue vigente el QR que escaneé?
router.get('/valido/:token', async (req, res, next) => {
  try { res.json({ valido: await tokenVigente(req.params.token) }); } catch (e) { next(e); }
});

// Celular: paso 1 — validar PIN (dice si hace falta verificación facial)
router.post('/pin', limitePin, async (req, res, next) => {
  try {
    const { token, pin } = req.body;
    if (!/^\d{4}$/.test(String(pin || ''))) return res.status(400).json({ ok: false, error: 'Ingresa los 4 dígitos de tu PIN.' });
    if (!(await tokenVigente(token))) return res.status(410).json({ ok: false, error: 'Este código ya expiró. Escanea el QR actual en pantalla.' });
    const emp = await buscarEmpleadoPorPin(String(pin));
    if (!emp) return res.status(401).json({ ok: false, error: 'PIN incorrecto.' });
    const conf = (await pool.query('SELECT requiere_facial FROM configuracion WHERE id = 1')).rows[0];
    res.json({
      ok: true,
      nombre: emp.nombre,
      requiere_facial: !!conf?.requiere_facial && !!emp.foto_url,
      foto_url: emp.foto_url
    });
  } catch (e) { next(e); }
});

// Celular: paso 2 — registrar la checada
router.post('/checar', limitePin, async (req, res, next) => {
  try {
    const { token, pin, verificado_facial, foto } = req.body;
    if (!/^\d{4}$/.test(String(pin || ''))) return res.status(400).json({ ok: false, error: 'Datos incompletos.' });
    if (!(await tokenVigente(token))) return res.status(410).json({ ok: false, error: 'Este código ya expiró. Escanea el QR actual en pantalla.' });
    const emp = await buscarEmpleadoPorPin(String(pin));
    if (!emp) return res.status(401).json({ ok: false, error: 'PIN incorrecto.' });

    let fotoUrl = null;
    if (foto) {
      try { fotoUrl = await guardarDataUrl(foto, { maxMb: 2 }); } catch (_) { fotoUrl = null; }
    }
    const r = await registrarChecada({
      empleadoId: emp.id, metodo: 'qr', ip: req.ip, fotoUrl, verificadoFacial: !!verificado_facial
    });
    res.json({ ok: true, empleado: emp.nombre, tipo: r.tipo, hora: r.hora });
  } catch (e) {
    if (e.status === 409) return res.status(409).json({ ok: false, error: e.message });
    next(e);
  }
});

module.exports = router;
