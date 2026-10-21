const express = require('express');
const pool = require('../db');
const { verificarToken, requiereAdmin } = require('../middleware/auth');
const { ahora } = require('../utils/tiempo');

const router = express.Router();
router.use(verificarToken);

router.get('/', async (req, res, next) => {
  try {
    const hoy = ahora().fecha;
    const anio = Number(req.query.anio) || Number(hoy.slice(0, 4));
    const [lista, anios, proximo] = await Promise.all([
      pool.query('SELECT * FROM dias_festivos WHERE EXTRACT(YEAR FROM fecha) = $1 ORDER BY fecha', [anio]),
      pool.query('SELECT DISTINCT EXTRACT(YEAR FROM fecha)::int AS anio FROM dias_festivos ORDER BY anio'),
      pool.query('SELECT * FROM dias_festivos WHERE fecha >= $1 ORDER BY fecha LIMIT 1', [hoy])
    ]);
    const disponibles = anios.rows.map((r) => r.anio);
    const anioHoy = Number(hoy.slice(0, 4));
    if (!disponibles.includes(anioHoy)) disponibles.push(anioHoy);
    disponibles.sort();
    let diasFaltan = null;
    if (proximo.rows[0]) {
      diasFaltan = Math.round((new Date(`${proximo.rows[0].fecha}T12:00:00Z`) - new Date(`${hoy}T12:00:00Z`)) / 86400000);
    }
    res.json({ anio, festivos: lista.rows, anios: disponibles, proximo: proximo.rows[0] || null, diasFaltan, hoy });
  } catch (e) { next(e); }
});

router.post('/', requiereAdmin, async (req, res, next) => {
  try {
    const fecha = req.body.fecha;
    const descripcion = String(req.body.descripcion || '').trim();
    const tipo = req.body.tipo === 'personalizado' ? 'personalizado' : 'oficial';
    if (!fecha || !descripcion) return res.status(400).json({ error: 'La fecha y la descripción son obligatorias.' });
    const existe = await pool.query('SELECT id FROM dias_festivos WHERE fecha = $1', [fecha]);
    if (existe.rows[0]) return res.status(400).json({ error: 'Ya existe un día festivo registrado en esa fecha.' });
    await pool.query('INSERT INTO dias_festivos (fecha, descripcion, tipo) VALUES ($1,$2,$3)', [fecha, descripcion, tipo]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Carga los días de descanso obligatorio de la LFT (art. 74) para un año
router.post('/cargar-oficiales', requiereAdmin, async (req, res, next) => {
  try {
    const anio = Number(req.body.anio) || Number(ahora().fecha.slice(0, 4));
    const lunesN = (mes, n) => {
      const d = new Date(Date.UTC(anio, mes - 1, 1));
      const primerLunes = 1 + ((8 - d.getUTCDay()) % 7);
      return `${anio}-${String(mes).padStart(2, '0')}-${String(primerLunes + 7 * (n - 1)).padStart(2, '0')}`;
    };
    const lista = [
      [`${anio}-01-01`, 'Año Nuevo'],
      [lunesN(2, 1), 'Día de la Constitución'],
      [lunesN(3, 3), 'Natalicio de Benito Juárez'],
      [`${anio}-05-01`, 'Día del Trabajo'],
      [`${anio}-09-16`, 'Día de la Independencia'],
      [lunesN(11, 3), 'Revolución Mexicana'],
      [`${anio}-12-25`, 'Navidad']
    ];
    if ((anio - 2024) % 6 === 0) lista.push([`${anio}-10-01`, 'Transmisión del Poder Ejecutivo Federal']);
    let agregados = 0;
    for (const [fecha, desc] of lista) {
      const r = await pool.query(
        "INSERT INTO dias_festivos (fecha, descripcion, tipo) VALUES ($1,$2,'oficial') ON CONFLICT (fecha) DO NOTHING", [fecha, desc]
      );
      agregados += r.rowCount;
    }
    res.json({ ok: true, agregados });
  } catch (e) { next(e); }
});

router.delete('/:id', requiereAdmin, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM dias_festivos WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
