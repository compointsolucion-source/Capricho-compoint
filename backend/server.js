require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { migrar } = require('./utils/migrar');

if (!process.env.JWT_SECRET) {
  console.error('Falta la variable JWT_SECRET. Configúrala en Render (Environment).');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '12mb' }));

app.use((req, res, next) => {
  const inicio = Date.now();
  res.on('finish', () => {
    if (req.originalUrl.startsWith('/api/archivos')) return;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl.split('?')[0]} → ${res.statusCode} (${Date.now() - inicio}ms)`);
  });
  next();
});

// Modo local (opcional): el mismo servidor entrega las pantallas.
// En Render no se usa: el frontend va como Static Site aparte.
if (process.env.FRONTEND_DIR) {
  const dir = path.resolve(process.env.FRONTEND_DIR);
  app.get('/js/config.js', (req, res) => {
    res.type('application/javascript').set('Cache-Control', 'no-store').send("const API_URL = location.origin + '/api';\n");
  });
  app.get('/', (req, res) => res.redirect('/login.html'));
  app.use(express.static(dir));
}

app.get('/', (req, res) => res.json({ ok: true, sistema: 'Capricho-compoint', api: '/api' }));
app.get('/api/salud', (req, res) => res.json({ ok: true }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/empleados', require('./routes/empleados'));
app.use('/api/horarios', require('./routes/horarios'));
app.use('/api/festivos', require('./routes/festivos'));
app.use('/api/checadas', require('./routes/checadas'));
app.use('/api/qr', require('./routes/qr'));
app.use('/api/huella', require('./routes/huella'));
app.use('/api/incidencias', require('./routes/incidencias'));
app.use('/api/portal', require('./routes/portal'));
app.use('/api/reportes', require('./routes/reportes'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/configuracion', require('./routes/configuracion'));
app.use('/api', require('./routes/sistema'));

app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

// Errores: los de validación (status 400) muestran su mensaje; los demás un texto genérico
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'El archivo es demasiado grande.' });
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  if (err.code === '23505') return res.status(400).json({ error: 'Ya existe un registro con ese dato.' });
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor. Intenta de nuevo.' });
});

const PORT = process.env.PORT || 3000;
migrar()
  .catch((e) => console.error('[migrar] Error:', e.message))
  .finally(() => app.listen(PORT, () => console.log(`Capricho-compoint escuchando en el puerto ${PORT}`)));
