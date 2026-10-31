const nodemailer = require('nodemailer');
const pool = require('../db');

const licencia = require('./licencia');

// Correo de Compoint (contacto@compoint.com.mx) para los sistemas de los clientes: la recuperación
// de contraseña y de PIN funciona SOLA desde el primer día, sin que nadie configure nada.
//  1) Si Compoint puso variables SMTP_* en el servidor, se usan.
//  2) Si no, el sistema le pide a compoint.com.mx (check/correo.php) que mande el correo; se identifica
//     con el token de su licencia y sale de contacto@compoint.com.mx con el nombre de su negocio.
// Si el negocio llena su propio correo en Configuración, se usa el suyo.
function smtpCompoint() {
  const e = process.env;
  if (e.SMTP_HOST && e.SMTP_USUARIO && e.SMTP_CONTRASENA) {
    return { host: e.SMTP_HOST, puerto: Number(e.SMTP_PUERTO) || 465, usuario: e.SMTP_USUARIO, contrasena: e.SMTP_CONTRASENA,
      correo_remitente: e.SMTP_REMITENTE || e.SMTP_USUARIO, nombre_remitente: null, de_compoint: true };
  }
  const c = licencia.central();
  if (!c) return null;
  return { relay: true, url: c.url.replace(/terminal\.php$/, 'correo.php'), token: c.token,
    correo_remitente: 'contacto@compoint.com.mx', de_compoint: true };
}

// Manda el correo por compoint.com.mx. Regresa true o un texto con el error.
async function porCompoint(c, destinatario, asunto, cuerpoHtml) {
  try {
    const resp = await fetch(c.url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'CompointCheck' },
      body: JSON.stringify({ t: c.token, para: destinatario, asunto, html: cuerpoHtml }), signal: AbortSignal.timeout(20000)
    });
    const r = await resp.json().catch(() => null);
    return r && r.ok ? true : (r && r.error) || `No se pudo enviar (${resp.status}).`;
  } catch (e) {
    return 'No se pudo conectar con el correo de Compoint. Intenta en un momento.';
  }
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
  if (c.relay) return porCompoint(c, destinatario, asunto, cuerpoHtml);
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
