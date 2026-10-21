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
  if (resp.status === 401 && tokenKey === 'cc_token' && !sinRedirigir) {
    localStorage.removeItem('cc_token');
    localStorage.removeItem('cc_usuario');
    location.href = 'login.html';
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
  { href: 'pantalla-qr.html', texto: 'Pantalla QR' },
  { href: 'empleados.html', texto: 'Empleados', admin: true },
  { href: 'organigrama.html', texto: 'Organigrama', admin: true },
  { href: 'horarios.html', texto: 'Horarios', admin: true },
  { href: 'festivos.html', texto: 'Días festivos', admin: true },
  { href: 'checadas.html', texto: 'Checadas', admin: true },
  { href: 'reportes.html', texto: 'Reportes' },
  { href: 'prenomina.html', texto: 'Pre-nómina', admin: true },
  { href: 'incidencias.html', texto: 'Incidencias' },
  { href: 'alertas.html', texto: 'Alertas', admin: true },
  { href: 'auditoria.html', texto: 'Auditoría', admin: true },
  { href: 'respaldos.html', texto: 'Respaldos', admin: true },
  { href: 'configuracion.html', texto: 'Configuración', admin: true }
];

// Llamar al inicio de cada pantalla del panel. Regresa el usuario o redirige al login.
function iniciarPanel({ soloAdmin = false } = {}) {
  const usuario = getUsuario();
  if (!getToken() || !usuario) { location.href = 'login.html'; return null; }
  if (soloAdmin && usuario.rol !== 'admin') { location.href = 'dashboard.html'; return null; }
  const actual = location.pathname.split('/').pop() || 'dashboard.html';
  const aside = document.getElementById('sidebar');
  if (aside) {
    aside.className = 'sidebar';
    aside.innerHTML = `
      <div class="brand"><a href="dashboard.html"><div class="logo-chip"><img src="img/logo.png" alt="Compoint"></div></a></div>
      <nav class="nav-section">
        ${MENU.filter((m) => !m.admin || usuario.rol === 'admin').map((m) =>
          `<a href="${m.href}" class="nav-item ${m.href === actual ? 'active' : ''}">${m.texto}</a>`).join('')}
      </nav>
      <div class="sidebar-foot">
        <div class="user-name">${esc(usuario.nombre)}</div>
        <div style="font-size:11px;color:var(--muted-2);text-transform:uppercase;letter-spacing:.06em;">${usuario.rol === 'admin' ? 'Administrador' : 'Supervisor'}</div>
        <a href="#" class="logout" onclick="cerrarSesion();return false;">Cerrar sesión</a>
      </div>`;
    const barra = document.createElement('div');
    barra.className = 'menu-movil';
    barra.innerHTML = `<img src="img/logo.png" alt="Compoint"><button type="button">☰ Menú</button>`;
    barra.querySelector('button').onclick = () => aside.classList.toggle('abierto');
    document.body.prepend(barra);
  }
  return usuario;
}

function cerrarSesion() {
  localStorage.removeItem('cc_token');
  localStorage.removeItem('cc_usuario');
  location.href = 'login.html';
}
