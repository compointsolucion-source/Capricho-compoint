const express = require('express');
const { estado, revisarAhora } = require('../utils/licencia');

// Estado de la suscripción para las pantallas (aviso 7 días antes, "solo consulta", módulos).
// No trae nada secreto: solo lo que el negocio debe ver.
const router = express.Router();

router.get('/', (req, res) => {
  const e = estado();
  res.json({
    control: e.control, bloqueado: e.bloqueado, motivo: e.motivo || null, aviso: e.aviso,
    dias: e.dias ?? null, vence: e.vence || null, paquete: e.paquete || null, paquete_nombre: e.paquete_nombre || null,
    modulos: e.modulos, max_empleados: e.max_empleados ?? null, contacto: e.contacto || null
  });
});

// "Ya pagué, revisar": vuelve a preguntar a Compoint sin esperar la hora
router.post('/revisar', async (req, res, next) => {
  try {
    const r = await revisarAhora();
    res.json({ ok: !!r.ok, espera: !!r.espera, ...estado() });
  } catch (e) { next(e); }
});

module.exports = router;
