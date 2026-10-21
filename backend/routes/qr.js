const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
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

async function confQr() {
  const { rows } = await pool.query('SELECT requiere_facial, requiere_dispositivo FROM configuracion WHERE id = 1');
  return { selfie: !!rows[0]?.requiere_facial, dispositivo: rows[0]?.requiere_dispositivo !== false };
}

// El celular guarda un código aleatorio propio; aquí solo se guarda su huella SHA-256
function hashDispositivo(codigo) {
  if (typeof codigo !== 'string' || !/^[a-f0-9]{32,128}$/.test(codigo)) return null;
  return crypto.createHash('sha256').update(codigo).digest('hex');
}
function describirCelular(ua) {
  const m = String(ua || '').match(/\(([^)]+)\)/);
  return (m ? m[1] : String(ua || 'Celular')).replace(/;\s*wv/, '').slice(0, 200);
}
const primerNombre = (n) => String(n || '').split(' ')[0];

// Identifica al empleado por su PIN respetando el celular registrado:
//  · celular ya registrado → el PIN solo se compara con su dueño (rápido)
//  · celular nuevo → se busca el PIN y, si el empleado no tiene celular, este queda registrado
async function identificar({ pin, dispositivo, conf, ua, registrar }) {
  if (!conf.dispositivo) {
    const emp = await buscarEmpleadoPorPin(pin);
    return emp ? { emp, disp: null } : { status: 401, error: 'PIN incorrecto.' };
  }
  const hash = hashDispositivo(dispositivo);
  if (!hash) return { status: 400, error: 'No se pudo identificar este celular. Cierra y vuelve a abrir la página (o usa la app).' };
  const d = (await pool.query(
    `SELECT d.id, d.empleado_id, e.nombre FROM dispositivos d JOIN empleados e ON e.id = d.empleado_id
     WHERE d.token_hash = $1 AND d.activo`, [hash])).rows[0];
  if (d) {
    const emp = await buscarEmpleadoPorPin(pin, null, d.empleado_id);
    if (!emp) return { status: 401, error: `PIN incorrecto. Este celular está registrado para ${primerNombre(d.nombre)}: solo esa persona puede checar desde aquí.` };
    return { emp, disp: { id: d.id } };
  }
  const emp = await buscarEmpleadoPorPin(pin);
  if (!emp) return { status: 401, error: 'PIN incorrecto.' };
  const otro = (await pool.query('SELECT creado_en FROM dispositivos WHERE empleado_id = $1 AND activo', [emp.id])).rows[0];
  if (otro) {
    return { status: 403, otro_celular: true, error: `${primerNombre(emp.nombre)}: ya tienes otro celular registrado. Checa desde ese celular (con la app o el mismo navegador de siempre). Si cambiaste de celular, pide a tu encargado que lo libere en Empleados.` };
  }
  if (!registrar) return { emp, disp: null, nuevo: true };
  const r = await pool.query(
    `INSERT INTO dispositivos (empleado_id, token_hash, descripcion) VALUES ($1, $2, $3)
     ON CONFLICT (token_hash) DO UPDATE SET empleado_id = EXCLUDED.empleado_id, descripcion = EXCLUDED.descripcion, activo = TRUE, creado_en = NOW()
     RETURNING id`, [emp.id, hash, describirCelular(ua)]);
  return { emp, disp: { id: r.rows[0].id }, nuevo: true };
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
      [token, segundos + 120]
    );
    await pool.query("DELETE FROM qr_tokens WHERE expira_en < NOW() - INTERVAL '1 hour'");
    res.json({ token, segundos });
  } catch (e) { next(e); }
});

// Celular: ¿sigue vigente el QR que escaneé?
router.get('/valido/:token', async (req, res, next) => {
  try {
    const valido = await tokenVigente(req.params.token);
    const conf = valido ? await confQr() : { selfie: false, dispositivo: false };
    res.json({ valido, requiere_facial: conf.selfie, requiere_dispositivo: conf.dispositivo });
  } catch (e) { next(e); }
});

// Celular: paso 1 — validar PIN (y celular). Da 4 minutos para tomar la selfie y terminar.
router.post('/pin', limitePin, async (req, res, next) => {
  try {
    const { token, pin, dispositivo } = req.body;
    if (!/^\d{4}$/.test(String(pin || ''))) return res.status(400).json({ ok: false, error: 'Ingresa los 4 dígitos de tu PIN.' });
    if (!(await tokenVigente(token))) return res.status(410).json({ ok: false, expirado: true, error: 'Este código ya expiró. Escanea otra vez el QR de la pantalla.' });
    const conf = await confQr();
    const r = await identificar({ pin: String(pin), dispositivo, conf, ua: req.headers['user-agent'], registrar: true });
    if (r.error) return res.status(r.status).json({ ok: false, error: r.error, otro_celular: !!r.otro_celular });
    const sesion = jwt.sign({ tipo: 'qr_sesion', emp: r.emp.id, disp: r.disp ? r.disp.id : null }, process.env.JWT_SECRET, { expiresIn: '4m' });
    res.json({ ok: true, nombre: r.emp.nombre, requiere_facial: conf.selfie, foto_url: r.emp.foto_url, sesion, celular_nuevo: !!r.nuevo });
  } catch (e) { next(e); }
});

// Celular: paso 2 — registrar la checada con la selfie (la comparación del rostro se hace después)
router.post('/checar', limitePin, async (req, res, next) => {
  try {
    const { token, pin, foto, sesion, dispositivo } = req.body;
    if (!/^\d{4}$/.test(String(pin || ''))) return res.status(400).json({ ok: false, error: 'Datos incompletos.' });
    const conf = await confQr();
    let s = null;
    if (sesion) { try { s = jwt.verify(sesion, process.env.JWT_SECRET); if (s.tipo !== 'qr_sesion') s = null; } catch (_) { s = null; } }
    if (!s && !(await tokenVigente(token))) return res.status(410).json({ ok: false, expirado: true, error: 'El tiempo para checar se terminó. Escanea otra vez el QR de la pantalla.' });

    let emp, dispId = null;
    if (s) {
      emp = await buscarEmpleadoPorPin(String(pin), null, s.emp);
      if (!emp) return res.status(401).json({ ok: false, error: 'PIN incorrecto.' });
      if (conf.dispositivo) {
        // La sesión solo sirve en el mismo celular registrado
        const hash = hashDispositivo(dispositivo);
        const ok = s.disp && hash && (await pool.query('SELECT 1 FROM dispositivos WHERE id = $1 AND token_hash = $2 AND activo AND empleado_id = $3', [s.disp, hash, emp.id])).rows[0];
        if (!ok) return res.status(403).json({ ok: false, error: 'Este celular no está registrado para ti. Escanea otra vez el QR.' });
        dispId = s.disp;
      }
    } else {
      const r = await identificar({ pin: String(pin), dispositivo, conf, ua: req.headers['user-agent'], registrar: true });
      if (r.error) return res.status(r.status).json({ ok: false, error: r.error });
      emp = r.emp; dispId = r.disp ? r.disp.id : null;
    }

    let fotoUrl = null;
    const fotoValida = typeof foto === 'string' && /^data:image\/jpeg;base64,/.test(foto) && foto.length > 8000;
    if (conf.selfie && !fotoValida) {
      return res.status(400).json({ ok: false, error: 'Falta la foto de tu rostro. Vuelve a escanear el QR y permite la cámara.' });
    }
    if (fotoValida) { try { fotoUrl = await guardarDataUrl(foto, { maxMb: 2 }); } catch (e) { if (conf.selfie) throw e; } }
    const r = await registrarChecada({
      empleadoId: emp.id, metodo: 'qr', ip: req.ip, fotoUrl, verificadoFacial: false,
      revision: fotoUrl ? 'pendiente' : null, dispositivoId: dispId
    });
    if (fotoUrl && !emp.foto_url) {
      await pool.query("UPDATE checadas SET revision = 'revisar', revision_motivo = 'Sin foto en el expediente para comparar' WHERE id = $1", [r.id]);
    }
    if (dispId) pool.query('UPDATE dispositivos SET ultimo_uso = NOW() WHERE id = $1', [dispId]).catch(() => {});
    let puntualidad = null;
    if (r.tipo === 'entrada') { try { puntualidad = await puntualidadAlChecar(emp.id, r.fecha, r.hora); } catch (_) { puntualidad = null; } }
    res.json({ ok: true, empleado: emp.nombre, tipo: r.tipo, hora: r.hora, foto_guardada: !!fotoUrl, puntualidad });
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
