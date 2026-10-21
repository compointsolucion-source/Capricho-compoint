// Todas las fechas y horas del checador se calculan en hora de México,
// sin importar en qué zona horaria esté el servidor (Render usa UTC).
const TZ = process.env.ZONA_HORARIA || 'America/Mexico_City';
const CODIGOS_DIA = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];

function ahora() {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date());
  const g = (t) => partes.find((p) => p.type === t).value;
  const fecha = `${g('year')}-${g('month')}-${g('day')}`;
  const hora = `${g('hour')}:${g('minute')}:${g('second')}`;
  return { fecha, hora, diaCodigo: diaCodigo(fecha) };
}

// "AAAA-MM-DD" → 'L','M','X','J','V','S','D'
function diaCodigo(fecha) {
  return CODIGOS_DIA[new Date(`${fecha}T12:00:00Z`).getUTCDay()];
}

function sumarDias(fecha, n) {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// "HH:MM[:SS]" → minutos desde medianoche
function aMinutos(hora) {
  if (!hora) return null;
  const [h, m, s] = String(hora).split(':').map(Number);
  return h * 60 + m + (s || 0) / 60;
}

// Horas entre dos horas del día; si la salida es menor que la entrada
// (o el turno es nocturno) se asume que cruzó la medianoche.
function horasEntre(inicio, fin, cruzaMedianoche = false) {
  let a = aMinutos(inicio);
  let b = aMinutos(fin);
  if (a === null || b === null) return 0;
  if (cruzaMedianoche || b < a) b += 24 * 60;
  return Math.round(((b - a) / 60) * 100) / 100;
}

// Semana ISO "AAAA-WW" (para agrupar horas extra por semana, como la LFT)
function semanaIso(fecha) {
  const d = new Date(`${fecha}T12:00:00Z`);
  const dia = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dia + 3);
  const anio = d.getUTCFullYear();
  const primerJueves = new Date(Date.UTC(anio, 0, 4));
  const semana = 1 + Math.round(((d - primerJueves) / 86400000 - 3 + ((primerJueves.getUTCDay() + 6) % 7)) / 7);
  return `${anio}-${String(semana).padStart(2, '0')}`;
}

// Lunes y domingo de la semana actual (México)
function semanaActual() {
  const { fecha } = ahora();
  const dia = (new Date(`${fecha}T12:00:00Z`).getUTCDay() + 6) % 7;
  const lunes = sumarDias(fecha, -dia);
  return { desde: lunes, hasta: sumarDias(lunes, 6) };
}

module.exports = { TZ, ahora, diaCodigo, sumarDias, aMinutos, horasEntre, semanaIso, semanaActual };
