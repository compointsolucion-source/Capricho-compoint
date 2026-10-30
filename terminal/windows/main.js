// Compoint Check Terminal para Windows.
// Abre la pantalla de conexión (www/index.html) y después el sistema del negocio en pantalla completa
// fija (modo kiosco) cuando es Pantalla QR o Tableta. Se abre solo al prender la computadora,
// no deja que la pantalla se apague y, si se va el internet, vuelve a intentar solo.
const { app, BrowserWindow, Menu, session, powerSaveBlocker, ipcMain, shell } = require('electron');
const path = require('path');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required'); // sonido del saludo
if (!app.requestSingleInstanceLock()) { app.quit(); }

const LOCAL = 'https://localhost/'; // terminal.html regresa aquí (conectado / cerrar con PIN)
let win = null;
let enKiosco = false;
let bloqueo = null;
let saliendo = false;

function local(search = '') {
  win.loadFile(path.join(__dirname, 'www', 'index.html'), { search: search.replace(/^\?/, '') });
}

function kiosco(on) {
  enKiosco = !!on;
  win.setKiosk(enKiosco);
  if (enKiosco && bloqueo === null) bloqueo = powerSaveBlocker.start('prevent-display-sleep');
  if (!enKiosco && bloqueo !== null) { powerSaveBlocker.stop(bloqueo); bloqueo = null; }
}

function esLocal(e) { return !!(e.senderFrame && String(e.senderFrame.url).startsWith('file:')); }
ipcMain.handle('kiosco', (e, on) => { if (esLocal(e)) kiosco(on); });
ipcMain.handle('autoarranque', (e, on) => { if (esLocal(e) && app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!on }); });
ipcMain.handle('cerrar', (e) => { if (esLocal(e)) { saliendo = true; app.quit(); } });

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  // Cámara para la tableta checador y pantalla siempre encendida
  const permitidos = ['media', 'fullscreen', 'wakeLock', 'screen-wake-lock'];
  session.defaultSession.setPermissionRequestHandler((wc, permiso, cb) => cb(permitidos.includes(permiso)));
  session.defaultSession.setPermissionCheckHandler((wc, permiso) => permitidos.includes(permiso));

  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 800, minHeight: 600,
    backgroundColor: '#0a0c0a', title: 'Compoint Check Terminal', autoHideMenuBar: true,
    icon: path.join(__dirname, 'icono.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  const wc = win.webContents;
  wc.setUserAgent(`${wc.getUserAgent()} CompointTerminal/${app.getVersion()} CompointWindows`);

  const interceptar = (e, url) => {
    if (url.startsWith(LOCAL)) { e.preventDefault(); local(new URL(url).search); }
  };
  wc.on('will-navigate', interceptar);
  wc.on('will-redirect', interceptar);
  // Ligas que abren otra ventana: al navegador normal
  wc.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  // Sin internet al abrir el sistema: pantalla propia que reintenta sola
  wc.on('did-fail-load', (e, codigo, desc, url, principal) => {
    if (principal && codigo !== -3 && !String(url).startsWith('file:')) local('?sinred=1');
  });
  wc.on('render-process-gone', () => local());
  // Ctrl+Shift+Q: cerrar la pantalla completa (pide el PIN de salida)
  wc.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && String(input.key).toLowerCase() === 'q') {
      e.preventDefault();
      wc.executeJavaScript(`window.ccPedirSalida ? window.ccPedirSalida() : (location.href = '${LOCAL}?salir=1')`).catch(() => {});
    }
  });
  // En modo kiosco no se cierra con Alt+F4: solo con el PIN de salida
  win.on('close', (e) => { if (enKiosco && !saliendo) e.preventDefault(); });

  local();
});

app.on('window-all-closed', () => app.quit());
