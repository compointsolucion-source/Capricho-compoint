// Dirección del servidor (backend).
//  · En tu computadora: localhost:3000
//  · Instalación de Render (páginas y servidor separados): capricho-compoint.onrender.com
//  · Sistemas de Compoint Check en el servidor de Compoint: el mismo dominio de la página
const API_URL = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? 'http://localhost:3000/api'
  : location.hostname === 'capricho-compoint-web.onrender.com'
    ? 'https://capricho-compoint.onrender.com/api'
    : location.origin + '/api';
