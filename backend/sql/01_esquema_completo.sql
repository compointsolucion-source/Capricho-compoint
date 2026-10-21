-- ============================================================
-- CAPRICHO-COMPOINT — Esquema completo (PostgreSQL / Neon)
-- Migrado desde checador-huella (PHP/MySQL), archivos 01 a 07
-- + lo que faltaba (archivo 06: roles, jefe directo, tolerancia
--   de salida, configuración de correo y tema).
-- Pegar completo en el SQL Editor de Neon.
-- ============================================================

-- Configuración general del sistema (una sola fila, id = 1)
CREATE TABLE IF NOT EXISTS configuracion (
    id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    empresa_nombre VARCHAR(120) NOT NULL DEFAULT 'Compoint',
    tema VARCHAR(40) NOT NULL DEFAULT 'oscuro-neon',
    tolerancia_default_min INT NOT NULL DEFAULT 10,
    qr_vigencia_segundos INT NOT NULL DEFAULT 25,
    requiere_facial BOOLEAN NOT NULL DEFAULT FALSE,
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO configuracion (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Configuración de correo para alertas (una sola fila, id = 1)
CREATE TABLE IF NOT EXISTS configuracion_smtp (
    id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    proveedor VARCHAR(30) NOT NULL DEFAULT 'gmail',
    host VARCHAR(120) NOT NULL DEFAULT 'smtp.gmail.com',
    puerto INT NOT NULL DEFAULT 587,
    usuario VARCHAR(150),
    contrasena VARCHAR(255),
    correo_remitente VARCHAR(150),
    nombre_remitente VARCHAR(120)
);
INSERT INTO configuracion_smtp (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Horarios / turnos
CREATE TABLE IF NOT EXISTS horarios (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(80) NOT NULL,
    tipo_turno VARCHAR(10) NOT NULL DEFAULT 'fijo'
        CHECK (tipo_turno IN ('fijo','nocturno','flexible')),
    hora_entrada TIME,
    hora_salida TIME,
    tolerancia_minutos INT NOT NULL DEFAULT 10,
    tolerancia_salida_minutos INT NOT NULL DEFAULT 10,
    horas_requeridas NUMERIC(4,2),
    dias_semana VARCHAR(20) NOT NULL DEFAULT 'L,M,X,J,V',
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Empleados (expediente digital)
CREATE TABLE IF NOT EXISTS empleados (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(150) NOT NULL,
    puesto VARCHAR(100),
    departamento VARCHAR(100),
    sucursal VARCHAR(100),
    foto_url VARCHAR(500),
    numero_empleado VARCHAR(30) UNIQUE,
    huella_id VARCHAR(100) UNIQUE,
    pin_hash VARCHAR(255),
    horario_id INT REFERENCES horarios(id) ON DELETE SET NULL,
    jefe_directo_id INT REFERENCES empleados(id) ON DELETE SET NULL,
    fecha_ingreso DATE,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (jefe_directo_id IS NULL OR jefe_directo_id <> id)
);

-- Usuarios del panel (RH / supervisores)
CREATE TABLE IF NOT EXISTS administradores (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(100) NOT NULL,
    usuario VARCHAR(50) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    rol VARCHAR(12) NOT NULL DEFAULT 'admin'
        CHECK (rol IN ('admin','supervisor')),
    empleado_id INT REFERENCES empleados(id) ON DELETE SET NULL,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    intentos_fallidos INT NOT NULL DEFAULT 0,
    bloqueado_hasta TIMESTAMPTZ,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Checadas (entradas / salidas)
CREATE TABLE IF NOT EXISTS checadas (
    id SERIAL PRIMARY KEY,
    empleado_id INT NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
    fecha DATE NOT NULL,
    hora TIME NOT NULL,
    tipo VARCHAR(8) NOT NULL CHECK (tipo IN ('entrada','salida')),
    metodo VARCHAR(8) NOT NULL DEFAULT 'huella'
        CHECK (metodo IN ('huella','manual','qr')),
    verificado_facial BOOLEAN NOT NULL DEFAULT FALSE,
    foto_url VARCHAR(500),
    ip_dispositivo VARCHAR(45),
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_checadas_empleado_fecha ON checadas (empleado_id, fecha);
CREATE INDEX IF NOT EXISTS idx_checadas_fecha ON checadas (fecha);

-- Tokens del QR dinámico de la pantalla de entrada
CREATE TABLE IF NOT EXISTS qr_tokens (
    id SERIAL PRIMARY KEY,
    token VARCHAR(64) NOT NULL UNIQUE,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expira_en TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qr_tokens_expira ON qr_tokens (expira_en);

-- Días festivos / no laborables
CREATE TABLE IF NOT EXISTS dias_festivos (
    id SERIAL PRIMARY KEY,
    fecha DATE NOT NULL UNIQUE,
    descripcion VARCHAR(150) NOT NULL,
    tipo VARCHAR(15) NOT NULL DEFAULT 'oficial'
        CHECK (tipo IN ('oficial','personalizado'))
);

-- Incidencias (vacaciones, permisos, incapacidades, horas extra...)
CREATE TABLE IF NOT EXISTS incidencias (
    id SERIAL PRIMARY KEY,
    empleado_id INT NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
    fecha DATE NOT NULL,
    fecha_fin DATE,
    tipo VARCHAR(12) NOT NULL
        CHECK (tipo IN ('falta','permiso','vacaciones','incapacidad','horas_extra','otro')),
    estado VARCHAR(10) NOT NULL DEFAULT 'pendiente'
        CHECK (estado IN ('pendiente','aprobado','rechazado')),
    comentario VARCHAR(255),
    horas NUMERIC(5,2),
    archivo_url VARCHAR(500),
    revisado_por INT REFERENCES administradores(id) ON DELETE SET NULL,
    revisado_en TIMESTAMPTZ,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_incidencias_empleado ON incidencias (empleado_id);
CREATE INDEX IF NOT EXISTS idx_incidencias_estado ON incidencias (estado);

-- Auditoría de cambios manuales a checadas
CREATE TABLE IF NOT EXISTS auditoria_checadas (
    id SERIAL PRIMARY KEY,
    checada_id INT,
    empleado_id INT NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
    admin_id INT REFERENCES administradores(id) ON DELETE SET NULL,
    accion VARCHAR(10) NOT NULL CHECK (accion IN ('creada','editada','eliminada')),
    valor_anterior VARCHAR(255),
    valor_nuevo VARCHAR(255),
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Vista: retardos (entrada vs. horario asignado)
CREATE OR REPLACE VIEW vista_retardos AS
SELECT
    c.id AS checada_id,
    e.id AS empleado_id,
    e.nombre,
    c.fecha,
    c.hora AS hora_checada,
    h.hora_entrada,
    h.tolerancia_minutos,
    (EXTRACT(EPOCH FROM (c.hora - h.hora_entrada)) / 60)::INT AS minutos_diferencia,
    ((EXTRACT(EPOCH FROM (c.hora - h.hora_entrada)) / 60) > h.tolerancia_minutos) AS es_retardo
FROM checadas c
JOIN empleados e ON e.id = c.empleado_id
JOIN horarios h ON h.id = e.horario_id
WHERE c.tipo = 'entrada' AND h.hora_entrada IS NOT NULL;

-- Usuario dueño inicial (solo si todavía no hay ningún usuario)
-- Usuario: Admin   Contraseña temporal: Compoint2026  (cámbiala al entrar)
INSERT INTO administradores (nombre, usuario, password_hash, rol)
SELECT 'Jose Antonio Hernandez', 'Admin',
       '$2a$10$jKKUHzO0fM.V6VcQt4qz2.CwjEz4ULQPamU5edV.ImcR54WMxy2U2', 'admin'
WHERE NOT EXISTS (SELECT 1 FROM administradores);
