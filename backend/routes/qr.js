const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const { verificarToken } = require('../middleware/auth');
const { buscarEmpleadoPorPin } = require('../utils/pin');
const { registrarChecada } = require('../utils/registro');
const { guardarDataUrl } = require('../utils/archivos');
const { puntualidadAlChecar, evaluarEntrada, config, diaOperacion } = require('../utils/finanzas');
const { sumarDias, aMinutos } = require('../utils/tiempo');

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

async function facialObligatorio() {
  const { rows } = await pool.query('SELECT requiere_facial FROM configuracion WHERE id = 1');
  return !!rows[0]?.requiere_facial;
}

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
  try {
    const valido = await tokenVigente(req.params.token);
    res.json({ valido, requiere_facial: valido ? await facialObligatorio() : false });
  } catch (e) { next(e); }
});

// Celular: paso 1 — validar PIN (dice si hace falta verificación facial)
router.post('/pin', limitePin, async (req, res, next) => {
  try {
    const { token, pin } = req.body;
    if (!/^\d{4}$/.test(String(pin || ''))) return res.status(400).json({ ok: false, error: 'Ingresa los 4 dígitos de tu PIN.' });
    if (!(await tokenVigente(token))) return res.status(410).json({ ok: false, error: 'Este código ya expiró. Escanea el QR actual en pantalla.' });
    const emp = await buscarEmpleadoPorPin(String(pin));
    if (!emp) return res.status(401).json({ ok: false, error: 'PIN incorrecto.' });
    const facial = await facialObligatorio();
    // Con verificación facial obligatoria, quien no tiene foto en su expediente no puede checar por QR
    if (facial && !emp.foto_url) {
      return res.status(403).json({ ok: false, error: `${emp.nombre}: no tienes foto registrada para verificar tu rostro. Pide a RH que te tome la foto.` });
    }
    res.json({ ok: true, nombre: emp.nombre, requiere_facial: facial, foto_url: emp.foto_url });
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

    const facial = await facialObligatorio();
    let fotoUrl = null;
    if (facial) {
      // Obligatorio: verificación hecha y foto en vivo de evidencia (se guarda con la checada)
      if (!emp.foto_url) return res.status(403).json({ ok: false, error: 'No tienes foto registrada. Pide a RH que te tome la foto.' });
      const fotoValida = typeof foto === 'string' && /^data:image\/jpeg;base64,/.test(foto) && foto.length > 8000;
      if (verificado_facial !== true || !fotoValida) {
        return res.status(400).json({ ok: false, error: 'La verificación de rostro es obligatoria. Vuelve a escanear el QR.' });
      }
      fotoUrl = await guardarDataUrl(foto, { maxMb: 2 });
    } else if (foto) {
      try { fotoUrl = await guardarDataUrl(foto, { maxMb: 2 }); } catch (_) { fotoUrl = null; }
    }
    const r = await registrarChecada({
      empleadoId: emp.id, metodo: 'qr', ip: req.ip, fotoUrl, verificadoFacial: facial ? true : !!verificado_facial
    });
    let puntualidad = null;
    if (r.tipo === 'entrada') { try { puntualidad = await puntualidadAlChecar(emp.id, r.fecha, r.hora); } catch (_) { puntualidad = null; } }
    res.json({ ok: true, empleado: emp.nombre, tipo: r.tipo, hora: r.hora, verificado_facial: !!fotoUrl && (facial || !!verificado_facial), puntualidad });
  } catch (e) {
    if (e.status === 409) return res.status(409).json({ ok: false, error: e.message });
    next(e);
  }
});

// Pantalla de la entrada: últimas entradas de hoy con su puntualidad
router.get('/ultimas', verificarToken, async (req, res, next) => {
  try {
    const conf = await config();
    // Entradas de la noche en curso (día de operación: después de medianoche sigue contando la noche anterior)
    const dia = diaOperacion(conf.hora_corte_dia);
    const corte = `${String(conf.hora_corte_dia).padStart(2, '0')}:00:00`;
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (c.empleado_id) c.empleado_id, e.nombre, c.hora, h.hora_entrada
       FROM checadas c JOIN empleados e ON e.id = c.empleado_id LEFT JOIN horarios h ON h.id = e.horario_id
       WHERE c.tipo = 'entrada' AND ((c.fecha = $1 AND c.hora >= $3) OR (c.fecha = $2 AND c.hora < $3))
       ORDER BY c.empleado_id, c.fecha, c.hora`, [dia, sumarDias(dia, 1), corte]);
    const lista = rows.map((r) => ({ nombre: r.nombre, hora: r.hora, orden: aMinutos(r.hora) + (aMinutos(r.hora) < conf.hora_corte_dia * 60 ? 1440 : 0), ...evaluarEntrada(r.hora, r.hora_entrada, conf.tolerancia) }))
      .sort((a, b) => b.orden - a.orden).slice(0, 6);
    res.json(lista);
  } catch (e) { next(e); }
});

module.exports = router;
