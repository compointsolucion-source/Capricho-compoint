// Solo la pantalla propia del programa (www/index.html) puede pedir pantalla completa, arranque y cerrar.
const { contextBridge, ipcRenderer } = require('electron');
if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('CompointShell', {
    plataforma: 'windows',
    kiosco: (on) => ipcRenderer.invoke('kiosco', !!on),
    autoarranque: (on) => ipcRenderer.invoke('autoarranque', !!on),
    cerrar: () => ipcRenderer.invoke('cerrar')
  });
}
