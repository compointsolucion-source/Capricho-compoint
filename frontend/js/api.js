// ============================================
// Capricho-compoint — utilidades comunes
// ============================================

const BASE_SERVIDOR = API_URL.replace(/\/api$/, '');

function getToken() { return localStorage.getItem('cc_token'); }
function getUsuario() {
  try { return JSON.parse(localStorage.getItem('cc_usuario') || 'null'); } catch (_) { return null; }
}
function esAdmin() { return (getUsuario() || {}).rol === 'admin'; }

// Petición al servidor. tokenKey permite usar la sesión del portal del empleado.
async function api(ruta, { method = 'GET', body, tokenKey = 'cc_token', sinRedirigir = false } = {}) {
  const headers = {};
  const token = localStorage.getItem(tokenKey);
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let resp;
  try {
    resp = await fetch(API_URL + ruta, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch (e) {
    throw new Error('No hay conexión con el servidor. Si es la primera vez del día, espera 30 segundos (el servidor se está despertando) e intenta de nuevo.');
  }
  let datos = null;
  try { datos = await resp.json(); } catch (_) { datos = null; }
  if (resp.status === 401 && !sinRedirigir && (tokenKey === 'cc_token' || tokenKey === 'cc_token_empleado')) {
    localStorage.removeItem(tokenKey);
    if (tokenKey === 'cc_token') { localStorage.removeItem('cc_usuario'); location.href = 'login.html'; }
    else location.href = 'portal.html';
    throw new Error('Sesión expirada');
  }
  if (!resp.ok) throw new Error((datos && datos.error) || `Error ${resp.status}`);
  return datos;
}

// Descarga de archivos que requieren sesión (respaldo)
async function descargar(ruta, nombre) {
  const resp = await fetch(API_URL + ruta, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!resp.ok) throw new Error('No se pudo descargar');
  const blob = await resp.blob();
  const disp = resp.headers.get('Content-Disposition') || '';
  const m = /filename="([^"]+)"/.exec(disp);
  bajarBlob(blob, (m && m[1]) || nombre);
}

function bajarBlob(blob, nombre) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

// CSV con BOM para que Excel respete los acentos
function exportarCsv(nombre, encabezados, filas) {
  const celda = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const texto = [encabezados, ...filas].map((f) => f.map(celda).join(',')).join('\r\n');
  bajarBlob(new Blob(['﻿' + texto], { type: 'text/csv;charset=utf-8' }), nombre);
}

function urlArchivo(url) { return url ? (url.startsWith('http') ? url : BASE_SERVIDOR + url) : ''; }

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function hhmm(h) { return h ? String(h).slice(0, 5) : '—'; }
function hhmmss(h) { return h ? String(h).slice(0, 8) : '—'; }

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
function fechaLarga(f) {
  if (!f) return '—';
  const d = new Date(`${f}T12:00:00`);
  return `${DIAS_SEMANA[d.getDay()]}, ${d.getDate()} de ${MESES[d.getMonth()]} de ${d.getFullYear()}`;
}
function fechaCorta(f) {
  if (!f) return '—';
  const [a, m, d] = String(f).slice(0, 10).split('-');
  return `${d}/${m}/${a}`;
}
function fechaHora(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('es-MX', { timeZone: 'America/Mexico_City', dateStyle: 'short', timeStyle: 'short' });
}
// Fecha de hoy en México (AAAA-MM-DD)
function hoyMx() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
}
function sumarDiasStr(f, n) {
  const d = new Date(`${f}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

let _toastTimer;
function toast(mensaje, tipo = 'ok') {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.className = `toast ${tipo}`;
  el.textContent = mensaje;
  requestAnimationFrame(() => el.classList.add('visible'));
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('visible'), tipo === 'error' ? 6000 : 3500);
}

// Lee un archivo elegido en un <input type=file> como data URL.
// Las fotos se reducen a máximo 800px para que pesen poco.
function leerArchivo(input, { esImagen = true, maxLado = 800 } = {}) {
  const f = input.files && input.files[0];
  if (!f) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const lector = new FileReader();
    lector.onerror = () => reject(new Error('No se pudo leer el archivo'));
    lector.onload = () => {
      if (!esImagen || !/^image\/(jpeg|png|webp)$/.test(f.type)) return resolve(lector.result);
      const img = new Image();
      img.onload = () => {
        const escala = Math.min(1, maxLado / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * escala);
        c.height = Math.round(img.height * escala);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => resolve(lector.result);
      img.src = lector.result;
    };
    lector.readAsDataURL(f);
  });
}

// ---------- Tema visual ----------
function aplicarTema(tema) {
  document.body.dataset.theme = tema || 'oscuro-neon';
}
(function temaInicial() {
  const guardado = localStorage.getItem('cc_tema') || 'oscuro-neon';
  if (document.body) aplicarTema(guardado);
  else document.addEventListener('DOMContentLoaded', () => aplicarTema(guardado));
  fetch(API_URL + '/configuracion/publica').then((r) => r.json()).then((c) => {
    if (c && c.tema) { localStorage.setItem('cc_tema', c.tema); aplicarTema(c.tema); }
  }).catch(() => {});
})();

// ---------- Menú lateral ----------
const MENU = [
  { href: 'dashboard.html', texto: 'Dashboard' },
  { grupo: 'Finanzas', admin: true },
  { href: 'corte.html', texto: 'Corte del día', admin: true },
  { href: 'semana.html', texto: 'Semana', admin: true },
  { href: 'nomina.html', texto: 'Nómina y pagos', admin: true },
  { href: 'mes.html', texto: 'Mes', admin: true },
  { href: 'catalogos.html', texto: 'Proveedores y conceptos', admin: true },
  { grupo: 'Personal' },
  { href: 'pantalla-qr.html', texto: 'Pantalla QR' },
  { href: 'empleados.html', texto: 'Empleados', admin: true },
  { href: 'permisos.html', texto: 'Permisos', admin: true },
  { href: 'organigrama.html', texto: 'Organigrama', admin: true },
  { href: 'horarios.html', texto: 'Horarios', admin: true },
  { href: 'festivos.html', texto: 'Días festivos', admin: true },
  { href: 'checadas.html', texto: 'Checadas', admin: true },
  { href: 'reportes.html', texto: 'Reportes' },
  { href: 'prenomina.html', texto: 'Pre-nómina', admin: true },
  { href: 'incidencias.html', texto: 'Incidencias' },
  { grupo: 'Sistema', admin: true },
  { href: 'alertas.html', texto: 'Alertas', admin: true },
  { href: 'auditoria.html', texto: 'Auditoría', admin: true },
  { href: 'respaldos.html', texto: 'Respaldos', admin: true },
  { href: 'configuracion.html', texto: 'Configuración', admin: true }
];

function pintarMenu(items, pie) {
  const actual = location.pathname.split('/').pop() || 'dashboard.html';
  const aside = document.getElementById('sidebar');
  if (!aside) return;
  aside.className = 'sidebar';
  aside.innerHTML = `
    <div class="brand"><a href="${items[0] ? items[0].href : '#'}"><div class="logo-chip"><img src="img/logo.png" alt="Compoint"></div></a></div>
    <nav class="nav-section">
      ${items.map((m) => m.grupo ? `<div class="nav-grupo">${m.grupo}</div>`
        : `<a href="${m.href}" class="nav-item ${m.href === actual ? 'active' : ''}">${m.texto}</a>`).join('')}
    </nav>
    <div class="sidebar-foot">${pie}</div>`;
  const barra = document.createElement('div');
  barra.className = 'menu-movil';
  barra.innerHTML = `<img src="img/logo.png" alt="Compoint"><button type="button">☰ Menú</button>`;
  barra.querySelector('button').onclick = () => aside.classList.toggle('abierto');
  document.body.prepend(barra);
}

// Llamar al inicio de cada pantalla del panel. Regresa el usuario o redirige al login.
function iniciarPanel({ soloAdmin = false } = {}) {
  const usuario = getUsuario();
  if (!getToken() || !usuario) { location.href = 'login.html'; return null; }
  if (soloAdmin && usuario.rol !== 'admin') { location.href = 'dashboard.html'; return null; }
  pintarMenu(MENU.filter((m) => !m.admin || usuario.rol === 'admin'), `
    <div class="user-name">${esc(usuario.nombre)}</div>
    <div style="font-size:11px;color:var(--muted-2);text-transform:uppercase;letter-spacing:.06em;">${usuario.rol === 'admin' ? 'Administrador' : 'Supervisor'}</div>
    <a href="#" class="logout" onclick="cerrarSesion();return false;">Cerrar sesión</a>`);
  return usuario;
}

// ---------- Finanzas: las usa el dueño (panel) o un empleado con permisos (portal) ----------
let FIN_KEY = 'cc_token';
function apiFin(ruta, op = {}) { return api(ruta, { ...op, tokenKey: FIN_KEY }); }

async function iniciarFinanzas(permisosPagina = []) {
  const u = getUsuario();
  if (getToken() && u && u.rol === 'admin') FIN_KEY = 'cc_token';
  else if (localStorage.getItem('cc_token_empleado')) FIN_KEY = 'cc_token_empleado';
  else { location.href = getToken() ? 'dashboard.html' : 'portal.html'; return null; }
  let yo;
  try { yo = await apiFin('/finanzas/yo'); } catch (e) {
    document.body.innerHTML = `<div class="checar-wrap"><div class="checar-card"><div class="resultado error">${esc(e.message)}</div><p class="sub" style="margin-top:16px;"><a href="${FIN_KEY === 'cc_token' ? 'dashboard.html' : 'portal.html'}" style="color:var(--neon)">Regresar</a></p></div></div>`;
    return null;
  }
  if (permisosPagina.length && !permisosPagina.some((p) => yo.permisos[p])) {
    location.href = yo.tipo === 'admin' ? 'dashboard.html' : 'portal.html';
    return null;
  }
  if (yo.tipo === 'admin') iniciarPanel({ soloAdmin: true });
  else {
    const p = yo.permisos;
    pintarMenu([
      { href: 'portal.html', texto: 'Mi portal' },
      { grupo: 'Finanzas' },
      ...(p.corte ? [{ href: 'corte.html', texto: 'Corte del día' }] : []),
      ...(p.ver_semana || p.surtida || p.gastos ? [{ href: 'semana.html', texto: p.ver_semana ? 'Semana' : 'Gastos y surtida' }] : []),
      ...(p.nomina ? [{ href: 'nomina.html', texto: 'Nómina y pagos' }] : []),
      ...(p.ver_utilidad ? [{ href: 'mes.html', texto: 'Mes' }] : [])
    ], `<div class="user-name">${esc(yo.nombre)}</div>
        <div style="font-size:11px;color:var(--muted-2);text-transform:uppercase;letter-spacing:.06em;">${esc(yo.puesto || 'Empleado')}</div>
        <a href="#" class="logout" onclick="localStorage.removeItem('cc_token_empleado');location.href='portal.html';return false;">Cerrar sesión</a>`);
  }
  return yo;
}

// Formato de dinero: $12,345.00 (o sin centavos)
function $m(n, dec = 0) {
  const v = Number(n) || 0;
  const s = Math.abs(v).toLocaleString('es-MX', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  return (v < 0 ? '−$' : '$') + s;
}
function numero(v) { const n = Number(String(v ?? '').replace(/[$,\s]/g, '')); return isFinite(n) ? n : 0; }
const DIA_NOMBRE = { L: 'Lunes', M: 'Martes', X: 'Miércoles', J: 'Jueves', V: 'Viernes', S: 'Sábado', D: 'Domingo' };
const DIA_CORTO = { L: 'LUN', M: 'MAR', X: 'MIÉ', J: 'JUE', V: 'VIE', S: 'SÁB', D: 'DOM' };
function diaMes(f) { return Number(String(f).slice(8, 10)); }
function rangoSemana(lunes, domingo) {
  const m1 = MESES[Number(lunes.slice(5, 7)) - 1].slice(0, 3), m2 = MESES[Number(domingo.slice(5, 7)) - 1].slice(0, 3);
  return m1 === m2 ? `${diaMes(lunes)} – ${diaMes(domingo)} ${m2} ${domingo.slice(0, 4)}` : `${diaMes(lunes)} ${m1} – ${diaMes(domingo)} ${m2} ${domingo.slice(0, 4)}`;
}
function linkWhatsApp(tel) { const t = String(tel || '').replace(/\D/g, ''); return t ? `https://wa.me/52${t.slice(-10)}` : null; }

// Ventana de confirmación propia (en lugar de confirm del navegador)
function preguntar(titulo, texto, { boton = 'Aceptar', peligro = false, campo = null } = {}) {
  return new Promise((ok) => {
    const v = document.createElement('div');
    v.className = 'ventana';
    v.innerHTML = `<div class="caja"><h3>${esc(titulo)}</h3><p>${texto}</p>
      ${campo ? `<div class="field"><label>${esc(campo.label)}</label>${campo.html}</div>` : ''}
      <div class="form-actions" style="justify-content:flex-end;"><button class="btn-secondary" data-r="0">Cancelar</button>
      <button class="${peligro ? 'btn-peligro' : 'btn-primary inline'}" data-r="1">${esc(boton)}</button></div></div>`;
    document.body.appendChild(v);
    const cerrar = (r) => { const val = campo ? v.querySelector('[name=valor]')?.value : true; v.remove(); ok(r ? val : null); };
    v.querySelectorAll('[data-r]').forEach((b) => b.onclick = () => cerrar(b.dataset.r === '1'));
    v.onclick = (e) => { if (e.target === v) cerrar(false); };
    const inp = v.querySelector('[name=valor]'); if (inp) inp.focus();
  });
}

function cerrarSesion() {
  localStorage.removeItem('cc_token');
  localStorage.removeItem('cc_usuario');
  location.href = 'login.html';
}

// ---------- App instalable (Windows / Android) ----------
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
let _instalarApp = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _instalarApp = e;
  document.querySelectorAll('.solo-instalable').forEach((x) => { x.style.display = ''; });
});
async function instalarApp() {
  if (!_instalarApp) return toast('Abre el menú del navegador (⋮) y elige "Instalar Capricho Compoint".');
  _instalarApp.prompt();
  await _instalarApp.userChoice;
  _instalarApp = null;
}
// ¿Corre dentro de la app de Android?
function esAppAndroid() { return /CaprichoApp/.test(navigator.userAgent) || !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()); }
