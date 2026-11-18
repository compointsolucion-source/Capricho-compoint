const crypto = require('crypto');
const pool = require('../db');

const TIPOS_IMAGEN = ['image/jpeg', 'image/png', 'image/webp'];
const TIPOS_JUSTIFICANTE = ['application/pdf', 'image/jpeg', 'image/png'];

// Recibe un "data URL" (data:image/jpeg;base64,....) desde el navegador,
// lo guarda en la tabla archivos y regresa la URL pública para mostrarlo.
async function guardarDataUrl(dataUrl, { permitidos = TIPOS_IMAGEN, maxMb = 4, cliente = pool } = {}) {
  const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(String(dataUrl || ''));
  if (!m) throw errorUsuario('El archivo no es válido.');
  const tipo = m[1].toLowerCase();
  if (!permitidos.includes(tipo)) throw errorUsuario('Tipo de archivo no permitido.');
  const datos = Buffer.from(m[2], 'base64');
  if (datos.length > maxMb * 1024 * 1024) throw errorUsuario(`El archivo no debe pesar más de ${maxMb} MB.`);
  const { rows } = await cliente.query(
    'INSERT INTO archivos (tipo_mime, tamano, datos) VALUES ($1, $2, $3) RETURNING id',
    [tipo, datos.length, datos]
  );
  return `/api/archivos/${rows[0].id}`;
}

function errorUsuario(mensaje) {
  const e = new Error(mensaje);
  e.status = 400;
  return e;
}

// Llave para VER fotos y justificantes. Cambia cada día y solo la recibe quien tiene sesión
// (panel o terminal), en la cabecera X-Llave-Archivos. Las imágenes la llevan como ?k=...
// Así una foto no se abre aunque alguien consiga su dirección, salvo con una llave del día.
function llaveArchivos(diasAtras = 0) {
  const dia = new Date(Date.now() - diasAtras * 86400000).toISOString().slice(0, 10);
  return crypto.createHmac('sha256', String(process.env.JWT_SECRET || '')).update('archivos|' + dia).digest('hex').slice(0, 32);
}
function llaveArchivosValida(k) {
  k = String(k || '');
  if (!/^[a-f0-9]{32}$/.test(k)) return false;
  return [0, 1].some((i) => crypto.timingSafeEqual(Buffer.from(k), Buffer.from(llaveArchivos(i))));
}
function darLlaveArchivos(res) {
  try { res.set('X-Llave-Archivos', llaveArchivos()); } catch (_) { /* respuesta ya enviada */ }
}

module.exports = { guardarDataUrl, errorUsuario, TIPOS_IMAGEN, TIPOS_JUSTIFICANTE, llaveArchivos, llaveArchivosValida, darLlaveArchivos };
