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

module.exports = { guardarDataUrl, errorUsuario, TIPOS_IMAGEN, TIPOS_JUSTIFICANTE };
