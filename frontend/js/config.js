// Dirección del servidor (backend). Para otro cliente solo se cambia esta línea.
const API_URL = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? 'http://localhost:3000/api'
  : 'https://capricho-compoint.onrender.com/api';
