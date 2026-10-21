# Capricho-compoint

Checador de asistencia de **Compoint, punto de soluciones**: entradas, salidas y retardos con
**código QR dinámico + PIN** desde el celular, **verificación facial** opcional (parpadeo + comparación
con la foto del expediente) y endpoint para el **lector de huella DigitalPersona U.are.U 4500**.

Migrado del checador PHP/MySQL (XAMPP) al mismo esquema que Cremería POS:
**Node.js/Express + PostgreSQL (Neon) + HTML/JS**, desplegado en **Render**.

## Estructura

```
capricho-compoint/
├── backend/            → Web Service en Render (Root Directory: backend)
│   ├── server.js
│   ├── db.js
│   ├── sql/            → esquema; se aplica solo al arrancar (no borra nada)
│   ├── routes/         → auth, empleados, horarios, festivos, checadas, qr, huella,
│   │                     incidencias, portal, reportes, dashboard, configuracion, sistema
│   ├── middleware/     → sesiones y roles (admin / supervisor / empleado)
│   └── utils/          → hora de México, pre-nómina LFT, correo, archivos
└── frontend/           → Static Site en Render (Root Directory: frontend)
    ├── login.html, dashboard.html, pantalla-qr.html, checar.html, portal.html ...
    ├── css/  js/  img/
    └── js/config.js    → dirección del backend (lo único que cambia por cliente)
```

## Variables de entorno (backend en Render)

| Variable | Valor |
|---|---|
| `DATABASE_URL` | Cadena de conexión de Neon (proyecto Capricho-compoint) |
| `JWT_SECRET` | Texto largo y secreto |
| `AGENTE_TOKEN` | Clave para el agente del lector de huella |

## Cómo se usa

1. **Panel**: `login.html` — usuario inicial `Admin` / `Compoint2026` (cámbiala en Configuración).
2. **Pantalla de la entrada**: abre *Pantalla QR* en una tablet o monitor con sesión iniciada. El QR cambia cada 25 s.
3. **Empleado**: escanea el QR con su celular → escribe su PIN → (opcional) parpadea frente a la cámara → listo.
4. **Portal del empleado**: `portal.html` — número de empleado + PIN: vacaciones (LFT), solicitudes y sus checadas.

## Lector de huella (siguiente fase)

El agente que corre en la PC del lector manda:

```
POST https://capricho-compoint.onrender.com/api/huella/checada
Header: X-Agente-Token: <AGENTE_TOKEN>
Body:   { "huella_id": "ID que reconoció el lector" }
```

## Correr en tu computadora (opcional)

```
cd backend
copy .env.example .env      (y pon tu DATABASE_URL)
npm install
set FRONTEND_DIR=../frontend
npm start                   → http://localhost:3000
```
