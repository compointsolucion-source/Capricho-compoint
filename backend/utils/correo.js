const nodemailer = require('nodemailer');
const pool = require('../db');

// Correo de Compoint (contacto@compoint.com.mx): Compoint lo pone en el servidor de cada cliente
// (variables SMTP_*), así la recuperación de contraseña funciona desde el primer día sin configurar nada.
// Si el negocio llena su propio correo en Configuración, se usa el suyo.
function smtpCompoint() {
  const e = process.env;
  if (!e.SMTP_HOST || !e.SMTP_USUARIO || !e.SMTP_CONTRASENA) return null;
  return { host: e.SMTP_HOST, puerto: Number(e.SMTP_PUERTO) || 465, usuario: e.SMTP_USUARIO, contrasena: e.SMTP_CONTRASENA,
    correo_remitente: e.SMTP_REMITENTE || e.SMTP_USUARIO, nombre_remitente: null, de_compoint: true };
}

async function obtenerConfigSmtp() {
  const { rows } = await pool.query('SELECT * FROM configuracion_smtp WHERE id = 1');
  const c = rows[0];
  if (c && c.host && c.usuario && c.contrasena) return c;
  return smtpCompoint();
}

// Regresa true si se envió, o un texto con el error.
async function enviarCorreo(destinatario, asunto, cuerpoHtml) {
  const c = await obtenerConfigSmtp();
  if (!c) return 'No has configurado el correo todavía. Ve a Configuración → Correo del sistema.';
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

module.exports = { enviarCorreo, smtpCompoint };
