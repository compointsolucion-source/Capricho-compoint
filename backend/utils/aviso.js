const pool = require('../db');

// Aviso de privacidad para los EMPLEADOS del negocio (el negocio es el responsable de sus datos;
// Compoint solo los guarda por su cuenta). Versión corta (art. 16 LFPDPPP) que se muestra al checar,
// y el aviso completo en /aviso-empleados.html. Si cambia el texto, sube la VERSION.
const VERSION = '2026-11-02';

async function datosNegocio() {
  const { rows } = await pool.query('SELECT empresa_nombre, empresa_domicilio FROM configuracion WHERE id = 1');
  return { empresa: rows[0]?.empresa_nombre || 'Tu centro de trabajo', domicilio: rows[0]?.empresa_domicilio || null };
}

async function avisoCorto() {
  const { empresa, domicilio } = await datosNegocio();
  return {
    version: VERSION,
    titulo: 'Aviso de privacidad: tu foto al checar',
    parrafos: [
      `${empresa}${domicilio ? ` (${domicilio})` : ''} es responsable de tus datos personales.`,
      'Para registrar tu asistencia usamos tu nombre, tu PIN, la hora de entrada y salida, y una foto de tu rostro (selfie) al checar, que se compara con la foto de tu expediente para evitar que alguien cheque por ti. Tu rostro es un dato sensible: por eso te pedimos tu permiso.',
      'Solo se usa para el control de asistencia y la nómina. No se vende ni se usa para publicidad. Se guarda en el sistema Compoint Check, por cuenta de tu centro de trabajo.',
      'Si no aceptas, puedes checar solo con tu PIN, sin foto. Puedes cambiar tu decisión cuando quieras con tu encargado, y pedir ver, corregir o borrar tus datos (derechos ARCO).'
    ],
    completo: '/aviso-empleados.html'
  };
}

// Guarda la decisión del empleado. medio: celular | tableta | papel
async function guardarPermiso(empleadoId, acepta, medio) {
  await pool.query(
    `UPDATE empleados SET consentimiento_fotos = $1, consentimiento_en = NOW(), consentimiento_version = $2, consentimiento_medio = $3 WHERE id = $4`,
    [acepta ? 'acepto' : 'rechazo', VERSION, medio, empleadoId]);
}

module.exports = { VERSION, avisoCorto, guardarPermiso, datosNegocio };
