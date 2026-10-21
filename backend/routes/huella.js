const express = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { registrarChecada } = require('../utils/registro');

const router = express.Router();

// Endpoint para el agente del lector de huella (DigitalPersona U.are.U 4500).
// El agente corre en la PC de la entrada, identifica la huella y manda:
//   POST /api/huella/checada   Header: X-Agente-Token: <AGENTE_TOKEN>
//   { "huella_id": "...", "tipo": "entrada" | "salida" (opcional) }
function tokenCorrecto(recibido) {
  const esperado = process.env.AGENTE_TOKEN || '';
  if (!esperado || !recibido) return false;
  const a = Buffer.from(String(recibido));
  const b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.post('/checada', async (req, res, next) => {
  try {
    if (!tokenCorrecto(req.headers['x-agente-token'] || req.body.token)) {
      return res.status(401).json({ ok: false, error: 'Token inválido' });
    }
    const huellaId = String(req.body.huella_id || '').trim();
    if (!huellaId) return res.status(400).json({ ok: false, error: 'Falta huella_id' });
    const { rows } = await pool.query('SELECT id, nombre FROM empleados WHERE huella_id = $1 AND activo = TRUE', [huellaId]);
    if (!rows[0]) return res.status(404).json({ ok: false, error: 'Huella no registrada a ningún empleado activo' });
    const tipo = ['entrada', 'salida'].includes(req.body.tipo) ? req.body.tipo : null;
    const r = await registrarChecada({ empleadoId: rows[0].id, metodo: 'huella', tipo, ip: req.ip });
    res.json({ ok: true, empleado: rows[0].nombre, tipo: r.tipo, hora: r.hora });
  } catch (e) {
    if (e.status === 409) return res.status(409).json({ ok: false, error: e.message });
    next(e);
  }
});

module.exports = router;
