# Compoint Check en el servidor de Compoint (Coolify).
# Un solo contenedor por cliente: el servidor (backend) también entrega las páginas (frontend),
# así la dirección del cliente (ej. https://taqueria.compoint.com.mx) sirve todo.
# Las variables de cada cliente las pone el panel de compoint.com.mx (admin → Compoint Check):
# DATABASE_URL, JWT_SECRET, COMPOINT_LICENCIA_TOKEN y, solo para el primer arranque, las ALTA_*.
FROM node:22-alpine

WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY backend/ ./
COPY frontend/ /app/frontend/

ENV NODE_ENV=production \
    PORT=3000 \
    FRONTEND_DIR=/app/frontend \
    DB_SSL=false \
    TZ=America/Mexico_City

EXPOSE 3000
USER node

# Al arrancar pone al día la base (migraciones), crea al dueño si es la primera vez y abre el sistema.
CMD ["node", "server.js"]
