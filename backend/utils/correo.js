const nodemailer = require('nodemailer');
const pool = require('../db');

async function obtenerConfigSmtp() {
  const { rows } = await pool.query('SELECT * FROM configuracion_smtp WHERE id = 1');
  const c = rows[0];
  if (!c || !c.host || !c.usuario || !c.contrasena) return null;
  return c;
}

// Regresa true si se envió, o un texto con el error.
async function enviarCorreo(destinatario, asunto, cuerpoHtml) {
  const c = await obtenerConfigSmtp();
  if (!c) return 'No has configurado el correo todavía. Ve a Configuración → Correo para alertas.';
  const { rows } = await pool.query('SELECT empresa_nombre FROM configuracion WHERE id = 1');
  try {
    const transporte = nodemailer.createTransport({
      host: c.host,
      port: Number(c.puerto),
      secure: Number(c.puerto) === 465,
      auth: { user: c.usuario, pass: c.contrasena }
    });
    await transporte.sendMail({
      from: `"${c.nombre_remitente || rows[0]?.empresa_nombre || 'Compoint'}" <${c.correo_remitente || c.usuario}>`,
      to: destinatario,
      subject: asunto,
      html: cuerpoHtml
    });
    return true;
  } catch (e) {
    return e.message;
  }
}

module.exports = { enviarCorreo };
